import type { HubEvent, Project, SessionInfo, ToolId } from './client';
import { sessionKeyAgentId } from './projection';
import { applyEvent, mergeHistory, type Timeline } from './store';
import { parseBrowserNavigation } from './browser-navigation';
import { parseComputerActivity } from './computer-activity';
import { MAX_OUTPUT_ATTACHMENTS } from './attachment-ref';
import { executionRetryAt, validRetryAt } from './execution-retry';

const MAX_EVENTS = 800;
const MAX_SESSIONS = 20;
const MAX_PROJECTS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseDirectProjects(value: unknown): Project[] {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'projects' && key !== 'capabilities')
    || !Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS) throw new Error('电脑项目目录无效');
  const seen = new Set<string>();
  const projects: Project[] = [];
  for (const item of value.projects) {
    if (!isRecord(item) || Object.keys(item).some(key => key !== 'path' && key !== 'name')
      || typeof item.path !== 'string' || !item.path || item.path.length > 8192 || /[\p{Cc}\p{Cf}]/u.test(item.path)
      || typeof item.name !== 'string' || item.name.length > 1024 || /[\p{Cc}\p{Cf}]/u.test(item.name)
      || seen.has(item.path)) throw new Error('电脑项目目录包含无效或重复路径');
    seen.add(item.path);
    projects.push({ path: item.path, name: item.name });
  }
  return projects;
}

/** Only explicit host capabilities enable direct workspace controls. */
export function parseDirectWorkspaceCapabilities(value: unknown): string[] {
  if (!isRecord(value) || value.capabilities === undefined) return [];
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 128
    || value.capabilities.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(item))) throw new Error('电脑工作区能力无效');
  return [...new Set(value.capabilities as string[])].filter(item => item.startsWith('workspace.') || item === 'session.projectless.v1');
}

export function parseDirectStartReceipt(value: unknown, tool: ToolId): string {
  if (!isRecord(value) || Object.keys(value).length !== 1 || Object.keys(value)[0] !== 'sessionKey'
    || typeof value.sessionKey !== 'string' || value.sessionKey.length > 512) throw new Error('电脑返回的新会话身份无效');
  try {
    if (sessionKeyAgentId(value.sessionKey) !== tool) throw new Error('电脑返回的新会话归属与所选 Agent 不一致');
  } catch { throw new Error('电脑返回的新会话归属与所选 Agent 不一致'); }
  return value.sessionKey;
}

export function isDirectSession(value: unknown): value is SessionInfo {
  if (!isRecord(value) || typeof value.sessionKey !== 'string' || value.sessionKey.length > 512
    || typeof value.tool !== 'string' || typeof value.client !== 'string' || value.client.length > 200
    || typeof value.title !== 'string' || value.title.length > 4096 || typeof value.cwd !== 'string' || value.cwd.length > 8192
    || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0
    || !['running', 'idle', 'waiting_approval', 'failed', 'unknown'].includes(String(value.status))
    || typeof value.controllable !== 'boolean'
    || value.projectless !== undefined && value.projectless !== true
    || value.controlSurface !== undefined && value.controlSurface !== 'cli'
    || value.workspaceMode !== undefined && value.workspaceMode !== 'code' && value.workspaceMode !== 'work') return false;
  try { return sessionKeyAgentId(value.sessionKey) === value.tool; } catch { return false; }
}

const eventCommon = new Set(['type', 'seq', 'turnId', 'deviceId', 'sessionKey', 'tool', 'ts', 'parentId', 'childSessionKeys']);

// Bridge's JSON omits empty text and false final flags. Keep that wire shape
// distinct from the normalized events consumed by the shared reducer.
type DirectWireEvent = Exclude<HubEvent, {type:'message'|'reasoning'}>
  | (Omit<Extract<HubEvent, {type:'message'}>, 'text'|'final'> & {text?:string;final?:boolean})
  | (Omit<Extract<HubEvent, {type:'reasoning'}>, 'text'|'final'> & {text?:string;final?:boolean});

