import { command, HubError, type AgentId, type Command, type Hub, type SessionInfo } from './client';
import { getRemoteState, onRemoteChange, remoteDeliveryScope, timelineKey, watchCredentials } from './store';

export const WORKSPACE_FILE_BYTES = 128 * 1024;
export interface WorkspaceFileEntry { name: string; path: string; kind: 'directory' | 'file'; size?: number }
export interface WorkspaceFilesPage { path: string; entries: WorkspaceFileEntry[]; nextCursor?: string; truncated: boolean }
export interface WorkspaceFileText { path: string; text: string; size: number; modifiedAt: number; revision?: string }
export interface WorkspaceFileReader {
  readonly cwd?: string;
  list(path?: string, cursor?: string): Promise<WorkspaceFilesPage>;
  read(path: string): Promise<WorkspaceFileText>;
  readonly writable?: boolean;
  write?(path: string, text: string, expectedRevision: string): Promise<WorkspaceFileText>;
  readonly manageable?: boolean;
  create?(path: string, text: string): Promise<WorkspaceFileText>;
  remove?(path: string, expectedRevision: string): Promise<void>;
  rename?(path: string, destination: string, expectedRevision: string): Promise<WorkspaceFileText>;
  dispose(): void;
}

/** A new task has no native session. Its files are admitted only by the
 * computer's explicitly saved project, never by a fabricated session ID. */
export function captureProjectWorkspaceFiles(selection: { deviceId: string; tool: string; cwd: string }, onInvalidated?: () => void): WorkspaceFileReader {
  const credentials = watchCredentials(), scope = remoteDeliveryScope(), controller = new AbortController();
  const owner = credentials?.pairToken ? { ...credentials, deviceId: selection.deviceId } : undefined;
  let disposed = false, invalidated = false, busy = false;
  const valid = () => {
    const state = getRemoteState(), now = watchCredentials(), device = state.devices.find(item => item.deviceId === selection.deviceId);
    return !disposed && !invalidated && Boolean(owner && device?.online && device.capabilities?.includes('workspace.project.files.v1')
      && device.projects.some(project => project.path === selection.cwd) && scope === remoteDeliveryScope()
      && now?.url === owner.url && now?.pairToken === owner.pairToken);
  };
  const guard = () => { if (!valid()) throw new HubError('项目授权或连接已变化，请重新选择引用', 499, 'workspace_scope_changed'); };
  const unsubscribe = onRemoteChange(() => { if (!disposed && !invalidated && !valid()) { invalidated = true; controller.abort(); onInvalidated?.(); } });
  const perform = async <T>(read: boolean, path: string, parse: (value: unknown, path: string) => T, cursor?: string): Promise<T> => {
    guard(); if (busy || !workspaceRelativePath(path, !read)) throw new HubError('请稍后重新读取文件');
    busy = true;
    try {
      const result = await command<unknown>(owner!, selection.deviceId, { type: read ? 'workspace.project.files.read' : 'workspace.project.files.list',
        tool: selection.tool, cwd: selection.cwd, expectedCwd: selection.cwd, controlSurface: 'cli', path, ...(cursor ? { cursor } : {}) }, undefined, controller.signal);
      guard(); return parse(result, path);
    } finally { busy = false; }
  };
  return { list: (path = '', cursor) => perform(false, path, parseWorkspaceFilesPage, cursor), read: path => perform(true, path, parseWorkspaceFileText),
    dispose: () => { if (!disposed) { disposed = true; controller.abort(); unsubscribe(); } } };
}

