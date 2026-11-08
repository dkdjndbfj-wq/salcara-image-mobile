import React, { useEffect, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useDesk } from '../theme';
import { ComposerPopover } from './ComposerPopover';
import { applyNativeSessionAction, applySessionWorkflow, nativeSessionActionScope, readNativeSessionActions, readSessionWorkflows, sessionWorkflowScope } from './store';
import type { NativeSessionActionsReading } from './session-actions';
import type { SessionWorkflowsReading } from './session-workflows';
import type { SessionCommand, SessionCommandTransport } from './session-commands';

export type { SessionCommand, SessionCommandTransport } from './session-commands';
type Reading = { kind: 'action'; reading: NativeSessionActionsReading } | { kind: 'review'; reading: SessionWorkflowsReading };
type Content = { owner: object; reading?: Reading; loading: boolean; busy: boolean; error: string };
const titles: Record<SessionCommand, string> = { fork: '创建分支', archive: '归档对话', review: '代码审查' };

/** A slash command first reads native capabilities; only its explicit action writes. */
export function SessionCommandPopover({ visible, anchorRef, scopeKey, deviceId, sessionKey, command, onClose, onFork, onArchive, onReviewStarted, transport }: {
  visible: boolean; anchorRef?: RefObject<View | null>; scopeKey: string; deviceId: string; sessionKey: string; command: SessionCommand;
  onClose: () => void; onFork: (key: string) => void; onArchive: () => void; onReviewStarted?: () => void; transport?: SessionCommandTransport;
}) {
  const dk = useDesk(), [reload, setReload] = useState(0), [content, setContent] = useState<Content>();
  const sourceScope = () => transport ? transport.scope() : command === 'review' ? sessionWorkflowScope(deviceId, sessionKey) : nativeSessionActionScope(deviceId, sessionKey);
  let scope = ''; try { if (visible) scope = sourceScope(); } catch { /* An unavailable source cannot submit. */ }
  const identity = JSON.stringify([visible, scopeKey, scope, deviceId, sessionKey, command]);
  const owner = useRef({ identity, transport, token: {} });
  if (owner.current.identity !== identity || owner.current.transport !== transport) owner.current = { identity, transport, token: {} };
  const token = owner.current.token, mounted = useRef(true), reader = useRef<AbortController | null>(null), flight = useRef<object | null>(null);
  const uncertain = useRef(new Set<string>()), callbacks = useRef({ onClose, visible }); callbacks.current = { onClose, visible };
  const active = () => {
    try { return mounted.current && visible && owner.current.token === token && AppState.currentState !== 'background' && AppState.currentState !== 'inactive'
      && Boolean(scope) && sourceScope() === scope && (!transport || transport.isCurrent()); } catch { return false; }
  };
  const dismiss = () => {
    if (!mounted.current || owner.current.token !== token) return;
    owner.current.token = {}; reader.current?.abort(); onClose();
  };
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => {
      if (state === 'active') return;
      owner.current.token = {}; reader.current?.abort(); if (callbacks.current.visible) callbacks.current.onClose();
    });
    return () => { mounted.current = false; reader.current?.abort(); listener.remove(); };
  }, []);
  useEffect(() => {
    flight.current = null;
    if (!active()) { setContent({ owner: token, loading: false, busy: false, error: visible ? '会话连接已改变' : '' }); return; }
    const controller = new AbortController(); reader.current?.abort(); reader.current = controller;
    setContent({ owner: token, loading: true, busy: false, error: '' });
    void Promise.resolve().then(async (): Promise<Reading> => {
      if (!active() || controller.signal.aborted) throw new Error('cancelled');
      return command === 'review'
        ? { kind: 'review', reading: await (transport ? transport.readWorkflows(controller.signal) : readSessionWorkflows(deviceId, sessionKey, controller.signal)) }
        : { kind: 'action', reading: await (transport ? transport.readActions(controller.signal) : readNativeSessionActions(deviceId, sessionKey, controller.signal)) };
    }).then(value => {
      if (!active() || controller.signal.aborted) return;
      if (value.reading.scope !== scope || value.reading.value.sessionKey !== sessionKey) throw new Error('source changed');
      setContent({ owner: token, reading: value, loading: false, busy: false, error: '' });
    }).catch(() => { if (active() && !controller.signal.aborted) setContent({ owner: token, loading: false, busy: false, error: '暂时无法读取，请刷新状态' }); });
    return () => controller.abort();
  }, [token, reload]);
  const current = content?.owner === token ? content : undefined, reading = current?.reading;
  const latest = useRef(current); latest.current = current;
  const uncertainKey = reading ? JSON.stringify([scope, reading.kind, reading.reading.value.revision]) : '';
  const blocked = Boolean(uncertainKey && uncertain.current.has(uncertainKey));
  const available = reading?.kind === 'review' ? reading.reading.value.canReview : reading?.reading.value.actions.includes(command as 'fork' | 'archive');
  const disabled = !active() || !reading || !available || blocked || Boolean(current?.loading || current?.busy);
  const execute = () => {
    if (disabled || !reading || !active() || flight.current || latest.current !== current || uncertain.current.has(uncertainKey)) return;
    const mutation = {}; flight.current = mutation; reader.current?.abort();
    setContent({ owner: token, reading, loading: false, busy: true, error: '' });
    void (async () => {
      try {
        // Re-check at dispatch, including retained event handlers from a prior render.
        if (!active()) return;
        if (reading.kind === 'review') {
          const result = await (transport ? transport.applyReview(reading.reading) : applySessionWorkflow(deviceId, sessionKey, reading.reading, { kind: 'review', target: { type: 'uncommittedChanges' } }));
          if (!active()) return;
          if (result.sessionKey !== sessionKey || result.kind !== 'review' || result.state !== 'requested') throw new Error('unconfirmed');
          dismiss(); onReviewStarted?.();
        } else {
          const action = command as 'fork' | 'archive';
          const result = await (transport ? transport.applyAction(reading.reading, action) : applyNativeSessionAction(deviceId, sessionKey, reading.reading, action));
          if (!active()) return;
          if (result.sessionKey !== sessionKey || result.action !== action || result.state !== 'completed' || action === 'fork' && !result.session) throw new Error('unconfirmed');
          dismiss(); if (action === 'fork') onFork(result.session!.sessionKey); else onArchive();
        }
      } catch {
        if (!active()) return;
        uncertain.current.add(uncertainKey);
        setContent({ owner: token, reading, loading: false, busy: false, error: '操作结果尚未确认，请刷新状态' });
      } finally {
        if (flight.current === mutation) flight.current = null;
      }
    })();
  };
  const loading = !current || current.loading, busy = Boolean(current?.busy);
  const status = current?.error || (blocked ? '操作结果尚未确认，请刷新状态' : reading?.reading.value.unavailableReason || (!loading && !available ? '当前会话暂不支持此操作' : ''));
  return <ComposerPopover visible={visible} anchorRef={anchorRef} onClose={dismiss} width={256} testID="session-command-menu" accessibilityLabel={titles[command]}>
    <View style={styles.body}>
      <Text style={[styles.title, { color: dk.text }]}>{titles[command]}</Text>
      <Text numberOfLines={2} style={[styles.detail, { color: dk.muted }]}>{command === 'review' ? '审查未提交的更改' : reading?.kind === 'action' ? reading.reading.value.title || '当前对话' : '当前对话'}</Text>
      {loading || busy ? <View style={styles.status}><ActivityIndicator size="small" color={dk.muted} /><Text style={[styles.detail, { color: dk.muted }]}>{busy ? '处理中…' : '读取状态…'}</Text></View> : null}
      {status ? <Text accessibilityRole="alert" style={[styles.detail, { color: dk.muted }]}>{status}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={command === 'review' ? '开始审查' : titles[command]} accessibilityState={{ disabled }} disabled={disabled} onPress={execute}
        style={({ pressed }) => [styles.action, { backgroundColor: pressed ? dk.surface3 : dk.surface2, opacity: disabled ? .45 : 1 }]}>
        <Text style={[styles.label, { color: dk.text }]}>{command === 'review' ? '开始审查' : titles[command]}</Text>
      </Pressable>
      {status && !busy ? <Pressable accessibilityRole="button" accessibilityLabel="刷新状态" disabled={loading} onPress={() => { if (active() && !flight.current) setReload(value => value + 1); }} style={styles.action}>
        <Text style={[styles.label, { color: dk.muted }]}>刷新状态</Text>
      </Pressable> : null}
    </View>
  </ComposerPopover>;
}
const styles = StyleSheet.create({ body: { padding: 12, gap: 8 }, title: { fontSize: 14, lineHeight: 20, fontWeight: '600' }, detail: { fontSize: 12, lineHeight: 18 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 26 }, action: { minHeight: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 }, label: { fontSize: 13, lineHeight: 19 } });
