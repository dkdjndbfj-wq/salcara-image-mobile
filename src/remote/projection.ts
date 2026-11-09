import type { AgentCapabilities, AgentExecution, AgentId, AgentProfile, ApiSource, DeviceStatus, RemoteApiOption, SessionInfo, ToolId, WorkspaceMode } from './client';
import { isApprovalMode, isPermissionMode } from './permission-mode';
import { isEffort, CODEX_EFFORTS } from './effort';
import { parseRemoteApiMetadata } from './api-eligibility';
import { AGENT_CHOICES } from './agent-catalog';
export { AGENT_CHOICES } from './agent-catalog';

/**
 * The legacy adapters have explicit compatibility rules. "Codex" lists every Codex thread on the computer —
 * the Codex app, CLI and IDE share one thread store, so this is the same list as
 * the Codex sidebar. "Claude Code" lists Claude Code sessions. "Claude Desktop"
 * separates native read-only Chat/Cowork from the Code worker. None of these
 * sources is silently substituted for another.
 */
export function isDesktopClient(client?: string): boolean { return /Claude Desktop/i.test(client ?? ''); }

// These are labels, not provider URLs or opaque credentials.
const label = (value: unknown) => typeof value === 'string' && value.length <= 200
  && !/[\r\n\x00]/.test(value) && !/(?:https?:\/\/|sk-|bearer\s|[\\]|[a-f0-9]{32,})/i.test(value) ? value : '';
const handle = (value: unknown) => typeof value === 'string' && /^api_[a-f0-9]{8,64}$/.test(value) ? value : undefined;
const stationUrl = (value: unknown) => typeof value === 'string' && value.length <= 512 && !/[\\\s?#\u0000-\u001f]/.test(value)
  && /^https?:\/\/[^/]+(?:\/[^/]*)*\/?$/i.test(value) ? value : undefined;
const stationDevice = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;
const apiFamily = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : undefined;

const CAPABILITY_KEYS = ['list', 'read', 'send', 'interrupt', 'approval', 'questions', 'subagents', 'attachments', 'imageInput', 'imageOutput', 'modelOverride', 'startModelOverride', 'preciseInterrupt', 'continue', 'steer', 'latestTurnRevert', 'context', 'compact', 'sessionActions', 'archivedSessions', 'sessionWorkflows', 'sideQuestion'] as const;
export const validAgentId = (value: unknown): value is AgentId => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) && value !== 'codex-desktop';
/** Real thread identities share the adapter namespace; local outbox identities
 * cannot be used as a thread even if a malformed reply returns one. */
export function sessionKeyAgentId(value: unknown): AgentId | undefined {
  if (typeof value !== 'string' || value.length > 512 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  const separator = value.indexOf(':');
  const id = value.slice(0, separator), thread = value.slice(separator + 1);
  if (separator < 1 || !validAgentId(id) || !thread || thread === '__salcara_start_v1__' || thread.startsWith('__salcara_start_v1__:')) return undefined;
  return id;
}
export const builtinAgent = (id: string): boolean => id === 'codex' || id === 'claude' || id === 'claude-desktop';

/**
 * Keep the Code/Work split stable across Bridge generations. New Bridges send
 * an explicit mode; old history has no such field, so a directory-backed
 * session remains Code and a directory-less/native work item is Work.
 */
export function sessionWorkspaceMode(session: Pick<SessionInfo, 'workspaceMode' | 'cwd' | 'sessionScope'>): WorkspaceMode {
  if (session.sessionScope === 'desktop-chat' || session.sessionScope === 'desktop-cowork') return 'work';
  if (session.workspaceMode === 'code' || session.workspaceMode === 'work') return session.workspaceMode;
  return session.cwd ? 'code' : 'work';
}
const legacyExecutions: Readonly<Record<string, AgentExecution>> = {
  codex: { tool: 'codex', controlSurface: 'cli' },
  claude: { tool: 'claude', controlSurface: 'cli' },
  'claude-desktop': { tool: 'claude', controlSurface: 'cli', entrypoint: 'claude-desktop' },
};
function parsedExecution(value: unknown, expected: AgentExecution): AgentExecution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['tool', 'controlSurface', 'entrypoint'].includes(key))
    || raw.tool !== expected.tool || raw.controlSurface !== expected.controlSurface
    || raw.entrypoint !== expected.entrypoint) return null;
  return { ...expected };
}
/** Omitted old metadata has a compatibility contract only for shipped built-ins.
 * Explicit invalid metadata and extension namespace mismatches never pick a CLI. */
