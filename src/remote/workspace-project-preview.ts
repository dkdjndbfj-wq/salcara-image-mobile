import { command, HubError, type Command } from './client';
import { getRemoteState, onRemoteChange, remoteDeliveryScope, timelineKey, watchCredentials } from './store';
import { workspaceRelativePath } from './workspace-files';
import { isComputerLoopbackURL } from './workspace-preview';
import type { TerminalSelection } from './workspace-terminal';

export interface ProjectPreviewScript { name: string; command: string; framework: 'vite' | 'next' | null; supported: boolean }
export interface ProjectPreviewRun {
  runId: string; operationId: string; projectPath: string; script: string;
  status: 'starting' | 'running' | 'exited' | 'failed' | 'stopped'; url?: string;
  logs: string; cursor: number; truncated: boolean; exitCode?: number; error?: string;
}
export interface ProjectPreviewInspection {
  projectPath: string; manifestRevision: string; packageName: string; scripts: ProjectPreviewScript[];
  dependenciesInstalled: boolean; ready: boolean; reason?: string; run?: ProjectPreviewRun;
}
export interface ProjectPreviewStart { projectPath: string; script: string; manifestRevision: string; operationId: string }
export interface ProjectPreviewLookup { projectPath: string; runId?: string; operationId?: string; cursor?: number }
export interface ProjectPreviewResult { found: boolean; run?: ProjectPreviewRun }
export interface WorkspaceProjectPreview {
  inspect(sourcePath: string): Promise<ProjectPreviewInspection>;
  start(input: ProjectPreviewStart): Promise<ProjectPreviewResult>;
  status(input: ProjectPreviewLookup): Promise<ProjectPreviewResult>;
  stop(input: Omit<ProjectPreviewLookup, 'cursor'>): Promise<ProjectPreviewResult>;
  dispose(): void;
}
const fail = () => new HubError('电脑返回的项目运行状态无效');
const object = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail();
  return raw as Record<string, unknown>;
};
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const projectPreviewPath = (value: unknown): value is string => typeof value === 'string' && workspaceRelativePath(value, true);

export function parseProjectPreviewRun(raw: unknown, expected?: ProjectPreviewLookup): ProjectPreviewRun {
  const run = object(raw);
  if (!id(run.runId) || !id(run.operationId) || !projectPreviewPath(run.projectPath) || !text(run.script, 128) || !run.script
    || !['starting', 'running', 'exited', 'failed', 'stopped'].includes(String(run.status))
    || typeof run.logs !== 'string' || run.logs.length > 262144 || !Number.isSafeInteger(run.cursor) || Number(run.cursor) < 0
    || typeof run.truncated !== 'boolean' || run.exitCode !== undefined && !Number.isSafeInteger(run.exitCode)
    || run.error !== undefined && !text(run.error, 8192)
    || run.url !== undefined && (!text(run.url) || !isComputerLoopbackURL(run.url))
    || run.status === 'running' && !run.url
    || expected && (run.projectPath !== expected.projectPath || expected.runId && run.runId !== expected.runId || expected.operationId && run.operationId !== expected.operationId)
    || expected?.cursor !== undefined && Number(run.cursor) < expected.cursor) throw fail();
  return run as unknown as ProjectPreviewRun;
}
export function parseProjectPreviewInspection(raw: unknown): ProjectPreviewInspection {
  const value = object(raw);
  if (!projectPreviewPath(value.projectPath) || !revision(value.manifestRevision) || !text(value.packageName, 512)
    || !Array.isArray(value.scripts) || value.scripts.length > 128 || typeof value.dependenciesInstalled !== 'boolean'
    || typeof value.ready !== 'boolean' || value.reason !== undefined && !text(value.reason, 8192)) throw fail();
  const names = new Set<string>();
  for (const rawScript of value.scripts) {
    const script = object(rawScript);
    if (!text(script.name, 128) || !script.name || names.has(script.name) || !text(script.command, 8192)
      || ![null, 'vite', 'next'].includes(script.framework as null | 'vite' | 'next') || typeof script.supported !== 'boolean') throw fail();
    names.add(script.name);
  }
  if (value.run !== undefined) parseProjectPreviewRun(value.run, { projectPath: value.projectPath });
  return value as unknown as ProjectPreviewInspection;
}
export function parseProjectPreviewResult(raw: unknown, expected: ProjectPreviewLookup): ProjectPreviewResult {
  const value = object(raw);
  if (typeof value.found !== 'boolean' || value.found !== (value.run !== undefined)) throw fail();
  return value.found ? { found: true, run: parseProjectPreviewRun(value.run, expected) } : { found: false };
}
/** Transport independent. Mutations are never automatically replayed. */
export function createWorkspaceProjectPreview(send: (payload: Record<string, unknown>) => Promise<unknown>, guard: () => void, dispose: () => void): WorkspaceProjectPreview {
  let busy = false;
  const request = async <T,>(payload: Record<string, unknown>, parse: (value: unknown) => T): Promise<T> => {
    guard(); if (busy) throw new HubError('项目状态正在更新，请稍后重试');
    busy = true;
    try { const raw = await send(payload); guard(); return parse(raw); } finally { busy = false; }
  };
  const lookup = (input: ProjectPreviewLookup) => {
    if (!projectPreviewPath(input.projectPath) || !input.runId && !input.operationId
      || input.runId !== undefined && !id(input.runId) || input.operationId !== undefined && !id(input.operationId)
      || input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < 0)) throw fail();
  };
  return {
    inspect: sourcePath => {
      if (!projectPreviewPath(sourcePath)) return Promise.reject(new HubError('请选择项目内的源文件'));
      return request({ action: 'inspect', sourcePath }, parseProjectPreviewInspection);
    },
    start: input => {
      if (!projectPreviewPath(input.projectPath) || !id(input.operationId) || !text(input.script, 128) || !input.script || !revision(input.manifestRevision)) return Promise.reject(fail());
      return request({ action: 'start', ...input }, raw => parseProjectPreviewResult(raw, input));
    },
    status: input => { lookup(input); return request({ action: 'status', ...input }, raw => parseProjectPreviewResult(raw, input)); },
    stop: input => { lookup(input); return request({ action: 'stop', ...input }, raw => parseProjectPreviewResult(raw, input)); },
    dispose,
  };
}

