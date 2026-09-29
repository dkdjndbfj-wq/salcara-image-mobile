import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ProviderProfile } from '../domain';
import { Icon } from '../components/Icon';
import { Appear, AppDialog, Group, IconButton, MotionPressable, PrimaryButton, SectionLabel, Sheet, showToast, Sheen, BrandFill } from '../components/ui';
import { useApp } from '../state/AppContext';
import { colors, radius, shadow } from '../theme';
import { type DeviceStatus, type SessionInfo, type ToolId } from './client';
import { NewTaskSheet } from './NewTaskSheet';
import { clientLabel, EmptyState, folderName, OnlineDot, osIcon, osName, relTime, Segmented, StatusPill, ToolBadge } from './parts';
import { SessionView } from './SessionView';
import {
  loadSessions, pairRemote, probeServices, refreshDevices, setRemoteFocus, setRemoteScreenOpen, signInRemote, signOutRemote, useRemote, type RemoteState,
} from './store';

/** 远程编程: devices → sessions → a live timeline of Codex / Claude Code running on the user's computer. */
export function RemoteScreen({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const remote = useRemote();
  const { providers } = useApp();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pairCode, setPairCode] = useState('');
  const [pairBusy, setPairBusy] = useState(false);
  const service = providers.find((item) => item.id === remote.serviceId);
  const setup = remote.phase === 'setup' || switching;

  useEffect(() => {
    setRemoteScreenOpen(visible);
    return () => setRemoteScreenOpen(false);
  }, [visible]);
  useEffect(() => {
    if (visible && setup) void probeServices(providers);
  }, [visible, setup, providers]);
  useEffect(() => {
    if (!visible || !remote.focus) return;
    setDeviceId(remote.focus.deviceId);
    setSessionKey(remote.focus.sessionKey);
    setRemoteFocus(null);
  }, [visible, remote.focus]);

  const refresh = async () => {
    setRefreshing(true);
    try { await refreshDevices(); } catch (error) { showToast((error as Error).message, 'alert'); } finally { setRefreshing(false); }
  };
  const choose = async (target: ProviderProfile) => {
    try { await signInRemote(target); setSwitching(false); } catch (error) { showToast((error as Error).message, 'alert'); }
  };

  const pendingByDevice = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const approval of Object.values(remote.approvals)) counts[approval.deviceId] = (counts[approval.deviceId] ?? 0) + 1;
    return counts;
  }, [remote.approvals]);
  const devices = useMemo(() => [...remote.devices].sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen), [remote.devices]);
  const pair = async () => {
    if (pairCode.trim().length !== 8) { showToast('请输入电脑显示的 8 位配对码', 'alert'); return; }
    setPairBusy(true);
    try { await pairRemote(pairCode); setPairCode(''); showToast('配对成功', 'check'); }
    catch (error) { showToast((error as Error).message, 'alert'); }
    finally { setPairBusy(false); }
  };

  return <>
    <Sheet visible={visible} presentation="page" scroll={false} onClose={() => { if (switching) setSwitching(false); else onClose(); }}
      title="远程编程" subtitle={!setup && service ? service.name : undefined}
      headerRight={!setup ? <IconButton icon="more" label="更多" onPress={() => setMenu(true)} /> : undefined}>
      {remote.phase === 'loading'
        ? <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        : setup
          ? <Setup providers={providers} remote={remote} onChoose={(item) => void choose(item)} />
          : remote.phase === 'pairing'
            ? <ScrollView contentContainerStyle={styles.setup} keyboardShouldPersistTaps="handled">
                <Group><View style={{ padding: 20, gap: 12 }}>
                  <Text style={styles.heroTitle}>配对你的电脑</Text>
                  <Text style={styles.heroDetail}>在电脑端 Salcara Bridge 点击“生成配对码”，然后输入显示的 8 位字符。配对只允许这部手机访问这台电脑。</Text>
                  <TextInput value={pairCode} onChangeText={(value) => setPairCode(value.toUpperCase().replace(/[^A-Z2-7]/g, '').slice(0, 8))}
                    autoCapitalize="characters" autoCorrect={false} maxLength={8} placeholder="输入配对码"
                    style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 16, height: 54, fontSize: 22, letterSpacing: 4, color: colors.text }} />
                  <PrimaryButton label={pairBusy ? '配对中…' : '配对电脑'} onPress={() => void pair()} disabled={pairBusy || pairCode.length !== 8} />
                </View></Group>
              </ScrollView>
          : <FlatList
            data={devices}
            keyExtractor={(item: DeviceStatus) => item.deviceId}
            contentContainerStyle={styles.list}
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={<ConnectionBanner remote={remote} />}
            ListEmptyComponent={!remote.devicesLoaded
              ? <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
              : <EmptyState icon="laptop" title="电脑暂时不在线" detail="请在已经配对的电脑上打开 Salcara Bridge。" />}
            ListFooterComponent={devices.length ? <Text style={styles.footnote}>电脑上的 Codex 和 Claude Code 照常使用中转站额度，Key 只保存在你的手机和电脑上。</Text> : null}
            renderItem={({ item, index }: { item: DeviceStatus; index: number }) => <Appear delay={index * 50}>
              <DeviceCard device={item} pending={pendingByDevice[item.deviceId] ?? 0} onPress={() => setDeviceId(item.deviceId)} />
            </Appear>}
          />}
    </Sheet>
    <DeviceSessions deviceId={deviceId} onClose={() => setDeviceId(null)} onOpen={setSessionKey} />
    <SessionView deviceId={deviceId} sessionKey={sessionKey} onClose={() => setSessionKey(null)} />
    <AppDialog visible={menu} title="远程编程" message={service ? `正在使用“${service.name}”的 Key 连接中转站。` : undefined} icon="code" onClose={() => setMenu(false)} actions={[
      { label: '换一个中转站', tone: 'secondary', onPress: () => { setMenu(false); setSwitching(true); } },
      { label: '退出', tone: 'danger', onPress: () => { setMenu(false); void signOutRemote(); } },
    ]} />
  </>;
}

