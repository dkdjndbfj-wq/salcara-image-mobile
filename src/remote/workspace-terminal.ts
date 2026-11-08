import { command, HubError, type AgentId, type Command, type Hub, type SessionInfo } from './client';
import { getRemoteState, onRemoteChange, remoteDeliveryScope, timelineKey, watchCredentials } from './store';

export interface TerminalSelection { deviceId: string; sessionKey: string; agentId: AgentId; surface: 'cli' | 'desktop'; cwd: string }
export interface TerminalOutput { terminalId: string; cursor: number; startCursor: number; dataBase64: string; truncated: boolean; exited: boolean; exitCode: number; nextSequence: number }
export interface WorkspaceTerminal {
  open(cols: number, rows: number): Promise<TerminalOutput>;
  read(cursor: number): Promise<TerminalOutput>;
  input(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
  dispose(): void;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HubError('终端响应无效');
  return value as Record<string, unknown>;
}
const integer = (value: unknown, min = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{12,128}$/.test(value);

export function parseTerminalOutput(value: unknown, terminalId?: string): TerminalOutput {
  const raw = object(value);
  if (!identifier(raw.terminalId) || terminalId && terminalId !== raw.terminalId || !integer(raw.cursor) || !integer(raw.startCursor)
      || (raw.startCursor as number) > (raw.cursor as number) || !integer(raw.nextSequence, 1)
      || typeof raw.dataBase64 !== 'string' || raw.dataBase64.length > 65536 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.dataBase64)
      || typeof raw.truncated !== 'boolean' || typeof raw.exited !== 'boolean'
      || typeof raw.exitCode !== 'number' || !Number.isSafeInteger(raw.exitCode)) throw new HubError('终端响应无效');
  const bytes = raw.dataBase64.length / 4 * 3 - (raw.dataBase64.endsWith('==') ? 2 : raw.dataBase64.endsWith('=') ? 1 : 0);
  if ((raw.cursor as number) - (raw.startCursor as number) !== bytes) throw new HubError('终端输出游标无效');
  return raw as unknown as TerminalOutput;
}

export function terminalDimensions(cols: number, rows: number) { return { cols: Math.max(20, Math.min(400, Math.floor(cols || 80))), rows: Math.max(5, Math.min(200, Math.floor(rows || 24))) }; }

/** A PTY never follows a replacement computer, phone generation, or session.
 * Input is serialized and numbered. Ambiguous input failures stop further
 * input; they are never silently resent as a fresh command. */
export function captureWorkspaceTerminal(selection: TerminalSelection, onInvalidated?: () => void): WorkspaceTerminal {
  const credentials = watchCredentials(), scope = remoteDeliveryScope(), controller = new AbortController();
  const owner: Hub | undefined = credentials?.pairToken ? { ...credentials, deviceId: selection.deviceId } : undefined;
  let disposed = false, invalidated = false, terminalId: string | undefined, sequence = 1, inputFailed = false;
  let writes: Promise<void> = Promise.resolve();
  const operationId = `terminal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
  const session = (): SessionInfo | undefined => {
    const state = getRemoteState(), directory = state.sessions[selection.deviceId];
    return state.timelines[timelineKey(selection.deviceId, selection.sessionKey)]?.session
      ?? (selection.surface === 'desktop' ? directory?.native?.list : directory?.list)?.find(item => item.sessionKey === selection.sessionKey);
  };
  const valid = () => {
    const state = getRemoteState(), current = watchCredentials(), info = session();
    const device = state.devices.find(item => item.deviceId === selection.deviceId);
    if (disposed || invalidated || !owner || !selection.cwd || scope !== remoteDeliveryScope() || current?.url !== owner.url || current?.pairToken !== owner.pairToken
        || !device?.online || !device.capabilities?.includes('workspace.terminal.v1') || !device.projects.some(project => project.path === selection.cwd)
        || info?.cwd !== selection.cwd || info.controlSurface === 'read-only' || (info.controlSurface === 'desktop' ? 'desktop' : 'cli') !== selection.surface) return false;
    if (selection.surface === 'desktop') {
      const lease = state.agents[selection.deviceId]?.list.find(item => item.id === selection.agentId)?.desktopLive;
      return Boolean(lease && lease.expiresAt > Date.now() && lease.capabilities?.list && lease.capabilities.read && lease.sessionKeys.includes(selection.sessionKey));
    }
    return true;
  };
  const guard = () => { if (!valid()) throw new HubError('终端所属电脑或会话已变化，请重新打开终端', 499, 'terminal_scope_changed'); };
  const unsubscribe = onRemoteChange(() => { if (!disposed && !invalidated && !valid()) { invalidated = true; controller.abort(); onInvalidated?.(); } });
  const base = { sessionKey: selection.sessionKey, controlSurface: selection.surface, expectedCwd: selection.cwd };
  const send = async (type: string, payload: Record<string, unknown>) => {
    guard();
    const response = await command<unknown>(owner!, selection.deviceId, { ...base, type, ...payload } as Command, undefined, controller.signal);
    guard(); return response;
  };
  const close = async () => {
    if (!terminalId || !valid()) return;
    const id = terminalId; terminalId = undefined;
    await send('workspace.terminal.close', { terminalId: id });
  };
  return {
    open: async (cols, rows) => {
      const reply = parseTerminalOutput(await send('workspace.terminal.open', { operationId, ...terminalDimensions(cols, rows) }), terminalId);
      terminalId = reply.terminalId; sequence = reply.nextSequence; return reply;
    },
    read: async cursor => {
      if (!terminalId) throw new HubError('终端尚未连接');
      const reply = parseTerminalOutput(await send('workspace.terminal.read', { terminalId, cursor }), terminalId);
      if (!reply.truncated && reply.startCursor !== cursor || reply.startCursor < cursor) throw new HubError('终端输出顺序无效');
      return reply;
    },
    input: data => {
      const pending = writes.then(async () => {
        guard(); if (inputFailed || !terminalId || !data || new TextEncoder().encode(data).length > 16384) throw new HubError('终端输入已暂停，请重新打开终端');
        const sentSequence = sequence;
        try {
          const response = object(await send('workspace.terminal.input', { terminalId, sequence: sentSequence, data }));
          if (response.terminalId !== terminalId || response.sequence !== sentSequence) throw new HubError('终端输入未确认');
          sequence += 1;
        } catch (error) { inputFailed = true; throw error; }
      });
      writes = pending.catch(() => {}); return pending;
    },
    resize: async (cols, rows) => { if (terminalId) await send('workspace.terminal.resize', { terminalId, ...terminalDimensions(cols, rows) }); },
    close,
    dispose: () => {
      if (disposed) return;
      // Capture the old credential only while still valid. Never deliver a
      // delayed close to a newly selected computer or replacement binding.
      if (terminalId && valid()) void command(owner!, selection.deviceId, { ...base, type: 'workspace.terminal.close', terminalId } as Command).catch(() => {});
      disposed = true; controller.abort(); unsubscribe();
    },
  };
}
