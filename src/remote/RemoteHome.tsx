import React, { useEffect, useMemo, useRef, useState } from 'react';
import { openPromo, PROMO, promoSnoozed, snoozePromo, usesOfficialRelay } from '../promo';
import { ActivityIndicator, AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import Svg, { Defs, Pattern, Circle, RadialGradient, Rect, Stop } from 'react-native-svg';
import { themed, useDesk } from '../theme';
import { DeskOrb } from './DeskOrb';
import { ProgrammingCard, ProgrammingRow, ProgrammingSection, ProgrammingStatus } from './ProgrammingUi';
import type { AgentId, DeviceStatus, SessionInfo } from './client';
import { remoteDeviceConnected } from './connection-state';
import { osName, relTime, ToolBadge } from './parts';
import { AGENT_CHOICES, agentApiLabel } from './projection';
import { hydrateCachedSessions, loadSessions, type RemoteState } from './store';
import { useThreadTitles } from './thread-titles';

export function sessionAgent(session: Pick<SessionInfo, 'tool' | 'client'>): AgentId {
  return session.tool === 'codex' ? 'codex' : /Claude Desktop/i.test(session.client) ? 'claude-desktop' : 'claude';
}

const AGENT_HINT: Record<AgentId, string> = { codex: 'App · CLI · IDE', claude: '终端 · IDE', 'claude-desktop': '桌面版' };

/** The entry page is never a pairing wizard. Credentials and execution targets are separate. */
export function RemoteHome({ visible, remote, device, onComputer, onApi, onAgent, onProjects, onSession, onDownload }: {
  visible: boolean; remote: RemoteState; device?: DeviceStatus;
  onComputer: () => void; onApi: () => void; onAgent: (id: AgentId) => void; onProjects: () => void;
  onSession: (deviceId: string, session: SessionInfo) => void; onDownload: () => void;
}) {
  const titleOf = useThreadTitles();
  const styles = useStyles();
  const d = useDesk();
  const saved = remote.connections.find(item => item.id === remote.connectionId);
  const online = remoteDeviceConnected(remote, device);
  // The saved computer's last task list is shown from the device cache even before it connects.
  const homeDeviceId = device?.deviceId ?? saved?.deviceId;
  const entry = homeDeviceId ? remote.sessions[homeDeviceId] : undefined;
  const agents = device ? remote.agents[device.deviceId] : undefined;
  const scope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId, device?.deviceId]);
  const generation = useRef({ visible, scope });
  if (generation.current.visible !== visible || generation.current.scope !== scope) generation.current = { visible, scope };
  const rendered = generation.current;
  const active = useRef({ visible, online }); active.current = { visible, online };
  useEffect(() => { active.current.visible = visible; return () => { active.current.visible = false; }; }, [visible]);
  const canOperate = () => active.current.visible && generation.current === rendered;
  const action = (callback: () => void) => () => { if (canOperate()) callback(); };
  const historyIdentity = agents?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity;
  const latest = useMemo(() => [...new Map([...(entry?.list ?? []), ...(entry?.native?.list ?? []),
    ...Object.values(entry?.readOnly ?? {}).filter(directory => directory?.identity === historyIdentity).flatMap(directory => directory?.list ?? [])]
    .map(item => [item.sessionKey, item])).values()].filter(item => !item.parentSessionKey)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3), [entry?.list, entry?.native?.list, entry?.readOnly, historyIdentity]);
  const reload = () => { if (canOperate() && device && active.current.online) void loadSessions(device.deviceId).catch(() => undefined); };
  useEffect(() => { if (visible && homeDeviceId) void hydrateCachedSessions(homeDeviceId); }, [visible, homeDeviceId, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  // Coming back to the app refreshes the list once (no timer while it sits in the background).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => { if (next === 'active') reload(); });
    return () => subscription.remove();
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // One initial read, no idle timer, no model request, and no API mutation.
    if (visible && online && device && !entry?.loaded && !entry?.loading && !entry?.error) reload();
  }, [visible, online, device?.deviceId, scope, entry?.loaded, entry?.loading, entry?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useMemo(() => new Set(Object.values(remote.approvals).filter(item => item.deviceId === device?.deviceId).map(item => item.sessionKey)), [remote.approvals, device?.deviceId]);
  const choices = ['codex', 'claude', 'claude-desktop'].map(id => AGENT_CHOICES.find(choice => choice.id === id)!);
  const hasComputer = Boolean(device || saved || remote.connections.length);
  // One quiet, dismissible pointer to the official relay; hidden for people already using it.
  const [promoReady, setPromoReady] = useState(false);
  useEffect(() => { let live = true; if (PROMO.enabled) void promoSnoozed('remote-home').then((snoozed) => { if (live) setPromoReady(!snoozed); }); return () => { live = false; }; }, []);
  const showPromo = promoReady && !usesOfficialRelay([...(agents?.apis ?? []).map(api => api.name), ...(agents?.list ?? []).map(agent => agent.api.name)]);

  const deviceName = device?.name ?? saved?.deviceName;
  const status = online ? `在线${device?.os ? ` · ${osName(device.os)}` : ''}` : device?.online ? '正在连接…' : hasComputer ? '离线 · 点按管理或切换' : '';
  const running = Boolean(entry?.list.some((session) => session.status === 'running'));
  const statusLabel = (session: SessionInfo) => pending.has(session.sessionKey) || session.status === 'waiting_approval' ? { text: '待回复', style: styles.pillWarn }
    : session.status === 'running' ? { text: '运行中', style: styles.pillRun } : session.status === 'failed' ? { text: '失败', style: styles.pillFail } : null;

  return <ScrollView testID="remote-home" contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={Boolean(entry?.loading && latest.length)} onRefresh={reload} tintColor={d.muted} />}>
    <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>编程</Text><Text style={styles.subtitle}>在手机上继续电脑里的工作</Text></View>

    {/* The desktop's home screen in miniature: the orb on a dotted stage, the computer underneath. */}
    <Pressable accessibilityRole="button" accessibilityLabel="连接电脑" accessibilityHint={hasComputer ? `${deviceName ?? '电脑'}，${status}` : '扫码绑定一台电脑'} onPress={action(onComputer)}
      style={({ pressed }) => [styles.hero, pressed && styles.pressed]}>
      <View pointerEvents="none" style={styles.stage}><Svg width="100%" height="100%">
        <Defs>
          <Pattern id="homeDots" width="18" height="18" patternUnits="userSpaceOnUse"><Circle cx="1" cy="1" r="0.9" fill={d.dot} /></Pattern>
          <RadialGradient id="homeGlow" cx="50%" cy="42%" rx="55%" ry="60%"><Stop offset="0" stopColor={d.glow} stopOpacity="1" /><Stop offset="1" stopColor={d.glow} stopOpacity="0" /></RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#homeDots)" /><Rect width="100%" height="100%" fill="url(#homeGlow)" />
      </Svg></View>
      <DeskOrb size={96} busy={running} mood={hasComputer && !online && !device?.online ? 'sleepy' : 'idle'} />
      <View style={styles.heroText}>
        <Text style={styles.heroName} numberOfLines={1}>{deviceName ?? (hasComputer ? `${remote.connections.length} 台已配对电脑` : '连接你的电脑')}</Text>
        {hasComputer ? <View style={styles.heroStatus}><ProgrammingStatus tone={online ? 'online' : device?.online ? 'pending' : 'offline'} text={status} />
          <Text style={styles.heroLinkText}>  ·  管理</Text></View>
          : <Text style={[styles.detail, { textAlign: 'center' }]} numberOfLines={2}>扫码绑定后，即可在手机上使用电脑里的 Codex 与 Claude</Text>}
      </View>
      {!hasComputer ? <View style={styles.heroCta}><Icon name="scan" size={16} color={d.onInk} /><Text style={styles.heroCtaText}>扫码绑定</Text></View> : null}
    </Pressable>

    <ProgrammingSection title="AGENT" hint={deviceName ? `运行在${deviceName}` : '绑定电脑后可用'} />
    <View style={styles.agents}>{choices.map((choice) => {
      const profile = agents?.list.find(item => item.id === choice.id);
      const missing = Boolean(agents?.loaded && profile && !profile.available);
      return <Pressable key={choice.id} accessibilityRole="button" accessibilityLabel={`打开 ${choice.name}`} onPress={action(() => onAgent(choice.id))}
        style={({ pressed }) => [styles.agent, pressed && styles.agentPressed]}>
        <ToolBadge tool={choice.tool} client={choice.client} size={24} />
        <Text style={styles.agentName} numberOfLines={2}>{choice.name}</Text>
        <Text style={[styles.agentDetail, missing && { color: d.faint }]} numberOfLines={1}>{missing ? '未安装' : profile ? agentApiLabel(profile) : AGENT_HINT[choice.id]}</Text>
      </Pressable>;
    })}</View>

    <ProgrammingCard style={{ marginTop: 8 }}>
      <ProgrammingRow first icon="key" title="API 密钥" accessibilityLabel="API 管理" onPress={action(onApi)} trailing="chevron"
        detail={!device ? '连接电脑后查看' : agents?.loaded && !agents.error ? `${agents.apis.length} 个 API · 电脑密钥库` : '电脑保存的密钥'} />
    </ProgrammingCard>

    <ProgrammingSection title="最近任务" action="全部会话" actionLabel="项目与会话" onAction={action(onProjects)} />
    {latest.length && homeDeviceId ? <ProgrammingCard>{latest.map((session, index) => {
      const badge = statusLabel(session);
      const name = titleOf(homeDeviceId, session.sessionKey, session.title || '无标题对话');
      return <Pressable key={session.sessionKey} accessibilityRole="button" accessibilityLabel={name}
        onPress={action(() => onSession(homeDeviceId, session))} style={({ pressed }) => [styles.task, index > 0 && styles.divider, pressed && styles.taskPressed]}>
        <ToolBadge tool={session.tool} client={session.client} size={24} />
        <View style={styles.body}><Text style={styles.taskTitle} numberOfLines={1}>{name}</Text>
          <Text style={styles.detail} numberOfLines={1}>{AGENT_CHOICES.find(choice => choice.id === sessionAgent(session))?.name} · {relTime(session.updatedAt)}</Text></View>
        {badge ? <View style={[styles.pill, badge.style]}><Text style={[styles.pillText, badge.style]}>{badge.text}</Text></View> : <Icon name="chevronRight" size={15} color={d.faint} />}
      </Pressable>;
    })}</ProgrammingCard>
      : <ProgrammingCard soft><View style={styles.empty}>{entry?.loading ? <ActivityIndicator size="small" color={d.muted} />
        : <><Icon name={entry?.error ? 'alert' : 'chat'} size={20} color={d.faint} /><Text style={styles.emptyText}>{entry?.error ? '任务未更新，下拉重试' : hasComputer ? '还没有任务' : '绑定电脑后，这里会显示最近的任务'}</Text></>}</View></ProgrammingCard>}

    {showPromo ? <Pressable accessibilityRole="link" accessibilityLabel={`推荐：${PROMO.name}`} onPress={() => void openPromo('remote-home')} style={({ pressed }) => [styles.promo, pressed && styles.taskPressed]}>
      <View style={styles.promoMark}><Icon name="sparkles" size={14} color={d.text2} /></View>
      <View style={styles.body}><Text style={styles.promoTitle} numberOfLines={1}>{PROMO.name}<Text style={styles.promoTag}>  推荐</Text></Text>
        <Text style={styles.detail} numberOfLines={1}>官方 API 中转 · Claude、GPT 一个 Key</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="不再显示推荐" hitSlop={10} onPress={() => { setPromoReady(false); void snoozePromo('remote-home'); }} style={styles.promoClose}>
        <Icon name="close" size={13} color={d.faint} /></Pressable>
    </Pressable> : null}
    <View style={styles.footer}><Pressable accessibilityRole="button" accessibilityLabel="下载电脑端" onPress={action(onDownload)} style={styles.download}>
      <Icon name="download" size={14} color={d.muted} /><Text style={styles.downloadText}>下载电脑端</Text></Pressable></View>
  </ScrollView>;
}

