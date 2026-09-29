import { fetch as expoFetch } from 'expo/fetch';

import { readSse } from '../api/sse';

/** Salcara Hub client — see remote/docs/PROTOCOL.md. The hub sits on the relay's own origin. */

export type ToolId = 'codex' | 'claude';
export type SessionStatus = 'running' | 'idle' | 'waiting_approval' | 'failed';
export type ApprovalMode = 'ask' | 'auto_edits' | 'auto_all';
export type Decision = 'allow' | 'allow_session' | 'deny';
export type ToolKind = 'command' | 'file_change' | 'read' | 'search' | 'web' | 'mcp' | 'other';

export interface DeviceTool { id: string; name: string; available: boolean; version?: string }
export interface Project { path: string; name: string }
export interface DeviceStatus {
  deviceId: string; name: string; os: 'windows' | 'darwin' | 'linux' | string; version?: string;
  tools: DeviceTool[]; projects: Project[]; online: boolean; lastSeen: number;
}
export interface SessionInfo {
  sessionKey: string; tool: ToolId; client: string; title: string; cwd: string; updatedAt: number;
  status: SessionStatus; controllable: boolean; model?: string;
}
export interface Usage { inputTokens?: number; outputTokens?: number; costUsd?: number }

type Base = { seq?: number; deviceId: string; sessionKey: string; tool: ToolId; ts: number };
export type HubEvent = Base & (
  | { type: 'session.updated'; session: SessionInfo }
  | { type: 'message'; id: string; role: 'user' | 'assistant'; text: string; final: boolean }
  | { type: 'reasoning'; id: string; text: string; final: boolean }
  | { type: 'tool'; id: string; kind: ToolKind; title: string; detail?: string; status: 'running' | 'done' | 'failed'; output?: string; diff?: string; exitCode?: number }
  | { type: 'approval.request'; approvalId: string; kind: 'command' | 'file_change' | 'tool' | 'permission'; title: string; detail?: string; diff?: string; cwd?: string }
  | { type: 'approval.resolved'; approvalId: string; decision: Decision; by: 'phone' | 'desktop' | 'timeout' }
  | { type: 'turn'; status: 'started' | 'completed' | 'failed' | 'interrupted'; error?: string; usage?: Usage }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
);

export type Command =
  | { type: 'sessions.list'; tool?: ToolId }
  | { type: 'session.open'; sessionKey: string }
  | { type: 'session.start'; tool: ToolId; cwd: string; prompt: string; model?: string; approval?: ApprovalMode }
  | { type: 'session.send'; sessionKey: string; text: string }
  | { type: 'session.interrupt'; sessionKey: string }
  | { type: 'approval.respond'; approvalId: string; decision: Decision; message?: string }
  | { type: 'projects.list' }
  | { type: 'models.list'; tool: ToolId };

export type Hub = { url: string; key: string; pairToken?: string };
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean; status: number; headers?: { get?: (name: string) => string | null } | null; body?: unknown; text?: () => Promise<string>; json?: () => Promise<unknown>;
}>;

export class HubError extends Error {
  constructor(message: string, readonly status = 0) { super(message); this.name = 'HubError'; }
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
  try { const value: unknown = JSON.parse(text || '{}'); return value && typeof value === 'object' ? value as Record<string, unknown> : {}; } catch { return {}; }
}

function httpMessage(status: number, error: unknown): string {
  if (typeof error === 'string' && error) return error;
  if (status === 401) return '这个 Key 不是中转站的有效用户';
  if (status === 404) return '这个 API 不支持远程编程';
  if (status === 409) return '电脑不在线';
  return `中转站暂时不可用（HTTP ${status}）`;
}

async function request(hub: Hub | { url: string; key?: string }, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${hub.url}${path}`, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(hub.key ? { Authorization: `Bearer ${hub.key}` } : {}), ...('pairToken' in hub && hub.pairToken ? { 'X-Salcara-Pair-Token': hub.pairToken } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal, credentials: 'omit',
    });
  } catch {
    throw new HubError(controller.signal.aborted ? '中转站响应超时，请稍后再试' : '连不上中转站，请检查网络');
  } finally { clearTimeout(timer); }
  const json = await readJson(response).catch(() => ({} as Record<string, unknown>));
  if (!response.ok) throw new HubError(httpMessage(response.status, json.error), response.status);
  return json;
}

/** True when this origin runs a Salcara Hub (no key needed). */
export async function ping(hubUrl: string): Promise<boolean> {
  try { return (await request({ url: hubUrl }, '/ping', { timeoutMs: 6000 })).service === 'salcara-hub'; } catch { return false; }
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
  return Array.isArray(list) ? list as DeviceStatus[] : [];
}

/** Runs one command on a computer; the hub waits up to 45 s for the reply. */
export async function command<T = Record<string, unknown>>(hub: Hub, deviceId: string, cmd: Command): Promise<T> {
  const reply = await request(hub, '/app/commands', { method: 'POST', body: { deviceId, command: cmd }, timeoutMs: 55_000 });
  if (reply.ok === false) throw new HubError(typeof reply.error === 'string' && reply.error ? reply.error : '电脑没有完成这个操作');
  return (reply.result ?? {}) as T;
}

export async function sessionEvents(hub: Hub, deviceId: string, sessionKey: string, after = 0): Promise<HubEvent[]> {
  const query = `deviceId=${encodeURIComponent(deviceId)}&sessionKey=${encodeURIComponent(sessionKey)}&after=${after}`;
  const list = (await request(hub, `/app/events?${query}`)).events;
  return Array.isArray(list) ? list as HubEvent[] : [];
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
        method: 'GET', headers: { Accept: 'text/event-stream', Authorization: `Bearer ${hub.key}`, ...(hub.pairToken ? { 'X-Salcara-Pair-Token': hub.pairToken } : {}) }, signal: attempt.signal, credentials: 'omit',
      });
      if (!response.ok) {
        const json = await readJson(response).catch(() => ({} as Record<string, unknown>));
        throw new HubError(httpMessage(response.status, json.error), response.status);
      }
      delay = BACKOFF_MIN;
      onState?.('open');
      const body = response.body as { getReader?: () => { read: () => Promise<{ done: boolean; value?: unknown }>; cancel?: () => unknown } } | undefined;
      const reader = body?.getReader?.();
      const tracked = reader ? { getReader: () => ({ read: async () => { const chunk = await reader.read(); alive = Date.now(); return chunk; }, cancel: () => reader.cancel?.() }) } : body;
      await readSse({ headers: response.headers, body: tracked, text: response.text }, (event) => {
        let data: unknown;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!data || typeof data !== 'object') return;
        if (event.event === 'device') { onDevice(data as DeviceStatus); return; }
        if (event.event !== 'event' && event.event !== null) return;
        const hubEvent = data as HubEvent;
        if (typeof hubEvent.seq === 'number') {
          if (hubEvent.seq <= seq) return;
          seq = hubEvent.seq;
        }
        onEvent(hubEvent);
      }, attempt.signal);
      return null;
    } catch (error) {
      if (error instanceof HubError && error.status === 401) throw error;
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