export function captureWorkspaceProjectPreview(selection: TerminalSelection, onInvalidated?: () => void): WorkspaceProjectPreview {
  const credentials = watchCredentials(), scope = remoteDeliveryScope(), controller = new AbortController();
  const owner = credentials?.pairToken ? { ...credentials, deviceId: selection.deviceId } : undefined;
  const profile = () => getRemoteState().agents[selection.deviceId]?.list.find(item => item.id === selection.agentId);
  const identity = JSON.stringify([profile()?.api, profile()?.execution]);
  let disposed = false, invalidated = false;
  const valid = () => {
    const state = getRemoteState(), now = watchCredentials(), directory = state.sessions[selection.deviceId];
    const session = state.timelines[timelineKey(selection.deviceId, selection.sessionKey)]?.session
      ?? (selection.surface === 'desktop' ? directory?.native?.list : directory?.list)?.find(item => item.sessionKey === selection.sessionKey);
    const device = state.devices.find(item => item.deviceId === selection.deviceId), agent = profile();
    if (disposed || invalidated || !owner || scope !== remoteDeliveryScope() || now?.url !== owner.url || now?.pairToken !== owner.pairToken
      || !device?.online || !device.capabilities?.includes('workspace.project.preview.v1') || !device.projects.some(project => project.path === selection.cwd)
      || !agent || agent.execution === null || JSON.stringify([agent.api, agent.execution]) !== identity || session?.cwd !== selection.cwd
      || session.tool !== (agent.execution?.tool ?? agent.tool) || session.controlSurface === 'read-only'
      || (session.controlSurface === 'desktop' ? 'desktop' : 'cli') !== selection.surface) return false;
    if (selection.surface === 'desktop') { const lease = agent.desktopLive; return Boolean(lease && lease.expiresAt > Date.now() && lease.capabilities?.read && lease.sessionKeys.includes(selection.sessionKey)); }
    return true;
  };
  const guard = () => { if (!valid()) throw new HubError('电脑、Agent 或项目授权已变化，请重新连接项目预览', 499, 'workspace_scope_changed'); };
  const unsubscribe = onRemoteChange(() => { if (!disposed && !invalidated && !valid()) { invalidated = true; controller.abort(); onInvalidated?.(); } });
  return createWorkspaceProjectPreview(async payload => {
    guard(); const raw = await command(owner!, selection.deviceId, { type: 'workspace.project.preview', sessionKey: selection.sessionKey,
      controlSurface: selection.surface, expectedCwd: selection.cwd, ...payload } as Command, undefined, controller.signal); guard(); return raw;
  }, guard, () => { disposed = true; controller.abort(); unsubscribe(); });
}