const useStyles = themed((_c, t) => StyleSheet.create({
  page: { paddingHorizontal: 18, paddingBottom: 14, flexGrow: 1, backgroundColor: t.bg }, heading: { paddingTop: 6, paddingBottom: 12 },
  title: { fontSize: 24, lineHeight: 31, color: t.text, fontWeight: '700', letterSpacing: -0.5 }, subtitle: { color: t.muted, fontSize: 12.5, lineHeight: 18, marginTop: 2 },
  hero: { alignItems: 'center', paddingTop: 14, paddingBottom: 16, paddingHorizontal: 16, borderRadius: 20, overflow: 'hidden', backgroundColor: t.surface2,
    borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, gap: 2 },
  stage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  heroText: { alignItems: 'center', gap: 5, maxWidth: '100%' },
  heroName: { color: t.text, fontSize: 15.5, lineHeight: 21, fontWeight: '600', letterSpacing: -0.1 },
  heroStatus: { flexDirection: 'row', alignItems: 'center' },
  heroLinkText: { color: t.muted, fontSize: 11.5 },
  heroCta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 42, alignSelf: 'stretch', marginTop: 12, borderRadius: 12, backgroundColor: t.ink },
  heroCtaText: { color: t.onInk, fontSize: 14, fontWeight: '600' },
  body: { flex: 1, gap: 4, minWidth: 0 }, detail: { fontSize: 11.5, lineHeight: 16, color: t.muted },
  agents: { flexDirection: 'row', gap: 8 },
  agent: { flex: 1, minWidth: 0, minHeight: 86, padding: 11, borderRadius: 14, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, gap: 6 },
  agentPressed: { backgroundColor: t.surface2, transform: [{ scale: 0.98 }] },
  agentName: { color: t.text, fontSize: 13, lineHeight: 17, fontWeight: '600', flexGrow: 1 }, agentDetail: { color: t.muted, fontSize: 10.5, lineHeight: 14 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.line },
  task: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 52, paddingHorizontal: 14, paddingVertical: 8 }, taskPressed: { backgroundColor: t.press },
  taskTitle: { color: t.text, fontSize: 13.5, fontWeight: '500' },
  pill: { paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center' }, pillText: { fontSize: 11, fontWeight: '500', backgroundColor: 'transparent' },
  pillWarn: { backgroundColor: t.warnSoft, color: t.warn }, pillRun: { backgroundColor: t.accentSoft, color: t.accentText }, pillFail: { backgroundColor: t.badSoft, color: t.bad },
  empty: { minHeight: 80, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 }, emptyText: { color: t.muted, fontSize: 12, textAlign: 'center' },
  footer: { alignItems: 'center', marginTop: 'auto', paddingTop: 16 }, download: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 }, downloadText: { fontSize: 12, color: t.muted },
  pressed: { opacity: 0.86 },
  promo: { marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingLeft: 12, paddingRight: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, backgroundColor: t.surface },
  promoMark: { width: 28, height: 28, borderRadius: 9, backgroundColor: t.surface3, alignItems: 'center', justifyContent: 'center' },
  promoTitle: { color: t.text, fontSize: 13, fontWeight: '600' }, promoTag: { color: t.faint, fontSize: 10.5, fontWeight: '500' },
  promoClose: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
}));
