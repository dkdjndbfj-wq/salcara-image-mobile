import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { AppDialog } from '../components/ui';
import { useDesk } from '../theme';
import { cooperationCandidate, readCooperationReceipts, saveCooperationReceipt, type CooperationReading, type CooperationReceipt } from './cooperation';
import { cooperationScope, cooperationReceiptOwner, loadSessions, prepareCooperation, sendCooperation, useRemote } from './store';

export function CooperationSheet({ deviceId, sourceSessionKey, initialTarget, onClose, onOpenTask }: {
  deviceId: string; sourceSessionKey: string; initialTarget?: string; onClose: () => void; onOpenTask: (key: string) => void;
}) {
  const dk = useDesk(), remote = useRemote();
  let scope = ''; try { scope = cooperationScope(deviceId, sourceSessionKey); } catch { /* source unavailable */ }
  const receiptOwner = cooperationReceiptOwner(deviceId), identity = `${deviceId}|${sourceSessionKey}|${scope}`;
  const owner = useRef(identity), mounted = useRef(true), flight = useRef(false), reader = useRef<AbortController | null>(null);
  owner.current = identity;
  const [query, setQuery] = useState(''), [text, setText] = useState(''), [reading, setReading] = useState<CooperationReading>(), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [receipts, setReceipts] = useState<CooperationReceipt[]>([]), [expired, setExpired] = useState(false);
  const current = () => { try { return mounted.current && owner.current === identity && scope !== '' && scope === cooperationScope(deviceId, sourceSessionKey); } catch { return false; } };
  const refreshReceipts = async () => { const list = await readCooperationReceipts(receiptOwner, sourceSessionKey); if (current()) setReceipts(list); };
  const select = (target: string) => {
    if (!current() || flight.current) return;
    reader.current?.abort(); const controller = new AbortController(); reader.current = controller;
    setBusy(true); setReading(undefined); setError('');
    void prepareCooperation(deviceId, sourceSessionKey, target, controller.signal).then(value => {
      if (current() && !controller.signal.aborted) { setReading(value); setExpired(false); }
    }, reason => { if (current() && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法读取任务'); })
      .finally(() => { if (current() && !controller.signal.aborted) setBusy(false); });
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reader.current?.abort(); }; }, []);
  useEffect(() => {
    setReading(undefined); setText(''); setQuery(''); setError(''); setReceipts([]); setBusy(false); flight.current = false;
    void refreshReceipts().catch(reason => { if (current()) setError(reason.message); });
    void loadSessions(deviceId, sourceSessionKey.split(':')[0]).catch(reason => { if (current()) setError(reason.message); });
    if (initialTarget) select(initialTarget);
    return () => reader.current?.abort();
  }, [identity]);
  useEffect(() => {
    if (!reading) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, reading.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [reading]);
  const pending = receipts.find(item => item.state === 'unconfirmed');
  const send = () => {
    if (!current() || !reading || expired || !text.trim() || busy || pending || flight.current) return;
    flight.current = true; setBusy(true); setError('');
    void sendCooperation(deviceId, reading, text).then(() => { if (current()) { setText(''); setReading(undefined); } }, reason => {
      if (current()) { setError(reason instanceof Error ? reason.message : '发送结果未确认，请核对目标任务'); setReading(undefined); }
    }).finally(() => { flight.current = false; if (current()) { setBusy(false); void refreshReceipts().catch(reason => setError(reason.message)); } });
  };
  const label = { color: dk.text, fontSize: 14, lineHeight: 21 }, detail = { color: dk.muted, fontSize: 12, lineHeight: 18 };
  const candidates = (remote.sessions[deviceId]?.list ?? []).filter(item => cooperationCandidate(item, sourceSessionKey)
    && `${item.title} ${item.cwd} ${item.sessionKey}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <AppDialog visible title={initialTarget ? '回复到另一任务' : '发送到另一任务'} icon="chat" onClose={onClose} actions={[
    ...(reading ? [{ label: '发送消息', tone: 'primary' as const, onPress: send, disabled: busy || expired || !text.trim() || Boolean(pending) }] : []),
    { label: '关闭', tone: 'secondary', onPress: onClose },
  ]}>
    <View style={{ gap: 10 }}>
      <Text style={detail}>由你发送到同一 Agent 的另一个可接收任务。对方会开始新一轮处理。</Text>
      {reading ? <>
        <Text style={label}>来源：{reading.source.title || sourceSessionKey}</Text>
        <Text style={label}>接收：{reading.target.title || reading.target.sessionKey}</Text>
        <TextInput accessibilityLabel="跨任务消息" multiline value={text} onChangeText={setText} editable={!busy && !pending} maxLength={16000}
          placeholder="输入要发送的消息" placeholderTextColor={dk.muted} style={{ ...label, minHeight: 100, maxHeight: 220, padding: 12, backgroundColor: dk.surface2, borderRadius: 10, textAlignVertical: 'top' }} />
        {expired ? <Text accessibilityRole="alert" style={{ ...detail, color: dk.bad }}>验证已过期，请重新选择任务。</Text> : null}
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => { if (current()) setReading(undefined); }} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={{ ...label, color: dk.accentText }}>重新选择任务</Text></Pressable>
      </> : !pending ? <>
        <TextInput accessibilityLabel="搜索接收任务" value={query} onChangeText={setQuery} placeholder="搜索任务名称或项目" placeholderTextColor={dk.muted} style={{ ...label, padding: 12, backgroundColor: dk.surface2, borderRadius: 10 }} />
        <ScrollView style={{ maxHeight: 240 }} keyboardShouldPersistTaps="handled">
          {candidates.map(item => <Pressable key={item.sessionKey} accessibilityRole="button" accessibilityLabel={`选择 ${item.title}`} disabled={busy} onPress={() => select(item.sessionKey)} style={{ minHeight: 52, paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: dk.line }}>
            <Text numberOfLines={2} style={label}>{item.title || item.sessionKey}</Text><Text numberOfLines={1} style={detail}>{item.cwd}</Text>
          </Pressable>)}
          {!candidates.length ? <Text style={detail}>没有匹配的可接收任务。运行中、归档及只读任务不会显示。</Text> : null}
        </ScrollView>
      </> : null}
      {busy ? <ActivityIndicator color={dk.muted} /> : null}
      {error || !scope ? <Text accessibilityRole="alert" style={{ ...detail, color: dk.bad }}>{error || '连接已变化，请重新打开'}</Text> : null}
      {receipts.slice(-5).reverse().map(receipt => <View key={receipt.operationId} style={{ gap: 5, paddingTop: 8, borderTopColor: dk.line, borderTopWidth: 0.5 }}>
        <Text style={detail}>{receipt.state === 'sent' ? '已发送' : receipt.state === 'acknowledged' ? '已核对' : receipt.state === 'not_sent' ? '未发送' : '待核对'} · {receipt.targetTitle}</Text>
        <Text numberOfLines={2} style={label}>{receipt.text}</Text>
        <Pressable accessibilityRole="button" onPress={() => { if (current()) onOpenTask(receipt.targetSessionKey); }} style={{ minHeight: 40, justifyContent: 'center' }}><Text style={{ ...label, color: dk.accentText }}>打开目标任务</Text></Pressable>
        {receipt.state === 'unconfirmed' ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => {
          if (!current()) return;
          void saveCooperationReceipt(receiptOwner, { ...receipt, state: 'acknowledged' }).then(refreshReceipts).catch(reason => { if (current()) setError(reason.message); });
        }} style={{ minHeight: 40, justifyContent: 'center' }}><Text style={{ ...detail, color: dk.accentText }}>已核对目标，允许我开始新消息</Text></Pressable> : null}
      </View>)}
    </View>
  </AppDialog>;
}
