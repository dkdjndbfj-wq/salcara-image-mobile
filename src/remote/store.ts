import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import type { ProviderProfile } from '../domain';
import { getSetting, setSetting } from '../storage/database';
import { getProviderKey } from '../storage/secure-keys';
import {
  command, confirmPair, confirmQrPair, devices as fetchDevices, discoverStation, hubUrlFor, HubError, me, ping, revokePair, sessionEventsPage,
  type AgentId, type AgentProfile, type ApprovalMode, type Command, type Decision, type DeviceStatus, type Effort, type Hub, type HubEvent, type Project,
  type RemoteApiOption, type SessionInfo, type ToolId, type ToolKind, type Usage,
  type RemoteQuestion, type QuestionAnswers, type ModelCapability, type ModelCatalog,
} from './client';
import { clearRemoteCache, loadCachedSessions, loadCachedThread, resetRemoteCacheForTests, saveCachedSessions, saveCachedThread } from './cache';
import { deletePairToken, getPairToken, savePairToken } from './pair-storage';
import { connectionId, connectionToken, deliveryCredentialId, forgetConnection, loadConnections, saveConnection, selectConnection, selectConnectionIf, selectedConnection, type RemoteConnection } from './connections';
import { canonicalHubUrl, readPairQr, type PairQr } from './pairing';
import { phoneIdentity } from './phone-identity';
import { parseAgentStatus, type AgentStatus } from './projection';
import { cancelPendingDelivery, deliverMessage, DeliveryPendingError, pendingDelivery, pendingDeliveriesForDevice, resetDeliveryForTests } from './delivery';
import { pendingQuestionReceiptsForDevice } from './question-outbox';
import { attachmentChunks, type RemoteImage } from './attachment-chunks';
import { randomUUID } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { CODEX_EFFORTS, isEffort } from './effort';

// ——— timeline ———

export type TimelineItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; final: boolean; ts: number; local?: boolean; images?: string[]; parentId?: string }
  | { kind: 'reasoning'; id: string; text: string; final: boolean; ts: number; parentId?: string }
  | { kind: 'tool'; id: string; tool: ToolKind; title: string; detail?: string; status: 'running' | 'done' | 'failed'; output?: string; diff?: string; exitCode?: number; ts: number; parentId?: string; childSessionKeys?: string[] }
  | { kind: 'approval'; id: string; approval: ApprovalKind; title: string; detail?: string; diff?: string; cwd?: string; state: 'pending' | Decision; by?: 'phone' | 'desktop' | 'timeout'; ts: number; questions?: RemoteQuestion[]; questionMode?: string; expiresAt?: number; approvalTransport?: 'codex-hook-v1' }
  | { kind: 'turn'; id: string; status: 'started' | 'completed' | 'failed' | 'interrupted'; error?: string; usage?: Usage; ts: number }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; ts: number; parentId?: string };
export type ApprovalKind = 'command' | 'file_change' | 'tool' | 'permission' | 'question';

export interface Timeline { items: TimelineItem[]; session?: SessionInfo; loading: boolean; /** Shown from the on-device cache, not yet confirmed by the computer. */ cachedAt?: number; error?: string; snapshotAt?: number; snapshotStartedAt?: number; nextCursor?: string; loadingEarlier?: boolean; earlierError?: string; historyLease?: string; historyExpanded?: boolean }
export const EMPTY_TIMELINE: Timeline = { items: [], loading: false };
const SESSION_PAGE_SIZE = 10;
const INITIAL_MESSAGE_COUNT = 2;
const OLDER_HISTORY_PAGE_SIZE = 10;
// Older Bridges still interpret limit as events; keep their bounded behavior.
// Current Bridges count actual messages and retain their associated tool events.
const HISTORY_EVENT_BUDGET = 400;
const HISTORY_GAP_PREFIX = '[salcara:history-gap:v1]';
const historyGap = (event: HubEvent) => event.type === 'notice' && event.text.startsWith(HISTORY_GAP_PREFIX);

function upsert(items: TimelineItem[], item: TimelineItem): TimelineItem[] {
  const index = items.findIndex((existing) => existing.kind === item.kind && existing.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

/** Folds one hub event into a session timeline: streamed items replace by id, approvals move pending → resolved. */
export function applyEvent(timeline: Timeline, event: HubEvent): Timeline {
  const ts = event.ts ?? Date.now();
  switch (event.type) {
    case 'session.updated':
      return { ...timeline, session: event.session };
    case 'message': {
      let items = timeline.items;
      // The echo of a follow-up we sent replaces its optimistic bubble.
      if (event.role === 'user') items = items.filter((item) => !(item.kind === 'message' && item.local && item.text.trim() === event.text.trim()));
      return { ...timeline, items: upsert(items, { kind: 'message', id: event.id, role: event.role, text: event.text, final: event.final, ts, parentId: event.parentId }) };
    }
    case 'reasoning': {
      return { ...timeline, items: upsert(timeline.items, { kind: 'reasoning', id: event.id, text: event.text, final: event.final, ts, parentId: event.parentId }) };
    }
    case 'tool': {
      return { ...timeline, items: upsert(timeline.items, { kind: 'tool', id: event.id, tool: event.kind, title: event.title, detail: event.detail, status: event.status, output: event.output, diff: event.diff, exitCode: event.exitCode, ts, parentId: event.parentId, childSessionKeys: event.childSessionKeys }) };
    }
    case 'approval.request': {
      const existing = timeline.items.find((item) => item.kind === 'approval' && item.id === event.approvalId);
      if (existing?.kind === 'approval' && existing.state !== 'pending') return timeline;
      return { ...timeline, items: upsert(timeline.items, { kind: 'approval', id: event.approvalId, approval: event.kind, title: event.title, detail: event.detail, diff: event.diff, cwd: event.cwd, state: event.expiresAt && event.expiresAt <= Date.now() ? 'deny' : 'pending', by: event.expiresAt && event.expiresAt <= Date.now() ? 'timeout' : undefined, ts, questions: event.questions, questionMode: event.questionMode, expiresAt: event.expiresAt, ...(event.approvalTransport === 'codex-hook-v1' ? { approvalTransport: event.approvalTransport } : {}) }) };
    }
    case 'approval.resolved': {
      const existing = timeline.items.find((item) => item.kind === 'approval' && item.id === event.approvalId);
      const base = existing?.kind === 'approval' ? existing : { kind: 'approval' as const, id: event.approvalId, approval: 'tool' as const, title: '操作', ts };
      return { ...timeline, items: upsert(timeline.items, { ...base, state: event.decision, by: event.by }) };
    }
    case 'turn': {
      const id = `turn:${event.status}:${ts}`;
      const last = timeline.items[timeline.items.length - 1];
      // History and the live stream can both report the same turn end.
      if (last?.kind === 'turn' && last.status === event.status) return timeline;
      if (timeline.items.some((item) => item.kind === 'turn' && item.id === id)) return timeline;
      return { ...timeline, items: [...timeline.items, { kind: 'turn', id, status: event.status, error: event.error, usage: event.usage, ts }] };
    }
    case 'notice': {
      const text = historyGap(event) ? '离线期间的临时进度缓存不完整，恢复时读取最近的会话记录；完整历史仍在原电脑。' : event.text;
      const id = `notice:${ts}:${text}`;
      if (timeline.items.some((item) => item.id === id)) return timeline;
      return { ...timeline, items: [...timeline.items, { kind: 'notice', id, level: event.level, text, ts, parentId: event.parentId }] };
    }
    default:
      return timeline;
  }
}

/** Only progress from a pre-snapshot recovery page must avoid downgrading that snapshot. */
export function applyRecoveredEvent(timeline: Timeline, event: HubEvent): Timeline {
  if (event.type === 'message' || event.type === 'reasoning') {
    const existing = timeline.items.find((item) => item.kind === event.type && item.id === event.id);
    if ((existing?.kind === 'message' || existing?.kind === 'reasoning') && existing.final && !event.final) return timeline;
  } else if (event.type === 'tool') {
    const existing = timeline.items.find((item) => item.kind === 'tool' && item.id === event.id);
    if (existing?.kind === 'tool' && existing.status !== 'running' && event.status === 'running') return timeline;
  }
  return applyEvent(timeline, event);
}

/** A bounded computer snapshot is not proof that older, already displayed history was deleted. */
export function mergeHistory(current: Timeline, session: SessionInfo | undefined, history: HubEvent[], concurrentApprovals = new Set<string>()): Timeline {
  let next: Timeline = { items: [], session: session ?? current.session, loading: false };
  for (const event of history) next = applyEvent(next, event);
  const knownItems = new Set(next.items.map(item => `${item.kind}:${item.id}`));
  const confirmed = new Set(next.items.filter((item) => item.kind === 'message' && item.role === 'user' && !item.local).map((item) => (item as { text: string }).text.trim()));
  for (const item of current.items) {
    const known = knownItems.has(`${item.kind}:${item.id}`);
    // A live question/decision received during the read is newer than an absent
    // or older snapshot. Preserve its identity even if computer clocks differ.
    if (item.kind === 'approval' && concurrentApprovals.has(item.id)) {
      next = { ...next, items: upsert(next.items, item) }; continue;
    }
    if (item.kind === 'approval' && known) {
      // Keep a decision the live stream already saw.
      if (item.state !== 'pending') next = { ...next, items: upsert(next.items, item) };
      continue;
    }
    // A stale request absent from the fresh snapshot is not a currently actionable approval.
    if (item.kind === 'approval' && item.state === 'pending') continue;
    // The optimistic bubble is replaced by the real message once the computer has it.
    if (item.kind === 'message' && item.local && confirmed.has(item.text.trim())) continue;
    if (!known) next = { ...next, items: [...next.items, item] };
  }
  return { ...next, items: next.items.sort((a, b) => a.ts - b.ts), session: session ?? next.session };
}

// ——— state ———

export type Probe = 'checking' | 'ok' | 'no';
export type Connection = 'idle' | 'connecting' | 'open' | 'retrying' | 'error';
export interface PendingApproval { approvalId: string; deviceId: string; sessionKey: string; tool: ToolId; title: string; ts: number }
export interface NativeDirectory { list: SessionInfo[]; loading: boolean; loaded: boolean; error?: string; nextCursor?: string }
export interface DeviceSessions { list: SessionInfo[]; loading: boolean; loaded: boolean; error?: string; native?: NativeDirectory; readOnly?: Partial<Record<import('./client').ClaudeDesktopScope, NativeDirectory & { nextCursor?: string; identity: string }>>; directorySurface?: 'desktop' | 'all'; pages?: Partial<Record<AgentId, { nextCursor?: string; loading: boolean; error?: string }>> }
export interface DeviceAgents { list: AgentProfile[]; apis: RemoteApiOption[]; loading: boolean; loaded: boolean; error?: string; autoAll?: boolean }

export interface RemoteState {
  /** 'loading' until the saved choice is read. */
  phase: 'loading' | 'setup' | 'pairing' | 'ready';
  serviceId: string | null;
  connections: RemoteConnection[];
  connectionId: string | null;
  /** Only set after a successful public plugin discovery. QR scans must match exactly. */
  selectedHubUrl: string | null;
  probes: Record<string, Probe>;
  connection: Connection;
  connectionError?: string;
  devices: DeviceStatus[];
  devicesLoaded: boolean;
  sessions: Record<string, DeviceSessions>;
  agents: Record<string, DeviceAgents>;
  timelines: Record<string, Timeline>;
  approvals: Record<string, PendingApproval>;
  signingIn: string | null;
  /** A session to jump to when the remote screen opens (from an approval toast). */
  focus: { deviceId: string; sessionKey: string } | null;
}

const SETTING = 'remote_service';
const initial: RemoteState = { phase: 'loading', serviceId: null, connections: [], connectionId: null, selectedHubUrl: null, probes: {}, connection: 'idle', devices: [], devicesLoaded: false, sessions: {}, agents: {}, timelines: {}, approvals: {}, signingIn: null, focus: null };
let state: RemoteState = initial;
let hub: Hub | null = null;
let lastSeq = 0;
let booted = false;
let screenOpen = false;
let connectionGeneration = 0;
// Pairing requests are separate from station-selection generations. A camera
// can report the same QR more than once, and users can scan a second computer
// before the first claim has returned. Deduplicate the same one-time ticket
// and make an older, different scan unable to select a stale result.
let pairingGeneration = 0;
const pairingFlights = new Map<string, Promise<void>>();
let probeGeneration = 0;
let hubCapabilities = new Set<string>();
const sessionCursors = new Map<string, number>();
const sessionApprovalSnapshots = new Map<string, number>();
const sessionRequests = new Map<string, number>();
const snapshotFlights = new Map<string, { owner: Hub; promise: Promise<void> }>();
const directoryPreloads = new Map<string, AbortController>();
const agentRequests = new Map<string, number>();
const apiChanges = new Map<string, number>();
const apiMutationOwners = new Map<Hub, Set<string>>();
// A station handover changes the Hub object. Keep a device-wide lock as well
// as the legacy per-Hub map so a key change cannot race a handover at the
// exact moment the active Hub object is replaced.
const apiMutationDevices = new Set<string>();

function apiMutationKey(owner: Hub, deviceId: string): string {
  // Device IDs are only unique inside a station. Prefer the physical
  // computer identity when it is available, otherwise include the Hub origin
  // so two different computers with the same legacy device ID do not block
  // one another.
  const profile = state.connections.find(item => item.id === state.connectionId && item.deviceId === deviceId);
  return profile?.computerId ? `computer:${profile.computerId}` : `hub:${owner.url}\u0000${deviceId}`;
}
function apiMutationBusy(owner: Hub, deviceId: string): boolean {
  const key = apiMutationKey(owner, deviceId);
  return apiMutationDevices.has(key) || Boolean(apiMutationOwners.get(owner)?.has(key));
}
interface ApiMutationLock { owner: Hub; key: string; mutations: Set<string> }
function beginApiMutation(owner: Hub, deviceId: string, message: string): ApiMutationLock {
  const key = apiMutationKey(owner, deviceId);
  if (apiMutationBusy(owner, deviceId)) throw new Error(message);
  const mutations = apiMutationOwners.get(owner) ?? new Set<string>();
  mutations.add(key); apiMutationOwners.set(owner, mutations);
  apiMutationDevices.add(key);
  return { owner, key, mutations };
}
function endApiMutation(lock: ApiMutationLock): void {
  lock.mutations.delete(lock.key); if (!lock.mutations.size) apiMutationOwners.delete(lock.owner);
  apiMutationDevices.delete(lock.key);
}

// A station handover is a two-Hub operation. Keep only non-secret intent on
// disk so an app restart can recognize the committed target if the A reply was
// lost after the desktop had already switched to B.
const HANDOVER_SETTING = 'remote_station_handover_v1';
const HANDOVER_TTL_MS = 24 * 60 * 60 * 1000;
interface PendingStationHandover {
  operationId: string; fromConnectionId: string; targetConnectionId: string; deviceId: string; createdAt: number;
  agent?: AgentId; accountId?: string; model?: string; sessionKey?: string;
}
function validHandover(value: unknown): value is PendingStationHandover {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PendingStationHandover>;
  return typeof item.operationId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.operationId)
    && typeof item.fromConnectionId === 'string' && /^[a-f0-9]{64}$/.test(item.fromConnectionId)
    && typeof item.targetConnectionId === 'string' && /^[a-f0-9]{64}$/.test(item.targetConnectionId)
    && typeof item.deviceId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(item.deviceId)
    && typeof item.createdAt === 'number' && Number.isSafeInteger(item.createdAt) && item.createdAt >= 0
    && (item.agent === undefined || item.agent === 'codex' || item.agent === 'claude' || item.agent === 'claude-desktop')
    && (item.accountId === undefined || typeof item.accountId === 'string' && item.accountId.length <= 256 && !/[\r\n\u0000]/.test(item.accountId))
    && (item.model === undefined || typeof item.model === 'string' && item.model.length <= 200 && !/[\r\n\u0000]/.test(item.model))
    && (item.sessionKey === undefined || typeof item.sessionKey === 'string' && item.sessionKey.length <= 512 && !/[\r\n\u0000]/.test(item.sessionKey));
}
async function loadPendingHandover(): Promise<PendingStationHandover | null> {
  const raw = await getSetting(HANDOVER_SETTING).catch(() => null);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!validHandover(value)) { await setSetting(HANDOVER_SETTING, null).catch(() => undefined); return null; }
    if (Date.now() - value.createdAt > HANDOVER_TTL_MS) { await setSetting(HANDOVER_SETTING, null).catch(() => undefined); return null; }
    return { ...value };
  } catch {
    await setSetting(HANDOVER_SETTING, null).catch(() => undefined);
    return null;
  }
}
async function savePendingHandover(value: PendingStationHandover, expectedGeneration = connectionGeneration): Promise<void> {
  if (expectedGeneration !== connectionGeneration) throw new Error('连接已切换，请刷新确认');
  await setSetting(HANDOVER_SETTING, JSON.stringify(value));
  // A sign-out or another station choice can happen while the settings write
  // is suspended. Do not leave a stale journal that could auto-switch a
  // computer after the user explicitly left this connection.
  if (expectedGeneration !== connectionGeneration) {
    const current = await loadPendingHandover();
    if (current?.operationId === value.operationId) await setSetting(HANDOVER_SETTING, null).catch(() => undefined);
    throw new Error('连接已切换，请刷新确认');
  }
}
async function discardPendingHandover(): Promise<void> { await setSetting(HANDOVER_SETTING, null).catch(() => undefined); }
async function clearPendingHandover(operationId?: string): Promise<void> {
  // An omitted operation ID means that the caller has no handover ownership;
  // never erase another in-flight journal as a side effect of switching views.
  if (!operationId) return;
  const current = await loadPendingHandover();
  if (current?.operationId === operationId) await setSetting(HANDOVER_SETTING, null).catch(() => undefined);
}