// UI validation is not filesystem authorization; the Bridge checks opened
// handles against its explicitly configured project and current session lease.
export function workspaceRelativePath(value: unknown, root = false): value is string {
  if (typeof value !== 'string' || value.length > 1024 || /[\\:*?"<>|\p{Cc}\p{Cf}]/u.test(value)) return false;
  if (!value) return root;
  return value.split('/').every(part => part.length > 0 && part.length <= 255 && part.trim() === part && !part.startsWith('.') && !part.endsWith('.'));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HubError('文件响应无效');
  return value as Record<string, unknown>;
}

export function parseWorkspaceFilesPage(value: unknown, path: string): WorkspaceFilesPage {
  const raw = record(value);
  if (raw.path !== path || !workspaceRelativePath(path, true) || !Array.isArray(raw.entries) || raw.entries.length > 50
      || raw.nextCursor !== undefined && (typeof raw.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw.nextCursor))
      || raw.truncated !== undefined && typeof raw.truncated !== 'boolean') throw new HubError('文件目录响应无效');
  const names = new Set<string>();
  const entries = raw.entries.map(value => {
    const item = record(value);
    if (!workspaceRelativePath(item.name) || item.name.includes('/') || names.has(item.name)
        || item.path !== (path ? `${path}/${item.name}` : item.name) || !workspaceRelativePath(item.path)
        || item.kind !== 'file' && item.kind !== 'directory'
        || item.size !== undefined && (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > (item.kind === 'file' ? WORKSPACE_FILE_BYTES : 2 ** 40))) throw new HubError('文件目录响应无效');
    names.add(item.name);
    return { name: item.name, path: item.path, kind: item.kind, ...(typeof item.size === 'number' ? { size: item.size } : {}) } as WorkspaceFileEntry;
  });
  return { path, entries, ...(typeof raw.nextCursor === 'string' ? { nextCursor: raw.nextCursor } : {}), truncated: raw.truncated === true };
}

export function parseWorkspaceFileText(value: unknown, path: string): WorkspaceFileText {
  const raw = record(value);
  if (raw.path !== path || !workspaceRelativePath(path) || typeof raw.text !== 'string' || raw.text.length > WORKSPACE_FILE_BYTES
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.text)
      || typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > WORKSPACE_FILE_BYTES
      || typeof raw.modifiedAt !== 'number' || !Number.isSafeInteger(raw.modifiedAt) || raw.modifiedAt < 0
      || new TextEncoder().encode(raw.text).length !== raw.size
      || raw.revision !== undefined && (typeof raw.revision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.revision))) throw new HubError('文件内容响应无效');
  return { path, text: raw.text, size: raw.size, modifiedAt: raw.modifiedAt, ...(typeof raw.revision === 'string' ? { revision: raw.revision } : {}) };
}