export function resolveAgentExecution(profile: Pick<AgentProfile, 'id' | 'tool' | 'execution'> | undefined, legacyId?: AgentId): AgentExecution | null {
  if (!profile) return legacyId && builtinAgent(legacyId) ? { ...legacyExecutions[legacyId] } : null;
  const expected = Object.prototype.hasOwnProperty.call(legacyExecutions, profile.id)
    ? legacyExecutions[profile.id] : { tool: profile.id, controlSurface: 'cli' as const };
  if (profile.tool !== expected.tool) return null;
  if (profile.execution !== undefined) return parsedExecution(profile.execution, expected);
  return builtinAgent(profile.id) ? { ...expected } : null;
}
function executionFromStatus(item: Record<string, unknown> | undefined, id: AgentId, tool: ToolId): AgentExecution | null {
  const expected = Object.prototype.hasOwnProperty.call(legacyExecutions, id)
    ? legacyExecutions[id] : { tool, controlSurface: 'cli' as const };
  // Missing tool was accepted by older built-ins, but an explicit contradiction
  // is never erased by the presentation card's fixed label.
  if (item && Object.prototype.hasOwnProperty.call(item, 'tool') && item.tool !== expected.tool) return null;
  if (item && Object.prototype.hasOwnProperty.call(item, 'execution')) return parsedExecution(item.execution, expected);
  return { ...expected };
}
/** Only shipped legacy adapters have a compatibility contract. Extensions
 * must declare every operation explicitly; method/name presence grants none. */
export function agentSupports(profile: AgentProfile | undefined, id: string, capability: keyof AgentCapabilities): boolean {
  if (profile?.execution === null && !['list', 'read', 'imageOutput'].includes(capability)) return false;
  if (['preciseInterrupt', 'continue', 'steer', 'latestTurnRevert', 'context', 'compact', 'sessionActions', 'archivedSessions', 'sessionWorkflows', 'sideQuestion'].includes(capability)) return profile?.available === true && profile.capabilities?.[capability] === true;
  if (profile && (!profile.available || capability === 'send' && !profile.remoteSendSupported)) return false;
  return profile?.capabilities ? profile.capabilities[capability] === true : builtinAgent(id);
}
function capabilities(value: unknown): AgentCapabilities | undefined {
  // Only an omitted field is legacy. An explicit empty/malformed descriptor
  // must not re-enable every legacy operation on an unavailable adapter.
  if (value === undefined) return undefined;
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return { ...Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, raw[key] === true])),
    ...(raw.features === true ? { features: true } : {}),
    ...(raw.contextReferences === true ? { contextReferences: true } : {}),
    ...(raw.contextReferences === true && raw.contextAnnotations === true ? { contextAnnotations: true } : {}),
    ...(raw.contextReferences === true && raw.contextDiffAnnotations === true ? { contextDiffAnnotations: true } : {}),
    ...(Array.isArray(raw.permissionModes) ? { permissionModes: Array.from(new Set(raw.permissionModes.filter(isPermissionMode))) } : {}),
    ...(Array.isArray(raw.approvalModes) ? { approvalModes: Array.from(new Set(raw.approvalModes.filter(isApprovalMode))) } : {}) } as unknown as AgentCapabilities;
}

const THREAD = /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function liveMode(value: unknown, now = Date.now()): Pick<AgentProfile, 'desktopLive'> {
  if (!value || typeof value !== 'object') return {};
  const live = value as Record<string, unknown>;
  if (live.active !== true || typeof live.expiresAt !== 'number' || live.expiresAt <= now || !Array.isArray(live.sessionKeys)) return {};
  const sessionKeys = live.sessionKeys.filter((key): key is string => typeof key === 'string' && THREAD.test(key)).slice(0, 200);
  const caps = live.capabilities && typeof live.capabilities === 'object' ? live.capabilities as Record<string, unknown> : {};
  const options = live.modelOptions && typeof live.modelOptions === 'object' ? live.modelOptions as Record<string, unknown> : {};
  const modelOverride = caps.modelOverride === true && live.modelOverrideTransport === 'codex-tool-schema-v1' && options.model === true;
  return sessionKeys.length ? { desktopLive: { expiresAt: live.expiresAt, sessionKeys, capabilities: {
    list: caps.list === true, read: caps.read === true, send: caps.send === true, navigate: caps.navigate === true,
    // A real trusted PermissionRequest hook, not the native tool catalogue,
    // owns approvals. Other unimplemented operations remain disabled.
    interrupt: false, approval: caps.approval === true && live.approvalTransport === 'codex-hook-v1', attachments: false, modelOverride,
  }, ...(caps.approval === true && live.approvalTransport === 'codex-hook-v1' ? { approvalTransport: 'codex-hook-v1' as const } : {}),
    ...(modelOverride ? { modelOverrideTransport: 'codex-tool-schema-v1' as const, modelOptions: { model: true as const,
      thinking: CODEX_EFFORTS.filter(effort => Array.isArray(options.thinking) && options.thinking.filter(isEffort).includes(effort)) } } : {}),
    ...(handle(live.accountId) ? { accountId: handle(live.accountId) } : {}),
    ...(label(live.apiName) ? { apiName: label(live.apiName) } : {}), ...(label(live.apiModel) ? { apiModel: label(live.apiModel) } : {}),
  } } : {};
}
/** True when messages to this thread are executed by Codex Desktop itself. */
export function desktopLiveFor(agent: Pick<AgentProfile, 'desktopLive'> | null | undefined, sessionKey: string | null, now = Date.now()): boolean {
  return Boolean(sessionKey && agent?.desktopLive && agent.desktopLive.expiresAt > now && agent.desktopLive.sessionKeys.includes(sessionKey));
}