function ConnectionBanner({ remote }: { remote: RemoteState }) {
  if (remote.connection === 'open' || remote.connection === 'idle' || (remote.connection === 'connecting' && !remote.devicesLoaded)) return null;
  const error = remote.connection === 'error';
  return <View style={[styles.banner, error && { backgroundColor: colors.dangerSurface }]}>
    {error ? <Icon name="alert" size={16} color={colors.danger} /> : <ActivityIndicator size="small" color={colors.warningText} />}
    <Text style={[styles.bannerText, error && { color: colors.danger }]} numberOfLines={2}>{error ? remote.connectionError ?? '连接已断开' : '正在重新连接中转站…'}</Text>
  </View>;
}

function Setup({ providers, remote, onChoose }: { providers: ProviderProfile[]; remote: RemoteState; onChoose: (service: ProviderProfile) => void }) {
  return <ScrollView contentContainerStyle={styles.setup} showsVerticalScrollIndicator={false}>
    <Appear>
      <View style={styles.hero}>
        <View style={styles.heroIcon}><View style={StyleSheet.absoluteFill}><BrandFill /><Sheen /></View><Icon name="code" size={30} color="#FFFFFF" strokeWidth={2} /></View>
        <Text style={styles.heroTitle}>在手机上继续写代码</Text>
        <Text style={styles.heroDetail}>看电脑上的 Codex 和 Claude Code 在做什么，随时批准、补充或者派新任务。</Text>
      </View>
    </Appear>
    <SectionLabel>用哪个中转站登录</SectionLabel>
    {providers.length ? <Group>
      {providers.map((item, index) => {
        const probe = remote.probes[item.id] ?? 'checking';
        const busy = remote.signingIn === item.id;
        const ok = probe === 'ok';
        return <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ disabled: !ok, busy }} disabled={!ok || Boolean(remote.signingIn)} onPress={() => onChoose(item)}
          style={({ pressed }: { pressed: boolean }) => [styles.service, index > 0 && styles.stepDivider, pressed && { backgroundColor: colors.surfaceStrong }]}>
          <View style={[styles.serviceIcon, !ok && { opacity: 0.45 }]}><Icon name="server" size={18} color={ok ? colors.primary : colors.subtle} /></View>
          <View style={{ flex: 1, gap: 2, opacity: probe === 'no' ? 0.55 : 1 }}>
            <Text style={styles.serviceName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.serviceDetail} numberOfLines={1}>{probe === 'no' ? '这个 API 不支持远程编程' : probe === 'checking' ? '正在检查…' : item.baseUrl.replace(/^https?:\/\//, '')}</Text>
          </View>
          {busy || probe === 'checking' ? <ActivityIndicator size="small" color={colors.primary} /> : ok ? <Icon name="chevronRight" size={18} color={colors.faint} /> : null}
        </Pressable>;
      })}
    </Group> : <Text style={styles.noService}>先在“设置 → API 管理”里添加中转站的 API，再回来这里。</Text>}
    <Text style={styles.footnote}>只有中转站的用户能用远程编程。任务照常使用中转站额度。</Text>
  </ScrollView>;
}