let handoverRecoveryFlight: Promise<boolean> | null = null;
// Station handover, recovery and revoke all mutate the same phone↔computer
// ownership. Serialize those operations so a foreground recovery cannot move
// the phone to B while a user-initiated A→C switch or revoke is still in
// flight. Account-only API changes keep their existing fail-fast lock.
let stationChangeTail: Promise<void> = Promise.resolve();
function serializeStationChange<T>(task: () => Promise<T>): Promise<T> {
  const run = stationChangeTail.then(task, task);
  stationChangeTail = run.then(() => undefined, () => undefined);
  return run;
}
function sameHandoverPayload(intent: PendingStationHandover, agent?: AgentId, accountId?: string, model?: string, sessionKey?: string): boolean {
  return (intent.agent ?? '') === (agent ?? '') && (intent.accountId ?? '') === (accountId ?? '')
    && (intent.model ?? '') === (model?.trim() ?? '') && (intent.sessionKey ?? '') === (sessionKey ?? '');
}
function handoverPayloadHash(target: RemoteConnection, agent?: AgentId, accountId?: string, model?: string, sessionKey?: string): string {
  const data = [target.hubUrl, target.deviceId, target.computerId ?? '', agent ?? '', accountId ?? '', model?.trim() ?? '', sessionKey ?? ''].join('\u0000');
  return Array.from(sha256(new TextEncoder().encode(data)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function optionalHandoverReplyMatches(result: unknown, operationId: string, payloadHash: string): boolean {
  if (!result || typeof result !== 'object') return true; // old Bridge reply
  const value = result as Record<string, unknown>;
  if (value.switched !== undefined && value.switched !== true) return false;
  if (value.operationId !== undefined && value.operationId !== operationId) return false;
  if (value.payloadHash !== undefined && value.payloadHash !== payloadHash) return false;
  return true;
}
const listeners = new Set<() => void>();
const alertListeners = new Set<(approval: PendingApproval) => void>();

function set(patch: Partial<RemoteState> | ((current: RemoteState) => Partial<RemoteState>)) {
  const previous = state;
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  try { persistChanges(previous, state); } catch { /* the cache is optional */ }
  listeners.forEach((listener) => listener());
}

/** Keep confirmed CLI threads and session lists on the device (see cache.ts). */
function remoteCacheScope(): string | null {
  return state.connectionId && hub?.pairToken ? `${state.connectionId}|credential:${deliveryCredentialId(hub.pairToken)}` : null;
}
function persistChanges(previous: RemoteState, next: RemoteState) {
  const scope = remoteCacheScope();
  if (!scope || previous.connectionId !== next.connectionId) return;
  if (previous.timelines !== next.timelines) {
    for (const [key, timeline] of Object.entries(next.timelines)) {
      if (timeline === previous.timelines[key] || !timeline.snapshotAt || timeline.loading || !timeline.items.length) continue;
      const sessionKey = key.slice(key.indexOf('|') + 1);
      if (isReadOnlyDesktopSession(sessionKey) || timeline.historyLease || timeline.session?.controlSurface === 'desktop' || timeline.session?.controlSurface === 'read-only') continue;
      // Approvals and unsent local echoes are live state; never restore them from disk.
      saveCachedThread(scope, key, { items: timeline.items.filter((item) => item.kind !== 'approval' && !(item.kind === 'message' && item.local)), session: timeline.session });
    }
  }
  if (previous.sessions !== next.sessions) {
    for (const [deviceId, entry] of Object.entries(next.sessions)) {
      if (entry && entry !== previous.sessions[deviceId] && entry.loaded && !entry.error) saveCachedSessions(scope, deviceId, entry.list);
    }
  }
}

/** Show the last confirmed copy of a thread at once; the computer's snapshot replaces it when it arrives. */
export async function hydrateCachedThread(deviceId: string, sessionKey: string): Promise<void> {
  const scope = remoteCacheScope(), owner = hub;
  const key = timelineKey(deviceId, sessionKey);
  if (!scope || isReadOnlyDesktopSession(sessionKey) || isNativeSession(deviceId, sessionKey) || state.timelines[key]?.historyLease || state.timelines[key]?.items.length) return;
  const cached = await loadCachedThread(scope, key);
  if (!cached || owner !== hub || remoteCacheScope() !== scope || isNativeSession(deviceId, sessionKey) || state.timelines[key]?.historyLease) return;
  set((current) => {
    const existing = current.timelines[key];
    if (existing?.items.length || existing?.snapshotAt || existing?.historyLease || existing?.session?.controlSurface === 'desktop') return {};
    return { timelines: { ...current.timelines, [key]: { ...(existing ?? EMPTY_TIMELINE), items: cached.items as TimelineItem[], session: existing?.session ?? cached.session, cachedAt: cached.savedAt } } };
  });
}

/** Recent tasks for the saved computer, readable before (or without) a connection. */
export async function hydrateCachedSessions(deviceId: string): Promise<void> {
  const scope = remoteCacheScope(), owner = hub;
  if (!scope || state.sessions[deviceId]?.list.length) return;
  const list = await loadCachedSessions(scope, deviceId);
  if (!list?.length || owner !== hub || remoteCacheScope() !== scope) return;
  set((current) => current.sessions[deviceId]?.list.length ? {} : { sessions: { ...current.sessions, [deviceId]: { ...(current.sessions[deviceId] ?? { loading: false, loaded: false }), list } } });
}

export const timelineKey = (deviceId: string, sessionKey: string) => `${deviceId}|${sessionKey}`;

export function useRemote(): RemoteState {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state, () => state);
}
export function usePendingApprovalCount(): number {
  const approvals = useRemote().approvals;
  return Object.keys(approvals).length;
}
export function getRemoteState() { return state; }

export function setRemoteScreenOpen(open: boolean) {
  screenOpen = open;
  if (!open) stopStream();
  if (open && hub?.pairToken) {
    void recoverPendingHandoverOnce();
    void refreshDevices(true);
  }
}
export function setRemoteFocus(focus: RemoteState['focus']) { set({ focus }); }
/** Foreground alerts for approvals that arrive while the remote screen is closed. */
const eventListeners = new Set<(event: HubEvent) => void>();
/** Live (non-replayed) events, e.g. for task-finished notifications. Listeners must not throw. */
export function onRemoteEvent(listener: (event: HubEvent) => void): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}
export function isRemoteScreenOpen(): boolean { return screenOpen; }
/** For the native background watch only: the current Hub and this session's read cursor. Kept in memory, never persisted. */
export function watchCredentials(): { url: string; key?: string; pairToken?: string } | null { return hub?.pairToken ? { url: hub.url, key: hub.key, pairToken: hub.pairToken } : null; }
export function sessionCursor(deviceId: string, sessionKey: string): number { return sessionCursors.get(timelineKey(deviceId, sessionKey)) ?? 0; }

export function onApprovalAlert(listener: (approval: PendingApproval) => void): () => void {
  alertListeners.add(listener);
  return () => { alertListeners.delete(listener); };
}

function handleEvent(event: HubEvent, recovered = false) {
  // Native Claude history has an account-stamped command channel only. An old
  // Hub event must not recreate a cleared namespace or turn it into a worker.
  if (event.sessionKey.startsWith('claude-desktop:')) return;
  if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq);
  const key = timelineKey(event.deviceId, event.sessionKey);
  let newApproval = false;
  set((current) => {
    const patch: Partial<RemoteState> = { timelines: { ...current.timelines, [key]: (recovered ? applyRecoveredEvent : applyEvent)(current.timelines[key] ?? EMPTY_TIMELINE, event) } };
    if (event.type === 'session.updated') {
      const entry = current.sessions[event.deviceId] ?? { list: [], loading: false, loaded: false };
      const list = [event.session, ...entry.list.filter((item) => item.sessionKey !== event.session.sessionKey)].sort((a, b) => b.updatedAt - a.updatedAt);
      // Native order belongs to a directory snapshot. A live status update must
      // not insert an unauthorized history thread or rearrange native pins.
      const native = entry.native && { ...entry.native, list: entry.native.list.map(item => item.sessionKey === event.session.sessionKey
        ? { ...event.session, controlSurface: 'desktop' as const, sidebarIndex: item.sidebarIndex, pinnedIndex: item.pinnedIndex } : item) };
      patch.sessions = { ...current.sessions, [event.deviceId]: { ...entry, list, ...(native ? { native } : {}) } };
    }
    if (event.type === 'approval.request') {
      const item = patch.timelines![key].items.find((entry) => entry.kind === 'approval' && entry.id === event.approvalId);
      const approvals = { ...current.approvals };
      if (item?.kind === 'approval' && item.state === 'pending' && (!item.expiresAt || item.expiresAt > Date.now())) {
        newApproval = !approvals[event.approvalId];
        approvals[event.approvalId] = { approvalId: event.approvalId, deviceId: event.deviceId, sessionKey: event.sessionKey, tool: event.tool, title: event.title, ts: event.ts };
      } else delete approvals[event.approvalId];
      patch.approvals = approvals;
    }
    if (event.type === 'approval.resolved' && current.approvals[event.approvalId]) {
      const approvals = { ...current.approvals };
      delete approvals[event.approvalId];
      patch.approvals = approvals;
    }
    return patch;
  });
  if (!recovered) eventListeners.forEach((listener) => { try { listener(event); } catch { /* decorative */ } });
  // Replayed history is not news.
  if (event.type === 'approval.request' && newApproval && !recovered && !screenOpen && Date.now() - event.ts < 120_000 && AppState.currentState === 'active') {
    const approval = state.approvals[event.approvalId];
    if (approval) alertListeners.forEach((listener) => listener(approval));
  }
}

function handleDevice(device: DeviceStatus) {
  set((current) => {
    const exists = current.devices.some((item) => item.deviceId === device.deviceId);
    return { devices: exists ? current.devices.map((item) => item.deviceId === device.deviceId ? device : item) : [...current.devices, device] };
  });
}

// Pairing is persistent; an HTTP connection is not. No default SSE, watchdog or background polling.
function startDemandConnection() { if (screenOpen && hub?.pairToken) void refreshDevices(true); }
function stopStream() {
  for (const controller of directoryPreloads.values()) controller.abort();
  directoryPreloads.clear();
  // There is no permanent phone stream to close.
}

function resetConnection(patch: Partial<RemoteState>) {
  stopStream(); connectionGeneration += 1; hub = null; lastSeq = 0;
  hubCapabilities.clear(); sessionCursors.clear(); sessionApprovalSnapshots.clear(); sessionRequests.clear(); snapshotFlights.clear(); modelCache.clear(); modelRequests.clear(); apiChanges.clear();
  set({ ...initial, phase: 'setup', connections: state.connections, probes: state.probes, ...patch });
}

/** First step: explicitly choose a station and verify its plugin. No model API key is read. */
export async function connectStation(stationUrl: string, stillWanted: () => boolean = () => true): Promise<void> {
  // Invalidate an in-flight login/QR request as soon as the user chooses a
  // different station. The old request may finish after discovery and must
  // not overwrite this selection.
  const generation = ++connectionGeneration;
  const previousConnectionId = state.connectionId;
  const previousServiceId = state.serviceId;
  let selectionAttempted = false;
  let serviceAttempted = false;
  let committed = false;
  set({ signingIn: 'station' });
  try {
    const discovery = await discoverStation(stationUrl);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    // Discovery is read-only. Leaving the setup page must not discard the
    // currently paired computer or its cached conversations when it finishes.
    if (!stillWanted()) return;
    selectionAttempted = true;
    await selectConnection(null);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    if (!stillWanted()) return;
    serviceAttempted = true;
    await setSetting(SETTING, null);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    if (!stillWanted()) return;
    committed = true;
    resetConnection({ phase: 'pairing', selectedHubUrl: discovery.url, signingIn: null });
    hub = { url: discovery.url };
    hubCapabilities = new Set(discovery.capabilities);
  } finally {
    // Cancellation during a SQLite await must also retain the saved startup
    // choice. Never restore over a different connection that has since won.
    if (!committed && generation === connectionGeneration) {
      try {
        if (selectionAttempted) await selectConnection(previousConnectionId);
        if (serviceAttempted && generation === connectionGeneration) await setSetting(SETTING, previousServiceId);
      } finally { if (generation === connectionGeneration && state.signingIn === 'station') set({ signingIn: null }); }
    }
  }
}

