import type { SessionInfo } from './client';
import { sessionKeyAgentId } from './projection';

export type SessionAction = 'rename' | 'archive' | 'unarchive' | 'fork';
export interface NativeSessionActions {
  sessionKey: string; revision: string; title: string; archived: boolean; actions: SessionAction[]; unavailableReason?: string;
}
export interface NativeSessionActionResult {
  sessionKey: string; operationId: string; action: SessionAction; state: 'completed' | 'unconfirmed'; session?: SessionInfo; error?: string;
}
export interface NativeSessionActionsReading { value: NativeSessionActions; scope: string }
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);
const revision = (value: unknown): value is string => text(value, 256) && Boolean(value) && !/\s/u.test(value);
const actions: SessionAction[] = ['rename', 'archive', 'unarchive', 'fork'];
export function validSessionName(value: string): boolean { return text(value, 320) && value.trim() === value && Boolean(value) && [...value].length <= 80; }
export function parseNativeSessionActions(value: unknown, sessionKey: string): NativeSessionActions | undefined {
  const raw = record(value);
  if (!raw || raw.sessionKey !== sessionKey || !sessionKeyAgentId(sessionKey) || !text(raw.title, 4096) || !text(raw.revision, 256)
    || typeof raw.archived !== 'boolean' || !Array.isArray(raw.actions) || raw.actions.length > 4 || new Set(raw.actions).size !== raw.actions.length
    || raw.actions.some(action => !actions.includes(action as SessionAction) || raw.archived && action === 'archive' || !raw.archived && action === 'unarchive')
    || raw.actions.length > 0 && !revision(raw.revision) || raw.unavailableReason !== undefined && !text(raw.unavailableReason, 4096)) return;
  return { sessionKey, title: raw.title, revision: raw.revision, archived: raw.archived, actions: raw.actions as SessionAction[],
    ...(raw.unavailableReason ? { unavailableReason: raw.unavailableReason as string } : {}) };
}
export function parseManagedSession(value: unknown, tool: string): SessionInfo | undefined {
  const raw = record(value);
  if (!raw || sessionKeyAgentId(raw.sessionKey) !== tool || raw.tool !== tool || !text(raw.client, 256) || !text(raw.title, 4096) || !text(raw.cwd, 4096)
    || typeof raw.updatedAt !== 'number' || !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt < 0 || typeof raw.controllable !== 'boolean'
    || !['idle', 'running', 'waiting_approval', 'failed', 'unknown'].includes(raw.status as string)
    || raw.controlSurface !== undefined && raw.controlSurface !== 'cli' || raw.archived !== undefined && typeof raw.archived !== 'boolean') return;
  return { sessionKey: raw.sessionKey as string, tool, client: raw.client, title: raw.title, cwd: raw.cwd,
    updatedAt: raw.updatedAt, status: raw.status as SessionInfo['status'], controllable: raw.controllable, controlSurface: 'cli',
    archived: raw.archived === true, ...(text(raw.model, 256) ? { model: raw.model } : {}),
    ...(sessionKeyAgentId(raw.forkedFromSessionKey) === tool ? { forkedFromSessionKey: raw.forkedFromSessionKey as string } : {}) };
}
export function parseNativeSessionActionResult(value: unknown, sessionKey: string, action: SessionAction, operationId: string): NativeSessionActionResult | undefined {
  const raw = record(value), tool = sessionKeyAgentId(sessionKey);
  if (!raw || !tool || raw.sessionKey !== sessionKey || raw.action !== action || raw.operationId !== operationId
    || raw.state !== 'completed' && raw.state !== 'unconfirmed' || raw.error !== undefined && !text(raw.error, 4096)) return;
  const session = raw.session === undefined || raw.session === null ? undefined : parseManagedSession(raw.session, tool);
  if (raw.session != null && !session || session && (action === 'fork' ? session.sessionKey === sessionKey : session.sessionKey !== sessionKey)
    || raw.state === 'completed' && action === 'fork' && !session
    || raw.state === 'completed' && session && (action === 'archive' && !session.archived || action === 'unarchive' && session.archived)) return;
  return { sessionKey, action, operationId, state: raw.state, ...(session ? { session } : {}), ...(raw.error ? { error: raw.error as string } : {}) };
}