function DeviceCard({ device, pending, onPress }: { device: DeviceStatus; pending: number; onPress: () => void }) {
  return <MotionPressable scaleTo={0.98} accessibilityRole="button" accessibilityLabel={`${device.name}，${device.online ? '在线' : '离线'}${pending ? `，${pending} 个待批准` : ''}`} onPress={onPress} style={styles.card}>
    <View style={styles.cardTop}>
      <View style={[styles.os, !device.online && { opacity: 0.5 }]}><Icon name={osIcon(device.os)} size={22} color={colors.text} /></View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={styles.deviceName} numberOfLines={1}>{device.name}</Text>
        <View style={styles.meta}>
          <OnlineDot online={device.online} />
          <Text style={[styles.metaText, device.online && { color: colors.success }]}>{device.online ? '在线' : `离线 · ${relTime(device.lastSeen)}`}</Text>
          <Text style={styles.metaText}>· {osName(device.os)}</Text>
        </View>
      </View>
      {pending > 0 ? <View style={styles.pending}><Text style={styles.pendingText}>{pending} 个待批准</Text></View> : <Icon name="chevronRight" size={18} color={colors.faint} />}
    </View>
    <View style={styles.tools}>
      {device.tools.map((tool) => <View key={tool.id} style={[styles.toolChip, !tool.available && { opacity: 0.45 }]}>
        <ToolBadge tool={tool.id} size={18} />
        <Text style={styles.toolChipText}>{tool.name}{tool.available ? '' : ' · 未安装'}</Text>
      </View>)}
    </View>
  </MotionPressable>;
}

type Filter = 'all' | ToolId;

function DeviceSessions({ deviceId, onClose, onOpen }: { deviceId: string | null; onClose: () => void; onOpen: (sessionKey: string) => void }) {
  const remote = useRemote();
  const device = remote.devices.find((item) => item.deviceId === deviceId);
  const entry = deviceId ? remote.sessions[deviceId] : undefined;
  const [filter, setFilter] = useState<Filter>('all');
  const [creating, setCreating] = useState(false);
  const load = () => {
    if (deviceId) void loadSessions(deviceId).catch(() => undefined);
  };
  useEffect(() => { if (deviceId) { setFilter('all'); load(); } }, [deviceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // A computer that comes back online gets its list refreshed.
  useEffect(() => { if (deviceId && device?.online && entry?.error) load(); }, [device?.online]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = useMemo(() => new Set(Object.values(remote.approvals).filter((item) => item.deviceId === deviceId).map((item) => item.sessionKey)), [remote.approvals, deviceId]);
  const list = (entry?.list ?? []).filter((item) => filter === 'all' || item.tool === filter);
  const canCreate = Boolean(device?.tools.some((tool) => tool.available));

  const empty = entry?.loading || !entry?.loaded
    ? <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
    : !device?.online ? <EmptyState icon="laptop" title="电脑不在线" detail="打开电脑，确认 SalcaraBridge 正在运行，这里会自动刷新。" />
      : entry?.error ? <EmptyState icon="alert" title="没有读到会话" detail={entry.error}><PrimaryButton label="重试" tone="secondary" onPress={load} style={{ marginTop: 12, minHeight: 44 }} /></EmptyState>
        : <EmptyState icon="chat" title={filter === 'all' ? '还没有会话' : `还没有 ${filter === 'codex' ? 'Codex' : 'Claude'} 会话`} detail="在电脑上用 Codex 或 Claude Code 的记录会出现在这里，也可以直接新建任务。" />;

  return <>
    <Sheet visible={Boolean(deviceId)} presentation="page" scroll={false} onClose={onClose} title={device?.name ?? '电脑'}
      subtitle={device ? (device.online ? '在线' : `离线 · ${relTime(device.lastSeen)}`) : undefined}>
      <View style={styles.filter}>
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部' }, { value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]} />
      </View>
      {!device?.online && list.length ? <View style={[styles.banner, { marginHorizontal: 16, marginTop: 4 }]}>
        <Icon name="laptop" size={16} color={colors.warningText} /><Text style={styles.bannerText}>电脑不在线，下面是上次看到的会话</Text>
      </View> : null}
      <FlatList
        data={list}
        keyExtractor={(item: SessionInfo) => item.sessionKey}
        contentContainerStyle={styles.sessions}
        refreshing={Boolean(entry?.loading && entry.list.length)}
        onRefresh={load}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={empty}
        renderItem={({ item, index }: { item: SessionInfo; index: number }) => <Appear delay={Math.min(index, 8) * 35}>
          <SessionRow session={item} pending={pending.has(item.sessionKey)} first={index === 0} onPress={() => onOpen(item.sessionKey)} />
        </Appear>}
      />
      {canCreate ? <View pointerEvents="box-none" style={styles.fabWrap}>
        <MotionPressable scaleTo={0.94} accessibilityRole="button" accessibilityLabel="新任务" disabled={!device?.online} onPress={() => setCreating(true)} style={[styles.fab, !device?.online && { opacity: 0.5 }]}>
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius.pill, overflow: 'hidden' }]}><BrandFill /><Sheen /></View>
          <Icon name="plus" size={20} color="#FFFFFF" strokeWidth={2.2} />
          <Text style={styles.fabText}>新任务</Text>
        </MotionPressable>
      </View> : null}
    </Sheet>
    <NewTaskSheet visible={creating} device={device} initialTool={filter === 'all' ? undefined : filter} onClose={() => setCreating(false)}
      onStarted={(sessionKey) => { setCreating(false); onOpen(sessionKey); }} />
  </>;
}

