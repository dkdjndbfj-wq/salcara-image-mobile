import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import type { ProviderProfile } from '../domain';
import { getSetting, setSetting } from '../storage/database';
import { getProviderKey } from '../storage/secure-keys';
import {
  command, confirmPair, devices as fetchDevices, hubUrlFor, HubError, me, openStream, ping,
  type ApprovalMode, type Decision, type DeviceStatus, type Hub, type HubEvent, type Project, type SessionInfo, type StreamHandle, type ToolId, type ToolKind, type Usage,
} from './client';
import { deletePairToken, getPairToken, savePairToken } from './pair-storage';

// ——— timeline ———

export type TimelineItem =
  | { kind: 'message'; id: string; role: 'user' | 'assistant'; text: string; final: boolean; ts: number; local?: boolean }
  | { kind: 'reasoning'; id: string; text: string; final: boolean; ts: number }
  | { kind: 'tool'; id: string; tool: ToolKind; title: string; detail?: string; status: 'running' | 'done' | 'failed'; output?: string; diff?: string; exitCode?: number; ts: number }
  | { kind: 'approval'; id: string; approval: ApprovalKind; title: string; detail?: string; diff?: string; cwd?: string; state: 'pending' | Decision; by?: 'phone' | 'desktop' | 'timeout'; ts: number }
  | { kind: 'turn'; id: string; status: 'started' | 'completed' | 'failed' | 'interrupted'; error?: string; usage?: Usage; ts: number }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; ts: number };
export type ApprovalKind = 'command' | 'file_change' | 'tool' | 'permission';

export interface Timeline { items: TimelineItem[]; session?: SessionInfo; loading: boolean; error?: string }
export const EMPTY_TIMELINE: Timeline = { items: [], loading: false };

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
      return { ...timeline, items: upsert(items, { kind: 'message', id: event.id, role: event.role, text: event.text, final: event.final, ts }) };
    }
    case 'reasoning':
      return { ...timeline, items: upsert(timeline.items, { kind: 'reasoning', id: event.id, text: event.text, final: event.final, ts }) };
    case 'tool':
      return { ...timeline, items: upsert(timeline.items, { kind: 'tool', id: event.id, tool: event.kind, title: event.title, detail: event.detail, status: event.status, output: event.output, diff: event.diff, exitCode: event.exitCode, ts }) };
    case 'approval.request': {
      const existing = timeline.items.find((item) => item.kind === 'approval' && item.id === event.approvalId);
      if (existing?.kind === 'approval' && existing.state !== 'pending') return timeline;
      return { ...timeline, items: upsert(timeline.items, { kind: 'approval', id: event.approvalId, approval: event.kind, title: event.title, detail: event.detail, diff: event.diff, cwd: event.cwd, state: 'pending', ts }) };
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
      const id = `notice:${ts}:${event.text}`;
      if (timeline.items.some((item) => item.id === id)) return timeline;
      return { ...timeline, items: [...timeline.items, { kind: 'notice', id, level: event.level, text: event.text, ts }] };
    }
    default:
      return timeline;
  }
}

/** Rebuilds from session.open history, keeping live items newer than the history. */
export function mergeHistory(current: Timeline, session: SessionInfo | undefined, history: HubEvent[]): Timeline {
  let next: Timeline = { items: [], session: session ?? current.session, loading: false };
  for (const event of history) next = applyEvent(next, event);
  const newest = next.items.reduce((max, item) => Math.max(max, item.ts), 0);
  for (const item of current.items) {
    const known = next.items.some((existing) => existing.kind === item.kind && existing.id === item.id);
    if (item.kind === 'approval' && known) {
      // Keep a decision the live stream already saw.
      if (item.state !== 'pending') next = { ...next, items: upsert(next.items, item) };
      continue;
    }
    if (!known && item.ts >= newest) next = { ...next, items: [...next.items, item] };
  }
  return { ...next, session: session ?? next.session };
}

// ——— state ———

export type Probe = 'checking' | 'ok' | 'no';
export type Connection = 'idle' | 'connecting' | 'open' | 'retrying' | 'error';
export interface PendingApproval { approvalId: string; deviceId: string; sessionKey: string; tool: ToolId; title: string; ts: number }
export interface DeviceSessions { list: SessionInfo[]; loading: boolean; loaded: boolean; error?: string }