/** A cached hook event cannot outlive the host's current approval capability. */
export function desktopApprovalFor(agent: Pick<AgentProfile, 'desktopLive'> | null | undefined, sessionKey: string | null, now = Date.now()): boolean {
  return desktopLiveFor(agent, sessionKey, now) && agent?.desktopLive?.capabilities?.approval === true
    && agent.desktopLive.approvalTransport === 'codex-hook-v1';
}

export interface AgentStatus { agents: AgentProfile[]; apis: RemoteApiOption[]; autoAll: boolean }

/** Drop every unrecognized field; never store a remotely returned credential. */
export function parseAgentStatus(result: unknown, device?: DeviceStatus): AgentStatus {
  if (!result || typeof result !== 'object' || !('agents' in result) || !Array.isArray(result.agents)) throw new Error('电脑未提供 Agent 信息');
  const raw: unknown[] = result.agents;
  if (raw.length > 64) throw new Error('电脑提供的 Agent 信息过多');
  const seenIds = new Set<string>();
  for (const value of raw) {
    const id = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).id : undefined;
    if (typeof id !== 'string') continue;
    if (seenIds.has(id)) throw new Error('电脑提供了重复的 Agent');
    seenIds.add(id);
  }
  const agents = AGENT_CHOICES.filter(choice => builtinAgent(choice.id)).map((choice) => {
    const item = raw.find((value: unknown) => Boolean(value && typeof value === 'object' && 'id' in value && value.id === choice.id)) as Record<string, unknown> | undefined;
    let itemCapabilities = capabilities(item?.capabilities);
    const execution = executionFromStatus(item, choice.id, choice.tool);
    const api = item?.api && typeof item.api === 'object' ? item.api as Record<string, unknown> : {};
    const history = item?.desktopHistory && typeof item.desktopHistory === 'object' ? item.desktopHistory as Record<string, unknown> : {};
    const scopes = Array.isArray(history.scopes) ? history.scopes.filter((scope): scope is 'desktop-chat' | 'desktop-cowork' => scope === 'desktop-chat' || scope === 'desktop-cowork') : [];
    const historyAvailable = history.available === true && history.readOnly === true && typeof history.identity === 'string' && /^[a-f0-9]{64}$/.test(history.identity) && scopes.length > 0 && new Set(scopes).size === scopes.length;
    if (!execution) itemCapabilities = { ...capabilities({})!, list: historyAvailable, read: historyAvailable, imageOutput: historyAvailable };
    // Claude Desktop sessions continue through the Claude Code CLI on the computer.
    const installed = choice.id === 'claude-desktop'
      ? item?.available === true && (Boolean(execution) && item.remoteSendSupported !== false || historyAvailable)
      : execution !== null && (item?.available === true || Boolean(item && !Object.prototype.hasOwnProperty.call(item, 'available')
        && device?.tools.find((tool) => tool.id === execution.tool)?.available));
    const source: ApiSource = api.source === 'phone' || api.source === 'computer' || api.source === 'tool'
      ? api.source : api.configured === true || api.pending === true ? 'computer' : 'tool';
    return {
      id: choice.id, name: choice.name, tool: execution?.tool ?? choice.tool, execution, available: installed,
      ...(apiFamily(item?.apiFamily) ? { apiFamily: apiFamily(item?.apiFamily) } : {}),
      ...(itemCapabilities ? { capabilities: itemCapabilities } : {}),
      api: {
        name: label(api.name), model: label(api.model),
        protocol: ['responses', 'chat', 'anthropic'].includes(String(api.protocol)) ? String(api.protocol) : '',
        configured: api.configured === true, pending: api.pending === true, source, accountId: handle(api.accountId),
      },
      remoteSendSupported: Boolean(execution) && installed && item?.remoteSendSupported !== false && (!itemCapabilities || itemCapabilities.send),
      conversationApiSwitch: Boolean(execution) && item?.conversationApiSwitch === true,
      ...(execution?.entrypoint === 'claude-desktop' ? { sessionScope: 'code' as const } : {}),
      ...(choice.id === 'claude-desktop' && historyAvailable ? { desktopHistory: { available: true as const, readOnly: true as const, identity: history.identity as string, scopes } } : {}),
      ...(choice.id === 'codex' ? liveMode(item?.desktopLive) : {}),
    } satisfies AgentProfile;
  });
  // A branded card grants no execution capability. Every extension still
  // requires an authoritative descriptor in its own adapter namespace.
  const extensionAgents = raw.flatMap((value): AgentProfile[] => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const id = item.id;
    const tool = item.tool;
    // `codex-desktop` is a legacy control-surface record represented by the
    // Codex profile's desktopLive lease, not a second Agent. Never duplicate it
    // as an extension card/session source.
    if (!validAgentId(id) || builtinAgent(id) || tool !== id
      || item.controlSurface !== undefined && item.controlSurface !== 'cli') return [];
    const api = item.api && typeof item.api === 'object' ? item.api as Record<string, unknown> : {};
    const execution = executionFromStatus(item, id, tool as ToolId);
    const itemCapabilities = execution ? capabilities(item.capabilities) : capabilities({});
    const source: ApiSource = api.source === 'phone' || api.source === 'computer' || api.source === 'tool' ? api.source : 'tool';
    const available = Boolean(execution) && item.available === true;
    const name = label(item.name) || id;
    const profile: AgentProfile = {
      id: id as AgentId, name, tool: tool as ToolId, execution, available,
      ...(apiFamily(item.apiFamily) ? { apiFamily: apiFamily(item.apiFamily) } : {}),
      ...(itemCapabilities ? { capabilities: itemCapabilities } : {}),
      api: { name: label(api.name), model: label(api.model), protocol: ['responses', 'chat', 'anthropic'].includes(String(api.protocol)) ? String(api.protocol) : '', configured: api.configured === true, pending: api.pending === true, source,
        ...(handle(api.accountId) ? { accountId: handle(api.accountId) } : {}) },
      remoteSendSupported: available && item.remoteSendSupported === true && itemCapabilities?.send === true,
      ...(item.conversationApiSwitch === true && itemCapabilities?.modelOverride ? { conversationApiSwitch: true } : {}),
    };
    return [profile];
  });
  const rawApis = (result as unknown as { apis?: unknown }).apis;
  const apis = Array.isArray(rawApis) ? rawApis.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const id = handle(item.id); const name = label(item.name);
    if (!id || !name) return [];
    const models = Array.isArray(item.models) ? item.models.map(label).filter(Boolean).slice(0, 80) : [];
    const stationRaw = item.station && typeof item.station === 'object' ? item.station as Record<string, unknown> : undefined;
    const stationHubUrl = stationUrl(stationRaw?.hubUrl);
    const stationDeviceId = stationDevice(stationRaw?.deviceId);
    return [{ id, name, models, ...parseRemoteApiMetadata(item), ...(stationHubUrl && stationDeviceId ? { station: { hubUrl: stationHubUrl, deviceId: stationDeviceId } } : {}) }];
  }).slice(0, 64) : [];
  const policy = (result as unknown as { policy?: { autoAll?: unknown } }).policy;
  // Older Bridges did not restrict it; newer ones report the computer's switch.
  const autoAll = Boolean(policy && typeof policy === 'object' && policy.autoAll === true);
  return { agents: [...agents, ...extensionAgents], apis, autoAll };
}

