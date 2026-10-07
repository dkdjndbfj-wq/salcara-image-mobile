import type { AgentId, AgentProfile, ApiSource, DeviceStatus, RemoteApiOption, SessionInfo } from './client';

/**
 * The phone drives three agents. "Codex" lists every Codex thread on the computer —
 * the Codex app, CLI and IDE share one thread store, so this is the same list as
 * the Codex sidebar. "Claude Code" lists Claude Code sessions. "Claude Desktop"
 * separates native read-only Chat/Cowork from the Code worker. None of these
 * sources is silently substituted for another.
 */
export const AGENT_CHOICES: ReadonlyArray<{ id: AgentId; name: string; tool: 'codex' | 'claude'; client?: string; detail: string }> = [
  { id: 'codex', name: 'Codex', tool: 'codex', detail: 'Codex App、CLI 与 IDE' },
  { id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', client: 'Claude Desktop', detail: 'Code 续聊 · Chat / Cowork 可查看并接着聊' },
  { id: 'claude', name: 'Claude Code', tool: 'claude', detail: '终端与 IDE' },
];
export function isDesktopClient(client?: string): boolean { return /Claude Desktop/i.test(client ?? ''); }

// These are labels, not provider URLs or opaque credentials.
const label = (value: unknown) => typeof value === 'string' && value.length <= 200
  && !/[\r\n\x00]/.test(value) && !/(?:https?:\/\/|sk-|bearer\s|[\\]|[a-f0-9]{32,})/i.test(value) ? value : '';
const handle = (value: unknown) => typeof value === 'string' && /^api_[a-f0-9]{8,64}$/.test(value) ? value : undefined;
const stationUrl = (value: unknown) => typeof value === 'string' && value.length <= 512 && !/[\\\s?#\u0000-\u001f]/.test(value)
  && /^https?:\/\/[^/]+(?:\/[^/]*)*\/?$/i.test(value) ? value : undefined;
const stationDevice = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : undefined;

const THREAD = /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function liveMode(value: unknown, now = Date.now()): Pick<AgentProfile, 'desktopLive'> {
  if (!value || typeof value !== 'object') return {};
  const live = value as Record<string, unknown>;
  if (live.active !== true || typeof live.expiresAt !== 'number' || live.expiresAt <= now || !Array.isArray(live.sessionKeys)) return {};
  const sessionKeys = live.sessionKeys.filter((key): key is string => typeof key === 'string' && THREAD.test(key)).slice(0, 200);
  const caps = live.capabilities && typeof live.capabilities === 'object' ? live.capabilities as Record<string, unknown> : {};
  return sessionKeys.length ? { desktopLive: { expiresAt: live.expiresAt, sessionKeys, capabilities: {
    list: caps.list === true, read: caps.read === true, send: caps.send === true,
    // A real trusted PermissionRequest hook, not the native tool catalogue,
    // owns approvals. Other unimplemented operations remain disabled.
    interrupt: false, approval: caps.approval === true && live.approvalTransport === 'codex-hook-v1', attachments: false, modelOverride: false,
  }, ...(caps.approval === true && live.approvalTransport === 'codex-hook-v1' ? { approvalTransport: 'codex-hook-v1' as const } : {}) } } : {};
}
/** True when messages to this thread are executed by Codex Desktop itself. */
export function desktopLiveFor(agent: Pick<AgentProfile, 'desktopLive'> | null | undefined, sessionKey: string | null, now = Date.now()): boolean {
  return Boolean(sessionKey && agent?.desktopLive && agent.desktopLive.expiresAt > now && agent.desktopLive.sessionKeys.includes(sessionKey));
}

export interface AgentStatus { agents: AgentProfile[]; apis: RemoteApiOption[]; autoAll: boolean }

/** Drop every unrecognized field; never store a remotely returned credential. */
export function parseAgentStatus(result: unknown, device?: DeviceStatus): AgentStatus {
  if (!result || typeof result !== 'object' || !('agents' in result) || !Array.isArray(result.agents)) throw new Error('电脑未提供 Agent 信息');
  const raw: unknown[] = result.agents;
  const agents = AGENT_CHOICES.map((choice) => {
    const item = raw.find((value: unknown) => Boolean(value && typeof value === 'object' && 'id' in value && value.id === choice.id)) as Record<string, unknown> | undefined;
    const api = item?.api && typeof item.api === 'object' ? item.api as Record<string, unknown> : {};
    const history = item?.desktopHistory && typeof item.desktopHistory === 'object' ? item.desktopHistory as Record<string, unknown> : {};
    const scopes = Array.isArray(history.scopes) ? history.scopes.filter((scope): scope is 'desktop-chat' | 'desktop-cowork' => scope === 'desktop-chat' || scope === 'desktop-cowork') : [];
    const historyAvailable = history.available === true && history.readOnly === true && typeof history.identity === 'string' && /^[a-f0-9]{64}$/.test(history.identity) && scopes.length > 0 && new Set(scopes).size === scopes.length;
    // Claude Desktop sessions continue through the Claude Code CLI on the computer.
    const installed = choice.id === 'claude-desktop'
      ? item?.available === true && (item.remoteSendSupported !== false || historyAvailable)
      : item?.available === true || Boolean(device?.tools.find((tool) => tool.id === choice.tool)?.available);
    const source: ApiSource = api.source === 'phone' || api.source === 'computer' || api.source === 'tool'
      ? api.source : api.configured === true || api.pending === true ? 'computer' : 'tool';
    return {
      id: choice.id, name: choice.name, tool: choice.tool, available: installed,
      api: {
        name: label(api.name), model: label(api.model),
        protocol: ['responses', 'chat', 'anthropic'].includes(String(api.protocol)) ? String(api.protocol) : '',
        configured: api.configured === true, pending: api.pending === true, source, accountId: handle(api.accountId),
      },
      remoteSendSupported: choice.id === 'claude-desktop' ? installed && item?.remoteSendSupported !== false : installed,
      conversationApiSwitch: item?.conversationApiSwitch === true,
      ...(choice.id === 'claude-desktop' ? { sessionScope: 'code' as const } : {}),
      ...(choice.id === 'claude-desktop' && historyAvailable ? { desktopHistory: { available: true as const, readOnly: true as const, identity: history.identity as string, scopes } } : {}),
      ...(choice.id === 'codex' ? liveMode(item?.desktopLive) : {}),
    } satisfies AgentProfile;
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
    return [{ id, name, models, ...(stationHubUrl && stationDeviceId ? { station: { hubUrl: stationHubUrl, deviceId: stationDeviceId } } : {}) }];
  }).slice(0, 64) : [];
  const policy = (result as unknown as { policy?: { autoAll?: unknown } }).policy;
  // Older Bridges did not restrict it; newer ones report the computer's switch.
  const autoAll = policy && typeof policy === 'object' ? policy.autoAll === true : true;
  return { agents, apis, autoAll };
}

export function fallbackAgentProfiles(device?: DeviceStatus): AgentProfile[] {
  return AGENT_CHOICES.map((choice) => {
    const available = Boolean(device?.tools.find((item) => item.id === choice.tool)?.available);
    return { id: choice.id, name: choice.name, tool: choice.tool, available, remoteSendSupported: available,
      api: { name: '', model: '', protocol: '', configured: false, pending: false, source: 'tool' as const } };
  });
}

/** Short, human description of the API remote tasks will use. */
export function agentApiLabel(agent: Pick<AgentProfile, 'api' | 'name'>): string {
  if (agent.api.source === 'tool') return `${agent.name} 自己的登录`;
  return agent.api.name || '电脑上的 API';
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
  if (agent.id === 'claude-desktop') return sessions.filter((session) => session.tool === 'claude' && isDesktopClient(session.client));
  if (agent.id === 'claude') return sessions.filter((session) => session.tool === 'claude' && !isDesktopClient(session.client));
  return sessions.filter((session) => session.tool === agent.tool);
}

export function projectName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '其他';
}

export interface SessionProjectGroup { key: string; name: string; path: string; updatedAt: number; sessions: SessionInfo[] }
/** Groups threads by workspace folder like the Codex sidebar; most recently active project first. */
export function groupSessionsByProject(sessions: SessionInfo[], options?: { nativeOrder?: boolean; nativeSessionOrder?: string[] }): SessionProjectGroup[] {
  if (options?.nativeOrder) {
    // The host already ordered this directory. Grouping it by cwd would move
    // pinned tasks and interleaved projects away from their real sidebar order.
    const ranks = new Map(options.nativeSessionOrder?.map((key, index) => [key, index]));
    const ordered = [...sessions].sort((a, b) => options.nativeSessionOrder
      ? (ranks.get(a.sessionKey) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.sessionKey) ?? Number.MAX_SAFE_INTEGER)
      : (a.sidebarIndex ?? Number.MAX_SAFE_INTEGER) - (b.sidebarIndex ?? Number.MAX_SAFE_INTEGER));
    return [
      { key: '__native_pinned', name: '置顶', path: '', sessions: ordered.filter(item => (item.pinnedIndex ?? 0) > 0) },
      { key: '__native_recent', name: '最近', path: '', sessions: ordered.filter(item => !(item.pinnedIndex ?? 0)) },
    ].filter(group => group.sessions.length).map(group => ({ ...group, updatedAt: Math.max(...group.sessions.map(item => item.updatedAt)) }));
  }
  const groups = new Map<string, SessionProjectGroup>();
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = session.cwd ? session.cwd.replace(/[\\/]+$/, '').toLowerCase() : '__none';
    const group = groups.get(key) ?? { key, name: session.cwd ? projectName(session.cwd) : '未关联项目', path: session.cwd, updatedAt: session.updatedAt, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function matchesSearch(session: SessionInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [session.title, session.cwd, session.model].some((value) => String(value ?? '').toLowerCase().includes(q));
}
