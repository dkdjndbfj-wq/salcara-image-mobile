import { fetch as expoFetch } from 'expo/fetch';

import { readSse } from '../api/sse';
import { canonicalHubUrl, type PairQr } from './pairing';

/** Salcara Hub client — see remote/docs/PROTOCOL.md. The hub sits on the relay's own origin. */

export type ToolId = 'codex' | 'claude';
export type SessionStatus = 'running' | 'idle' | 'waiting_approval' | 'failed';
export type ApprovalMode = 'ask' | 'auto_edits' | 'auto_all';
export type Decision = 'allow' | 'allow_session' | 'deny';
export type ToolKind = 'command' | 'file_change' | 'read' | 'search' | 'web' | 'mcp' | 'plan' | 'subagent' | 'other';

export interface DeviceTool { id: string; name: string; available: boolean; version?: string }
export type AgentId = 'codex' | 'claude' | 'claude-desktop';
export type ClaudeDesktopScope = 'desktop-chat' | 'desktop-cowork';
export type ApiSource = 'phone' | 'computer' | 'tool';
/** Public metadata only: model credentials remain on the paired computer. */
export interface AgentProfile {
  /** Absent on older Bridges; never send an in-conversation change to them. */
  conversationApiSwitch?: boolean;
  id: AgentId; name: string; tool: ToolId; available: boolean;
  /** What remote tasks of this agent use right now. accountId is an opaque per-computer handle. */
  api: { name: string; model: string; protocol: string; configured: boolean; pending: boolean; source: ApiSource; accountId?: string };
  remoteSendSupported: boolean;
  /** Codex Desktop live mode: messages to these threads run inside the desktop app (window stays in sync). */
  desktopLive?: { expiresAt: number; sessionKeys: string[]; capabilities?: DesktopCapabilities; approvalTransport?: 'codex-hook-v1' };
  sessionScope?: 'code';
  desktopHistory?: { available: true; readOnly: true; identity: string; scopes: ClaudeDesktopScope[] };
}
export interface DesktopCapabilities { list: boolean; read: boolean; send: boolean; interrupt: boolean; approval: boolean; attachments: boolean; modelOverride: boolean }
/** One API in the computer's vault the phone may pick. No address or key ever leaves the computer. */
export interface RemoteApiOption { id: string; name: string; models: string[] }
/** Missing capability fields mean unknown, not inferred from a model name. */
export interface ModelCapability {
  source: 'codex-model-list' | 'relay-model-list' | 'unknown';
  reasoningKnown: boolean;
  reasoningEfforts?: Effort[];
  inputModalities?: Array<'text' | 'image'>;
}
export interface ModelCatalog { models: string[]; api?: string; modelCapabilities?: Record<string, ModelCapability> }
export type { Effort } from './effort';
import type { Effort } from './effort';
export interface Project { path: string; name: string }
export interface DeviceStatus {
  deviceId: string; name: string; os: 'windows' | 'darwin' | 'linux' | string; version?: string;
  tools: DeviceTool[]; projects: Project[]; online: boolean; lastSeen: number;
}
export interface SessionInfo {
  sessionKey: string; tool: ToolId; client: string; title: string; cwd: string; updatedAt: number;
  status: SessionStatus; controllable: boolean; model?: string;
  controlSurface?: 'cli' | 'desktop' | 'read-only';
  /** Genuine native directory order, never inferred from history timestamps. */
  pinnedIndex?: number;
  sidebarIndex?: number;
  parentSessionKey?: string;
  sessionScope?: ClaudeDesktopScope;
}
export interface RemoteQuestion {
  id: string; header?: string; question: string; options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean; allowCustom?: boolean; required?: boolean; inputType?: 'text' | 'enum' | 'boolean' | 'number' | 'integer';
  min?: number; max?: number;
  preserveWhitespace?: boolean; allowEmpty?: boolean;
}
export type QuestionAnswers = Record<string, string[]>;
export interface Usage { inputTokens?: number; outputTokens?: number; costUsd?: number }