function SessionRow({ session, pending, first, onPress }: { session: SessionInfo; pending: boolean; first: boolean; onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }: { pressed: boolean }) => [styles.session, !first && styles.sessionDivider, pressed && { backgroundColor: colors.surface }]}>
    <ToolBadge tool={session.tool} client={session.client} size={38} />
    <View style={{ flex: 1, gap: 3 }}>
      <View style={styles.sessionTop}>
        <Text style={styles.client} numberOfLines={1}>{clientLabel(session)}</Text>
        <Text style={styles.time}>{relTime(session.updatedAt)}</Text>
      </View>
      <Text style={styles.sessionTitle} numberOfLines={2}>{session.title || '（没有标题）'}</Text>
      <View style={styles.sessionBottom}>
        <Icon name="archive" size={13} color={colors.subtle} />
        <Text style={styles.folder} numberOfLines={1}>{folderName(session.cwd)}</Text>
        {pending || session.status !== 'idle' ? <StatusPill status={pending ? 'waiting_approval' : session.status} /> : null}
      </View>
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  center: { paddingVertical: 64, alignItems: 'center' },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32, gap: 12 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 14, backgroundColor: colors.warningSurface, marginBottom: 4 },
  bannerText: { flex: 1, color: colors.warningText, fontSize: 13, lineHeight: 18 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.primarySoft, marginTop: 10 },
  linkText: { color: colors.primaryDeep, fontSize: 14, fontWeight: '600' },
  footnote: { color: colors.subtle, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 20, paddingHorizontal: 16 },
  setup: { paddingHorizontal: 16, paddingBottom: 32 },
  hero: { alignItems: 'center', paddingTop: 16, paddingBottom: 20, paddingHorizontal: 12, gap: 8 },
  heroIcon: { width: 68, height: 68, borderRadius: 22, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', marginBottom: 8, ...shadow.glow },
  heroTitle: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  heroDetail: { color: colors.textMuted, fontSize: 14.5, lineHeight: 22, textAlign: 'center' },
  steps: {},
  step: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  stepDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  stepNo: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  stepNoText: { color: colors.onPrimary, fontSize: 13, fontWeight: '700' },
  stepTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  stepDetail: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  service: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, minHeight: 60, paddingVertical: 10 },
  serviceIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  serviceName: { color: colors.text, fontSize: 15.5 },
  serviceDetail: { color: colors.subtle, fontSize: 12.5 },
  noService: { color: colors.subtle, fontSize: 13.5, lineHeight: 20, paddingHorizontal: 16 },
  card: { borderRadius: radius.lg, backgroundColor: colors.card, padding: 16, gap: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, ...shadow.soft },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  os: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceStrong },
  deviceName: { color: colors.text, fontSize: 16.5, fontWeight: '600', letterSpacing: -0.2 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { color: colors.subtle, fontSize: 12.5 },
  pending: { height: 24, paddingHorizontal: 9, borderRadius: 12, justifyContent: 'center', backgroundColor: colors.danger },
  pendingText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  toolChip: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 30, paddingLeft: 6, paddingRight: 11, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  toolChipText: { color: colors.textSecondary, fontSize: 12.5, fontWeight: '500' },
  filter: { paddingHorizontal: 16, paddingBottom: 8 },
  sessions: { paddingBottom: 110 },
  session: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  sessionDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.divider },
  sessionTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  client: { flex: 1, color: colors.subtle, fontSize: 12, fontWeight: '600' },
  time: { color: colors.faint, fontSize: 12 },
  sessionTitle: { color: colors.text, fontSize: 15, lineHeight: 21, fontWeight: '500' },
  sessionBottom: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 2 },
  folder: { flex: 1, color: colors.subtle, fontSize: 12.5 },
  fabWrap: { position: 'absolute', right: 20, bottom: 24 },
  fab: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 52, paddingHorizontal: 20, borderRadius: radius.pill, overflow: 'hidden', backgroundColor: colors.primary, ...shadow.glow },
  fabText: { color: '#FFFFFF', fontSize: 15.5, fontWeight: '600' },
});