export function isDirectEvent(value: unknown, deviceId: string, sessionKey: string): value is DirectWireEvent {
  if (!isRecord(value) || value.deviceId !== deviceId || value.sessionKey !== sessionKey || typeof value.tool !== 'string'
    || !Number.isSafeInteger(value.ts) || (value.ts as number) < 0
    || value.seq !== undefined && (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0)
    || value.turnId !== undefined && (typeof value.turnId !== 'string' || value.turnId.length > 256)
    || value.parentId !== undefined && (typeof value.parentId !== 'string' || value.parentId.length > 512)) return false;
  try { if (sessionKeyAgentId(sessionKey) !== value.tool) return false; } catch { return false; }
  const fields = (...keys: string[]) => Object.keys(value).every(key => eventCommon.has(key) || keys.includes(key));
  const streamText = () => (value.text === undefined || typeof value.text === 'string' && value.text.length <= 200_000)
    && (value.final === undefined || typeof value.final === 'boolean');
  switch (value.type) {
    case 'session.reverted': return fields('id','operationId') && !value.parentId && typeof value.id==='string' && Boolean(value.id) && typeof value.operationId==='string' && Boolean(value.operationId) && typeof value.turnId==='string' && Boolean(value.turnId);
    case 'context.updated': return fields('context');
    case 'workflows.changed': return fields();
    case 'session.updated': return fields('session') && isDirectSession(value.session) && value.session.sessionKey === sessionKey;
    case 'message': return fields('id', 'role', 'text', 'final', 'attachments', 'clientId', 'messagePhase', 'messageOrigin', 'skills', 'contextReferences')
      && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 512
      && (value.role === 'user' || value.role === 'assistant') && streamText()
      && (value.attachments === undefined || Array.isArray(value.attachments) && value.attachments.length <= MAX_OUTPUT_ATTACHMENTS);
    case 'reasoning': return fields('id', 'text', 'final') && typeof value.id === 'string' && value.id.length <= 512 && streamText();
    case 'tool': return fields('id', 'kind', 'title', 'detail', 'status', 'output', 'outputFinal', 'planKind', 'diff', 'exitCode', 'durationMs', 'attachments', 'browser', 'computer')
      && typeof value.id === 'string' && value.id.length <= 512 && typeof value.title === 'string' && value.title.length <= 4096
      && ['command', 'file_change', 'read', 'image_view', 'image_generation', 'search', 'web', 'mcp', 'plan', 'subagent', 'skill', 'other'].includes(String(value.kind))
      && ['running', 'done', 'failed', 'interrupted'].includes(String(value.status))
      && (value.browser === undefined || Boolean(parseBrowserNavigation(value.browser)))
      && (value.computer === undefined || Boolean(parseComputerActivity(value.computer)));
    case 'approval.request': return fields('approvalId', 'kind', 'title', 'detail', 'diff', 'cwd', 'questions', 'questionMode', 'expiresAt', 'approvalTransport', 'approvalOptions')
      && typeof value.approvalId === 'string' && value.approvalId.length > 0 && value.approvalId.length <= 512
      && ['command', 'file_change', 'tool', 'permission', 'question'].includes(String(value.kind)) && typeof value.title === 'string' && value.title.length <= 4096;
    case 'approval.resolved': return fields('approvalId', 'decision', 'by') && typeof value.approvalId === 'string'
      && ['allow', 'allow_session', 'deny'].includes(String(value.decision)) && ['phone', 'desktop', 'timeout'].includes(String(value.by));
    case 'turn': return fields('id', 'status', 'error', 'errorCode', 'retryAt', 'usage', 'durationMs') && ['started', 'completed', 'failed', 'interrupted'].includes(String(value.status))
      && (value.id === undefined || typeof value.id === 'string' && value.id.length <= 512)
      && (value.retryAt === undefined || validRetryAt(value.retryAt));
    case 'notice': return fields('id', 'level', 'text', 'errorCode', 'retryAt', 'retrying', 'noticeKind', 'progress')
      && (value.retryAt === undefined || validRetryAt(value.retryAt))
      && ['info', 'warn', 'error'].includes(String(value.level)) && typeof value.text === 'string' && value.text.length <= 20_000;
    default: return false;
  }
}

export interface DirectHistoryPage {
  session: SessionInfo;
  events: HubEvent[];
  nextCursor?: string;
}

export function normalizeDirectEvent(value: DirectWireEvent, deviceId: string): HubEvent {
  if (value.type === 'message' || value.type === 'reasoning') return {...value, deviceId, text:value.text ?? '', final:value.final ?? false};
  if (value.type === 'turn' || value.type === 'notice') {
    const { retryAt, ...event } = value;
    const at = executionRetryAt(value.errorCode, retryAt);
    return { ...event, deviceId, ...(at === undefined ? {} : { retryAt: at }) };
  }
  return { ...value, deviceId };
}