type Base = { seq?: number; deviceId: string; sessionKey: string; tool: ToolId; ts: number; parentId?: string; childSessionKeys?: string[] };
export type HubEvent = Base & (
  | { type: 'session.updated'; session: SessionInfo }
  | { type: 'message'; id: string; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'reasoning'; id: string; text: string; final: boolean }
  | { type: 'tool'; id: string; kind: ToolKind; title: string; detail?: string; status: 'running' | 'done' | 'failed'; output?: string; diff?: string; exitCode?: number }
  | { type: 'approval.request'; approvalId: string; kind: 'command' | 'file_change' | 'tool' | 'permission' | 'question'; title: string; detail?: string; diff?: string; cwd?: string; questions?: RemoteQuestion[]; questionMode?: string; expiresAt?: number; approvalTransport?: 'codex-hook-v1' }
  | { type: 'approval.resolved'; approvalId: string; decision: Decision; by: 'phone' | 'desktop' | 'timeout' }
  | { type: 'turn'; status: 'started' | 'completed' | 'failed' | 'interrupted'; error?: string; usage?: Usage }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
);

export type Command =
  | { type: 'agents.status' }
  | { type: 'agents.api.set'; agent: AgentId; accountId: string; model?: string; sessionKey?: string }
  | { type: 'sessions.list'; tool?: ToolId; client?: 'code' | 'desktop-code' | ClaudeDesktopScope; cursor?: string; limit?: number; controlSurface?: 'read-only'; historyIdentity?: string }
  | { type: 'desktop.sessions.list'; tool: 'codex'; controlSurface: 'desktop' }
  | { type: 'desktop.session.open'; sessionKey: string; controlSurface: 'desktop'; cursor?: string }
  | { type: 'session.open'; sessionKey: string; cursor?: string; limit?: number; controlSurface?: 'read-only'; historyIdentity?: string; client?: ClaudeDesktopScope }
  | { type: 'session.describe'; sessionKey: string; controlSurface: 'read-only'; historyIdentity: string }
  | { type: 'session.start'; tool: ToolId; cwd: string; prompt: string; model?: string; effort?: Effort; approval?: ApprovalMode; attachments?: string[]; entrypoint?: 'claude-desktop' }
  | { type: 'session.send'; sessionKey: string; text: string; model?: string; effort?: Effort; attachments?: string[]; controlSurface: 'cli' | 'desktop'; operationId?: string }
  | { type: 'attachment.put'; id: string; mime: string; index: number; total: number; data: string }
  | { type: 'session.interrupt'; sessionKey: string; controlSurface: 'cli' }
  | { type: 'approval.respond'; approvalId: string; decision: Decision; message?: string; answers?: QuestionAnswers; controlSurface: 'cli' }
  | { type: 'desktop.approval.respond'; sessionKey: string; approvalId: string; decision: 'allow' | 'deny'; message?: string; operationId: string; controlSurface: 'desktop' }
  | { type: 'projects.list' }
  | { type: 'models.list'; tool: ToolId; refresh?: boolean }
  | { type: 'desktop.navigate'; sessionKey: string; controlSurface: 'desktop' };

export type Hub = { url: string; key?: string; pairToken?: string; deviceId?: string };
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; url?: string; redirected?: boolean; headers?: { get?: (name: string) => string | null } | null; body?: unknown; text?: () => Promise<string>; json?: () => Promise<unknown>;
}>;

export class HubError extends Error {
  constructor(message: string, readonly status = 0, readonly code?: string) { super(message); this.name = 'HubError'; }
}