export interface RemoteState {
  /** 'loading' until the saved choice is read. */
  phase: 'loading' | 'setup' | 'pairing' | 'ready';
  serviceId: string | null;
  probes: Record<string, Probe>;
  connection: Connection;
  connectionError?: string;
  devices: DeviceStatus[];
  devicesLoaded: boolean;
  sessions: Record<string, DeviceSessions>;
  timelines: Record<string, Timeline>;
  approvals: Record<string, PendingApproval>;
  signingIn: string | null;
  /** A session to jump to when the remote screen opens (from an approval toast). */
  focus: { deviceId: string; sessionKey: string } | null;
}

const SETTING = 'remote_service';
const initial: RemoteState = { phase: 'loading', serviceId: null, probes: {}, connection: 'idle', devices: [], devicesLoaded: false, sessions: {}, timelines: {}, approvals: {}, signingIn: null, focus: null };
let state: RemoteState = initial;
let hub: Hub | null = null;
let stream: StreamHandle | null = null;
let lastSeq = 0;
let booted = false;
let screenOpen = false;
const listeners = new Set<() => void>();
const alertListeners = new Set<(approval: PendingApproval) => void>();

function set(patch: Partial<RemoteState> | ((current: RemoteState) => Partial<RemoteState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  listeners.forEach((listener) => listener());
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

export function setRemoteScreenOpen(open: boolean) { screenOpen = open; }
export function setRemoteFocus(focus: RemoteState['focus']) { set({ focus }); }
/** Foreground alerts for approvals that arrive while the remote screen is closed. */
export function onApprovalAlert(listener: (approval: PendingApproval) => void): () => void {
  alertListeners.add(listener);
  return () => { alertListeners.delete(listener); };
}

function handleEvent(event: HubEvent) {
  if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq);
  const key = timelineKey(event.deviceId, event.sessionKey);
  set((current) => {
    const patch: Partial<RemoteState> = { timelines: { ...current.timelines, [key]: applyEvent(current.timelines[key] ?? EMPTY_TIMELINE, event) } };
    if (event.type === 'session.updated') {
      const entry = current.sessions[event.deviceId] ?? { list: [], loading: false, loaded: false };
      const list = [event.session, ...entry.list.filter((item) => item.sessionKey !== event.session.sessionKey)].sort((a, b) => b.updatedAt - a.updatedAt);
      patch.sessions = { ...current.sessions, [event.deviceId]: { ...entry, list } };
    }
    if (event.type === 'approval.request') {
      patch.approvals = { ...current.approvals, [event.approvalId]: { approvalId: event.approvalId, deviceId: event.deviceId, sessionKey: event.sessionKey, tool: event.tool, title: event.title, ts: event.ts } };
    }
    if (event.type === 'approval.resolved' && current.approvals[event.approvalId]) {
      const approvals = { ...current.approvals };
      delete approvals[event.approvalId];
      patch.approvals = approvals;
    }
    return patch;
  });
  // Replayed history is not news.
  if (event.type === 'approval.request' && !screenOpen && Date.now() - event.ts < 120_000 && AppState.currentState === 'active') {
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

function startStream() {
  stream?.close();
  if (!hub?.pairToken) return;
  stream = openStream({
    hub, after: lastSeq, onEvent: handleEvent, onDevice: handleDevice,
    onState: (next, info) => {
      if (next === 'open') { set({ connection: 'open', connectionError: undefined }); void refreshDevices(true); }
      else if (next === 'connecting') set((current) => ({ connection: current.connection === 'retrying' ? 'retrying' : 'connecting' }));
      else if (next === 'retrying') set({ connection: 'retrying', connectionError: info?.error });
      else if (info?.error) set({ connection: 'error', connectionError: info.error });
    },
  });
}

function stopStream() { stream?.close(); stream = null; }

/** Reads the saved relay once and connects; call whenever the service list changes. */
export async function bootRemote(providers: ProviderProfile[]): Promise<void> {
  if (!booted) {
    booted = true;
    const saved = await getSetting(SETTING).catch(() => null);
    set({ serviceId: saved, phase: saved ? 'ready' : 'setup' });
  }
  const service = providers.find((item) => item.id === state.serviceId);
  if (state.serviceId && !service && providers.length) { await signOutRemote(); return; }
  if (!service || hub) return;
  const key = await getProviderKey(service.id).catch(() => null);
  const url = hubUrlFor(service.baseUrl);
  if (!key || !url) return;
  const pairToken = await getPairToken(service.id).catch(() => null);
  hub = { url, key, pairToken: pairToken ?? undefined };
  set({ phase: pairToken ? 'ready' : 'pairing' });
  if (pairToken) { startStream(); void refreshDevices(); }
}

/** Pauses the stream in the background and catches up (after=<seq>) on return. */
export function setRemoteForeground(active: boolean) {
  if (!hub?.pairToken) return;
  if (active && !stream) startStream();
  else if (!active) { stopStream(); set({ connection: 'idle' }); }
}

export async function probeServices(providers: ProviderProfile[]): Promise<void> {
  const byHub = new Map<string, string[]>();
  for (const service of providers) {
    const url = hubUrlFor(service.baseUrl);
    if (!url) { set((current) => ({ probes: { ...current.probes, [service.id]: 'no' } })); continue; }
    byHub.set(url, [...(byHub.get(url) ?? []), service.id]);
  }
  set((current) => {
    const probes = { ...current.probes };
    for (const ids of byHub.values()) for (const id of ids) if (probes[id] !== 'ok') probes[id] = 'checking';
    return { probes };
  });
  await Promise.all([...byHub].map(async ([url, ids]) => {
    const result: Probe = (await ping(url)) ? 'ok' : 'no';
    set((current) => ({ probes: { ...current.probes, ...Object.fromEntries(ids.map((id) => [id, result])) } }));
  }));
}

export async function signInRemote(service: ProviderProfile): Promise<void> {
  const url = hubUrlFor(service.baseUrl);
  if (!url) throw new Error('这个 API 地址不对');
  set({ signingIn: service.id });
  try {
    const key = await getProviderKey(service.id);
    if (!key) throw new Error(`没有找到“${service.name}”的 API 密钥`);
    const pairToken = await getPairToken(service.id).catch(() => null);
    const next = { url, key, pairToken: pairToken ?? undefined };
    await me(next);
    let paired = Boolean(pairToken);
    if (paired) {
      try { await fetchDevices(next); }
      catch (error) {
        // A transient outage must not erase an existing one-to-one pairing.
        if (error instanceof HubError && error.status === 403) {
          paired = false;
          await deletePairToken(service.id).catch(() => undefined);
          next.pairToken = undefined;
        }
      }
    }
    stopStream();
    hub = next;
    lastSeq = 0;
    await setSetting(SETTING, service.id);
    set({ ...initial, phase: paired ? 'ready' : 'pairing', serviceId: service.id, probes: state.probes, signingIn: null });
    if (paired) { startStream(); void refreshDevices(true); }
  } finally {
    set({ signingIn: null });
  }
}

export async function signOutRemote(): Promise<void> {
  stopStream();
  if (state.serviceId) await deletePairToken(state.serviceId).catch(() => undefined);
  hub = null;
  lastSeq = 0;
  await setSetting(SETTING, null).catch(() => undefined);
  set({ ...initial, phase: 'setup', probes: state.probes });
}

export async function pairRemote(code: string): Promise<void> {
  if (!hub || !state.serviceId) throw new Error('请先选择中转站');
  const result = await confirmPair(hub, code);
  await savePairToken(state.serviceId, result.token);
  hub = { ...hub, pairToken: result.token };
  lastSeq = 0;
  set({ phase: 'ready', devices: [result.device], devicesLoaded: true, connectionError: undefined });
  startStream();
}

export async function refreshDevices(quiet = false): Promise<void> {
  if (!hub || !hub.pairToken) return;
  try {
    const list = await fetchDevices(hub);
    set({ devices: list, devicesLoaded: true, ...(quiet ? {} : { connectionError: undefined }) });
  } catch (error) {
    if (error instanceof HubError && error.status === 403) {
      stopStream();
      if (state.serviceId) await deletePairToken(state.serviceId).catch(() => undefined);
      hub = { ...hub, pairToken: undefined };
      set({ phase: 'pairing', devices: [], connection: 'idle' });
    }
    set({ devicesLoaded: true });
    if (!quiet) throw error;
  }
}

function need(): Hub {
  if (!hub) throw new Error('还没有登录中转站');
  return hub;
}

export async function loadSessions(deviceId: string): Promise<void> {
  const entry = state.sessions[deviceId] ?? { list: [], loading: false, loaded: false };
  set((current) => ({ sessions: { ...current.sessions, [deviceId]: { ...entry, loading: true, error: undefined } } }));
  try {
    const result = await command<{ sessions?: SessionInfo[] }>(need(), deviceId, { type: 'sessions.list' });
    const list = [...(result.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
    set((current) => ({ sessions: { ...current.sessions, [deviceId]: { list, loading: false, loaded: true } } }));
  } catch (error) {
    set((current) => ({ sessions: { ...current.sessions, [deviceId]: { ...(current.sessions[deviceId] ?? entry), loading: false, loaded: true, error: (error as Error).message } } }));
    throw error;
  }
}

export async function openSession(deviceId: string, sessionKey: string): Promise<void> {
  const key = timelineKey(deviceId, sessionKey);
  set((current) => ({ timelines: { ...current.timelines, [key]: { ...(current.timelines[key] ?? EMPTY_TIMELINE), loading: true, error: undefined } } }));
  try {
    const result = await command<{ session?: SessionInfo; events?: HubEvent[] }>(need(), deviceId, { type: 'session.open', sessionKey });
    set((current) => {
      const timeline = mergeHistory(current.timelines[key] ?? EMPTY_TIMELINE, result.session, result.events ?? []);
      const approvals = { ...current.approvals };
      for (const item of timeline.items) {
        if (item.kind === 'approval' && item.state === 'pending') approvals[item.id] = { approvalId: item.id, deviceId, sessionKey, tool: timeline.session?.tool ?? 'codex', title: item.title, ts: item.ts };
        else if (item.kind === 'approval') delete approvals[item.id];
      }
      return { timelines: { ...current.timelines, [key]: timeline }, approvals };
    });
  } catch (error) {
    set((current) => ({ timelines: { ...current.timelines, [key]: { ...(current.timelines[key] ?? EMPTY_TIMELINE), loading: false, error: (error as Error).message } } }));
    throw error;
  }
}

export async function startSession(deviceId: string, input: { tool: ToolId; cwd: string; prompt: string; model?: string; approval: ApprovalMode }): Promise<string> {
  const result = await command<{ sessionKey?: string }>(need(), deviceId, { type: 'session.start', ...input, model: input.model?.trim() || undefined });
  if (!result.sessionKey) throw new Error('电脑没有返回新会话');
  const key = timelineKey(deviceId, result.sessionKey);
  set((current) => {
    const existing = current.timelines[key] ?? EMPTY_TIMELINE;
    const hasPrompt = existing.items.some((item) => item.kind === 'message' && item.role === 'user');
    return { timelines: { ...current.timelines, [key]: hasPrompt ? existing : { ...existing, items: [{ kind: 'message', id: `local:${Date.now()}`, role: 'user', text: input.prompt, final: true, ts: Date.now(), local: true }, ...existing.items] } } };
  });
  return result.sessionKey;
}

export async function sendToSession(deviceId: string, sessionKey: string, text: string): Promise<void> {
  const key = timelineKey(deviceId, sessionKey);
  const id = `local:${Date.now()}`;
  const optimistic: TimelineItem = { kind: 'message', id, role: 'user', text, final: true, ts: Date.now(), local: true };
  set((current) => ({ timelines: { ...current.timelines, [key]: { ...(current.timelines[key] ?? EMPTY_TIMELINE), items: [...(current.timelines[key]?.items ?? []), optimistic] } } }));
  try {
    await command(need(), deviceId, { type: 'session.send', sessionKey, text });
  } catch (error) {
    set((current) => ({ timelines: { ...current.timelines, [key]: { ...(current.timelines[key] ?? EMPTY_TIMELINE), items: (current.timelines[key]?.items ?? []).filter((item) => item.id !== id) } } }));
    throw error;
  }
}

export async function interruptSession(deviceId: string, sessionKey: string): Promise<void> {
  await command(need(), deviceId, { type: 'session.interrupt', sessionKey });
}

export async function respondApproval(approval: { approvalId: string; deviceId: string; sessionKey: string }, decision: Decision, message?: string): Promise<void> {
  await command(need(), approval.deviceId, { type: 'approval.respond', approvalId: approval.approvalId, decision, message: message?.trim() || undefined });
  handleEvent({ type: 'approval.resolved', approvalId: approval.approvalId, decision, by: 'phone', deviceId: approval.deviceId, sessionKey: approval.sessionKey, tool: 'codex', ts: Date.now() });
}

export async function listProjects(deviceId: string): Promise<Project[]> {
  const result = await command<{ projects?: Project[] }>(need(), deviceId, { type: 'projects.list' });
  return result.projects ?? [];
}

export async function listModels(deviceId: string, tool: ToolId): Promise<string[]> {
  try { return (await command<{ models?: string[] }>(need(), deviceId, { type: 'models.list', tool })).models ?? []; } catch { return []; }
}

/** Test hook. */
export function resetRemoteForTests() { stopStream(); hub = null; lastSeq = 0; booted = false; state = initial; }
