import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppDialog, showToast } from '../components/ui';
import { useDesk } from '../theme';
import { applyNativeSessionAction, nativeSessionActionScope, readNativeSessionActions, remoteDeliveryScope, useRemote } from './store';
import { type NativeSessionActionsReading, type SessionAction, validSessionName } from './session-actions';
import { renameThread } from './thread-titles';

const labels: Record<SessionAction, string> = { rename: '重命名', archive: '归档', unarchive: '恢复对话', fork: '创建分支' };
export function SessionActionsSheet({ visible, deviceId, sessionKey, onClose, onFork, onArchive, onComplete }: {
  visible: boolean; deviceId: string; sessionKey: string; onClose: () => void; onFork: (key: string) => void; onArchive: () => void; onComplete?: (action: SessionAction) => void;
}) {
  useRemote();
  const dk = useDesk(), [reading, setReading] = useState<NativeSessionActionsReading>(), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [renaming, setRenaming] = useState(false), [name, setName] = useState('');
  const flight = useRef<object | null>(null), owner = useRef<object | null>(null);
  let scope = '';
  try { if (visible) scope = nativeSessionActionScope(deviceId, sessionKey); } catch { /* A removed pairing has no usable scope. */ }
  const identity = `${visible}|${deviceId}|${sessionKey}|${scope}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const renderOwner = useRef({ identity, token: {} });
  if (renderOwner.current.identity !== identity) renderOwner.current = { identity, token: {} };
  const renderToken = renderOwner.current.token;
  const currentOwner = (active: object | null) => {
    try { return active !== null && owner.current === active && renderOwner.current.token === renderToken && currentIdentity.current === identity && scope === nativeSessionActionScope(deviceId, sessionKey); }
    catch { return false; }
  };
  const close = () => { if (currentOwner(owner.current)) onClose(); };
  useEffect(() => {
    const active = {}; owner.current = active; flight.current = null;
    setReading(undefined); setError(''); setBusy(false); setRenaming(false); setName('');
    if (!visible || !scope) return () => { if (owner.current === active) owner.current = null; };
    const controller = new AbortController();
    void readNativeSessionActions(deviceId, sessionKey, controller.signal).then(value => {
      if (!currentOwner(active)) return;
      setReading(value); setName(value.value.title);
    }).catch((reason: Error) => { if (owner.current === active && currentIdentity.current === identity && !controller.signal.aborted) setError(reason.message); });
    return () => { controller.abort(); if (owner.current === active) owner.current = null; };
  }, [identity]);
  const execute = (action: SessionAction) => {
    if (!reading || !scope || !currentOwner(owner.current) || flight.current || reading.scope !== scope) return;
    const active = owner.current, token = {}, deliveryScope = remoteDeliveryScope();
    flight.current = token; setBusy(true); setError('');
    void (async () => {
      try {
        const result = await applyNativeSessionAction(deviceId, sessionKey, reading, action, action === 'rename' ? name.trim() : undefined);
        if (!currentOwner(active)) return;
        if (result.state !== 'completed') { setReading(undefined); setError(result.error || '操作结果未确认'); return; }
        if (action === 'rename') {
          await renameThread(deviceId, sessionKey, '', deliveryScope);
          if (!currentOwner(active)) return;
        }
        onClose();
        if (action === 'fork' && result.session) onFork(result.session.sessionKey);
        else if (action === 'archive') onArchive();
        else { onComplete?.(action); showToast(action === 'rename' ? '名称已同步' : '对话已恢复', 'checkCircle'); }
      } catch (reason) {
        if (owner.current === active && currentIdentity.current === identity) { setError(reason instanceof Error ? reason.message : '操作失败'); setReading(undefined); }
      } finally {
        if (flight.current === token) flight.current = null;
        if (owner.current === active && currentIdentity.current === identity) setBusy(false);
      }
    })();
  };
  return <AppDialog visible={visible} title={renaming ? '重命名对话' : '管理会话'} icon="code" onClose={close} actions={[
    ...(renaming ? [{ label: '保存', tone: 'primary' as const, disabled: busy || !reading || !validSessionName(name.trim()), onPress: () => execute('rename') }]
      : (reading?.value.actions ?? []).map(action => ({ label: labels[action], tone: 'secondary' as const, disabled: busy, onPress: () => {
        if (!currentOwner(owner.current) || flight.current) return;
        if (action === 'rename') setRenaming(true); else execute(action);
      } }))),
    { label: '关闭', tone: 'secondary', onPress: close },
  ]}>
    {renaming ? <TextInput accessibilityLabel="原生会话名称" value={name} onChangeText={setName} editable={!busy} maxLength={160} selectTextOnFocus autoFocus
      style={[styles.input, { color: dk.text, backgroundColor: dk.surface2 }]} /> : null}
    {busy || !reading && !error && scope ? <View style={styles.status}><ActivityIndicator size="small" color={dk.muted} /><Text style={[styles.text, { color: dk.muted }]}>{busy ? '处理中…' : '读取会话…'}</Text></View> : null}
    {error || !scope ? <Text accessibilityRole="alert" style={[styles.text, { color: dk.bad }]}>{error || '会话连接已改变'}</Text>
      : reading && !reading.value.actions.length ? <Text style={[styles.text, { color: dk.muted }]}>{reading.value.unavailableReason || '当前会话暂不支持管理操作'}</Text> : null}
  </AppDialog>;
}
const styles = StyleSheet.create({ input: { minHeight: 40, borderRadius: 10, paddingHorizontal: 12, fontSize: 13 },
  status: { minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 8 }, text: { fontSize: 12, lineHeight: 18 } });