export function fallbackAgentProfiles(device?: DeviceStatus): AgentProfile[] {
  return AGENT_CHOICES.filter(choice => builtinAgent(choice.id)).map((choice) => {
    // A detected Claude CLI does not prove a Desktop history/Code surface exists.
    const available = choice.id !== 'claude-desktop' && Boolean(device?.tools.find((item) => item.id === choice.tool)?.available);
    return { id: choice.id, name: choice.name, tool: choice.tool, available, remoteSendSupported: available,
      api: { name: '', model: '', protocol: '', configured: false, pending: false, source: 'tool' as const } };
  });
}

/** Short, human description of the API remote tasks will use. */
export function agentApiLabel(agent: Pick<AgentProfile, 'api' | 'name'>): string {
  if (agent.api.source === 'tool') return `${agent.name} 自己的登录`;
  return agent.api.name || '电脑上的 API';
}
/** Canonical API-selection namespace used by handover/model caches. */
export function agentApiFamily(agent: Pick<AgentProfile, 'id' | 'apiFamily'> | AgentId): string {
  if (typeof agent === 'string') return agent === 'claude-desktop' || agent === 'codex-desktop' ? agent.slice(0, -'-desktop'.length) : agent;
  if (agent.apiFamily) return agent.apiFamily;
  return agentApiFamily(agent.id);
}
export function agentApiSourceLabel(source: ApiSource): string {
  return source === 'phone' ? '手机为远程任务选择' : source === 'computer' ? '与电脑上的设置相同' : '沿用电脑上的原工具设置';
}