type Selection = { deviceId: string; sessionKey: string; agentId: AgentId; surface: 'cli' | 'desktop'; expectedCwd?: string; expectedSessionKey?: string; expectedSurface?: 'cli' | 'desktop' };
export function captureWorkspaceFiles(selection: Selection, onInvalidated?: () => void): WorkspaceFileReader {
  const credentials = watchCredentials();
  const scope = remoteDeliveryScope();
  const controller = new AbortController();
  const { deviceId, sessionKey, agentId, surface } = selection;
  const owner: Hub | undefined = credentials?.pairToken ? { ...credentials, deviceId } : undefined;
  let disposed = false;
  let invalidated = false;
  let busy = false;
  const session = (): SessionInfo | undefined => {
    const state = getRemoteState(), directory = state.sessions[deviceId];
    return state.timelines[timelineKey(deviceId, sessionKey)]?.session
      ?? (surface === 'desktop' ? directory?.native?.list : directory?.list)?.find(item => item.sessionKey === sessionKey);
  };
  const cwd = selection.expectedCwd ?? session()?.cwd;
  const valid = () => {
    const state = getRemoteState(), now = watchCredentials(), info = session();
    const device = state.devices.find(item => item.deviceId === deviceId);
    if (disposed || invalidated || !owner || !cwd || scope !== remoteDeliveryScope() || now?.url !== owner.url || now?.pairToken !== owner.pairToken
        || selection.expectedSessionKey !== undefined && selection.expectedSessionKey !== sessionKey
        || selection.expectedSurface !== undefined && selection.expectedSurface !== surface
        || !device?.online || !device.capabilities?.includes('workspace.files.v1') || info?.sessionKey !== sessionKey || info.cwd !== cwd
        || info.controlSurface === 'read-only' || (info.controlSurface === 'desktop' ? 'desktop' : 'cli') !== surface) return false;
    if (surface === 'desktop') {
      const lease = state.agents[deviceId]?.list.find(item => item.id === agentId)?.desktopLive;
      return Boolean(lease && lease.expiresAt > Date.now() && lease.capabilities?.list && lease.capabilities.read && lease.sessionKeys.includes(sessionKey));
    }
    return true;
  };
  const guard = () => { if (!valid()) throw new HubError('文件授权或连接已变化，请重新打开侧边栏', 499, 'workspace_scope_changed'); };
  const writable = () => valid() && Boolean(getRemoteState().devices.find(item => item.deviceId === deviceId)?.capabilities?.includes('workspace.files.write.v1'));
  const manageable = () => valid() && Boolean(getRemoteState().devices.find(item => item.deviceId === deviceId)?.capabilities?.includes('workspace.files.manage.v1'));
  const unsubscribe = onRemoteChange(() => { if (!invalidated && !disposed && !valid()) { invalidated = true; controller.abort(); onInvalidated?.(); } });
  const perform = async <T>(type: 'workspace.files.list' | 'workspace.files.read', path: string, parse: (value: unknown, path: string) => T, cursor?: string): Promise<T> => {
    guard();
    if (!workspaceRelativePath(path, type === 'workspace.files.list') || busy) throw new HubError('请稍后重新读取文件');
    busy = true;
    try {
      const reply = await command<unknown>(owner!, deviceId, { type, sessionKey, controlSurface: surface, expectedCwd: cwd!, path, ...(cursor ? { cursor } : {}) }, undefined, controller.signal);
      guard();
      return parse(reply, path);
    } finally { busy = false; }
  };
  const mutate = async (action: 'create' | 'delete' | 'rename', path: string, payload: Record<string, string>): Promise<WorkspaceFileText | undefined> => {
    guard();
    if (!manageable()) throw new HubError('当前电脑尚未开放文件管理，请更新电脑端', 403, 'workspace_manage_unavailable');
    if (busy || !workspaceRelativePath(path) || action !== 'create' && !/^[a-f0-9]{64}$/.test(payload.expectedRevision)
      || action === 'rename' && (!workspaceRelativePath(payload.destination) || payload.destination.split('/').slice(0, -1).join('/') !== path.split('/').slice(0, -1).join('/'))
      || action === 'create' && (new TextEncoder().encode(payload.text).length > WORKSPACE_FILE_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(payload.text))) throw new HubError('文件操作参数无效或已有操作正在进行');
    busy = true;
    try {
      const reply = record(await command<unknown>(owner!, deviceId, { type: 'workspace.files.mutate', sessionKey, controlSurface: surface, expectedCwd: cwd!, action, path, ...payload } as Command, undefined, controller.signal));
      guard();
      if (reply.action !== action || reply.path !== path || action === 'rename' && reply.destination !== payload.destination) throw new HubError('文件操作结果无法确认，请刷新目录');
      if (action === 'delete') return;
      const result = parseWorkspaceFileText(reply.file, action === 'rename' ? payload.destination : path);
      if (!result.revision || action === 'create' && result.text !== payload.text) throw new HubError('文件操作结果无法确认，请刷新目录');
      return result;
    } finally { busy = false; }
  };
  return {
    cwd,
    list: (path = '', cursor) => perform('workspace.files.list', path, parseWorkspaceFilesPage, cursor),
    read: path => perform('workspace.files.read', path, parseWorkspaceFileText),
    get writable() { return writable(); },
    get manageable() { return manageable(); },
    create: async (path, text) => (await mutate('create', path, { text }))!,
    remove: async (path, expectedRevision) => { await mutate('delete', path, { expectedRevision }); },
    rename: async (path, destination, expectedRevision) => (await mutate('rename', path, { destination, expectedRevision }))!,
    write: async (path, text, expectedRevision) => {
      guard();
      if (!writable()) throw new HubError('当前电脑尚未开放文件保存', 403, 'workspace_write_unavailable');
      if (busy || !workspaceRelativePath(path) || !/^[a-f0-9]{64}$/.test(expectedRevision)
          || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || new TextEncoder().encode(text).length > WORKSPACE_FILE_BYTES) throw new HubError('文件内容无效或文件操作正在进行');
      busy = true;
      try {
        const reply = await command<unknown>(owner!, deviceId, { type: 'workspace.files.write', sessionKey, controlSurface: surface, expectedCwd: cwd!, path, text, expectedRevision }, undefined, controller.signal);
        guard();
        const saved = parseWorkspaceFileText(reply, path);
        if (!saved.revision || saved.text !== text) throw new HubError('保存结果无法确认，请重新读取后比较', 409, 'workspace_file_save_unconfirmed');
        return saved;
      } finally { busy = false; }
    },
    dispose: () => { if (!disposed) { disposed = true; controller.abort(); unsubscribe(); } },
  };
}