export async function useSavedConnection(id: string, deferNetwork = false, options: { skipHandover?: boolean; handoverOperationId?: string } = {}): Promise<void> {
  const profile = state.connections.find((item) => item.id === id);
  if (!profile) throw new Error('没有找到这台电脑的连接记录');
  const selectionGeneration = connectionGeneration;
  const currentProfile = state.connections.find((item) => item.id === state.connectionId);
  const currentOwner = hub;
  // Selecting another station record for the same physical computer is a
  // server handover, not merely a phone-side view change. Ask the currently
  // active Hub to atomically switch the desktop first; otherwise the phone
  // could show B while the computer remains attached to A.
  if (!options.skipHandover && !deferNetwork && currentOwner?.pairToken && currentProfile && currentProfile.id !== profile.id
    && currentProfile.deviceId === profile.deviceId && (!currentProfile.computerId || !profile.computerId || currentProfile.computerId !== profile.computerId)) {
    // Legacy records do not carry the physical-computer identity. Never move
    // the phone between two station records that expose the same device ID
    // without that proof; re-pair after updating the computer instead.
    throw new Error('无法确认这是同一台电脑，请更新电脑端后重新扫码');
  }
  if (!options.skipHandover && !deferNetwork && currentOwner?.pairToken && currentProfile && currentProfile.id !== profile.id
    && currentProfile.computerId && profile.computerId && currentProfile.computerId === profile.computerId) {
    // Keep one lock implementation for station-only and API+station changes.
    // The helper journals the operation and reuses the same exact receipt path.
    await switchRemoteStation(currentProfile.deviceId, profile.id);
    return;
  }
  if (selectionGeneration !== connectionGeneration) throw new Error('连接选择已改变，请重试');
  // When an A→B handover has already been committed, validate B before
  // clearing the A-side in-memory connection. A temporary B outage must not
  // strand the phone without a retry path to the old station.
  let preflightDiscovery: Awaited<ReturnType<typeof discoverStation>> | null = null;
  let preflightToken: string | null = null;
  if (!deferNetwork && options.handoverOperationId) {
    preflightDiscovery = await discoverStation(profile.hubUrl);
    preflightToken = await connectionToken(profile);
    if (!preflightToken) throw new Error('目标中转站的手机配对已失效，请重新扫码');
    if (selectionGeneration !== connectionGeneration) throw new Error('连接选择已改变，请重试');
  }
  resetConnection({ phase: 'ready', connectionId: profile.id, selectedHubUrl: profile.hubUrl, signingIn: id, connection: 'connecting' });
  const generation = connectionGeneration;
  try {
    const discovery = deferNetwork ? null : (preflightDiscovery ?? await discoverStation(profile.hubUrl));
    const token = preflightToken ?? await connectionToken(profile);
    if (generation !== connectionGeneration) return;
    if (!token) {
      set({ phase: 'pairing', signingIn: null, connection: 'idle', connectionId: null });
      hub = { url: profile.hubUrl };
      await selectConnection(null);
      return;
    }
    hub = { url: profile.hubUrl, pairToken: token, deviceId: profile.deviceId };
    const activeOwner = hub;
    hubCapabilities = new Set(discovery?.capabilities ?? []);
    if (!await selectConnectionIf(profile.id, () => generation === connectionGeneration && hub === activeOwner)) return;
    await clearPendingHandover(options.handoverOperationId);
    if (generation !== connectionGeneration || activeOwner !== hub) return;
    set({ signingIn: null, ...(deferNetwork ? { connection: 'idle' as const } : {}) });
    if (!deferNetwork) {
      // The desktop acknowledges on A before reconnecting B. Give that
      // bounded reconnect a short grace period; no permanent phone stream or
      // polling loop is created.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (generation !== connectionGeneration || activeOwner !== hub) return;
        await refreshDevices(true);
        if (generation !== connectionGeneration || activeOwner !== hub) return;
        if (state.devices.some((item) => item.deviceId === profile.deviceId && item.online)) break;
        if (attempt < 5) await new Promise<void>(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (generation === connectionGeneration) set({ signingIn: null, devicesLoaded: true, connection: 'error', connectionError: (error as Error).message });
    throw error;
  }
}

/** Scanner validation and confirmation are separate: merely scanning never sends a ticket. */
export function parseRemoteQr(raw: string): PairQr {
  if (!state.selectedHubUrl || state.phase !== 'pairing') throw new Error('请先输入中转站地址并检查远程插件');
  return readPairQr(raw, state.selectedHubUrl);
}

/** Direct scanner: validate locally; do not send any credential merely on scan. */
export function parseScannedRemoteQr(raw: string): PairQr { return readPairQr(raw, null); }

function pairingKey(qr: PairQr): string { return `${qr.hubUrl}\u0000${qr.deviceId}\u0000${qr.ticket}`; }

/** The QR supplies the station. Discover it anonymously after user confirmation,
 * then claim the single-use ticket. An existing pairing is retained on failure. */
async function pairScannedRemoteQrImpl(validated: PairQr, stillWanted: () => boolean, attempt: number): Promise<void> {
  const generation = connectionGeneration;
  const discovery = await discoverStation(validated.hubUrl);
  if (validated.computerId && !discovery.capabilities.includes('pair.single-phone.v1')) throw new Error('请先更新中转站远程服务后重新扫码');
  if (generation !== connectionGeneration || attempt !== pairingGeneration || !stillWanted()) throw new Error('连接选择已改变，请重新扫码');
  // Recheck expiry after the network check, before transmitting the ticket.
  const identity = validated.computerId ? await phoneIdentity() : undefined;
  if (generation !== connectionGeneration || attempt !== pairingGeneration || !stillWanted()) throw new Error('连接选择已改变，请重新扫码');
  const result = await confirmQrPair(readPairQr(JSON.stringify(validated), discovery.url), identity);
  // A different scan may have superseded this one while the one-time ticket
  // was in flight. Keep the credential durable, but never select the stale
  // computer or replace the active in-memory connection.
  const profile: RemoteConnection = { id: connectionId(validated.hubUrl, validated.deviceId), hubUrl: validated.hubUrl,
    deviceId: validated.deviceId, deviceName: result.device.name, pairedAt: Date.now(), ...(validated.computerId ? { computerId: validated.computerId } : {}) };
  const connections = await saveConnection(profile, result.token);
  if (generation !== connectionGeneration || attempt !== pairingGeneration || !stillWanted()) { set({ connections }); return; }
  if (!await selectConnectionIf(profile.id, () => generation === connectionGeneration && attempt === pairingGeneration)) { set({ connections }); return; }
  resetConnection({ phase: 'ready', connections, connectionId: profile.id, selectedHubUrl: profile.hubUrl,
    devices: [result.device], devicesLoaded: true, connection: 'open', connectionError: undefined });
  hub = { url: profile.hubUrl, pairToken: result.token, deviceId: profile.deviceId };
  hubCapabilities = new Set(discovery.capabilities);
}

/**
 * Claiming is idempotent within the process for one QR ticket. Camera
 * callbacks often deliver the same frame several times; a second HTTP claim
 * would otherwise consume the ticket error and could surface a false failure
 * after the first claim already succeeded. A different ticket supersedes the
 * older attempt at every await boundary.
 */
function enqueuePairing(key: string, task: (attempt: number) => Promise<void>): Promise<void> {
  const existing = pairingFlights.get(key);
  if (existing) return existing;
  const attempt = ++pairingGeneration;
  const flight = task(attempt);
  pairingFlights.set(key, flight);
  void flight.finally(() => { if (pairingFlights.get(key) === flight) pairingFlights.delete(key); }).catch(() => undefined);
  return flight;
}

export function pairScannedRemoteQr(qr: PairQr, stillWanted: () => boolean = () => true): Promise<void> {
  const validated = readPairQr(JSON.stringify(qr), null);
  return enqueuePairing(pairingKey(validated), attempt => pairScannedRemoteQrImpl(validated, stillWanted, attempt));
}

async function pairRemoteQrImpl(validated: PairQr, attempt: number): Promise<void> {
  const generation = connectionGeneration;
  const result = await confirmQrPair(validated, validated.computerId ? await phoneIdentity() : undefined);
  if (generation !== connectionGeneration || attempt !== pairingGeneration) throw new Error('连接选择已改变，请重新扫码');
  const profile: RemoteConnection = {
    id: connectionId(validated.hubUrl, validated.deviceId), hubUrl: validated.hubUrl,
    deviceId: validated.deviceId, deviceName: result.device.name, pairedAt: Date.now(), ...(validated.computerId ? { computerId: validated.computerId } : {}),
  };
  const connections = await saveConnection(profile, result.token);
  if (generation !== connectionGeneration || attempt !== pairingGeneration) { set({ connections }); return; }
  if (!await selectConnectionIf(profile.id, () => generation === connectionGeneration && attempt === pairingGeneration)) { set({ connections }); return; }
  hub = { url: profile.hubUrl, pairToken: result.token, deviceId: profile.deviceId };
  lastSeq = 0;
  set({ phase: 'ready', connections, connectionId: profile.id, devices: [result.device], devicesLoaded: true, connection: 'open', connectionError: undefined });
}

export function pairRemoteQr(qr: PairQr): Promise<void> {
  if (!state.selectedHubUrl || state.phase !== 'pairing') throw new Error('请先连接中转站');
  const validated = readPairQr(JSON.stringify(qr), state.selectedHubUrl);
  return enqueuePairing(pairingKey(validated), attempt => pairRemoteQrImpl(validated, attempt));
}

export function revokeRemoteConnection(): Promise<void> {
  const generation = connectionGeneration, owner = hub;
  return serializeStationChange(() => {
    if (generation !== connectionGeneration || owner !== hub) throw new Error('连接已改变，请刷新后再解除绑定');
    return revokeRemoteConnectionImpl();
  });
}

async function revokeRemoteConnectionImpl(): Promise<void> {
  const profile = state.connections.find((item) => item.id === state.connectionId);
  if (!profile || !hub?.pairToken) throw new Error('请先恢复这台电脑的连接');
  const generation = connectionGeneration;
  const owner = hub;
  const mutation = beginApiMutation(owner, profile.deviceId, 'API 或中转站正在切换，请稍候');
  try {
  const cacheScope = remoteCacheScope();
  // A physical computer may have several station-specific identities. Revoke
  // all of this phone's known channels, not just the currently selected one.
  const related = state.connections.filter(item => item.id === profile.id || profile.computerId && item.computerId === profile.computerId);
  // Keep the exact credentials used by this revoke. A fresh QR claim can
  // replace one of these SecureStore entries while the network request is in
  // flight; later cleanup must not remove that replacement.
  const expectedTokens = new Map<string, string>();
  const revoked = await Promise.allSettled(related.map(async item => {
    const token = item.id === profile.id ? owner.pairToken : await connectionToken(item);
    if (!token) return;
    expectedTokens.set(item.id, token);
    try { await revokePair({ url: item.hubUrl, deviceId: item.deviceId, pairToken: token }); }
    catch (error) { if (!(error instanceof HubError) || error.status !== 401 && error.status !== 403) throw error; }
  }));
  if (revoked.some(result => result.status === 'rejected')) throw new Error('部分中转站暂时未能解除绑定，请网络恢复后重试');
  // A new QR pairing may have replaced one of these profiles while the
  // network revocation was in flight. Never let the old revoke finish by
  // deleting the newly issued token or resetting the new connection.
  if (generation !== connectionGeneration || owner !== hub) throw new Error('连接已改变，请刷新后再解除绑定');
  if (cacheScope) await clearRemoteCache(cacheScope, [profile.deviceId, ...Object.keys(state.sessions)]);
  // Retire the pre-credential cache too; never migrate unverified old contents.
  await clearRemoteCache(profile.id, [profile.deviceId]);
  let connections = state.connections;
  for (const item of related) {
    if (generation !== connectionGeneration || owner !== hub) return;
    const expectedToken = expectedTokens.get(item.id);
    if (item.id !== profile.id) {
      if (expectedToken) await clearRemoteCache(`${item.id}|credential:${deliveryCredentialId(expectedToken)}`, [item.deviceId]);
      await clearRemoteCache(item.id, [item.deviceId]);
    }
    try { connections = await forgetConnection(item, expectedToken); }
    catch {
      // The server revoke has already succeeded. A failing OS keychain delete
      // must not leave the revoked token in active memory or strand cleanup of
      // other stations. Only a successfully persisted index removal is enough
      // to continue; otherwise keep the records available for a safe retry.
      const remaining = await loadConnections();
      if (remaining.some(connection => connection.id === item.id)) throw new Error('解除绑定已生效，本地记录未清理，请重试');
      connections = remaining;
    }
  }
  if (generation !== connectionGeneration || owner !== hub) return;
  await discardPendingHandover();
  resetConnection({ connections });
  } finally { endApiMutation(mutation); }
}

/** Reads the saved relay once and connects; call whenever the service list changes. */
export async function bootRemote(providers: ProviderProfile[]): Promise<void> {
  if (!booted) {
    const generation = connectionGeneration;
    booted = true;
    const connections = await loadConnections().catch(() => []);
    if (generation !== connectionGeneration) return;
    const selected = await selectedConnection().catch(() => null);
    if (generation !== connectionGeneration) return;
    set({ connections });
    if (selected && connections.some((item) => item.id === selected)) {
      await useSavedConnection(selected, true).catch(() => undefined);
      // If the process died after the desktop committed B but before this
      // phone persisted its selected connection, reconcile the non-secret
      // handover journal opportunistically.  Offline B simply leaves A active
      // and will be retried on the next foreground/startup check.
      await recoverPendingHandoverOnce();
      return;
    }
    const saved = await getSetting(SETTING).catch(() => null);
    set({ serviceId: saved, phase: saved ? 'ready' : 'setup' });
  }
  if (state.connectionId || state.selectedHubUrl) return;
  const service = providers.find((item) => item.id === state.serviceId);
  if (state.serviceId && !service && providers.length) { await signOutRemote(); return; }
  if (!service || hub) return;
  const key = await getProviderKey(service.id).catch(() => null);
  const url = hubUrlFor(service.baseUrl);
  if (!key || !url) return;
  const pairToken = await getPairToken(service.id).catch(() => null);
  hub = { url, key, pairToken: pairToken ?? undefined };
  set({ phase: pairToken ? 'ready' : 'pairing' });
  if (pairToken) startDemandConnection();
}

/** Returning to the remote screen performs one short check, never opens a permanent stream. */
export function setRemoteForeground(active: boolean) {
  if (!active) stopStream();
  if (!hub?.pairToken) return;
  if (active && screenOpen) {
    void recoverPendingHandoverOnce();
    startDemandConnection();
  }
}

export async function probeServices(providers: ProviderProfile[]): Promise<void> {
  const generation = ++probeGeneration;
  const byHub = new Map<string, string[]>();
  for (const service of providers) {
    const url = hubUrlFor(service.baseUrl);
    if (!url) { if (generation === probeGeneration) set((current) => ({ probes: { ...current.probes, [service.id]: 'no' } })); continue; }
    byHub.set(url, [...(byHub.get(url) ?? []), service.id]);
  }
  if (generation !== probeGeneration) return;
  set((current) => {
    const probes = { ...current.probes };
    for (const ids of byHub.values()) for (const id of ids) if (probes[id] !== 'ok') probes[id] = 'checking';
    return { probes };
  });
  await Promise.all([...byHub].map(async ([url, ids]) => {
    const result: Probe = (await ping(url)) ? 'ok' : 'no';
    if (generation !== probeGeneration) return;
    set((current) => ({ probes: { ...current.probes, ...Object.fromEntries(ids.map((id) => [id, result])) } }));
  }));
}

export async function signInRemote(service: ProviderProfile): Promise<void> {
  const url = hubUrlFor(service.baseUrl);
  if (!url) throw new Error('这个 API 地址不对');
  // A new station login supersedes any QR confirmation or previous login that
  // is still waiting on the network. Existing state is kept until this login
  // proves the target, but stale completions are rejected by this generation.
  const generation = ++connectionGeneration;
  set({ signingIn: service.id });
  try {
    const key = await getProviderKey(service.id);
    if (!key) throw new Error(`没有找到“${service.name}”的 API 密钥`);
    const pairToken = await getPairToken(service.id).catch(() => null);
    const next = { url, key, pairToken: pairToken ?? undefined };
    await me(next);
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    let paired = Boolean(pairToken);
    if (paired) {
      try { await fetchDevices(next); }
      catch (error) {
        // A transient outage must not erase an existing one-to-one pairing.
        if (error instanceof HubError && error.status === 403) {
          paired = false;
          await deletePairToken(service.id, pairToken ?? undefined).catch(() => undefined);
          next.pairToken = undefined;
        }
      }
    }
    if (generation !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    stopStream(); connectionGeneration += 1;
    const committedGeneration = connectionGeneration;
    hub = next;
    lastSeq = 0;
    await setSetting(SETTING, service.id);
    if (committedGeneration !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    await selectConnection(null);
    if (committedGeneration !== connectionGeneration) throw new Error('连接选择已改变，请重试');
    set({ ...initial, connections: state.connections, phase: paired ? 'ready' : 'pairing', serviceId: service.id, probes: state.probes, signingIn: null });
    if (committedGeneration === connectionGeneration && paired) startDemandConnection();
  } finally {
    if (generation === connectionGeneration && state.signingIn === service.id) set({ signingIn: null });
  }
}

export async function signOutRemote(): Promise<void> {
  const generation = ++connectionGeneration;
  const serviceId = state.serviceId;
  stopStream();
  await discardPendingHandover();
  const oldPairToken = serviceId ? await getPairToken(serviceId).catch(() => null) : null;
  if (generation !== connectionGeneration) return;
  if (serviceId) await deletePairToken(serviceId, oldPairToken ?? undefined).catch(() => undefined);
  if (generation !== connectionGeneration) return;
  hub = null;
  lastSeq = 0;
  await setSetting(SETTING, null).catch(() => undefined);
  if (generation !== connectionGeneration) return;
  await selectConnection(null).catch(() => undefined);
  if (generation !== connectionGeneration) return;
  set({ ...initial, phase: 'setup', probes: state.probes, connections: state.connections });
}

export async function pairRemote(code: string): Promise<void> {
  if (!hub || !state.serviceId) throw new Error('请先选择中转站');
  const owner = hub;
  const serviceId = state.serviceId;
  const generation = connectionGeneration;
  const result = await confirmPair(owner, code);
  if (generation !== connectionGeneration || owner !== hub || serviceId !== state.serviceId) throw new Error('连接选择已改变，请重试');
  await savePairToken(serviceId, result.token);
  if (generation !== connectionGeneration || owner !== hub || serviceId !== state.serviceId) {
    await deletePairToken(serviceId, result.token).catch(() => undefined);
    throw new Error('连接选择已改变，请重试');
  }
  hub = { ...owner, pairToken: result.token };
  lastSeq = 0;
  set({ phase: 'ready', devices: [result.device], devicesLoaded: true, connection: 'open', connectionError: undefined });
}

export async function refreshDevices(quiet = false): Promise<void> {
  if (!hub || !hub.pairToken) return;
  const owner = hub;
  const generation = connectionGeneration;
  try {
    if (!hubCapabilities.size) {
      const discovery = await discoverStation(owner.url);
      if (owner !== hub) return;
      hubCapabilities = new Set(discovery.capabilities);
    }
    const list = await fetchDevices(owner);
    if (owner !== hub) return;
    set({ devices: list, devicesLoaded: true, connection: 'open', connectionError: undefined });
  } catch (error) {
    if (owner !== hub || generation !== connectionGeneration) return;
    if (error instanceof HubError && (error.status === 403 || error.status === 401)) {
      stopStream();
      const cacheScope = remoteCacheScope();
      if (cacheScope) await clearRemoteCache(cacheScope, Object.keys(state.sessions)).catch(() => undefined);
      const profile = state.connections.find((item) => item.id === state.connectionId
        && item.hubUrl === owner.url && item.deviceId === owner.deviceId);
      // Retire a multi-station profile, not just the in-memory Hub. Otherwise
      // bootRemote() reads the revoked SecureStore token again after restart.
      // The profile is removed only for this exact station/device; other Hub
      // connections for the same physical computer remain usable.
      const revokedHub = { ...owner, pairToken: undefined };
      hub = revokedHub;
      connectionGeneration += 1;
      let connections = state.connections;
      if (profile) {
        try { connections = await forgetConnection(profile, owner.pairToken); }
        catch { connections = await loadConnections().catch(() => state.connections.filter((item) => item.id !== profile.id)); }
        if (hub !== revokedHub) return;
        await clearRemoteCache(profile.id, [profile.deviceId]).catch(() => undefined);
      } else if (state.serviceId) {
        await deletePairToken(state.serviceId, owner.pairToken).catch(() => undefined);
      }
      if (hub !== revokedHub) return;
      await discardPendingHandover();
      set({ phase: 'pairing', serviceId: profile ? null : state.serviceId, connections,
        connectionId: null, selectedHubUrl: owner.url, devices: [], sessions: {}, agents: {}, timelines: {}, approvals: {}, focus: null,
        connection: 'error', connectionError: error.message });
    }
    set({ devicesLoaded: true, connectionError: (error as Error).message, connection: 'error' });
    if (!quiet) throw error;
  }
}

function need(): Hub {
  if (!hub?.pairToken) throw new Error('请先扫码配对电脑');
  return hub;
}

export function remoteDeliveryScope(): string {
  const station = state.connectionId ?? state.selectedHubUrl ?? state.serviceId ?? '';
  return hub?.pairToken ? `${station}|credential:${deliveryCredentialId(hub.pairToken)}` : station;
}
export function getPendingRemoteMessage(deviceId: string, sessionKey: string) { return pendingDelivery(remoteDeliveryScope(), deviceId, sessionKey); }
export function cancelPendingRemoteMessage(deviceId: string, sessionKey: string, scope = remoteDeliveryScope()) { return cancelPendingDelivery(scope, deviceId, sessionKey); }

/**
 * Returns whether any outgoing message or approval answer for this computer is
 * still awaiting a delivery receipt on the active station. A station handover
 * must be all-or-nothing: switching first would move the phone to B while a
 * retry token remains scoped to A. The durable outboxes are checked even when
 * the corresponding session directory is not loaded yet.
 */
async function hasPendingDeliveryForDevice(deviceId: string): Promise<boolean> {
  const scope = remoteDeliveryScope();
  if ((await pendingDeliveriesForDevice(scope, deviceId)).length > 0) return true;
  if ((await pendingQuestionReceiptsForDevice(scope, deviceId)).length > 0) return true;

  // Keep the state walk as a compatibility fallback for older outbox records
  // that predate the device-wide listing helpers.
  const sessionKeys = new Set<string>();
  const prefix = `${deviceId}|`;
  for (const key of Object.keys(state.timelines)) {
    if (key.startsWith(prefix)) sessionKeys.add(key.slice(prefix.length));
  }
  const entry = state.sessions[deviceId];
  for (const session of entry?.list ?? []) sessionKeys.add(session.sessionKey);
  for (const session of entry?.native?.list ?? []) sessionKeys.add(session.sessionKey);
  for (const directory of Object.values(entry?.readOnly ?? {})) {
    for (const session of directory?.list ?? []) sessionKeys.add(session.sessionKey);
  }
  for (const approval of Object.values(state.approvals)) {
    if (approval.deviceId === deviceId) sessionKeys.add(approval.sessionKey);
  }
  for (const sessionKey of sessionKeys) {
    if (await pendingDelivery(scope, deviceId, sessionKey)) return true;
  }
  return false;
}

async function targetComputerOnline(profile: RemoteConnection): Promise<boolean> {
  const token = await connectionToken(profile);
  if (!token) return false;
  try {
    const list = await fetchDevices({ url: profile.hubUrl, pairToken: token, deviceId: profile.deviceId });
    return list.some((item) => item.deviceId === profile.deviceId && item.online);
  } catch { return false; }
}

async function handoverPayloadApplied(profile: RemoteConnection, intent: PendingStationHandover): Promise<boolean> {
  const token = await connectionToken(profile);
  if (!token) return false;
  try {
    const expectedHash = handoverPayloadHash(profile, intent.agent, intent.accountId, intent.model, intent.sessionKey);
    const receipt = await command<unknown>({ url: profile.hubUrl, pairToken: token, deviceId: profile.deviceId }, profile.deviceId,
      { type: 'remote.station.receipt', operationId: intent.operationId });
    if (!receipt || typeof receipt !== 'object') return false;
    const committed = receipt as Record<string, unknown>;
    if (committed.committed !== true || committed.operationId !== intent.operationId || committed.payloadHash !== expectedHash
      || committed.deviceId !== profile.deviceId || typeof committed.hubUrl !== 'string'
      || stationOriginKey(committed.hubUrl) !== stationOriginKey(profile.hubUrl)) return false;
    if (!intent.agent || (!intent.accountId && !intent.model)) return true;
    const result = await command<unknown>({ url: profile.hubUrl, pairToken: token, deviceId: profile.deviceId }, profile.deviceId, { type: 'agents.status' });
    const parsed = parseAgentStatus(result, undefined);
    const family = intent.agent === 'claude-desktop' ? 'claude' : intent.agent;
    const agent = parsed.agents.find((item) => item.id === family);
    if (!agent) return false;
    if (intent.accountId && agent.api.accountId !== intent.accountId) return false;
    if (intent.model && agent.api.model !== intent.model) return false;
    return true;
  } catch { return false; }
}

function ambiguousHandoverError(error: unknown): boolean {
  // `command()` normalizes transport failures to HubError.  An arbitrary
  // programming/runtime error is not evidence that the Bridge committed B;
  // probing B in that case could move the phone away from a still-active A.
  if (!(error instanceof HubError)) return false;
  return error.status === 0 || error.status >= 500 || error.code === 'command_delivery_uncertain';
}

/**
 * If the old Hub reply was lost after the Bridge committed B, the target
 * station is the only safe recovery signal: its device credential is unique
 * to this computer. Never switch merely because B is paired; it must report
 * this device online, which means the Bridge has actually reconnected there.
 */
async function recoverPendingHandover(intent: PendingStationHandover, expectedGeneration = connectionGeneration, expectedOwner = hub): Promise<boolean> {
  if (expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
  const current = state.connections.find((item) => item.id === state.connectionId);
  const target = state.connections.find((item) => item.id === intent.targetConnectionId);
  if (!target || !current || current.id !== intent.fromConnectionId || current.deviceId !== intent.deviceId) return false;
  if (target.computerId && current.computerId && target.computerId !== current.computerId) return false;
  if (!(await targetComputerOnline(target))) return false;
  if (expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
  if (!(await handoverPayloadApplied(target, intent))) return false;
  if (expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
  try {
    await useSavedConnection(target.id, false, { skipHandover: true, handoverOperationId: intent.operationId });
    if (state.connectionId !== target.id) return false;
    await clearPendingHandover(intent.operationId);
    return true;
  } catch { return false; }
}

/** Same handover UUID and payload, delivered through B's bounded standby lane. */
async function requestStandbyHandover(target: RemoteConnection, intent: PendingStationHandover, expectedGeneration: number, expectedOwner: Hub): Promise<void> {
  const current = () => expectedGeneration === connectionGeneration && expectedOwner === hub && state.connectionId === intent.fromConnectionId;
  const discovery = await discoverStation(target.hubUrl);
  if (!current()) throw new Error('连接已切换，请刷新确认');
  if (!discovery.capabilities.includes('station.standby.v1') || !discovery.capabilities.includes('commands.idempotency.v1')) {
    throw new Error('目标中转站暂不支持备用切换，请先更新远程服务');
  }
  const token = await connectionToken(target);
  if (!token || !current()) throw new Error('目标配对或连接已变化，请重新确认');
  const reply = await command<unknown>({ url: discovery.url, pairToken: token, deviceId: target.deviceId }, target.deviceId, {
    type: 'remote.station.switch', targetHubUrl: target.hubUrl, targetDeviceId: target.deviceId, targetComputerId: target.computerId!,
    ...(intent.agent ? { agent: intent.agent } : {}), ...(intent.accountId ? { accountId: intent.accountId } : {}),
    ...(intent.model ? { model: intent.model } : {}), ...(intent.sessionKey ? { sessionKey: intent.sessionKey } : {}), operationId: intent.operationId,
  }, intent.operationId);
  if (!current()) throw new Error('连接已切换，请刷新确认');
  // Unlike legacy A replies, standby must prove exactly what was committed.
  if (!reply || typeof reply !== 'object' || !optionalHandoverReplyMatches(reply, intent.operationId, handoverPayloadHash(target, intent.agent, intent.accountId, intent.model, intent.sessionKey))
    || (reply as Record<string, unknown>).operationId !== intent.operationId || (reply as Record<string, unknown>).switched !== true
    || (reply as Record<string, unknown>).payloadHash !== handoverPayloadHash(target, intent.agent, intent.accountId, intent.model, intent.sessionKey)) {
    throw new HubError('备用切换回执不匹配，请刷新确认', 409, 'handover_receipt_mismatch');
  }
}

/** Reconcile a handover journal on foreground/screen entry as well as boot. */
async function recoverPendingHandoverOnce(): Promise<boolean> {
  if (handoverRecoveryFlight) return handoverRecoveryFlight;
  const expectedGeneration = connectionGeneration;
  const expectedOwner = hub;
  const flight = serializeStationChange(async () => {
    const intent = await loadPendingHandover();
    if (!intent) return false;
    if (expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
    const deviceId = state.connections.find(item => item.id === state.connectionId)?.deviceId;
    if (!expectedOwner || !deviceId || apiMutationBusy(expectedOwner, deviceId)) return false;
    const mutation = beginApiMutation(expectedOwner, deviceId, 'API 或中转站正在切换，请稍候');
    try {
    if (state.connectionId === intent.targetConnectionId) {
      const target = state.connections.find((item) => item.id === intent.targetConnectionId);
      if (target && await handoverPayloadApplied(target, intent)) {
        if (expectedGeneration !== connectionGeneration || expectedOwner !== hub) return false;
        await clearPendingHandover(intent.operationId);
        return true;
      }
      return false;
    }
    return await recoverPendingHandover(intent, expectedGeneration, expectedOwner);
    } finally { endApiMutation(mutation); }
  });
  handoverRecoveryFlight = flight;
  try { return await flight; }
  finally { if (handoverRecoveryFlight === flight) handoverRecoveryFlight = null; }
}

async function runCommand<T = Record<string, unknown>>(owner: Hub, deviceId: string, input: Command, requestId?: string, signal?: AbortSignal, quiet = false): Promise<T> {
  try {
    const result = await command<T>(owner, deviceId, input, requestId, signal);
    if (!quiet && owner === hub) set((current) => ({ connection: 'open', connectionError: undefined,
      ...(!requestId ? { devices: current.devices.map((device) => device.deviceId === deviceId ? { ...device, online: true } : device) } : {}) }));
    return result;
  } catch (error) {
    if (!quiet && owner === hub && error instanceof HubError && (error.status === 0 || error.status >= 500 || error.status === 401 || error.status === 403 || error.status === 409)) {
      set({ connection: 'error', connectionError: error.message });
    }
    throw error;
  }
}

async function retryCapability(owner: Hub, force = false): Promise<boolean> {
  if (!hubCapabilities.size || force) {
    const discovery = await discoverStation(owner.url);
    if (owner !== hub) throw new Error('连接已切换');
    hubCapabilities = new Set(discovery.capabilities);
  }
  return hubCapabilities.has('commands.idempotency.v1');
}

/** A bounded short request resumes only this session's cursor, without keeping an SSE subscription. */
export async function syncSessionEvents(deviceId: string, sessionKey: string, waitSeconds = 0, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  // Desktop execution is observed through the actual host, not CLI-only Hub
  // emitters. The existing foreground demand window schedules these reads.
  if (isNativeSession(deviceId, sessionKey) || isReadOnlyDesktopSession(sessionKey)) {
    if (state.timelines[timelineKey(deviceId, sessionKey)]?.loading) return;
    await openSession(deviceId, sessionKey, { background: true, signal });
    return;
  }
  const owner = need();
  const key = timelineKey(deviceId, sessionKey);
  const revisionKey = `sync:${key}`;
  const snapshotKey = `open:${key}`;
  const revision = (sessionRequests.get(revisionKey) ?? 0) + 1;
  sessionRequests.set(revisionKey, revision);
  let snapshotRevision = sessionRequests.get(snapshotKey) ?? 0;
  let approvalSnapshotThrough = sessionApprovalSnapshots.get(key) ?? 0;
  const currentRequest = () => owner === hub && sessionRequests.get(revisionKey) === revision
    && (sessionRequests.get(snapshotKey) ?? 0) === snapshotRevision;
  try {
    if (!sessionCursors.has(key) || state.devices.some((device) => device.deviceId === deviceId && device.online === false)) {
      // Establish the cursor BEFORE the authoritative snapshot; later events are not skipped.
      // A known-offline computer is checked by the same read-only recovery,
      // not by adding a permanent presence ping or a model task.
      const flight = snapshotFlights.get(key);
      if (flight?.owner === owner) await flight.promise;
      else await openSession(deviceId, sessionKey, { signal });
      snapshotRevision = sessionRequests.get(snapshotKey) ?? 0;
      if (signal?.aborted || !currentRequest()) return;
      approvalSnapshotThrough = sessionApprovalSnapshots.get(key) ?? 0;
    }
    for (let page = 0; page < 3; page += 1) {
      if (signal?.aborted) return;
      const after = sessionCursors.get(key) ?? 0;
      const result = await sessionEventsPage(owner, deviceId, sessionKey, after, page === 0 && hubSupportsWait() ? waitSeconds : 0, 100, signal);
      if (signal?.aborted || !currentRequest()) return;
      const gap = result.events.find((event) => event.deviceId === deviceId && event.sessionKey === sessionKey
        && (typeof event.seq !== 'number' || event.seq > after) && historyGap(event));
      if (result.resetRequired || gap) {
        // The Hub buffer has a gap: reload the authoritative thread, then follow from the newest event.
        snapshotRevision += 1;
        await openSession(deviceId, sessionKey, { signal });
        if (signal?.aborted || !currentRequest()) return;
        approvalSnapshotThrough = sessionApprovalSnapshots.get(key) ?? 0;
        // The local registry in session.open is authoritative for pending
        // approvals. Preserve progress from this page, but never resurrect an
        // old request just because a transient Hub buffer still contains it.
        for (const event of result.events) {
          if (event.deviceId !== deviceId || event.sessionKey !== sessionKey || historyGap(event)
            || event.type === 'session.updated' || (typeof event.seq === 'number' && event.seq <= after)) continue;
          if (event.type === 'approval.request' && (typeof event.seq !== 'number' || event.seq <= approvalSnapshotThrough)) continue;
          handleEvent(event, true);
        }
        if (gap) handleEvent(gap);
        // nextSeq is the last event actually in this page; lastSeq may point
        // beyond it. Continuing from lastSeq silently discards unread progress.
        if (result.events.length) sessionCursors.set(key, result.nextSeq);
        if (!result.hasMore || result.nextSeq <= after) break;
        continue;
      }
      for (const event of result.events) {
        if (event.deviceId !== deviceId || event.sessionKey !== sessionKey || (typeof event.seq === 'number' && event.seq <= after)) continue;
        const predatesSnapshot = approvalSnapshotThrough > 0 && (typeof event.seq !== 'number' || event.seq <= approvalSnapshotThrough);
        if (event.type === 'session.updated' && predatesSnapshot) continue;
        if (event.type === 'approval.request' && approvalSnapshotThrough > 0
          && (typeof event.seq !== 'number' || event.seq <= approvalSnapshotThrough)) continue;
        handleEvent(event, predatesSnapshot);
      }
      sessionCursors.set(key, result.nextSeq);
      if (!result.hasMore || result.nextSeq <= after) break;
    }
    set({ connection: 'open', connectionError: undefined });
  } catch (error) {
    // A desktop lease/history error is local to this thread. It must not
    // falsely turn a healthy phone -> Hub -> computer link into "offline".
    if (!signal?.aborted && currentRequest() && error instanceof HubError && error.status !== 200) set({ connection: 'error', connectionError: error.message });
    throw error;
  }
}

/** Every status source must revoke cached history from a previous desktop identity. */
function publishAgentStatus(deviceId: string, parsed: AgentStatus): void {
  set(previous => {
    const identity = parsed.agents.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity;
    const entry = previous.sessions[deviceId];
    const readOnly = Object.fromEntries(Object.entries(entry?.readOnly ?? {}).filter(([, directory]) => Boolean(identity) && directory?.identity === identity));
    const timelines = Object.fromEntries(Object.entries(previous.timelines).filter(([key, timeline]) => !key.startsWith(`${deviceId}|claude-desktop:`)
      || Boolean(identity) && timeline.historyLease === identity));
    return { agents: { ...previous.agents, [deviceId]: { list: parsed.agents, apis: parsed.apis, autoAll: parsed.autoAll, loading: false, loaded: true } },
      ...(entry?.readOnly ? { sessions: { ...previous.sessions, [deviceId]: { ...entry, readOnly } } } : {}), timelines };
  });
}

/** Reads which agents are installed and which API remote tasks will use. Never applies keys or restarts tools. */
export async function loadAgentProfiles(deviceId: string): Promise<void> {
  const owner = need();
  const revision = (agentRequests.get(deviceId) ?? 0) + 1;
  agentRequests.set(deviceId, revision);
  const current = () => owner === hub && agentRequests.get(deviceId) === revision;
  const entry = state.agents[deviceId] ?? { list: [], apis: [], loading: false, loaded: false };
  set((previous) => ({ agents: { ...previous.agents, [deviceId]: { ...entry, loading: true, error: undefined } } }));
  try {
    const result = await runCommand<unknown>(owner, deviceId, { type: 'agents.status' });
    if (!current()) return;
    const parsed = parseAgentStatus(result, state.devices.find((item) => item.deviceId === deviceId));
    publishAgentStatus(deviceId, parsed);
  } catch (error) {
    if (!current()) return;
    const message = error instanceof HubError && error.status === 409 ? '电脑不在线' : '没有读到 Agent 信息，请更新电脑端 Salcara Bridge 或重试';
    set((previous) => ({ agents: { ...previous.agents, [deviceId]: { ...entry, loading: false, loaded: true, error: message } } }));
    throw new Error(message);
  }
}

function stationOriginKey(value: string): string {
  // Compare the same canonical Hub endpoint that pairing and connection
  // storage accept. String trimming alone could treat /salcara-hub/v1/v1 as
  // the same station, or let an untrusted API status match another path.
  try { return canonicalHubUrl(value); } catch { return ''; }
}

/**
 * A key is allowed to move the phone between stations only when the desktop
 * explicitly returned a single, already-paired public station match.  If the
 * API and Hub origins are unrelated, they remain intentionally decoupled and
 * the key is changed on the current station.
 */
function stationForApi(deviceId: string, accountId: string): RemoteConnection | undefined {
  if (!accountId) return undefined;
  const option = state.agents[deviceId]?.apis.find((item) => item.id === accountId);
  const candidate = option?.station;
  if (!candidate) return undefined;
  const current = state.connections.find((item) => item.id === state.connectionId);
  if (!current || !current.computerId) return undefined;
  const matches = state.connections.filter((item) => item.deviceId === candidate.deviceId
    && stationOriginKey(item.hubUrl) === stationOriginKey(candidate.hubUrl)
    && item.computerId === current.computerId);
  return matches.length === 1 && matches[0].id !== current.id ? matches[0] : undefined;
}

/**
 * Chooses the API the computer uses for this agent's remote tasks. An empty
 * accountId follows the computer again. The desktop tool itself is not changed.
 */
export async function setAgentApi(deviceId: string, agent: AgentId, accountId: string, model?: string, sessionKey?: string): Promise<AgentProfile | undefined> {
  const owner = need();
  const targetStation = stationForApi(deviceId, accountId);
  if (targetStation) {
    // The station command performs API + Hub changes as one desktop-side
    // transaction. Do not issue a separate agents.api.set first.
    await switchRemoteStation(deviceId, targetStation.id, agent, accountId, model, sessionKey);
    // A Hub may assign a different deviceId to the same physical computer.
    // After the handover all reads must use B's credential-scoped device ID;
    // reusing A's ID makes command() reject the request even though the
    // desktop already committed the API + station transaction.
    const activeDeviceId = targetStation.deviceId;
    await loadAgentProfiles(activeDeviceId);
    return state.agents[activeDeviceId]?.list.find((item) => item.id === agent);
  }
  const mutation = beginApiMutation(owner, deviceId, 'API 正在切换，请稍候');
  try {
  if (await hasPendingDeliveryForDevice(deviceId)) throw new Error('先核对待确认消息，再换 API');
  if (owner !== hub) throw new Error('连接已切换，请刷新确认');
  const cacheKey = `${deviceId}|${agent === 'codex' ? 'codex' : 'claude'}`;
  // Replies contain all Agent cards, so mutations of different families on one
  // computer must share a revision too.
  const changeKey = apiMutationKey(owner, deviceId);
  const change = (apiChanges.get(changeKey) ?? 0) + 1;
  apiChanges.set(changeKey, change);
  modelCache.delete(cacheKey);
  modelRequests.set(cacheKey, (modelRequests.get(cacheKey) ?? 0) + 1);
  agentRequests.set(deviceId, (agentRequests.get(deviceId) ?? 0) + 1);
  const result = await runCommand<unknown>(owner, deviceId, { type: 'agents.api.set', agent, accountId, model: model?.trim() || undefined, ...(sessionKey ? { sessionKey } : {}) });
  if (owner !== hub || apiChanges.get(changeKey) !== change) throw new Error('API 或连接已切换，请刷新确认');
  agentRequests.set(deviceId, (agentRequests.get(deviceId) ?? 0) + 1);
  modelCache.delete(cacheKey);
  modelRequests.set(cacheKey, (modelRequests.get(cacheKey) ?? 0) + 1);
  const parsed = parseAgentStatus(result, state.devices.find((item) => item.deviceId === deviceId));
  publishAgentStatus(deviceId, parsed);
  return parsed.agents.find((item) => item.id === agent);
  } finally { endApiMutation(mutation); }
}

/**
 * Atomically hands this physical computer from the currently selected Hub to
 * another saved Hub for the same computer.  The phone sends only the target's
 * public station/device metadata and the opaque API handle; the desktop looks
 * up its own device secret and vault entry, verifies the target pair, commits
 * the API + station together, acknowledges on A, then reconnects on B.
 */
export function switchRemoteStation(deviceId: string, targetConnectionId: string, agent?: AgentId, accountId?: string, model?: string, sessionKey?: string): Promise<void> {
  const generation = connectionGeneration, owner = hub;
  return serializeStationChange(() => {
    if (generation !== connectionGeneration || owner !== hub) throw new Error('连接已切换，请刷新确认');
    return switchRemoteStationImpl(deviceId, targetConnectionId, agent, accountId, model, sessionKey);
  });
}

async function switchRemoteStationImpl(deviceId: string, targetConnectionId: string, agent?: AgentId, accountId?: string, model?: string, sessionKey?: string): Promise<void> {
  const owner = need();
  const operationGeneration = connectionGeneration;
  const current = state.connections.find(item => item.id === state.connectionId);
  const target = state.connections.find(item => item.id === targetConnectionId);
  if (!current || !owner.pairToken || owner.deviceId !== deviceId) throw new Error('请先连接当前电脑');
  if (!target || target.id === current.id || !target.computerId || !current.computerId || target.computerId !== current.computerId) {
    throw new Error('目标中转站不是同一台已配对电脑，请先在两边完成配对');
  }
  const mutation = beginApiMutation(owner, deviceId, 'API 或中转站正在切换，请稍候');
  try {
    if (await hasPendingDeliveryForDevice(deviceId)) throw new Error('先核对待确认消息，再切换中转站');
    if (operationGeneration !== connectionGeneration || owner !== hub || state.connectionId !== current.id) throw new Error('连接已切换，请刷新确认');
    if (!(await connectionToken(target))) throw new Error('目标中转站的手机配对已失效，请重新扫码');
    if (operationGeneration !== connectionGeneration || owner !== hub || state.connectionId !== current.id) throw new Error('连接已切换，请刷新确认');
    const previous = await loadPendingHandover();
    if (previous && (previous.fromConnectionId !== current.id || previous.targetConnectionId !== target.id || previous.deviceId !== deviceId
      || !sameHandoverPayload(previous, agent, accountId, model, sessionKey))) {
      throw new Error('上一次中转站切换仍在确认，请先恢复或重试原目标');
    }
    const operationId = previous?.operationId ?? randomUUID();
    await savePendingHandover({ operationId, fromConnectionId: current.id, targetConnectionId: target.id, deviceId,
      createdAt: previous?.createdAt ?? Date.now(), ...(agent ? { agent } : {}), ...(accountId ? { accountId } : {}),
      ...(model?.trim() ? { model: model.trim() } : {}), ...(sessionKey ? { sessionKey } : {}) }, operationGeneration);
    // The journal write is an await boundary. If the user selected another
    // station or signed out while it was in flight, do not send the old
    // station a command with a credential that is no longer active. Keep the
    // intent on disk so the next foreground check can decide whether it is
    // recoverable.
    if (operationGeneration !== connectionGeneration || owner !== hub || state.connectionId !== current.id) {
      throw new Error('连接已切换，请刷新确认');
    }
    try {
      const reply = await command<unknown>(owner, deviceId, {
        type: 'remote.station.switch', targetHubUrl: target.hubUrl, targetDeviceId: target.deviceId,
        targetComputerId: target.computerId, ...(agent ? { agent } : {}), ...(accountId ? { accountId } : {}),
        ...(model?.trim() ? { model: model.trim() } : {}), ...(sessionKey ? { sessionKey } : {}), operationId,
      }, hubSupportsIdempotency() ? operationId : undefined);
      if (!optionalHandoverReplyMatches(reply, operationId, handoverPayloadHash(target, agent, accountId, model, sessionKey))) {
        throw new HubError('中转站切换回执不匹配，请重试', 409, 'handover_receipt_mismatch');
      }
    } catch (error) {
      const intent: PendingStationHandover = { operationId, fromConnectionId: current.id, targetConnectionId: target.id, deviceId,
        createdAt: previous?.createdAt ?? Date.now(), ...(agent ? { agent } : {}), ...(accountId ? { accountId } : {}),
        ...(model?.trim() ? { model: model.trim() } : {}), ...(sessionKey ? { sessionKey } : {}) };
      if (ambiguousHandoverError(error) && await recoverPendingHandover(intent, operationGeneration, owner)) return;
      if (ambiguousHandoverError(error) || error instanceof HubError && error.code === 'computer_offline') {
        try {
          await requestStandbyHandover(target, intent, operationGeneration, owner);
          await useSavedConnection(target.id, false, { skipHandover: true, handoverOperationId: operationId });
          await clearPendingHandover(operationId);
          return;
        } catch (standbyError) {
          if (ambiguousHandoverError(standbyError) && await recoverPendingHandover(intent, operationGeneration, owner)) return;
          throw standbyError;
        }
      }
      if (error instanceof HubError && (error.status === 200 || error.status === 401 || error.status === 403 || error.code === 'request_id_conflict')) await clearPendingHandover(operationId);
      throw error;
    }
    if (owner !== hub) throw new Error('连接已切换，请重新选择目标中转站');
    // The desktop commits after replying on A. Switch the phone only after that
    // acknowledgement, never before; otherwise a dropped request could leave
    // the phone unable to retry on the original station.
    await useSavedConnection(target.id, false, { skipHandover: true, handoverOperationId: operationId });
    await clearPendingHandover(operationId);
  } finally { endApiMutation(mutation); }
}

const LAST_AGENT = 'remote_last_agent_v1';
export async function lastAgent(): Promise<AgentId> {
  const saved = await getSetting(LAST_AGENT).catch(() => null);
  return saved === 'claude' || saved === 'claude-desktop' ? saved : 'codex';
}
export async function rememberAgent(agent: AgentId): Promise<void> { await setSetting(LAST_AGENT, agent).catch(() => undefined); }

/** True when the station can hold an empty events read open (live updates without a permanent stream). */
export function hubSupportsWait(): boolean { return hubCapabilities.has('events.wait.v1'); }
/** The active station can persist a bounded command receipt for an A→B handover. */
export function hubSupportsIdempotency(): boolean { return hubCapabilities.has('commands.idempotency.v1'); }
/** The Hub can push task news to this phone while the app is closed (Firebase). */
export function hubSupportsPush(): boolean { return hubCapabilities.has('push.fcm.v1'); }
/** The paired connection push registration is for: its Hub credentials and computer. */
export function pushTarget(): { hub: Hub; deviceId: string } | null {
  // Legacy code pairing has no device in the connection: it pairs exactly one computer.
  const deviceId = hub?.deviceId ?? (state.devices.length === 1 ? state.devices[0].deviceId : undefined);
  return hub?.pairToken && deviceId ? { hub, deviceId } : null;
}
/** Plain subscription to store changes (outside React). */
export function onRemoteChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

const sessionMatchesAgent = (session: SessionInfo, agent: AgentId) => agent === 'codex' ? session.tool === 'codex'
  : session.tool === 'claude' && /Claude Desktop/i.test(session.client ?? '') === (agent === 'claude-desktop');
function safePageCursor(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('电脑返回的读取位置无效');
  return value;
}
const readOnlyDesktopKey = /^claude-desktop:local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isReadOnlyDesktopSession(key: string): boolean { return readOnlyDesktopKey.test(key); }
function claudeHistoryIdentity(deviceId: string): string {
  const history = state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory;
  if (!history?.available) throw new Error('桌面历史不可用，请刷新');
  return history.identity;
}
function claudeHistoryScope(deviceId: string, sessionKey: string, identity: string): import('./client').ClaudeDesktopScope {
  const timeline = state.timelines[timelineKey(deviceId, sessionKey)];
  const row = (timeline?.historyLease === identity ? timeline.session : undefined) ?? Object.values(state.sessions[deviceId]?.readOnly ?? {})
    .filter(entry => entry?.identity === identity).flatMap(entry => entry?.list ?? []).find(item => item.sessionKey === sessionKey);
  if (row?.sessionScope !== 'desktop-chat' && row?.sessionScope !== 'desktop-cowork') throw new Error('请从桌面会话列表打开');
  return row.sessionScope;
}
function validClaudeHistorySession(session: SessionInfo, key: string, scope: import('./client').ClaudeDesktopScope): boolean {
  return session.sessionKey === key && session.tool === 'claude' && session.client === 'Claude Desktop'
    && session.sessionScope === scope && session.controlSurface === 'read-only' && session.controllable === false;
}
/** A cold native ID must resolve its category from current desktop metadata, never from a guessed CLI list. */
async function resolveClaudeHistoryScope(owner: Hub, deviceId: string, sessionKey: string, identity: string, signal?: AbortSignal): Promise<import('./client').ClaudeDesktopScope> {
  try { return claudeHistoryScope(deviceId, sessionKey, identity); } catch { /* No current metadata cached. */ }
  const result = await runCommand<{ session?: SessionInfo; historyIdentity?: string }>(owner, deviceId,
    { type: 'session.describe', sessionKey, controlSurface: 'read-only', historyIdentity: identity }, undefined, signal);
  if (owner !== hub || claudeHistoryIdentity(deviceId) !== identity || result.historyIdentity !== identity) throw new Error('桌面账号已变更，请刷新');
  const scope = result.session?.sessionScope;
  const scopes = state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.scopes ?? [];
  if (!result.session || scope !== 'desktop-chat' && scope !== 'desktop-cowork' || !scopes.includes(scope)
    || !validClaudeHistorySession(result.session, sessionKey, scope)) throw new Error('桌面会话身份不一致，已取消读取');
  return scope;
}
/** Native Claude Chat/Cowork has its own read-only directory and account identity. */
export async function loadClaudeDesktopHistory(deviceId: string, scope: import('./client').ClaudeDesktopScope, more = false, options?: { preservePages?: boolean }): Promise<void> {
  const owner = need(), identity = claudeHistoryIdentity(deviceId);
  if (!state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.scopes.includes(scope)) throw new Error('这个桌面目录不可用');
  const entry = state.sessions[deviceId]?.readOnly?.[scope], cursor = more && entry?.identity === identity ? entry.nextCursor : undefined;
  const preserve = !more && options?.preservePages && entry?.identity === identity && entry.loaded;
  if (preserve && entry?.loading) return;
  if (more && (!cursor || entry?.loading)) return;
  const requestKey = `claude-history:${deviceId}:${scope}`, revision = (sessionRequests.get(requestKey) ?? 0) + 1;
  sessionRequests.set(requestKey, revision);
  const current = () => owner === hub && sessionRequests.get(requestKey) === revision;
  const publish = (directory: NonNullable<DeviceSessions['readOnly']>[typeof scope]) => set(previous => ({ sessions: { ...previous.sessions,
    [deviceId]: { ...(previous.sessions[deviceId] ?? { list: [], loading: false, loaded: false }), readOnly: { ...previous.sessions[deviceId]?.readOnly, [scope]: directory } } } }));
  publish({ list: entry?.identity === identity ? entry.list : [], nextCursor: entry?.identity === identity ? entry.nextCursor : undefined,
    loaded: entry?.identity === identity && entry.loaded === true, loading: !preserve, identity });
  try {
    const result = await runCommand<{ sessions?: SessionInfo[]; nextCursor?: string; historyIdentity?: string }>(owner, deviceId,
      { type: 'sessions.list', tool: 'claude', client: scope, controlSurface: 'read-only', historyIdentity: identity, limit: SESSION_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    if (!current()) return;
    if (claudeHistoryIdentity(deviceId) !== identity || result.historyIdentity !== identity) throw new Error('桌面账号已变更，请刷新');
    if (!Array.isArray(result.sessions) || result.sessions.some(row => !row || !isReadOnlyDesktopSession(row.sessionKey) || row.tool !== 'claude' || row.controlSurface !== 'read-only' || row.controllable !== false
      || row.client !== 'Claude Desktop' || row.sessionScope !== scope) || new Set(result.sessions.map(row => row.sessionKey)).size !== result.sessions.length) throw new Error('桌面目录无效');
    const nextCursor = safePageCursor(result.nextCursor);
    if (cursor && nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
    const list = [...new Map([...(more || preserve ? entry?.list ?? [] : []), ...result.sessions].map(row => [row.sessionKey, row])).values()].sort((a, b) => b.updatedAt - a.updatedAt);
    publish({ list, nextCursor: preserve ? entry?.nextCursor : nextCursor, loading: false, loaded: true, identity });
    if (!more) warmDirectoryMessages(deviceId, list);
  } catch (error) {
    if (!current()) return;
    if (state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity !== identity) throw error;
    publish({ list: entry?.identity === identity ? entry.list : [], nextCursor: entry?.identity === identity ? entry.nextCursor : undefined, loading: false, loaded: true, identity, error: (error as Error).message });
    throw error;
  }
}
export async function loadSessions(deviceId: string, agent?: AgentId, options?: { preservePages?: boolean }): Promise<void> { return readSessions(deviceId, agent, false, options?.preservePages === true); }
export async function loadMoreSessions(deviceId: string, agent: AgentId): Promise<void> { return readSessions(deviceId, agent, true); }
const nativeThreadKey = /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function isNativeSession(deviceId: string, sessionKey: string): boolean {
  return Boolean(state.timelines[timelineKey(deviceId, sessionKey)]?.session?.controlSurface === 'desktop'
    || state.sessions[deviceId]?.native?.list.some(item => item.sessionKey === sessionKey)
    || state.agents[deviceId]?.list.find(item => item.id === 'codex')?.desktopLive?.sessionKeys.includes(sessionKey));
}
function nativeLease(deviceId: string, sessionKey?: string) {
  const live = state.agents[deviceId]?.list.find(item => item.id === 'codex')?.desktopLive;
  if (!live || live.expiresAt <= Date.now() || (sessionKey ? !live.capabilities?.read || !live.sessionKeys.includes(sessionKey) : !live.capabilities?.list)) {
    throw new Error('桌面连接已断开，请在电脑重新授权');
  }
  return live;
}
function nativeLeaseIdentity(deviceId: string, sessionKey?: string): string {
  const live = nativeLease(deviceId, sessionKey);
  return JSON.stringify([live.expiresAt, [...live.sessionKeys].sort()]);
}
/** Local directory preference survives opening a thread and returning after lease expiry. */
export function selectSessionDirectory(deviceId: string, surface: 'desktop' | 'all'): void {
  set(current => { const entry = current.sessions[deviceId] ?? { list: [], loading: false, loaded: false };
    return { sessions: { ...current.sessions, [deviceId]: { ...entry, directorySurface: surface } } }; });
}
/** Native and all-history directories are separate; a native failure never falls back to CLI. */
export async function loadNativeSessions(deviceId: string, more = false, options?: { preservePages?: boolean }): Promise<void> {
  const original = state.sessions[deviceId]?.native;
  const preserve = !more && options?.preservePages && original?.loaded;
  if (preserve && original?.loading) return;
  const cursor = more ? original?.nextCursor : undefined;
  if (more && (!cursor || original?.loading)) return;
  const owner = need(), requestKey = `native-sessions:${deviceId}`;
  const revision = (sessionRequests.get(requestKey) ?? 0) + 1;
  sessionRequests.set(requestKey, revision);
  const currentRequest = () => owner === hub && sessionRequests.get(requestKey) === revision;
  set(current => { const entry = current.sessions[deviceId] ?? { list: [], loading: false, loaded: false };
    return { sessions: { ...current.sessions, [deviceId]: { ...entry, directorySurface: 'desktop', native: { ...(entry.native ?? { list: [], loaded: false }), loading: !preserve, error: undefined } } } }; });
  try {
    const lease = nativeLeaseIdentity(deviceId);
    const result = await runCommand<{ sessions?: SessionInfo[]; nextCursor?: string }>(owner, deviceId, { type: 'desktop.sessions.list', tool: 'codex', controlSurface: 'desktop', limit: SESSION_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    if (!currentRequest()) return;
    if (nativeLeaseIdentity(deviceId) !== lease) throw new Error('桌面授权已更新，请重新读取');
    const allowed = new Set(nativeLease(deviceId).sessionKeys), seen = new Set<string>(), positions = new Set<number>();
    if (!Array.isArray(result.sessions) || result.sessions.length > 200) throw new Error('电脑返回的桌面目录无效');
    const list = result.sessions.map(item => {
      if (!item || !nativeThreadKey.test(item.sessionKey) || !allowed.has(item.sessionKey) || seen.has(item.sessionKey)
        || item.tool !== 'codex' || item.controlSurface !== 'desktop' || !Number.isInteger(item.sidebarIndex) || item.sidebarIndex! < 1 || item.sidebarIndex! > 200 || positions.has(item.sidebarIndex!)
        || item.pinnedIndex !== undefined && (!Number.isInteger(item.pinnedIndex) || item.pinnedIndex < 1 || item.pinnedIndex > 10000)) throw new Error('电脑返回的桌面目录无效');
      seen.add(item.sessionKey); positions.add(item.sidebarIndex!); return item;
    }).sort((a, b) => a.sidebarIndex! - b.sidebarIndex!);
    const nextCursor = safePageCursor(result.nextCursor);
    if (cursor && nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
    set(current => { const entry = current.sessions[deviceId];
      const previous = entry.native?.list ?? [], updates = new Map(list.map(item => [item.sessionKey, item]));
      // A refreshed head is authoritative for its order, while older loaded
      // pages keep their relative order. Old sidebar indices can collide with
      // a newly inserted head; preserve the host metadata, not an invented rank.
      const merged = preserve ? [...list, ...previous.filter(item => !updates.has(item.sessionKey))]
        : more ? [...previous.map(item => updates.get(item.sessionKey) ?? item), ...list.filter(item => !previous.some(old => old.sessionKey === item.sessionKey))] : list;
      return { sessions: { ...current.sessions, [deviceId]: { ...entry, native: { list: merged, nextCursor: preserve ? original?.nextCursor : nextCursor, loading: false, loaded: true } } } }; });
    if (!more) warmDirectoryMessages(deviceId, list);
  } catch (error) {
    if (!currentRequest()) return;
    set(current => { const entry = current.sessions[deviceId];
      return { sessions: { ...current.sessions, [deviceId]: { ...entry, native: { ...entry.native!, loading: false, loaded: true, error: (error as Error).message } } } }; });
    throw error;
  }
}
async function readSessions(deviceId: string, agent: AgentId | undefined, more: boolean, preservePages = false): Promise<void> {
  const owner = need();
  const entry = state.sessions[deviceId] ?? { list: [], loading: false, loaded: false };
  const preserve = Boolean(agent && preservePages && entry.pages?.[agent]);
  // Automatic head refresh must not supersede a user's in-flight older page.
  if (preserve && agent && entry.pages?.[agent]?.loading) return;
  const cursor = agent && more ? entry.pages?.[agent]?.nextCursor : undefined;
  if (more && (!cursor || agent && entry.pages?.[agent]?.loading)) return;
  const requestKey = `sessions:${deviceId}:${agent ?? 'all'}`;
  const revision = (sessionRequests.get(requestKey) ?? 0) + 1;
  sessionRequests.set(requestKey, revision);
  const currentRequest = () => owner === hub && sessionRequests.get(requestKey) === revision;
  set(current => ({ sessions: { ...current.sessions, [deviceId]: { ...(current.sessions[deviceId] ?? entry),
    ...(more ? {} : { loading: !preserve, error: undefined }),
    ...(agent ? { pages: { ...current.sessions[deviceId]?.pages, [agent]: { ...(more || preserve ? entry.pages?.[agent] : {}), loading: !preserve } } } : {}) } } }));
  try {
    const result = await runCommand<{ sessions?: SessionInfo[]; nextCursor?: string }>(owner, deviceId, { type: 'sessions.list',
      limit: SESSION_PAGE_SIZE,
      ...(agent ? { tool: agent === 'codex' ? 'codex' : 'claude', ...(agent === 'codex' ? {} : { client: agent === 'claude-desktop' ? 'desktop-code' : 'code' }) } : {}),
      ...(cursor ? { cursor } : {}) });
    if (!currentRequest()) return;
    const nextCursor = safePageCursor(result.nextCursor);
    if (cursor && nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
    const received = [...(result.sessions ?? [])].filter(item => item && typeof item.sessionKey === 'string' && (!agent || sessionMatchesAgent(item, agent)));
    set(current => {
      const latest = current.sessions[deviceId] ?? entry;
      const previous = more || preserve ? latest.list : agent ? latest.list.filter(item => !sessionMatchesAgent(item, agent)) : [];
      const list = [...new Map([...previous, ...received].map(item => [item.sessionKey, item])).values()].sort((a, b) => b.updatedAt - a.updatedAt);
      return { sessions: { ...current.sessions, [deviceId]: { ...latest, list, loading: false, loaded: true, error: undefined,
        ...(agent ? { pages: { ...latest.pages, [agent]: { nextCursor: preserve ? entry.pages?.[agent]?.nextCursor : nextCursor, loading: false } } } : {}) } } };
    });
    if (!more && agent) warmDirectoryMessages(deviceId, received);
  } catch (error) {
    if (!currentRequest()) return;
    set(current => ({ sessions: { ...current.sessions, [deviceId]: { ...(current.sessions[deviceId] ?? entry), loading: false, loaded: true,
      ...(more ? {} : { error: (error as Error).message }),
      ...(agent ? { pages: { ...current.sessions[deviceId]?.pages, [agent]: { ...(more || preserve ? entry.pages?.[agent] : {}), loading: false, error: (error as Error).message } } } : {}) } } }));
    throw error;
  }
}

function warmDirectoryMessages(deviceId: string, sessions: SessionInfo[]) {
  if (!screenOpen || AppState.currentState !== 'active') return;
  directoryPreloads.get(deviceId)?.abort();
  const controller = new AbortController();
  directoryPreloads.set(deviceId, controller);
  void preloadRecentSessionMessages(deviceId, sessions, controller.signal).finally(() => {
    if (directoryPreloads.get(deviceId) === controller) directoryPreloads.delete(deviceId);
  }).catch(() => undefined);
}

/** First-page previews are optional background reads, never a directory gate. */
export async function preloadRecentSessionMessages(deviceId: string, sessions: SessionInfo[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || !hub) return;
  const owner = hub, generation = connectionGeneration;
  const queue = [...new Map(sessions.filter(item => !item.parentSessionKey).map(item => [item.sessionKey, item])).values()]
    .slice(0, SESSION_PAGE_SIZE);
  let index = 0;
  const worker = async () => {
    while (!signal?.aborted && owner === hub && generation === connectionGeneration && index < queue.length) {
      const item = queue[index++], key = timelineKey(deviceId, item.sessionKey);
      const cached = state.timelines[key];
      if (snapshotFlights.has(key) || cached?.loading || cached?.loadingEarlier || cached?.historyExpanded
        || cached?.snapshotAt && Date.now() - cached.snapshotAt < 30_000) continue;
      try { await openSession(deviceId, item.sessionKey, { background: true, preload: true, signal }); }
      catch { /* Selecting the thread performs an authoritative foreground retry. */ }
    }
  };
  // Reserve capacity for a selected conversation, sends and approval replies.
  await Promise.all([worker(), worker()]);
}

export function openSession(deviceId: string, sessionKey: string, options?: { background?: boolean; preload?: boolean; signal?: AbortSignal }): Promise<void> {
  if (options?.signal?.aborted) return Promise.resolve();
  if (!options?.background) {
    directoryPreloads.get(deviceId)?.abort();
    directoryPreloads.delete(deviceId);
  }
  const key = timelineKey(deviceId, sessionKey), owner = need();
  const flight = { owner, promise: Promise.resolve() as Promise<void> };
  flight.promise = readSessionSnapshot(deviceId, sessionKey, options).finally(() => {
    if (snapshotFlights.get(key) === flight) snapshotFlights.delete(key);
  });
  snapshotFlights.set(key, flight);
  return flight.promise;
}

async function readSessionSnapshot(deviceId: string, sessionKey: string, options?: { background?: boolean; preload?: boolean; signal?: AbortSignal }): Promise<void> {
  const owner = need();
  if (options?.signal?.aborted) return;
  const key = timelineKey(deviceId, sessionKey);
  const revisionKey = `open:${key}`;
  const revision = (sessionRequests.get(revisionKey) ?? 0) + 1;
  sessionRequests.set(revisionKey, revision);
  if (!options?.background) sessionRequests.set(`history:${key}`, (sessionRequests.get(`history:${key}`) ?? 0) + 1);
  const currentRequest = () => owner === hub && sessionRequests.get(revisionKey) === revision && !options?.signal?.aborted;
  const snapshotStartedAt = Date.now();
  const native = isNativeSession(deviceId, sessionKey);
  const readOnly = isReadOnlyDesktopSession(sessionKey);
  let lease = '';
  const originalApprovals = new Map((state.timelines[key]?.items ?? []).filter(item => item.kind === 'approval').map(item => [item.id, item]));
  set(current => {
    const identity = readOnly ? current.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity : undefined;
    const cached = current.timelines[key] ?? EMPTY_TIMELINE;
    const existing = readOnly && (!identity || cached.historyLease !== identity) ? EMPTY_TIMELINE : cached;
    return { timelines: { ...current.timelines, [key]: { ...existing,
      ...(readOnly ? { historyLease: identity } : {}), loading: !options?.background, error: undefined,
      ...(options?.background ? {} : { loadingEarlier: false, earlierError: undefined }) } } };
  });
  try {
    lease = native ? nativeLeaseIdentity(deviceId, sessionKey) : readOnly ? claudeHistoryIdentity(deviceId) : '';
    const historyScope = readOnly ? await resolveClaudeHistoryScope(owner, deviceId, sessionKey, lease, options?.signal) : undefined;
    // Capture a baseline before reading the computer. Anything produced during
    // that read remains available to the next incremental request.
    const head = native || readOnly ? { lastSeq: 0, nextSeq: 0 } : await sessionEventsPage(owner, deviceId, sessionKey, 0, 0, 1, options?.signal);
    if (!currentRequest()) return;
    const result = await runCommand<{ session?: SessionInfo; events?: HubEvent[]; nextCursor?: string; historyIdentity?: string }>(owner, deviceId,
      native ? { type: 'desktop.session.open', sessionKey, controlSurface: 'desktop', limit: INITIAL_MESSAGE_COUNT, messageLimit: INITIAL_MESSAGE_COUNT } : { type: 'session.open', sessionKey, limit: HISTORY_EVENT_BUDGET, messageLimit: INITIAL_MESSAGE_COUNT, ...(readOnly ? { controlSurface: 'read-only' as const, historyIdentity: lease, client: historyScope } : {}) }, undefined, options?.signal, options?.preload);
    if (!currentRequest()) return;
    if (!result.session || result.session.sessionKey !== sessionKey) throw new Error('会话身份不一致，已取消读取');
    if (native && (nativeLeaseIdentity(deviceId, sessionKey) !== lease || result.session.controlSurface !== 'desktop' || result.session.tool !== 'codex')) throw new Error('桌面授权已更新，请重新读取');
    if (readOnly && (claudeHistoryIdentity(deviceId) !== lease || result.historyIdentity !== lease)) throw new Error('桌面账号已变更，请刷新');
    if (historyScope && !validClaudeHistorySession(result.session, sessionKey, historyScope)) throw new Error('桌面会话身份不一致，已取消读取');
    const history = (result.events ?? []).filter((event) => event.sessionKey === sessionKey
      && (!event.deviceId || event.deviceId === deviceId)
      && (event.type !== 'session.updated' || event.session.sessionKey === sessionKey)
      && (!readOnly || event.tool === 'claude' && event.type !== 'approval.request' && event.type !== 'approval.resolved'
        && (event.type !== 'session.updated' || validClaudeHistorySession(event.session, sessionKey, historyScope!))));
    set((current) => {
      const cached = current.timelines[key] ?? EMPTY_TIMELINE;
      const existing = readOnly && cached.historyLease !== lease ? EMPTY_TIMELINE : cached;
      const concurrentApprovals = new Set(existing.items.filter(item => item.kind === 'approval' && originalApprovals.get(item.id) !== item).map(item => item.id));
      const keepFrontier = Boolean(options?.background && existing.historyExpanded && (!(native || readOnly) || existing.historyLease === lease));
      const timeline = { ...mergeHistory(existing, result.session, history, concurrentApprovals), cachedAt: undefined, snapshotAt: Date.now(), snapshotStartedAt,
        nextCursor: keepFrontier ? existing.nextCursor : safePageCursor(result.nextCursor), historyLease: native || readOnly ? lease : undefined,
        historyExpanded: keepFrontier, loadingEarlier: options?.background ? existing.loadingEarlier : false,
        earlierError: options?.background ? existing.earlierError : undefined };
      const approvals = { ...current.approvals };
      // A fresh snapshot reconciles approvals for this thread only. Do not
      // resurrect a days-old request merely because it was once cached.
      for (const [id, approval] of Object.entries(approvals)) {
        if (approval.deviceId === deviceId && approval.sessionKey === sessionKey) delete approvals[id];
      }
      for (const item of timeline.items) {
        if (item.kind === 'approval' && item.state === 'pending' && (!item.expiresAt || item.expiresAt > Date.now())) approvals[item.id] = { approvalId: item.id, deviceId, sessionKey, tool: timeline.session?.tool ?? 'codex', title: item.title, ts: item.ts };
        else if (item.kind === 'approval') delete approvals[item.id];
      }
      const entry = current.sessions[deviceId];
      const sessions = entry && result.session ? { ...current.sessions, [deviceId]: { ...entry,
        list: entry.list.map((item) => item.sessionKey === sessionKey ? result.session! : item),
        ...(entry.native ? { native: { ...entry.native, list: entry.native.list.map(item => item.sessionKey === sessionKey ? { ...result.session!, sidebarIndex: item.sidebarIndex, pinnedIndex: item.pinnedIndex } : item) } } : {}) } } : current.sessions;
      return { timelines: { ...current.timelines, [key]: timeline }, approvals, sessions };
    });
    sessionCursors.set(key, Math.max(head.lastSeq, head.nextSeq));
    sessionApprovalSnapshots.set(key, Math.max(head.lastSeq, head.nextSeq));
  } catch (error) {
    // Leaving the thread/backgrounding deliberately aborts this read. Do not
    // turn that lifecycle action into a visible timeline error.
    if (options?.signal?.aborted) return;
    if (!currentRequest()) return;
    if (readOnly && lease && state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity !== lease) throw error;
    set((current) => ({ timelines: { ...current.timelines, [key]: { ...(current.timelines[key] ?? EMPTY_TIMELINE),
      session: current.timelines[key]?.session ?? (native ? current.sessions[deviceId]?.native?.list : current.sessions[deviceId]?.list)?.find((item) => item.sessionKey === sessionKey),
      loading: false, error: (error as Error).message } } }));
    throw error;
  } finally {
    // A cancelled first snapshot has no snapshotAt yet. Release only its own
    // loading state, or the next foreground read would be skipped forever.
    if (owner === hub && sessionRequests.get(revisionKey) === revision && state.timelines[key]?.loading) {
      set(current => ({ timelines: { ...current.timelines, [key]: { ...(current.timelines[key] ?? EMPTY_TIMELINE), loading: false } } }));
    }
  }
}

/** Older history is local-computer data, not an extension of server event retention. */
export async function loadEarlierHistory(deviceId: string, sessionKey: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const owner = need(), key = timelineKey(deviceId, sessionKey);
  const original = state.timelines[key];
  if (!original?.nextCursor || original.loading || original.loadingEarlier) return;
  const cursor = original.nextCursor, historyRevision = sessionRequests.get(`history:${key}`);
  const pageKey = `earlier:${key}`, revision = (sessionRequests.get(pageKey) ?? 0) + 1;
  sessionRequests.set(pageKey, revision);
  const currentRequest = () => owner === hub && sessionRequests.get(pageKey) === revision && sessionRequests.get(`history:${key}`) === historyRevision && !signal?.aborted;
  const readOnly = isReadOnlyDesktopSession(sessionKey);
  let lease = '';
  set(current => ({ timelines: { ...current.timelines, [key]: { ...current.timelines[key], loadingEarlier: true, earlierError: undefined } } }));
  try {
    const native = original.session?.controlSurface === 'desktop';
    lease = native ? nativeLeaseIdentity(deviceId, sessionKey) : readOnly ? claudeHistoryIdentity(deviceId) : '';
    if (readOnly && original.historyLease !== lease) throw new Error('桌面账号已变更，请刷新');
    const historyScope = readOnly ? await resolveClaudeHistoryScope(owner, deviceId, sessionKey, lease, signal) : undefined;
    const result = await runCommand<{ session?: SessionInfo; events?: HubEvent[]; nextCursor?: string; historyIdentity?: string }>(owner, deviceId,
      native ? { type: 'desktop.session.open', sessionKey, cursor, controlSurface: 'desktop', limit: OLDER_HISTORY_PAGE_SIZE, messageLimit: OLDER_HISTORY_PAGE_SIZE } : { type: 'session.open', sessionKey, cursor, limit: HISTORY_EVENT_BUDGET, messageLimit: OLDER_HISTORY_PAGE_SIZE, ...(readOnly ? { controlSurface: 'read-only' as const, historyIdentity: lease, client: historyScope } : {}) }, undefined, signal);
    if (!currentRequest()) return;
    if (result.session?.sessionKey !== sessionKey) throw new Error('会话身份不一致，已取消读取');
    if (native && (nativeLeaseIdentity(deviceId, sessionKey) !== lease || result.session.controlSurface !== 'desktop' || result.session.tool !== 'codex')) throw new Error('桌面授权已更新，请重新读取');
    if (readOnly && (claudeHistoryIdentity(deviceId) !== lease || result.historyIdentity !== lease)) throw new Error('桌面账号已变更，请刷新');
    if (historyScope && !validClaudeHistorySession(result.session, sessionKey, historyScope)) throw new Error('桌面会话身份不一致，已取消读取');
    const nextCursor = safePageCursor(result.nextCursor);
    if (nextCursor === cursor) throw new Error('电脑没有推进读取位置，请刷新');
    let older: Timeline = EMPTY_TIMELINE;
    for (const event of result.events ?? []) {
      if (event.sessionKey !== sessionKey || event.deviceId && event.deviceId !== deviceId || event.type === 'approval.request' || event.type === 'approval.resolved' || event.type === 'session.updated') continue;
      if (readOnly && event.tool !== 'claude') continue;
      older = applyEvent(older, event);
    }
    set(current => {
      const cached = current.timelines[key];
      const latest = readOnly && cached?.historyLease !== lease ? { ...EMPTY_TIMELINE, session: result.session, historyLease: lease } : cached ?? EMPTY_TIMELINE;
      const items = [...new Map([...older.items, ...latest.items].map(item => [`${item.kind}|${item.id}`, item])).values()].sort((a, b) => a.ts - b.ts);
      return { timelines: { ...current.timelines, [key]: { ...latest, items, nextCursor, historyExpanded: true, loadingEarlier: false, earlierError: undefined } } };
    });
  } catch (error) {
    if (signal?.aborted) return;
    if (!currentRequest()) return;
    if (readOnly && lease && state.agents[deviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity !== lease) throw error;
    set(current => ({ timelines: { ...current.timelines, [key]: { ...current.timelines[key], loadingEarlier: false, earlierError: (error as Error).message } } }));
    throw error;
  } finally {
    // Cancellation is not a failed page. Keep its cursor and content while
    // releasing only the loading state still owned by this exact read.
    if (owner === hub && sessionRequests.get(pageKey) === revision && state.timelines[key]?.loadingEarlier
      && sessionRequests.get(`history:${key}`) === historyRevision) {
      set(current => ({ timelines: { ...current.timelines, [key]: { ...current.timelines[key], loadingEarlier: false } } }));
    }
  }
}

/** Sends phone images to the computer in Hub-sized chunks; returns their ids. */
export async function uploadImages(deviceId: string, images: RemoteImage[], owner: Hub = need()): Promise<string[]> {
  const ids: string[] = [];
  for (const image of images) {
    const id = `att_${randomUUID().replace(/-/g, '')}`;
    const chunks = attachmentChunks(image.base64);
    for (let index = 0; index < chunks.length; index += 1) {
      if (owner !== hub) throw new Error('连接已切换，图片未发送');
      await command(owner, deviceId, { type: 'attachment.put', id, mime: image.mime, index, total: chunks.length, data: chunks[index] });
      if (owner !== hub) throw new Error('连接已切换，图片未发送');
    }
    ids.push(id);
  }
  return ids;
}

export async function startSession(deviceId: string, input: { tool: ToolId; cwd: string; prompt: string; model?: string; effort?: Effort; approval: ApprovalMode; images?: RemoteImage[]; desktop?: boolean }): Promise<string> {
  const owner = need();
  if (apiMutationBusy(owner, deviceId)) throw new Error('API 正在切换，请稍候');
  const attachments = input.images?.length ? await uploadImages(deviceId, input.images, owner) : [];
  if (owner !== hub) throw new Error('连接已切换，任务未发送');
  if (apiMutationBusy(owner, deviceId)) throw new Error('API 正在切换，请稍候');
  const result = await command<{ sessionKey?: string }>(owner, deviceId, { type: 'session.start', tool: input.tool, cwd: input.cwd, prompt: input.prompt, approval: input.approval,
    model: input.model?.trim() || undefined, ...(input.effort ? { effort: input.effort } : {}), ...(attachments.length ? { attachments } : {}),
    ...(input.desktop && input.tool === 'claude' ? { entrypoint: 'claude-desktop' as const } : {}) });
  if (owner !== hub) throw new Error('连接已切换，原电脑上的任务不会被转移');
  if (!result.sessionKey) throw new Error('电脑没有返回新会话');
  const key = timelineKey(deviceId, result.sessionKey);
  set((current) => {
    const existing = current.timelines[key] ?? EMPTY_TIMELINE;
    const hasPrompt = existing.items.some((item) => item.kind === 'message' && item.role === 'user');
    return { timelines: { ...current.timelines, [key]: hasPrompt ? existing : { ...existing, items: [{ kind: 'message', id: `local:${Date.now()}`, role: 'user', text: input.prompt, final: true, ts: Date.now(), local: true, images: input.images?.map((image) => image.uri) }, ...existing.items] } } };
  });
  return result.sessionKey;
}

export interface SendOptions { model?: string; effort?: Effort; images?: RemoteImage[]; surface?: 'cli' | 'desktop' }

/** Continues a thread on the computer. Shows the message immediately; the computer's echo replaces it. */
export async function sendToSession(deviceId: string, sessionKey: string, text: string, options: SendOptions = {}): Promise<void> {
  if (isReadOnlyDesktopSession(sessionKey) || state.timelines[timelineKey(deviceId, sessionKey)]?.session?.controlSurface === 'read-only') throw new Error('这个桌面对话目前只支持查看');
  const owner = need();
  if (apiMutationBusy(owner, deviceId)) throw new Error('API 正在切换，请稍候');
  const scope = remoteDeliveryScope();
  const previous = await pendingDelivery(scope, deviceId, sessionKey);
  const surface = previous?.surface ?? options.surface ?? 'cli';
  const idempotent = await retryCapability(owner, previous?.attempted === true);
  if (owner !== hub) throw new Error('连接已切换，消息未从新连接发送');
  if (apiMutationBusy(owner, deviceId)) throw new Error('API 正在切换，请稍候');
  const key = timelineKey(deviceId, sessionKey);
  const localId = `local:${Date.now()}`;
  let originalSession: SessionInfo | undefined, optimisticSession: SessionInfo | undefined;
  let originalItems = new Set<TimelineItem>();
  set((current) => {
    const timeline = current.timelines[key] ?? EMPTY_TIMELINE;
    if (timeline.items.some((item) => item.kind === 'message' && item.local && item.text.trim() === text.trim())) return {};
    originalSession = timeline.session; originalItems = new Set(timeline.items);
    optimisticSession = timeline.session ? { ...timeline.session, status: 'running' } : undefined;
    return { timelines: { ...current.timelines, [key]: { ...timeline, items: [...timeline.items, { kind: 'message', id: localId, role: 'user', text, final: true, ts: Date.now(), local: true, images: options.images?.map((image) => image.uri) }],
      session: optimisticSession } } };
  });
  try {
    // A retried message reuses the images already on the computer.
    const attachments = previous?.attachments ?? (options.images?.length ? await uploadImages(deviceId, options.images, owner) : undefined);
    await deliverMessage({ scope, deviceId, sessionKey, surface, text, idempotent, attachments, sendOptions: { ...(options.model ? { model: options.model } : {}), ...(options.effort ? { effort: options.effort } : {}) },
      perform: async (receipt) => {
        if (owner !== hub) throw new HubError('连接已切换，尚未发送消息', 200, 'request_scope_changed');
        if (apiMutationBusy(owner, deviceId)) throw new HubError('API 正在切换，请稍候', 429, 'api_switching');
        const frozenOptions = receipt.sendOptions ?? options; // Pre-upgrade receipts retain their original compatibility behavior.
        await runCommand(owner, deviceId, { type: 'session.send', sessionKey, text, controlSurface: receipt.surface, operationId: receipt.requestId,
          ...(frozenOptions.model ? { model: frozenOptions.model } : {}), ...(frozenOptions.effort ? { effort: frozenOptions.effort } : {}),
          ...(receipt.attachments?.length ? { attachments: receipt.attachments } : {}) }, receipt.requestId);
        if (owner !== hub) throw new HubError('连接已切换，请回原连接确认送达', 409, 'command_delivery_uncertain');
      } });
  } catch (error) {
    // Keep the bubble only while the phone will retry the same receipt.
    if (owner === hub && !(error instanceof Error && error.name === 'DeliveryPendingError' && (error as { retryable?: boolean }).retryable)) {
      set((current) => {
        const timeline = current.timelines[key];
        if (!timeline) return {};
        // An explicit rejection before any actual worker progress must not
        // leave the API picker locked by our optimistic "running" placeholder.
        const progressed = timeline.items.some((item) => item.id !== localId && !originalItems.has(item));
        const restore = !(error instanceof DeliveryPendingError) && originalSession && timeline.session === optimisticSession && !progressed;
        return { timelines: { ...current.timelines, [key]: { ...timeline, items: timeline.items.filter((item) => item.id !== localId), session: restore ? originalSession : timeline.session } } };
      });
    }
    throw error;
  }
}

const CODEX_THREAD = /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAUDE_SESSION = /^claude:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Codex threads open in the Codex app; Claude Desktop sessions bring up Claude Desktop. */
export function canOpenOnDesktop(sessionKey: string, client?: string): boolean {
  return CODEX_THREAD.test(sessionKey) || (CLAUDE_SESSION.test(sessionKey) && /Claude Desktop/i.test(client ?? ''));
}
/** Asks the computer to show this thread in its desktop app. Sends nothing. */
export async function openOnDesktop(deviceId: string, sessionKey: string, client?: string): Promise<void> {
  if (!canOpenOnDesktop(sessionKey, client)) throw new Error('这个对话没有对应的桌面应用');
  await command(need(), deviceId, { type: 'desktop.navigate', sessionKey, controlSurface: 'desktop' });
}

export async function interruptSession(deviceId: string, sessionKey: string): Promise<void> {
  if (isReadOnlyDesktopSession(sessionKey)) throw new Error('这个桌面对话目前只支持查看');
  await command(need(), deviceId, { type: 'session.interrupt', sessionKey, controlSurface: 'cli' });
}

export interface ApprovalReceipt { requestId: string; retrying: boolean; scope: string; expiresAt?: number; signal: AbortSignal }
export async function respondApproval(approval: { approvalId: string; deviceId: string; sessionKey: string; controlSurface?: 'cli' | 'desktop' }, decision: Decision, message?: string, answers?: QuestionAnswers, receipt?: ApprovalReceipt): Promise<void> {
  if (isReadOnlyDesktopSession(approval.sessionKey)) throw new Error('这个桌面对话目前只支持查看');
  const owner = need();
  const guard = () => {
    if (!receipt) return;
    if (receipt.signal.aborted || owner !== hub || receipt.scope !== remoteDeliveryScope()) throw new HubError('连接已切换，回答没有从新连接发送', 200, 'request_scope_changed');
    if (receipt.expiresAt && receipt.expiresAt <= Date.now()) throw new HubError('问题已过期，请刷新', 200, 'question_expired');
  };
  guard();
  // Lost acknowledgements may only be retried on a Hub with durable deduplication.
  if (receipt?.retrying && !(await retryCapability(owner, true))) throw new HubError('本站不支持安全重试，请先核对电脑上的问题', 200, 'question_retry_unsupported');
  guard();
  const timeline = state.timelines[`${approval.deviceId}|${approval.sessionKey}`];
  const item = timeline?.items.find(value => value.kind === 'approval' && value.id === approval.approvalId);
  const native = approval.controlSurface === 'desktop' || timeline?.session?.controlSurface === 'desktop' || item?.kind === 'approval' && item.approvalTransport === 'codex-hook-v1';
  if (native) {
    if (item?.kind !== 'approval' || item.approvalTransport !== 'codex-hook-v1' || item.state !== 'pending'
        || !item.expiresAt || item.expiresAt <= Date.now() || decision === 'allow_session' || answers) throw new HubError('这个桌面请求请在电脑处理', 200, 'desktop_capability_unavailable');
    const operationId = receipt?.requestId ?? randomUUID();
    await command(owner, approval.deviceId, { type: 'desktop.approval.respond', sessionKey: approval.sessionKey, approvalId: approval.approvalId, decision,
      message: message?.trim() || undefined, operationId, controlSurface: 'desktop' }, operationId);
  } else {
    await command(owner, approval.deviceId, { type: 'approval.respond', approvalId: approval.approvalId, decision, message: message?.trim() || undefined, ...(answers ? { answers } : {}), controlSurface: 'cli' }, receipt?.requestId);
  }
  if (owner !== hub) throw new HubError('请回原连接核对回答', 409, 'command_delivery_uncertain');
  handleEvent({ type: 'approval.resolved', approvalId: approval.approvalId, decision, by: 'phone', deviceId: approval.deviceId, sessionKey: approval.sessionKey, tool: 'codex', ts: Date.now() });
}

export async function listProjects(deviceId: string): Promise<Project[]> {
  const owner = need();
  const result = await command<{ projects?: Project[] }>(owner, deviceId, { type: 'projects.list' });
  if (owner !== hub) throw new Error('连接已切换');
  return result.projects ?? [];
}

/** The selected API's upstream models (cached per computer and agent; refresh re-reads the provider). */
const modelCache = new Map<string, ModelCatalog>();
const modelRequests = new Map<string, number>();
export function cachedModels(deviceId: string, tool: ToolId): ModelCatalog | undefined { return modelCache.get(`${deviceId}|${tool}`); }
export async function listModels(deviceId: string, tool: ToolId, refresh = false): Promise<ModelCatalog> {
  const owner = need();
  const cacheKey = `${deviceId}|${tool}`;
  const revision = (modelRequests.get(cacheKey) ?? 0) + 1;
  modelRequests.set(cacheKey, revision);
  const result = await command<{ models?: string[]; api?: string; modelCapabilities?: unknown }>(owner, deviceId, { type: 'models.list', tool, ...(refresh ? { refresh: true } : {}) });
  if (owner !== hub || modelRequests.get(cacheKey) !== revision) throw new Error('API 或连接已切换，请重新读取模型');
  const models = Array.from(new Set(Array.isArray(result.models) ? result.models.filter((item): item is string =>
    typeof item === 'string' && item.length > 0 && item.length <= 200 && item.trim() === item && !/[\r\n\u0000]/.test(item)) : [])).slice(0, 1000);
  const raw = result.modelCapabilities && typeof result.modelCapabilities === 'object' && !Array.isArray(result.modelCapabilities) ? result.modelCapabilities as Record<string, unknown> : {};
  const modelCapabilities = Object.fromEntries(models.map(id => {
    const entry = raw[id] && typeof raw[id] === 'object' ? raw[id] as Record<string, unknown> : {};
    const source: ModelCapability['source'] = entry.source === 'codex-model-list' || entry.source === 'relay-model-list' ? entry.source : 'unknown';
    const known = source === 'codex-model-list' && entry.reasoningKnown === true && Array.isArray(entry.reasoningEfforts);
    const efforts = Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts.filter(isEffort) : [];
    const modalities = Array.isArray(entry.inputModalities) ? entry.inputModalities : [];
    const capability: ModelCapability = { source, reasoningKnown: known,
      ...(known ? { reasoningEfforts: CODEX_EFFORTS.filter(value => efforts.includes(value)) } : {}),
      ...(source === 'codex-model-list' && Array.isArray(entry.inputModalities) ? { inputModalities: ['text', 'image'].filter(value => modalities.includes(value)) as Array<'text' | 'image'> } : {}) };
    return [id, capability];
  }));
  const value: ModelCatalog = { models, modelCapabilities, api: typeof result.api === 'string' ? result.api : undefined };
  modelCache.set(`${deviceId}|${tool}`, value);
  return value;
}

/** Test hook. */
export function resetRemoteForTests() { resetRemoteCacheForTests(); modelCache.clear(); modelRequests.clear(); apiChanges.clear(); apiMutationOwners.clear(); apiMutationDevices.clear(); pairingGeneration += 1; pairingFlights.clear(); handoverRecoveryFlight = null; stationChangeTail = Promise.resolve(); stopStream(); connectionGeneration += 1; probeGeneration += 1; hub = null; lastSeq = 0; booted = false; screenOpen = false; hubCapabilities.clear(); sessionCursors.clear(); sessionApprovalSnapshots.clear(); sessionRequests.clear(); snapshotFlights.clear(); agentRequests.clear(); resetDeliveryForTests(); state = initial; }