/** Short origin tag shown next to a thread, like the Codex sidebar distinguishes local apps. */
export function originTag(client: string): string {
  if (/Codex App|Codex Desktop|Claude Desktop/i.test(client)) return '桌面';
  if (/IDE/i.test(client)) return 'IDE';
  if (/CLI|Claude Code/i.test(client)) return '终端';
  return '';
}

export function agentSessions(sessions: SessionInfo[], agent: Pick<AgentProfile, 'tool'> & { id?: AgentId }): SessionInfo[] {
	 sessions = sessions.filter(session => session.archived !== true);
  if (agent.id === 'claude-desktop') return sessions.filter((session) => session.tool === 'claude' && isDesktopClient(session.client));
  if (agent.id === 'claude') return sessions.filter((session) => session.tool === 'claude' && !isDesktopClient(session.client));
  return sessions.filter((session) => session.tool === agent.tool && (!agent.id || builtinAgent(agent.id) || session.sessionKey.startsWith(`${agent.id}:`)));
}

export function projectName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '其他';
}

export interface SessionProjectGroup { key: string; name: string; path: string; projectless?: true; updatedAt: number; sessions: SessionInfo[] }
/** Groups every thread under its working folder; conversations without one are temporary tasks. */
export function groupSessionsByProject(sessions: SessionInfo[], options?: { nativeOrder?: boolean; nativeSessionOrder?: string[]; caseSensitivePaths?: boolean }): SessionProjectGroup[] {
  let ordered: SessionInfo[];
  if (options?.nativeOrder) {
    // Keep the computer's native order inside each project. Project grouping
    // may gather interleaved sessions, but never reorders sessions within it.
    const ranks = options.nativeSessionOrder ? new Map(options.nativeSessionOrder.map((key, index) => [key, index])) : undefined;
    ordered = [...sessions].sort((a, b) => ranks
      ? (ranks.get(a.sessionKey) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.sessionKey) ?? Number.MAX_SAFE_INTEGER)
      : (a.sidebarIndex ?? Number.MAX_SAFE_INTEGER) - (b.sidebarIndex ?? Number.MAX_SAFE_INTEGER));
  } else {
    ordered = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const groups = new Map<string, SessionProjectGroup>();
  const normalize = (value: string) => (options?.caseSensitivePaths === false ? value.toLocaleLowerCase() : value);
  for (const session of ordered) {
    const path = !session.projectless && typeof session.cwd === 'string' ? session.cwd.trim().replace(/[\\/]+$/, '') : '';
    const identity = path && normalize(/^(?:[a-z]:[\\/]|\\\\)/i.test(path)?path.replace(/\//g,'\\'):path);
    const key = session.projectless ? '__projectless' : identity ? `project:${identity}` : '__temporary';
    const group = groups.get(key) ?? { key, name: session.projectless ? '不关联文件夹' : path ? projectName(path) : '临时任务', path, ...(session.projectless ? { projectless: true as const } : {}), updatedAt: session.updatedAt, sessions: [] };
    group.sessions.push(session);
    group.updatedAt = Math.max(group.updatedAt, session.updatedAt);
    groups.set(key, group);
  }
  const result = [...groups.values()];
  if (!options?.nativeOrder) result.sort((a, b) => a.key === '__temporary' ? 1 : b.key === '__temporary' ? -1 : b.updatedAt - a.updatedAt);
  else result.sort((a, b) => a.key === '__temporary' ? 1 : b.key === '__temporary' ? -1 : 0);
  return result;
}

export function matchesSearch(session: SessionInfo, query: string, displayTitle = session.title): boolean {
  const q = query.trim().toLowerCase();
  return !q || [displayTitle, session.cwd, session.model].some((value) => String(value ?? '').toLowerCase().includes(q));
}
