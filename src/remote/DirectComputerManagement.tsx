import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { themed, useDesk } from '../theme';
import { ProgrammingCard, ProgrammingField, ProgrammingPanel, ProgrammingSection, ProgrammingSheet } from './ProgrammingUi';
import { apiCreationConfirmed, buildComputerApiCommand, parseManagementJob, parseManagementStatus,
  type ComputerManagementTransport, type ManagementAuth, type ManagementItem, type ManagementStatus, type ManagementWire } from './direct-computer-management';

export interface DirectComputerManagementProps {
  visible: boolean; online: boolean;
  /** Includes the direct pairing identity, device and connection generation. Never a Hub scope. */
  scope: string; onClose: () => void; command: ComputerManagementTransport; onChanged: () => void;
}
const wires: { value: ManagementWire; label: string }[] = [
  { value: 'auto', label: '自动' }, { value: 'responses', label: 'Responses' }, { value: 'chat', label: 'Chat Completions' }, { value: 'anthropic', label: 'Messages' },
];

export function DirectComputerManagement({ visible, online, scope, onClose, command, onChanged }: DirectComputerManagementProps) {
  const styles = useStyles(), t = useDesk();
  const [status, setStatus] = useState<ManagementStatus | null>(null), [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState<'api' | 'install' | null>(null);
  const [expanded, setExpanded] = useState(false), [uncertain, setUncertain] = useState(false);
  const [installUncertain, setInstallUncertain] = useState(false);
  const [name, setName] = useState(''), [baseUrl, setBaseUrl] = useState(''), [key, setKey] = useState(''), [models, setModels] = useState('');
  const [wire, setWire] = useState<ManagementWire>('auto'), [authMode, setAuthMode] = useState<ManagementAuth>('bearer');
  const [confirm, setConfirm] = useState<ManagementItem | null>(null);
  const confirmation = useRef<ManagementItem | null>(null); confirmation.current = confirm;
  const generation = useRef({ visible, online, scope });
  if (generation.current.visible !== visible || generation.current.online !== online || generation.current.scope !== scope) generation.current = { visible, online, scope };
  const rendered = generation.current;
  const callbacks = useRef({ command, onChanged, onClose }); callbacks.current = { command, onChanged, onClose };
  const mutation = useRef<object | null>(null), reading = useRef<object | null>(null);
  const current = () => generation.current === rendered && rendered.visible && rendered.online && Boolean(rendered.scope);
  const clearForm = () => { setName(''); setBaseUrl(''); setKey(''); setModels(''); setWire('auto'); setAuthMode('bearer'); };
  const close = () => {
    generation.current = { ...generation.current, visible: false };
    setKey(''); confirmation.current = null; setConfirm(null); callbacks.current.onClose();
  };
  const refresh = async (quiet = false) => {
    if (!current() || reading.current || mutation.current) return;
    const token = {}; reading.current = token;
    if (!quiet) { setLoading(true); setMessage(''); }
    try {
      const raw = await callbacks.current.command({ type: 'computer.management.status', controlSurface: 'cli' });
      if (!current() || reading.current !== token) return;
      const next = parseManagementStatus(raw);
      if (!next) { setStatus(null); setMessage('电脑暂不支持直连管理，请更新 Bridge 后重试'); return; }
      setStatus(next);
      setInstallUncertain(false);
      if (status?.job?.state === 'running' && next.job?.state !== 'running') callbacks.current.onChanged();
      if (next.job?.state === 'failed') setMessage('安装未完成，请在电脑端查看原因后重试');
    } catch { if (current() && reading.current === token) setMessage('暂时无法读取电脑配置，请重新连接后刷新'); }
    finally { if (reading.current === token) reading.current = null; if (current()) setLoading(false); }
  };
  useEffect(() => {
    clearForm(); setExpanded(false); setConfirm(null); setUncertain(false); setInstallUncertain(false); setStatus(null); setMessage(''); setLoading(false);
    // The mutation mutex lives until its request settles even when the sheet closes.
    setBusy(null); reading.current = null;
    if (visible && online && scope) void refresh();
    return () => { if (generation.current === rendered) generation.current = { ...rendered, visible: false }; };
    // Identity changes invalidate every pending callback before effects execute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, online, scope]);
  useEffect(() => {
    if (!visible || !online || !status || busy || !(status.job?.state === 'running' || status.discoveryPending || status.busy)) return;
    const timer = setTimeout(() => { void refresh(true); }, 2500);
    return () => clearTimeout(timer);
    // Poll only the visible active computer, and never automatically replay a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, online, scope, status, busy]);

  const save = async () => {
    if (!current() || !status || uncertain || mutation.current || reading.current) return;
    let payload: ReturnType<typeof buildComputerApiCommand>;
    try { payload = buildComputerApiCommand({ name, baseUrl, key, models, wire, authMode }, randomUUID()); }
    catch (error) { setMessage(error instanceof Error ? error.message : '请检查 API 配置'); return; }
    const token = {}; mutation.current = token; setBusy('api'); setMessage(''); setKey('');
    try {
      const raw = await callbacks.current.command(payload);
      if (!current() || mutation.current !== token) return;
      if (!apiCreationConfirmed(raw)) throw new Error('unconfirmed');
      clearForm(); setExpanded(false); setMessage('API 已保存到电脑。返回后可为 Agent 选择此 API。'); callbacks.current.onChanged();
    } catch {
      if (current() && mutation.current === token) {
        setUncertain(true); setMessage('保存结果未确认。请返回 API 列表核对，避免重复添加。'); callbacks.current.onChanged();
      }
    } finally {
      payload.key = ''; // Do not retain a credential in this request after transport completion.
      if (mutation.current === token) mutation.current = null;
      if (current()) setBusy(null);
    }
  };
  const install = async (item: ManagementItem) => {
    if (!current() || mutation.current || reading.current || installUncertain || confirmation.current !== item || status?.busy || status?.job?.state === 'running'
      || !status?.items.some(row => row.id === item.id && row.installable && !row.installed)) return;
    const token = {}; mutation.current = token; confirmation.current = null; setBusy('install'); setConfirm(null); setMessage('');
    try {
      const raw = await callbacks.current.command({ type: 'computer.agent.install', controlSurface: 'cli', requestId: randomUUID(), tool: item.id, confirmed: true });
      if (!current() || mutation.current !== token) return;
      const object = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
      const job = object?.ok === true ? parseManagementJob(object.job) : undefined;
      if (!job || job.tool !== item.id) throw new Error('unconfirmed');
      setStatus(previous => previous ? { ...previous, job, busy: job.state === 'running' } : previous);
      setMessage(job.state === 'failed' ? '安装未完成，请在电脑端查看原因后重试' : '已提交电脑安装。完成后刷新检测，再为 Agent 选择 API。'); callbacks.current.onChanged();
    } catch { if (current() && mutation.current === token) { setInstallUncertain(true); setMessage('安装结果未确认，请刷新安装状态；不会自动再次安装。'); } }
    finally { if (mutation.current === token) mutation.current = null; if (current()) setBusy(null); }
  };
  const disabled = !online || !scope || loading || busy !== null;
  const canEdit = !disabled && Boolean(status) && !uncertain;
  return <><ProgrammingSheet visible={visible} title="管理电脑" subtitle="通过已配对的电脑直连，添加 API 或安装 Agent。" onClose={close} maxContentWidth={560}>
    <View style={styles.topRow}><Text style={styles.hint}>{online ? '电脑直连已连接' : '电脑直连已断开'}</Text>
      <Action label="刷新电脑配置" disabled={disabled} onPress={() => void refresh()} /></View>
    {!online ? <Text accessibilityRole="alert" style={styles.notice}>重新连接电脑后继续。密钥输入已清空。</Text> : null}
    {loading ? <ActivityIndicator color={t.muted} /> : null}
    {message ? <Text accessibilityRole="alert" style={styles.notice}>{message}</Text> : null}
    {uncertain ? <Action label="返回 API 列表核对" onPress={() => { callbacks.current.onChanged(); close(); }} /> : null}
    <ProgrammingSection title="API" />
    <ProgrammingCard><View style={styles.cardBody}><Text style={styles.title}>添加 API 到这台电脑</Text>
      <Text style={styles.hint}>密钥通过电脑直连发送并保存到电脑，手机不保存密钥。</Text>
      {!expanded ? <Action label="添加 API" disabled={disabled || !status} onPress={() => { if (current()) setExpanded(true); }} /> : null}</View>
      {expanded ? <><ProgrammingField label="API 名称" value={name} onChangeText={setName} editable={canEdit} maxLength={80} placeholder="例如：我的 API" />
        <ProgrammingField label="API 地址" value={baseUrl} onChangeText={setBaseUrl} editable={canEdit} maxLength={4096} keyboardType="url" placeholder="https://api.example.com/v1" />
        <ProgrammingField label="API Key" value={key} onChangeText={setKey} editable={canEdit} maxLength={8192} secureTextEntry textContentType="none" autoComplete="off" placeholder="输入 API Key" />
        <View style={styles.options}><Text style={styles.fieldLabel}>接口协议</Text><View style={styles.choices}>{wires.map(option => <Choice key={option.value} label={option.label} selected={wire === option.value} disabled={!canEdit} onPress={() => setWire(option.value)} />)}</View>
          <Text style={styles.fieldLabel}>认证方式</Text><View style={styles.choices}><Choice label="Bearer" selected={authMode === 'bearer'} disabled={!canEdit} onPress={() => setAuthMode('bearer')} /><Choice label="x-api-key" selected={authMode === 'api-key'} disabled={!canEdit} onPress={() => setAuthMode('api-key')} /></View></View>
        <ProgrammingField label="模型目录（可选）" value={models} onChangeText={setModels} editable={canEdit} multiline maxLength={20000} placeholder="每行一个模型 ID" />
        <View style={styles.cardBody}><Action label={busy === 'api' ? '正在保存…' : '保存到电脑'} disabled={!canEdit} primary onPress={() => void save()} />
          <Action label="取消添加" disabled={busy === 'api'} onPress={() => { clearForm(); setExpanded(false); }} /></View></> : null}
    </ProgrammingCard>
    <ProgrammingSection title="Agent 与运行环境" hint="安装后返回，为 Agent 选择 API。" />
    {status?.items.map(item => <ProgrammingCard key={item.id} style={styles.toolCard}><View style={styles.cardBody}><View style={styles.toolHeading}><Text style={styles.title}>{item.name}</Text><Text style={styles.badge}>{item.installed ? '已安装' : '未检测到'}</Text></View>
      <Text style={styles.hint}>{item.role}</Text>{item.version ? <Text style={styles.hint}>版本 {item.version}</Text> : null}{item.note ? <Text style={styles.hint}>{item.note}</Text> : null}
      {!item.installed && item.installable ? <Action label={`安装 ${item.name}`} disabled={disabled || installUncertain || status.busy || status.job?.state === 'running'} onPress={() => { if (current() && !mutation.current && !installUncertain) setConfirm(item); }} /> : null}
      {!item.installed && !item.installable ? <Text style={styles.hint}>请在电脑端按官网说明安装</Text> : null}
      {status.job?.tool === item.id ? <Text style={styles.hint}>{status.job.state === 'running' ? '正在电脑上安装…' : status.job.state === 'failed' ? '安装未完成，请在电脑端查看原因' : item.installed ? '安装完成，已检测到工具' : '安装程序已结束，等待检测；可刷新确认'}</Text> : null}
    </View></ProgrammingCard>)}
    {status?.discoveryPending ? <Text style={styles.hint}>正在检测电脑环境…</Text> : null}
    {status?.busy && !status.job ? <Text style={styles.hint}>电脑正在安装其他工具，请等待完成。</Text> : null}
  </ProgrammingSheet>
    <ProgrammingPanel visible={visible && Boolean(confirm)} title={confirm ? `在电脑上安装 ${confirm.name}？` : '安装 Agent'}
      onClose={() => { confirmation.current = null; setConfirm(null); }} footer={<View style={styles.confirmActions}>
        <Action label="取消安装" onPress={() => { confirmation.current = null; setConfirm(null); }} />
        <Action label="确认安装" primary disabled={disabled} onPress={() => { if (confirm) void install(confirm); }} />
      </View>}><Text style={styles.hint}>将运行官方安装程序，下载并安装到当前配对电脑。电脑可能需要确认系统权限。</Text></ProgrammingPanel>
  </>;
}
function Action({ label, disabled = false, primary = false, onPress }: { label: string; disabled?: boolean; primary?: boolean; onPress: () => void }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, primary && styles.primary, disabled && styles.disabled]}><Text style={[styles.actionText, primary && styles.primaryText]}>{label}</Text></Pressable>;
}
function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled: boolean; onPress: () => void }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress} style={[styles.choice, selected && styles.choiceSelected, disabled && styles.disabled]}><Text style={styles.choiceText}>{label}</Text></Pressable>;
}
const useStyles = themed((_c, t) => StyleSheet.create({
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  cardBody: { padding: 14, gap: 10 }, title: { color: t.text, fontSize: 15, lineHeight: 21, fontWeight: '600', flexShrink: 1 },
  hint: { color: t.muted, fontSize: 12, lineHeight: 18 }, notice: { color: t.text2, backgroundColor: t.surface2, borderRadius: 12, padding: 12, marginTop: 12, fontSize: 13, lineHeight: 20 },
  action: { minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line },
  actionText: { color: t.text, fontSize: 13, fontWeight: '600' }, primary: { backgroundColor: t.ink, borderColor: t.ink }, primaryText: { color: t.onInk }, disabled: { opacity: 0.45 },
  options: { padding: 14, gap: 9, borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.line }, fieldLabel: { color: t.muted, fontSize: 12 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, choice: { paddingHorizontal: 12, paddingVertical: 11, borderRadius: 10, borderWidth: 1, borderColor: t.line, minHeight: 44, justifyContent: 'center' },
  choiceSelected: { borderColor: t.text, backgroundColor: t.surface2 }, choiceText: { color: t.text2, fontSize: 12 },
  toolCard: { marginBottom: 10 }, toolHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, badge: { color: t.muted, fontSize: 11 },
  confirmActions: { gap: 8 },
}));
