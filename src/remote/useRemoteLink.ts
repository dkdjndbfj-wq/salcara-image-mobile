import { useEffect, useRef } from 'react';
import { AppState, Linking } from 'react-native';

import { showToast } from '../components/ui';
import { useApp } from '../state/AppContext';
import type { HubEvent } from './client';
import { bootRemote, getRemoteState, loadSessions, onApprovalAlert, onRemoteChange, onRemoteEvent, pushTarget, remoteDeliveryScope, setRemoteFocus, setRemoteForeground, syncSessionEvents } from './store';
import { isVisibleThread, startRemoteNotifications } from './notifications';
import { startRemotePush } from './push';
import { foregroundTaskNotice } from './notification-policy';
import { parseSalcaraThreadLink } from './remote-links';
import { nextBackgroundSyncBatch } from './background-sync';
import { sessionAgentDisplayName } from './agent-catalog';

/** Restore pairing locally; network access is demand-driven by the visible remote workspace. */
export function useRemoteLink(onOpen: () => void) {
  const { providers, ready, space } = useApp();
  const openRef = useRef(onOpen); openRef.current = onOpen;
  useEffect(() => { if (ready) void bootRemote(providers).catch(() => undefined); }, [providers, ready]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: string) => setRemoteForeground(next === 'active'));
    return () => subscription?.remove?.();
  }, []);
  // Task completion/failure/final-reply notifications; a tap opens that thread.
  useEffect(() => startRemoteNotifications(() => openRef.current()), []);
  // App-owned session links carry exact connection, computer and Agent scope.
  // They only navigate; the receiving screen still performs normal read checks.
  useEffect(() => {
    let active = true, last = '', queued: ReturnType<typeof parseSalcaraThreadLink>;
    const openTarget = (target: NonNullable<ReturnType<typeof parseSalcaraThreadLink>>) => {
      const remote = getRemoteState();
      if (remote.phase !== 'ready' || remote.signingIn) { queued = target; return; }
      queued = undefined;
      setRemoteFocus(target);
      openRef.current();
    };
    const openLink = (url: string | null | undefined) => {
      if (!url || !active) return;
      const target = parseSalcaraThreadLink(url);
      if (!target) return;
      const identity = JSON.stringify(target);
      if (last === identity) return;
      last = identity;
      openTarget(target);
      setTimeout(() => { if (last === identity) last = ''; }, 1500);
    };
    void Linking.getInitialURL().then(openLink).catch(() => undefined);
    const subscription = Linking.addEventListener('url', event => openLink(event.url));
    const remoteSub = onRemoteChange(() => { if (active && queued) openTarget(queued); });
    return () => { active = false; queued = undefined; subscription.remove(); remoteSub(); };
  }, []);
  useEffect(() => startRemotePush(), []);
  // Approval requests are actionable in the assistant/chat spaces. The
  // programming space renders them inline and must not also show a global
  // toast that can steal attention from its composer.
  useEffect(() => {
    if (space === 'remote') return undefined;
    return onApprovalAlert((approval) => {
      if (AppState.currentState !== 'active') return;
      const scope = remoteDeliveryScope();
      const session = getRemoteState().sessions[approval.deviceId]?.list.find(item => item.sessionKey === approval.sessionKey);
      showToast(`电脑上的 ${sessionAgentDisplayName(session, approval.tool)} 需要批准：${approval.title}`, 'code', () => {
        setRemoteFocus(scope === remoteDeliveryScope() ? { deviceId: approval.deviceId, sessionKey: approval.sessionKey } : { home: true });
        openRef.current();
      });
    });
  }, [space]);
  // The programming thread already renders its own live status. Other spaces
  // get only terminal events or a completed assistant reply, never tool noise,
  // intermediate tokens, approvals, or generic error banners.
  useEffect(() => {
    const seen = new Map<string, number>();
    const lastNoticeAt = new Map<string, number>();
    const label = (event: HubEvent) => {
      const session = getRemoteState().sessions[event.deviceId]?.list.find(item => item.sessionKey === event.sessionKey);
      const name = session?.title?.trim() || '远程任务';
      const agent = sessionAgentDisplayName(session, event.tool);
      const notice = foregroundTaskNotice(event, name, isVisibleThread(event.deviceId, event.sessionKey), agent);
      if (!notice) return;
      const sessionId = `${event.deviceId}|${event.sessionKey}`;
      const eventId = 'id' in event ? event.id : 'seq' in event ? event.seq ?? event.ts : event.ts;
      const id = `${sessionId}|${event.turnId ?? `${event.type}:${eventId}`}`;
      const now = Date.now();
      if (seen.has(id) || now - event.ts > 10 * 60_000 || now - (lastNoticeAt.get(sessionId) ?? 0) < 8_000) return;
      seen.set(id, now);
      lastNoticeAt.set(sessionId, now);
      if (seen.size > 200) seen.delete(seen.keys().next().value as string);
      if (lastNoticeAt.size > 200) lastNoticeAt.delete(lastNoticeAt.keys().next().value as string);
      if (AppState.currentState === 'active') {
        const scope = remoteDeliveryScope();
        showToast(notice.text, notice.icon, () => {
          setRemoteFocus(scope === remoteDeliveryScope() ? { deviceId: event.deviceId, sessionKey: event.sessionKey } : { home: true });
          openRef.current();
        });
      }
    };
    return onRemoteEvent(label);
  }, []);

  // Keep a small, cancellable foreground window across spaces. The visible
  // thread keeps using its own long-poll; other known active threads are
  // followed while the list is refreshed slowly to discover desktop-started
  // work. Backgrounding aborts the JS work immediately.
  useEffect(() => {
    if (!ready) return undefined;
    let controller: AbortController | null = null;
    const inFlight = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let refreshingSessions = false;
    let lastSessionRefresh = 0;
    let nextSyncKey: string | null = null;
    const sync = () => {
      if (stopped || AppState.currentState !== 'active') return;
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (!controller || controller.signal.aborted) controller = new AbortController();
      const target = pushTarget();
      const state = getRemoteState();
      const entry = target ? state.sessions[target.deviceId] : undefined;
      if (target && !refreshingSessions && (!entry?.loaded || Date.now() - lastSessionRefresh >= 30_000) && !entry?.loading) {
        refreshingSessions = true; lastSessionRefresh = Date.now();
        void loadSessions(target.deviceId).catch(() => undefined).finally(() => { refreshingSessions = false; sync(); });
      }
      const running = target ? (entry?.list ?? [])
        .filter(session => !session.parentSessionKey && (session.status === 'running' || session.status === 'waiting_approval'))
        .map(session => ({ deviceId: target.deviceId, session })) : [];
      const background = running.filter(({ deviceId, session }) => !isVisibleThread(deviceId, session.sessionKey));
      const keyOf = ({ deviceId, session }: typeof running[number]) => `${deviceId}|${session.sessionKey}`;
      const batch = nextBackgroundSyncBatch(background, nextSyncKey, inFlight, keyOf, 4);
      nextSyncKey = batch.cursorKey;
      for (const { deviceId, session } of batch.items) {
        const key = keyOf({ deviceId, session });
        inFlight.add(key);
        void syncSessionEvents(deviceId, session.sessionKey, 0, controller.signal).catch(() => undefined).finally(() => inFlight.delete(key));
      }
      // A short cadence is only needed while work is known to be running. A
      // much slower idle check lets a desktop-started task become visible
      // without keeping a battery-draining poll loop alive all day.
      timer = setTimeout(sync, running.length ? 3500 : 15000);
    };
    const appSub = AppState.addEventListener('change', next => {
      if (next === 'active') { controller = new AbortController(); if (timer) clearTimeout(timer); sync(); }
      else { controller?.abort(); controller = null; if (timer) { clearTimeout(timer); timer = undefined; } }
    });
    const changeSub = onRemoteChange(() => { if (AppState.currentState === 'active') sync(); });
    sync();
    return () => { stopped = true; controller?.abort(); if (timer) clearTimeout(timer); appSub.remove(); changeSub(); };
  }, [ready, space]);
}
