import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { showToast } from '../components/ui';
import { themed, useDesk } from '../theme';
import type { DeviceStatus } from './client';
import { diagnosticDuration, diagnosticSummary, type ConnectionDiagnosticResult, type DiagnosticSegment } from './connection-diagnostics';
import { remoteConnectionModeLabel, remoteConnectionState } from './connection-state';
import { diagnoseRemoteConnection, remoteDeliveryScope, type RemoteState } from './store';
import { ProgrammingAction, ProgrammingCard, ProgrammingSheet } from './ProgrammingUi';

export function RemoteConnectionDiagnostics({ visible, onClose, remote, device }: { visible: boolean; onClose: () => void; remote: RemoteState; device?: DeviceStatus }) {
  const styles = useStyles(), dk = useDesk();
  const profile = remote.connections.find(item => item.id === remote.connectionId);
  const target = profile?.deviceId ?? device?.deviceId;
  // Device IDs can repeat across stations. The selected connection's snapshot
  // owns status and naming; an old prop is only a fallback for legacy callers.
  const currentDevice = profile ? remote.devices?.find(item => item.deviceId === target) : device;
  const name = profile?.alias || currentDevice?.name || profile?.deviceName || '当前电脑';
  const mode = remoteConnectionModeLabel(remote);
  const state = remoteConnectionState(remote, currentDevice);
  const [result, setResult] = useState<ConnectionDiagnosticResult | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const controller = useRef<AbortController | null>(null), revision = useRef(0);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scope = remoteDeliveryScope();
  const owner = useMemo(() => ({ visible, target, connectionId: remote.connectionId }), [visible, target, remote.connectionId, remote.selectedHubUrl, scope, remote.phase]);
  const current = useRef(owner);
  current.current = owner;
  useEffect(() => {
    revision.current++;
    controller.current?.abort(); controller.current = null;
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    setResult(null); setBusy(false); setNotice(''); setCooldown(false);
    return () => { revision.current++; controller.current?.abort(); controller.current = null; if (cooldownTimer.current) clearTimeout(cooldownTimer.current); };
  }, [owner]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', next => {
      if (next === 'active' || !controller.current) return;
      revision.current++; controller.current.abort(); controller.current = null;
      setBusy(false); setNotice('已暂停后台检测，请回到此页后重新检测。');
    });
    return () => listener.remove();
  }, []);
  const close = () => { revision.current++; controller.current?.abort(); controller.current = null; onClose(); };
  const run = async () => {
    if (current.current !== owner || !visible || !target || controller.current || cooldown) return;
    const id = ++revision.current, selected = remote.connectionId, requested = target;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setNotice(''); setResult(null); setCooldown(true);
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => { cooldownTimer.current = null; setCooldown(false); }, 5000);
    const owns = () => current.current === owner && revision.current === id && !abort.signal.aborted && current.current.visible && current.current.target === requested && current.current.connectionId === selected;
    try {
      const measured = await diagnoseRemoteConnection(requested, abort.signal);
      if (owns()) setResult(measured);
    } catch {
      if (owns()) setNotice('连接或配对已变化，请确认当前电脑后重新检测。');
    } finally {
      if (controller.current === abort) controller.current = null;
      if (revision.current === id) setBusy(false);
    }
  };
  const exportSummary = async (copy: boolean) => {
    if (current.current !== owner || !result || !visible || busy) return;
    const summary = diagnosticSummary(result);
    try {
      if (copy) { await Clipboard.setStringAsync(summary); showToast('脱敏摘要已复制', 'check'); }
      else await Share.share({ title: 'Salcara 连接诊断', message: summary });
    } catch { showToast('摘要导出未完成，可以使用复制摘要', 'alert'); }
  };
  const row = (label: string, segment?: DiagnosticSegment) => <View key={label} style={styles.row}>
    <View style={styles.rowHead}><Text style={styles.label}>{label}</Text><Text style={[styles.value, { color: segment?.status === 'ok' ? dk.text : dk.muted }]}>{segment ? diagnosticDuration(segment) : '未测量'}</Text></View>
    <Text style={styles.detail}>{segment?.detail ?? '点击检测后显示当前连接的实测结果。'}</Text>
  </View>;
  return <ProgrammingSheet visible={visible} title="连接诊断" subtitle={`${name} · ${mode}`} onClose={close}>
    <ProgrammingCard><View style={styles.overview}><Text style={styles.heading}>{state.label}</Text><Text style={styles.detail}>{state.detail}</Text></View></ProgrammingCard>
    <ProgrammingCard style={styles.card}>
      {row(`手机 ↔ ${mode}`, result?.hub)}
      {row(`${mode} ↔ 电脑`, result?.computer)}
      {row('完整回显', result?.roundTrip)}
    </ProgrammingCard>
    {result ? <Text style={styles.note}>检测于 {new Date(result.checkedAt).toLocaleString()}{result.lastSeen ? `\n电脑最近报告：${new Date(result.lastSeen).toLocaleString()}` : ''}</Text> : null}
    {notice ? <Text accessibilityRole="alert" style={styles.note}>{notice}</Text> : null}
    {!target ? <Text style={styles.note}>请先选择一台已配对的电脑。</Text> : null}
    <ProgrammingAction label={cooldown && !busy ? '稍后重新检测' : '检测当前连接'} icon="pulse" loading={busy} disabled={!target || cooldown || Boolean(remote.signingIn)} onPress={() => void run()} style={styles.action} />
    {result ? <View style={styles.exports}><ProgrammingAction tone="secondary" label="导出摘要" icon="share" onPress={() => void exportSummary(false)} style={styles.exportButton} /><ProgrammingAction tone="secondary" label="复制摘要" icon="copy" onPress={() => void exportSummary(true)} style={styles.exportButton} /></View> : null}
    <Text style={styles.note}>各项包含网络与处理时间，完整回显不包含模型推理。这里只测当前连接，不代表所有用户的延迟。关闭页面、切换电脑或进入后台会取消检测。</Text>
    <Text style={styles.note}>导出的摘要仅含检测时间、状态和耗时，不含地址、节点、设备标识、配对凭据或会话内容。</Text>
  </ProgrammingSheet>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  card: { marginTop: 14 }, overview: { padding: 16, gap: 6 }, heading: { color: d.text, fontSize: 15, fontWeight: '600' },
  row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line, gap: 6 },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  label: { color: d.text2, fontSize: 13, fontWeight: '500' }, value: { fontSize: 15, fontWeight: '600' },
  detail: { color: d.muted, fontSize: 12, lineHeight: 19 }, note: { color: d.muted, fontSize: 12, lineHeight: 20, marginTop: 14 },
  action: { marginTop: 18 }, exports: { flexDirection: 'row', gap: 10, marginTop: 10 }, exportButton: { flex: 1 },
}));
