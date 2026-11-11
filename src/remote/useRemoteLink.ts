import { useEffect, useRef } from 'react';
import { AppState, Linking } from 'react-native';

import { showToast } from '../components/ui';
import { useApp } from '../state/AppContext';
import type { HubEvent } from './client';
import { bootRemote, getRemoteState, loadSessions, onRemoteChange, onRemoteEvent, pushTarget, remoteDeliveryScope, setRemoteFocus, setRemoteForeground, syncSessionEvents } from './store';
import { admitForegroundNotification, isVisibleThread, startRemoteNotifications } from './notifications';
import { startRemotePush } from './push';
import { createTaskNotificationPolicy, foregroundTaskNotice, type TaskNotificationDecision } from './notification-policy';
import { createNotificationDispatcher } from './notification-dispatch';
import { remoteNotificationsEnabled } from './notification-preferences';
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
  // One policy owns foreground results and actionable requests. A short batch
  // window reduces noise without swallowing a failure behind a final reply.
  useEffect(() => {
    const policy = createTaskNotificationPolicy();
    const admissions = new WeakMap<TaskNotificationDecision, boolean>();
    const dispatcher = createNotificationDispatcher<{ event: HubEvent; decision: TaskNotificationDecision }>(batch => {
      const items = batch.filter(item => {
        const { decision, event } = item.value;
        if (!admissions.has(decision)) admissions.set(decision, admitForegroundNotification(item.id, event, decision.kind));
        return admissions.get(decision);
      });
      if (!items.length) return;
      const first = items[0];
      const { event } = first.value;
      const session = getRemoteState().sessions[event.deviceId]?.list.find(item => item.sessionKey === event.sessionKey);
      const notice = foregroundTaskNotice(event, session?.title?.trim() || '远程任务', false, sessionAgentDisplayName(session, event.tool));
      if (!notice) return;
      const failed = items.filter(item => item.value.decision.kind === 'failed').length;
      const requests = items.filter(item => ['approval', 'question'].includes(item.value.decision.kind)).length;
      const text = items.length === 1 ? notice.text : [failed && `${failed} 项任务失败`, requests && `${requests} 项需要你处理`,
        items.length - failed - requests > 0 && `${items.length - failed - requests} 项任务有更新`].filter(Boolean).join(' · ');
      showToast(text, items.length === 1 ? notice.icon : failed ? 'alert' : requests ? 'code' : notice.icon, () => {
        setRemoteFocus(items.length === 1 && first.scope === remoteDeliveryScope()
          ? { deviceId: event.deviceId, sessionKey: event.sessionKey } : { home: true });
        openRef.current();
      });
    });
    const label = (event: HubEvent) => {
      const scope = remoteDeliveryScope();
      if (!scope) return;
      const decision = policy.observe(event, scope);
      if (event.type === 'approval.resolved') dispatcher.cancel(scope, `${scope}:approval:${event.deviceId}:${event.sessionKey}:${event.approvalId}`);
      if (!decision) return;
      const isCurrent = () => remoteNotificationsEnabled() && AppState.currentState === 'active' && scope === remoteDeliveryScope()
        && !isVisibleThread(event.deviceId, event.sessionKey)
        && (event.type !== 'approval.request' || Object.values(getRemoteState().approvals).some(approval => approval.deviceId === event.deviceId
          && approval.sessionKey === event.sessionKey && approval.approvalId === event.approvalId));
      if (!isCurrent()) return;
      dispatcher.enqueue({ ...decision, value: { event, decision }, isCurrent });
    };
    const unsubscribe = onRemoteEvent(label);
    return () => { unsubscribe(); dispatcher.dispose(); };
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
