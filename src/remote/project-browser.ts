import { command, type Command, type Hub, type Project, type WorkspaceMode } from './client';
import { getRemoteState, remoteDeliveryScope, watchCredentials } from './store';
import { requestDirect } from './direct-api';
import { directConnectionGeneration, directDeliveryScope, getDirectConnectionState } from './direct-pairing';
import { parseWorkspaceFilesPage, type WorkspaceFilesPage } from './workspace-files';

export type ProjectCommand = Extract<Command, { type: 'workspace.projects' }>;
export type ProjectRequest = (input: Omit<ProjectCommand, 'type' | 'tool' | 'workspaceMode' | 'controlSurface'>) => Promise<unknown>;
export interface ProjectBrowserResult { roots?: Project[]; directory?: Omit<WorkspaceFilesPage, 'entries'> & { entries: Array<WorkspaceFilesPage['entries'][number] & { blockedReason?: string }> }; project?: Project }
const pathText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f]/.test(value);
const project = (value: unknown): Project => {
  const p = value as Project;
  if (!p || !pathText(p.path) || typeof p.name !== 'string' || p.name.length > 512) throw new Error('电脑返回的项目目录无效');
  return { path: p.path, name: p.name };
};
export function parseProjectBrowserResult(value: unknown, request: { cwd: string; path: string; action: string; name?: string }, tool: string, mode: WorkspaceMode, explorer = false): ProjectBrowserResult {
  const raw = value as Record<string, unknown>;
  if (!raw || raw.tool !== tool || raw.workspaceMode !== mode || raw.cwd !== request.cwd || raw.path !== request.path) throw new Error('电脑或项目目录已变化，请重新读取');
  if (request.action !== 'list') {
    const selected = project(raw.project);
    const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([A-Z]):/, (_, drive: string) => drive.toLowerCase() + ':');
    const suffix = [request.path, request.action === 'mkdir' ? request.name : ''].filter(Boolean).join('/');
    const expected = normalize(request.cwd) + (suffix ? '/' + suffix : '');
    if (normalize(selected.path) !== expected) throw new Error('电脑返回了另一个项目，未创建会话');
    return { project: selected };
  }
  if (request.cwd) return { directory: explorer ? parseExplorerPage(raw.directory, request.path) : parseWorkspaceFilesPage(raw.directory, request.path) };
  if (!Array.isArray(raw.roots) || raw.roots.length > 128) throw new Error('电脑返回的授权目录无效');
  return { roots: raw.roots.map(project) };
}

// Browsing computer directories includes normal hidden/system names. This is
// deliberately separate from the narrower session-file content policy.
export function explorerRelativePath(value: unknown, root = false): value is string {
  if (typeof value !== 'string' || value.length > 4096 || /[\\:*?"<>|\p{Cc}\p{Cf}]/u.test(value)) return false;
  return value === '' ? root : value.split('/').every(part => part.length > 0 && part.length <= 255 && part !== '.' && part !== '..' && part.trim() === part && !part.endsWith('.'));
}
function parseExplorerPage(value: unknown, path: string): NonNullable<ProjectBrowserResult['directory']> {
  const raw = value as Record<string, unknown>;
  if (!raw || raw.path !== path || !explorerRelativePath(path, true) || !Array.isArray(raw.entries) || raw.entries.length > 50
    || raw.nextCursor !== undefined && (typeof raw.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw.nextCursor))
    || raw.truncated !== undefined && typeof raw.truncated !== 'boolean') throw new Error('电脑返回的文件夹列表无效');
  const names = new Set<string>();
  const entries = raw.entries.map((value: unknown) => {
    const item = value as Record<string, unknown>;
    if (!item || !explorerRelativePath(item.name) || item.name.includes('/') || names.has(item.name) || item.kind !== 'directory'
      || item.path !== (path ? path + '/' : '') + item.name || !explorerRelativePath(item.path)
      || item.blockedReason !== undefined && (typeof item.blockedReason !== 'string' || item.blockedReason.length > 512)) throw new Error('电脑返回的文件夹列表无效');
    names.add(item.name);
    return { name: item.name, path: item.path, kind: 'directory' as const, ...(typeof item.blockedReason === 'string' ? { blockedReason: item.blockedReason } : {}) };
  });
  return { path, entries, ...(typeof raw.nextCursor === 'string' ? { nextCursor: raw.nextCursor } : {}), truncated: raw.truncated === true };
}

/** Capture credentials and the exact computer once; a later switch cannot
 * retarget a directory mutation or deliver its result into the new editor. */
export function projectBrowserRequest(transport: 'remote' | 'direct', deviceId: string, tool: string, mode: WorkspaceMode, explorer = false): ProjectRequest {
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
    if (explorer && input.action === 'select') throw new Error('请先为新文件夹命名');
    const cmd: Command = explorer
      ? { type: 'workspace.explorer', controlSurface: 'cli', tool, workspaceMode: mode, ...input, action: input.action as 'list' | 'mkdir' }
      : { type: 'workspace.projects', controlSurface: 'cli', tool, workspaceMode: mode, ...input };
    const result = transport === 'direct' ? await requestDirect(cmd) : await command(credentials!, deviceId, cmd);
    if (!valid()) throw new Error('电脑连接已变化，请重新打开项目目录');
    return result;
  };
}
