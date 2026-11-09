import { command, type Command, type Hub, type Project, type WorkspaceMode } from './client';
import { getRemoteState, remoteDeliveryScope, watchCredentials } from './store';
import { requestDirect } from './direct-api';
import { directConnectionGeneration, directDeliveryScope, getDirectConnectionState } from './direct-pairing';
import { parseWorkspaceFilesPage, type WorkspaceFilesPage } from './workspace-files';

export type ProjectCommand = Extract<Command, { type: 'workspace.projects' }>;
export type ProjectRequest = (input: Omit<ProjectCommand, 'type' | 'tool' | 'workspaceMode' | 'controlSurface'>) => Promise<unknown>;
export interface ProjectBrowserResult { roots?: Project[]; directory?: WorkspaceFilesPage; project?: Project }
const pathText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
const project = (value: unknown): Project => {
  const p = value as Project;
  if (!p || !pathText(p.path) || typeof p.name !== 'string' || p.name.length > 512) throw new Error('电脑返回的项目目录无效');
  return { path: p.path, name: p.name };
};
export function parseProjectBrowserResult(value: unknown, request: { cwd: string; path: string; action: string; name?: string }, tool: string, mode: WorkspaceMode): ProjectBrowserResult {
  const raw = value as Record<string, unknown>;
  if (!raw || raw.tool !== tool || raw.workspaceMode !== mode || raw.cwd !== request.cwd || raw.path !== request.path) throw new Error('电脑或项目目录已变化，请重新读取');
  if (request.action !== 'list') {
    const selected = project(raw.project);
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([A-Z]):/, (_, drive: string) => drive.toLowerCase() + ':');
    const expected = [normalize(request.cwd), request.path, request.action === 'mkdir' ? request.name : ''].filter(Boolean).join('/');
    if (normalize(selected.path) !== expected) throw new Error('电脑返回了另一个项目，未创建会话');
    return { project: selected };
  }
  if (request.cwd) return { directory: parseWorkspaceFilesPage(raw.directory, request.path) };
  if (!Array.isArray(raw.roots) || raw.roots.length > 128) throw new Error('电脑返回的授权目录无效');
  return { roots: raw.roots.map(project) };
}

/** Capture credentials and the exact computer once; a later switch cannot
 * retarget a directory mutation or deliver its result into the new editor. */
export function projectBrowserRequest(transport: 'remote' | 'direct', deviceId: string, tool: string, mode: WorkspaceMode): ProjectRequest {
  let initialized = false, credentials: Hub | null | undefined, scope = '', directScope = '', generation: number;
  const valid = () => transport === 'direct'
    ? directDeliveryScope() === directScope && directConnectionGeneration() === generation && getDirectConnectionState().deviceId === deviceId && getDirectConnectionState().status === 'connected'
    : credentials?.pairToken && remoteDeliveryScope() === scope && watchCredentials()?.pairToken === credentials.pairToken
      && watchCredentials()?.url === credentials.url && getRemoteState().devices.some(device => device.deviceId === deviceId && device.online);
  return async input => {
    if (!initialized) {
      if (transport === 'remote') { const current = watchCredentials(); credentials = current ? { ...current } : current; scope = remoteDeliveryScope(); }
      else { directScope = directDeliveryScope(); generation = directConnectionGeneration(); }
      initialized = true;
    }
    if (!valid()) throw new Error('电脑连接已变化，请重新打开项目目录');
    const cmd: ProjectCommand = { type: 'workspace.projects', controlSurface: 'cli', tool, workspaceMode: mode, ...input };
    const result = transport === 'direct' ? await requestDirect(cmd) : await command(credentials!, deviceId, cmd);
    if (!valid()) throw new Error('电脑连接已变化，请重新打开项目目录');
    return result;
  };
}