export interface DirectSessionPage {
  sessions: SessionInfo[];
  nextCursor?: string;
}

/** Validate a direct-only session directory page without silently losing pagination. */
export function parseDirectSessionPage(raw: unknown, tool: string, cursor?: string): DirectSessionPage {
  if (!isRecord(raw) || !Array.isArray(raw.sessions) || raw.sessions.length > MAX_SESSIONS) {
    throw new Error('电脑返回的会话目录无效');
  }
  let nextCursor: string | undefined;
  if (raw.nextCursor !== undefined && raw.nextCursor !== null && raw.nextCursor !== '') {
    if (typeof raw.nextCursor !== 'string' || raw.nextCursor.length > 4096) throw new Error('电脑返回的会话读取位置无效');
    nextCursor = raw.nextCursor;
    if (cursor && nextCursor === cursor) throw new Error('电脑没有推进会话读取位置，请刷新');
  }
  return {
    sessions: raw.sessions.filter((value): value is SessionInfo => isDirectSession(value) && value.tool === tool),
    nextCursor,
  };
}

/** Validate a direct-only history response and its opaque paging cursor. */
export function parseDirectHistoryPage(
  raw: unknown,
  deviceId: string,
  expected: Pick<SessionInfo, 'sessionKey' | 'tool'>,
  cursor?: string,
): DirectHistoryPage {
  if (!isRecord(raw) || !isDirectSession(raw.session) || raw.session.sessionKey !== expected.sessionKey
    || raw.session.tool !== expected.tool || !Array.isArray(raw.events) || raw.events.length > MAX_EVENTS) {
    throw new Error('电脑返回的会话快照与当前会话不匹配');
  }
  let nextCursor: string | undefined;
  if (raw.nextCursor !== undefined && raw.nextCursor !== null && raw.nextCursor !== '') {
    if (typeof raw.nextCursor !== 'string' || raw.nextCursor.length > 4096) throw new Error('电脑返回的读取位置无效');
    nextCursor = raw.nextCursor;
    if (cursor && nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
  }
  return {
    session: raw.session,
    events: raw.events.filter((value): value is DirectWireEvent => isDirectEvent(value, deviceId, expected.sessionKey))
      .map(value => normalizeDirectEvent(value, deviceId)),
    nextCursor,
  };
}

/** Merge the fetched page first, then replay realtime events buffered during that read. */
export function mergeDirectHistoryPage(current: Timeline, page: DirectHistoryPage, queuedEvents: HubEvent[]): Timeline & { historyInvalidated?: true } {
  if (queuedEvents.some(event => event.type === 'session.reverted' && !current.revertOperations?.includes(event.operationId))) {
    // A partial page can contain only untagged output. It is unsafe to guess
    // its turn after a concurrent revert; preserve live events and re-read.
    return { ...queuedEvents.reduce(applyEvent, current), historyInvalidated: true };
  }
  let merged = mergeHistory(current, page.session, page.events);
  for (const event of queuedEvents) merged = applyEvent(merged, event);
  return merged;
}

/** A reversion invalidates the cursor too. One fresh-head retry is enough;
 * repeated changes keep the retained timeline and ask for an explicit refresh. */
export async function readDirectHistoryWithRevertGuard(initial: Timeline, read: (freshHead: boolean) => Promise<DirectHistoryPage>,
  takeEvents: () => HubEvent[], isCurrent: () => boolean, onRetained: (timeline: Timeline) => void = () => undefined): Promise<{ timeline: Timeline; nextCursor?: string; reread: boolean; invalidated: boolean } | undefined> {
  let retained = initial;
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await read(attempt > 0);
    if (!isCurrent()) return;
    const { historyInvalidated, ...timeline } = mergeDirectHistoryPage(retained, page, takeEvents());
    if (!historyInvalidated) return { timeline, nextCursor: page.nextCursor, reread: attempt > 0, invalidated: false };
    retained = timeline;
    onRetained(retained);
  }
  return { timeline: { ...retained, error: '会话在读取期间再次回退，请刷新记录' }, reread: true, invalidated: true };
}