export function originOf(baseUrl: string): string | null {
  return baseUrl.trim().match(/^(https?:\/\/[^/?#\s]+)/i)?.[1] ?? null;
}

export function hubUrlFor(baseUrl: string): string | null {
  const origin = originOf(baseUrl);
  return origin ? `${origin}/salcara-hub/v1` : null;
}

let fetchImpl: FetchLike = expoFetch as unknown as FetchLike;
/** Tests swap the transport. */
export function setHubFetch(next: FetchLike | null) { fetchImpl = next ?? (expoFetch as unknown as FetchLike); }

async function readJson(response: Awaited<ReturnType<FetchLike>>): Promise<Record<string, unknown>> {
  const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json?.());
  try {
    const value: unknown = JSON.parse(text || '');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value as Record<string, unknown>;
  } catch { throw new HubError('响应未接收完整，保留原请求等待重试'); }
}

function httpMessage(status: number, error: unknown): string {
  if (status === 401 || status === 403) return '配对凭证无效或已撤销，请重新扫码连接电脑';
  if (typeof error === 'string' && error) return error;
  if (status === 404) return '这个 API 不支持远程编程';
  if (status === 409) return '电脑不在线';
  return `中转站暂时不可用（HTTP ${status}）`;
}

function authHeaders(hub: Hub | { url: string; key?: string }) {
  return { ...(hub.key ? { Authorization: `Bearer ${hub.key}` } : {}), ...('pairToken' in hub && hub.pairToken ? { 'X-Salcara-Pair-Token': hub.pairToken } : {}) };
}
function checkResponseScope(response: Awaited<ReturnType<FetchLike>>, hubUrl: string) {
  // Never follow station redirects with a device credential, even within the same origin.
  if (response.redirected || (response.url && !response.url.startsWith(`${hubUrl}/`))) throw new HubError('中转站接口发生重定向，已停止连接以保护配对凭证');
}

async function request(hub: Hub | { url: string; key?: string }, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${hub.url}${path}`, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...authHeaders(hub), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal, credentials: 'omit', redirect: 'error',
    });
    checkResponseScope(response, hub.url);
    const json = response.ok ? await readJson(response) : await readJson(response).catch(() => ({} as Record<string, unknown>));
    if (!response.ok) throw new HubError(httpMessage(response.status, json.error), response.status, typeof json.code === 'string' ? json.code : undefined);
    return json;
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError(controller.signal.aborted ? '中转站响应超时，请稍后再试' : '连不上中转站，请检查网络');
  } finally { clearTimeout(timer); }
}

/** True when this origin runs a Salcara Hub (no key needed). */
export async function ping(hubUrl: string): Promise<boolean> {
  try { return (await request({ url: hubUrl }, '/ping', { timeoutMs: 6000 })).service === 'salcara-hub'; } catch { return false; }
}

export interface HubDiscovery { url: string; service: 'salcara-hub'; protocol: 'salcara-remote'; protocolVersion: 1; capabilities: string[] }
/** Discovery is public and requires all device-only pairing capabilities, not an API-user login. */
export async function discoverStation(stationUrl: string): Promise<HubDiscovery> {
  const url = canonicalHubUrl(stationUrl);
  const result = await request({ url }, '/ping', { timeoutMs: 6000 });
  const capabilities = Array.isArray(result.capabilities) ? result.capabilities.filter((item): item is string => typeof item === 'string') : [];
  if (result.service !== 'salcara-hub' || result.protocol !== 'salcara-remote' || result.protocolVersion !== 1
    || !Array.isArray(result.authModes) || !result.authModes.includes('device-pairing')
    || !['device.identity.v1', 'pair.qr.v1', 'session.remote.v1', 'pair.revoke.v1'].every((item) => capabilities.includes(item))) {
    throw new HubError('这个中转站没有安装兼容的扫码远程插件，请联系站长');
  }
  return { url, service: 'salcara-hub', protocol: 'salcara-remote', protocolVersion: 1, capabilities };
}

export async function confirmQrPair(qr: PairQr): Promise<{ token: string; device: DeviceStatus }> {
  const result = await request({ url: qr.hubUrl }, '/app/pair/qr', { method: 'POST', body: { deviceId: qr.deviceId, ticket: qr.ticket } });
  const device = result.device as DeviceStatus | undefined;
  if (typeof result.pair_token !== 'string' || !/^[a-f0-9]{64}$/.test(result.pair_token) || !device
    || device.deviceId !== qr.deviceId || typeof device.name !== 'string' || !Array.isArray(device.tools) || !Array.isArray(device.projects)) {
    throw new HubError('中转站返回的电脑配对信息无效');
  }
  return { token: result.pair_token, device };
}

export async function revokePair(hub: Hub): Promise<void> {
  await request(hub, '/app/pair/revoke', { method: 'POST' });
}

/** Hub capability push.fcm.v1: this phone's FCM token for task news while the app is closed; '' unregisters. */
export async function registerPushToken(hub: Hub, deviceId: string, token: string): Promise<'fcm' | 'off'> {
  const result = await request(hub, '/app/push/register', { method: 'POST', body: { deviceId, token, platform: 'android' }, timeoutMs: 15_000 });
  return result.push === 'fcm' ? 'fcm' : 'off';
}

export async function me(hub: Hub): Promise<string> {
  return String((await request(hub, '/me')).account ?? '');
}

/** A one-time code must be displayed by the local desktop app. */
export async function confirmPair(hub: Hub, code: string): Promise<{ token: string; device: DeviceStatus }> {
  const result = await request(hub, '/app/pair/confirm', { method: 'POST', body: { code: code.trim().toUpperCase() } });
  if (typeof result.pair_token !== 'string' || !result.device || typeof result.device !== 'object') {
    throw new HubError('中转站没有返回配对凭证');
  }
  return { token: result.pair_token, device: result.device as unknown as DeviceStatus };
}

export async function devices(hub: Hub): Promise<DeviceStatus[]> {
  const list = (await request(hub, '/app/devices')).devices;
  return Array.isArray(list) ? (list as DeviceStatus[]).filter((device) => !hub.deviceId || device.deviceId === hub.deviceId) : [];
}

/** Runs one command on a computer; the hub waits up to 45 s for the reply. */
export async function command<T = Record<string, unknown>>(hub: Hub, deviceId: string, cmd: Command, requestId?: string): Promise<T> {
  if (hub.deviceId && hub.deviceId !== deviceId) throw new HubError('这台电脑不属于当前配对连接');
  const reply = await request(hub, '/app/commands', { method: 'POST', body: { deviceId, command: cmd, ...(requestId ? { requestId } : {}) }, timeoutMs: 55_000 });
  if (reply.ok === false) throw new HubError(typeof reply.error === 'string' && reply.error ? reply.error : '电脑没有完成这个操作', 200, typeof reply.code === 'string' ? reply.code : undefined);
  if (reply.ok !== true || (reply.result !== undefined && (!reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result)))) throw new HubError('未收到完整送达确认，保留原请求等待重试');
  return (reply.result ?? {}) as T;
}

export async function sessionEvents(hub: Hub, deviceId: string, sessionKey: string, after = 0): Promise<HubEvent[]> {
  return (await sessionEventsPage(hub, deviceId, sessionKey, after)).events;
}
export interface SessionEventsPage { events: HubEvent[]; nextSeq: number; lastSeq: number; hasMore: boolean; resetRequired: boolean }
/** With waitSeconds > 0 (Hub capability events.wait.v1) the Hub holds an empty read until a new event arrives. */
export async function sessionEventsPage(hub: Hub, deviceId: string, sessionKey: string, after = 0, waitSeconds = 0, limit = 100): Promise<SessionEventsPage> {
  if (hub.deviceId && hub.deviceId !== deviceId) throw new HubError('这台电脑不属于当前配对连接');
  const wait = Math.max(0, Math.min(25, Math.floor(waitSeconds)));
  const query = `deviceId=${encodeURIComponent(deviceId)}&sessionKey=${encodeURIComponent(sessionKey)}&after=${after}&limit=${Math.max(1, Math.min(500, limit))}${wait ? `&wait=${wait}` : ''}`;
  const result = await request(hub, `/app/events?${query}`, { timeoutMs: wait ? (wait + 15) * 1000 : 20_000 });
  const events = Array.isArray(result.events) ? result.events as HubEvent[] : [];
  return { events, nextSeq: typeof result.nextSeq === 'number' && Number.isSafeInteger(result.nextSeq) && result.nextSeq >= after
    ? result.nextSeq : events.reduce((seq, event) => Math.max(seq, event.seq ?? 0), after),
    lastSeq: typeof result.lastSeq === 'number' && Number.isSafeInteger(result.lastSeq) ? result.lastSeq : 0,
    hasMore: result.hasMore === true, resetRequired: result.resetRequired === true };
}

// ——— live stream ———

export type StreamState = 'connecting' | 'open' | 'retrying' | 'closed';
export interface StreamOptions {
  hub: Hub; after?: number;
  onEvent: (event: HubEvent) => void;
  onDevice: (device: DeviceStatus) => void;
  onState?: (state: StreamState, info?: { retryInMs?: number; error?: string }) => void;
  /** Reconnect when nothing (not even the 20 s `: ping`) arrives for this long. */
  idleMs?: number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface StreamHandle { close: () => void; lastSeq: () => number }

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

export const BACKOFF_MIN = 1000;
export const BACKOFF_MAX = 30_000;

/**
 * Follows /app/stream until closed: resumes with `after=<last seq>` and backs off 1 s → 30 s between
 * attempts. A 401 stops for good (the key is no longer a relay user).
 */
export function openStream(options: StreamOptions): StreamHandle {
  const { hub, onEvent, onDevice, onState, idleMs = 65_000, wait = sleep } = options;
  const outer = new AbortController();
  let seq = options.after ?? 0;
  let delay = BACKOFF_MIN;

  const connect = async () => {
    const attempt = new AbortController();
    const stop = () => attempt.abort();
    outer.signal.addEventListener('abort', stop, { once: true });
    let alive = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - alive > idleMs) attempt.abort(); }, Math.min(idleMs, 5000));
    try {
      const response = await fetchImpl(`${hub.url}/app/stream?after=${seq}`, {
        method: 'GET', headers: { Accept: 'text/event-stream', ...authHeaders(hub) }, signal: attempt.signal, credentials: 'omit', redirect: 'error',
      });
      checkResponseScope(response, hub.url);
      if (!response.ok) {
        const json = await readJson(response).catch(() => ({} as Record<string, unknown>));
        throw new HubError(httpMessage(response.status, json.error), response.status);
      }
      if (!response.headers?.get?.('content-type')?.toLowerCase().includes('text/event-stream')) throw new HubError('中转站没有返回远程事件流，请检查插件和反向代理配置');
      delay = BACKOFF_MIN;
      onState?.('open');
      const body = response.body as { getReader?: () => { read: () => Promise<{ done: boolean; value?: unknown }>; cancel?: () => unknown } } | undefined;
      const reader = body?.getReader?.();
      const tracked = reader ? { getReader: () => ({ read: async () => { const chunk = await reader.read(); alive = Date.now(); return chunk; }, cancel: () => reader.cancel?.() }) } : body;
      await readSse({ headers: response.headers, body: tracked, text: response.text }, (event) => {
        let data: unknown;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!data || typeof data !== 'object') return;
        if (event.event === 'device') { const device = data as DeviceStatus; if (!hub.deviceId || device.deviceId === hub.deviceId) onDevice(device); return; }
        if (event.event !== 'event' && event.event !== null) return;
        const hubEvent = data as HubEvent;
        if (hub.deviceId && hubEvent.deviceId !== hub.deviceId) return;
        if (typeof hubEvent.seq === 'number') {
          if (hubEvent.seq <= seq) return;
          seq = hubEvent.seq;
        }
        onEvent(hubEvent);
      }, attempt.signal);
      return null;
    } catch (error) {
      if (error instanceof HubError && (error.status === 401 || error.status === 403)) throw error;
      return error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(watchdog);
      outer.signal.removeEventListener('abort', stop);
    }
  };

  void (async () => {
    while (!outer.signal.aborted) {
      onState?.('connecting');
      let error: string | null;
      try { error = await connect(); } catch (fatal) {
        if (!outer.signal.aborted) onState?.('closed', { error: (fatal as Error).message });
        return;
      }
      if (outer.signal.aborted) break;
      onState?.('retrying', { retryInMs: delay, error: error ?? undefined });
      await wait(delay, outer.signal);
      delay = Math.min(delay * 2, BACKOFF_MAX);
    }
    onState?.('closed');
  })();

  return { close: () => outer.abort(), lastSeq: () => seq };
}
