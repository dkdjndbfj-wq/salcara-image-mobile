import React, { useEffect, useMemo, useRef, useState } from 'react';
import { openPromo, PROMO, promoSnoozed, snoozePromo, usesOfficialRelay } from '../promo';
import { AppState, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import Svg, { Defs, Pattern, Circle, RadialGradient, Rect, Stop } from 'react-native-svg';
import { themed, useDesk } from '../theme';
import { DeskOrb } from './DeskOrb';
import { ProgrammingCard, ProgrammingRow, ProgrammingSection, ProgrammingStatus } from './ProgrammingUi';
import type { AgentId, AgentProfile, DeviceStatus, SessionInfo, WorkspaceMode } from './client';
import { remoteDeviceConnected } from './connection-state';
import { connectionDisplayName, pairedComputerCount } from './connections';
import { osName, relTime, ToolBadge } from './parts';
import { AGENT_CHOICES, agentApiLabel, builtinAgent, sessionWorkspaceMode, validAgentId } from './projection';
import { hydrateCachedSessions, loadAgentProfiles, loadSessions, remoteDeliveryScope, type RemoteState } from './store';
import { useThreadTitles } from './thread-titles';
import { SkeletonGroup, SkeletonRows } from '../components/Skeleton';
import { SIMULATED_REMOTE_AGENTS } from './development-fixture';
import { agentDisplayName } from './agent-catalog';

export function sessionAgent(session: Pick<SessionInfo, 'tool' | 'client'> & Partial<Pick<SessionInfo, 'sessionKey'>>, profiles?: AgentProfile[]): AgentId | null {
  if (!validAgentId(session.tool) || session.tool === 'claude-desktop') return null;
  const desktop = session.tool === 'claude' && /Claude Desktop/i.test(session.client);
  const id = desktop ? 'claude-desktop' : session.tool;
  if (session.sessionKey !== undefined) {
    if (session.sessionKey.length > 512 || /[|\p{Cc}\p{Cf}]/u.test(session.sessionKey)) return null;
    const separator = session.sessionKey.indexOf(':');
    if (separator < 1 || separator === session.sessionKey.length - 1) return null;
    const namespace = session.sessionKey.slice(0, separator);
    if (namespace !== session.tool && !(desktop && namespace === 'claude-desktop')) return null;
  }
  // Only the two known Claude surfaces may share a tool. An extension must
  // have an exact current registration; never reinterpret it as Claude/Codex.
  if (!builtinAgent(id) && !profiles?.some(profile => profile.id === id && profile.tool === id)) return null;
  if (profiles && !profiles.some(profile => profile.id === id && profile.tool === session.tool)) return null;
  return id;
}

const AGENT_HINT: Record<AgentId, string> = { codex: 'App · CLI · IDE', claude: '终端 · IDE', 'claude-desktop': '桌面版' };

/** The entry page is never a pairing wizard. Credentials and execution targets are separate. */
export function RemoteHome({ visible, remote, device: remoteDevice, simulatedDevice, simulatedAgents, simulatedSessions, workspaceMode = 'code', onWorkspaceModeChange = () => undefined, directDevice, directSelected = false, onDirect, onComputer, onDemo, onApi, onAgent, onProjects, onSession, onDownload }: {
  visible: boolean; remote: RemoteState; device?: DeviceStatus; simulatedDevice?: DeviceStatus; simulatedAgents?: AgentProfile[]; simulatedSessions?: SessionInfo[];
  workspaceMode?: WorkspaceMode; onWorkspaceModeChange?: (mode: WorkspaceMode) => void;
  directDevice?: { deviceId: string; deviceName?: string; connected: boolean; status?: 'idle' | 'connecting' | 'authenticating' | 'connected' | 'closed' | 'error' };
  onDirect?: () => void;
  directSelected?: boolean;
  onComputer: () => void; onDemo?: () => void; onApi: () => void; onAgent: (id: AgentId) => void; onProjects: () => void;
  onSession: (deviceId: string, session: SessionInfo) => void; onDownload: () => void;
}) {
  const titleOf = useThreadTitles();
  const styles = useStyles();
  const d = useDesk();
  const directOnly = Boolean(directSelected && directDevice);
  const saved = directOnly ? undefined : remote.connections.find(item => item.id === remote.connectionId);
  const device = directOnly || saved && remoteDevice?.deviceId !== saved.deviceId ? undefined : remoteDevice;
  const online = remoteDeviceConnected(remote, device);
  // The saved computer's last task list is shown from the device cache even before it connects.
  const effectiveDevice = directOnly ? undefined : device ?? simulatedDevice;
  const homeDeviceId = effectiveDevice?.deviceId ?? saved?.deviceId;
  const entry = simulatedSessions ? { list: simulatedSessions, loaded: true, loading: false } : homeDeviceId ? remote.sessions[homeDeviceId] : undefined;
  const agents = simulatedAgents ? {
    list: simulatedAgents,
    apis: SIMULATED_REMOTE_AGENTS.map(agent => ({ id: `preview-${agent.id}`, name: agent.api.name, models: agent.api.model ? [agent.api.model] : [] })),
    loaded: true, loading: false, error: undefined,
  } : homeDeviceId ? remote.agents[homeDeviceId] : undefined;
  const pairingScope = typeof remoteDeliveryScope === 'function' ? remoteDeliveryScope() : '';
  const scope = JSON.stringify([pairingScope, remote.connectionId, remote.selectedHubUrl, remote.serviceId, homeDeviceId, directOnly, directDevice?.deviceId]);
  const generation = useRef({ visible, scope });
  if (generation.current.visible !== visible || generation.current.scope !== scope) generation.current = { visible, scope };
  const rendered = generation.current;
  const effectiveOnline = directOnly ? Boolean(directDevice?.connected) : online || Boolean(simulatedDevice);
  const active = useRef({ visible, online: effectiveOnline }); active.current = { visible, online: effectiveOnline };
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [agentGridWidth, setAgentGridWidth] = useState(0);
  const agentColumns = agentGridWidth >= 580 ? 5 : agentGridWidth >= 336 ? 3 : 2;
  const agentCardSize = agentGridWidth ? Math.min(132, (agentGridWidth - 8 * (agentColumns - 1)) / agentColumns) : 108;
  useEffect(() => { active.current.visible = visible; return () => { active.current.visible = false; }; }, [visible]);
  const canOperate = () => active.current.visible && generation.current === rendered;
  const action = (callback: () => void) => () => { if (canOperate()) callback(); };
  const historyIdentity = agents?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity;
  const latest = useMemo(() => [...new Map([...(entry?.list ?? []), ...(entry?.native?.list ?? []),
    ...Object.values(entry?.readOnly ?? {}).filter(directory => directory?.identity === historyIdentity).flatMap(directory => directory?.list ?? [])]
    .map(item => [item.sessionKey, item])).values()].filter(item => !item.parentSessionKey && sessionWorkspaceMode(item) === workspaceMode)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3), [entry?.list, entry?.native?.list, entry?.readOnly, historyIdentity, workspaceMode]);
  const reload = (manual = false) => {
    if (!canOperate() || !device || !active.current.online || directOnly || simulatedDevice) return;
    if (manual) setManualRefreshing(true);
    // Installing or configuring another Agent must be discoverable without
    // restarting the app. Refresh the catalogue together with the directory.
    void Promise.allSettled([loadSessions(device.deviceId), ...(manual ? [loadAgentProfiles(device.deviceId)] : [])])
      .finally(() => { if (manual && canOperate()) setManualRefreshing(false); });
  };
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => { setManualRefreshing(false); }, [visible, scope]);
  useEffect(() => { if (visible && homeDeviceId && !simulatedSessions) void hydrateCachedSessions(homeDeviceId); }, [visible, homeDeviceId, scope, simulatedSessions]); // eslint-disable-line react-hooks/exhaustive-deps
  // Coming back to the app refreshes the list once (no timer while it sits in the background).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => { if (next === 'active') reloadRef.current(); });
    return () => subscription.remove();
  }, [visible, homeDeviceId, scope]);
  useEffect(() => {
    // One initial read, no idle timer, no model request, and no API mutation.
    if (visible && online && device && !simulatedSessions && !entry?.loaded && !entry?.loading && !entry?.error) reload();
  }, [visible, online, device?.deviceId, scope, entry?.loaded, entry?.loading, entry?.error, simulatedSessions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (visible && online && device && !simulatedAgents && !agents?.loaded && !agents?.loading && !agents?.error) {
      void loadAgentProfiles(device.deviceId).catch(() => undefined);
    }
  }, [visible, online, device?.deviceId, scope, agents?.loaded, agents?.loading, agents?.error, simulatedAgents]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useMemo(() => new Set(Object.values(remote.approvals).filter(item => item.deviceId === device?.deviceId).map(item => item.sessionKey)), [remote.approvals, device?.deviceId]);
  const choices: Array<{ id: AgentId; name: string; tool: AgentProfile['tool']; client?: string; detail: string }> = [
    ...['codex', 'claude', 'claude-desktop'].map(id => AGENT_CHOICES.find(choice => choice.id === id)!),
    ...AGENT_CHOICES.filter(choice => !builtinAgent(choice.id)),
    ...(agents?.loaded ? agents.list.filter(profile => !AGENT_CHOICES.some(choice => choice.id === profile.id)).map(profile => ({
      id: profile.id, name: profile.name, tool: profile.tool, detail: profile.name,
    })) : []),
  ];
  const hasComputer = Boolean(directOnly || effectiveDevice || saved || remote.connections.length);
  // One quiet, dismissible pointer to the official relay; hidden for people already using it.
  const [promoReady, setPromoReady] = useState(false);
  useEffect(() => { let live = true; if (PROMO.enabled) void promoSnoozed('remote-home').then((snoozed) => { if (live) setPromoReady(!snoozed); }); return () => { live = false; }; }, []);
  const showPromo = promoReady && !usesOfficialRelay([...(agents?.apis ?? []).map(api => api.name), ...(agents?.list ?? []).map(agent => agent.api.name)]);

  const deviceName = directOnly ? directDevice?.deviceName || '直连电脑' : simulatedDevice ? simulatedDevice.name : saved ? connectionDisplayName(saved) : effectiveDevice?.name;
  const modeLabel = directOnly ? '直连' : simulatedDevice ? '演示' : saved?.botGroupId ? 'Bot' : '中转站';
  const status = directOnly ? `直连 · ${directDevice?.connected?'已连接':directDevice?.status==='connecting'||directDevice?.status==='authenticating'?'正在连接':'未连接'}`
    : effectiveOnline ? `${modeLabel} · 在线${effectiveDevice?.os ? ` · ${osName(effectiveDevice.os)}` : ''}` : effectiveDevice?.online ? `${modeLabel} · 正在连接…` : hasComputer ? `${modeLabel} · 离线` : '';
  const running = Boolean(entry?.list.some((session) => session.status === 'running'));
  const statusLabel = (session: SessionInfo) => pending.has(session.sessionKey) || session.status === 'waiting_approval' ? { text: '待回复', style: styles.pillWarn }
    : session.status === 'running' ? { text: '运行中', style: styles.pillRun } : session.status === 'failed' ? { text: '失败', style: styles.pillFail } : null;

  return <ScrollView testID="remote-home" contentContainerStyle={styles.page} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={manualRefreshing} onRefresh={() => { reload(true); }} tintColor={d.muted} />}>
    <View style={styles.heading}><Text accessibilityRole="header" style={styles.title}>{workspaceMode === 'code' ? 'Code' : 'Work'}</Text><Text style={styles.subtitle}>在手机上继续电脑里的工作</Text>
      <View style={styles.modeTabs} accessibilityRole="tablist">
        {(['code', 'work'] as const).map(mode => <Pressable key={mode} accessibilityRole="tab" accessibilityLabel={mode === 'code' ? 'Code' : 'Work'} accessibilityState={{ selected: workspaceMode === mode }}
          onPress={action(() => onWorkspaceModeChange(mode))} style={[styles.modeTab, workspaceMode === mode && styles.modeTabOn]}><Text style={[styles.modeTabText, workspaceMode === mode && styles.modeTabTextOn]}>{mode === 'code' ? 'Code' : 'Work'}</Text></Pressable>)}
      </View>
    </View>

    {/* The computer, with the desk orb as its face: tap to manage or pair. */}
    <Pressable accessibilityRole="button" accessibilityLabel="连接电脑" accessibilityHint={hasComputer ? `切换或管理：${deviceName ?? '电脑'}，${status}` : '扫码绑定一台电脑'} onPress={action(onComputer)}
      style={({ pressed }) => [styles.hero, !hasComputer && styles.heroEmpty, pressed && styles.pressed]}>
      {!hasComputer ? <View pointerEvents="none" style={styles.stage}><Svg width="100%" height="100%">
        <Defs><Pattern id="homeDots" width="18" height="18" patternUnits="userSpaceOnUse"><Circle cx="1" cy="1" r="0.9" fill={d.dot} /></Pattern>
          <RadialGradient id="homeGlow" cx="50%" cy="42%" rx="55%" ry="60%"><Stop offset="0" stopColor={d.glow} stopOpacity="1" /><Stop offset="1" stopColor={d.glow} stopOpacity="0" /></RadialGradient></Defs>
        <Rect width="100%" height="100%" fill="url(#homeDots)" /><Rect width="100%" height="100%" fill="url(#homeGlow)" />
      </Svg></View> : null}
      <DeskOrb size={hasComputer ? 44 : 88} busy={running} compact={hasComputer}
        mood={pending.size ? 'waiting' : hasComputer && !effectiveOnline && !device?.online ? 'sleepy' : 'idle'} />
      <View style={[styles.heroText, !hasComputer && { alignItems: 'center' }]}>
        <Text style={styles.heroName} numberOfLines={1}>{deviceName ?? (hasComputer ? `${pairedComputerCount(remote.connections)} 台已配对电脑` : '连接你的电脑')}</Text>
        {hasComputer ? <View style={styles.heroStatus}><ProgrammingStatus tone={effectiveOnline ? 'online' : device?.online ? 'pending' : 'offline'} text={status} /></View>
          : <Text style={[styles.detail, { textAlign: 'center' }]} numberOfLines={2}>扫码绑定后，即可继续电脑上的 Agent 任务</Text>}
      </View>
      {hasComputer ? <Icon name="chevronRight" size={16} color={d.faint} strokeWidth={2} />
        : <View style={styles.heroCta}><Icon name="scan" size={16} color={d.onInk} /><Text style={styles.heroCtaText}>扫码绑定</Text></View>}
    </Pressable>

    {directDevice && onDirect ? <ProgrammingCard style={{ marginTop: 10 }}>
      <ProgrammingRow first icon="link" title={directOnly ? '打开直连工作区' : `直连 · ${directDevice.deviceName || '电脑'}`} detail={directDevice.connected ? '局域网 / VPN' : directDevice.status === 'connecting' || directDevice.status === 'authenticating' ? '正在建立加密直连…' : '未连接 · 点按重连'}
        onPress={action(onDirect)} accessibilityRole="button" accessibilityLabel="打开电脑直连" trailing="chevron" />
    </ProgrammingCard> : null}

    {!directOnly ? <><ProgrammingSection title="AGENT" hint={deviceName ? `运行在${deviceName}` : '绑定电脑后可用'} />
    <View style={styles.agents} onLayout={event => setAgentGridWidth(event.nativeEvent.layout.width)}>{choices.map((choice) => {
      const profile = agents?.list.find(item => item.id === choice.id);
      const missing = Boolean(agents?.loaded && (!profile || !profile.available));
      const unconfirmed = !builtinAgent(choice.id) && !profile;
      const disabled = missing || unconfirmed;
      const name = profile?.name || choice.name;
      const detail = unconfirmed ? agents?.loaded ? '电脑端未提供' : '连接后确认' : missing ? builtinAgent(choice.id) ? '未安装' : '未就绪' : profile ? agentApiLabel(profile) : AGENT_HINT[choice.id] ?? choice.detail;
      return <Pressable key={choice.id} accessibilityRole="button" accessibilityLabel={`打开 ${name}`} accessibilityState={{ disabled }} disabled={disabled} onPress={action(() => { if (!disabled) onAgent(choice.id); })}
        style={({ pressed }) => [styles.agent, { width: agentCardSize }, disabled && { opacity: 0.55 }, pressed && styles.agentPressed]}>
        <ToolBadge tool={choice.tool} client={choice.client} size={24} />
        <Text style={styles.agentName} numberOfLines={2}>{name}</Text>
        <Text style={[styles.agentDetail, disabled && { color: d.faint }]} numberOfLines={1}>{detail}</Text>
      </Pressable>;
    })}</View>

    <ProgrammingCard style={{ marginTop: 8 }}>
      <ProgrammingRow first icon="key" title="API 密钥" accessibilityLabel="API 管理" onPress={action(onApi)} trailing="chevron"
        detail={!effectiveDevice ? '连接电脑后查看' : agents?.loaded && !agents.error ? `${agents.apis.length} 个 API · 电脑密钥库` : '电脑保存的密钥'} />
    </ProgrammingCard>

    <ProgrammingSection title="最近任务" action="全部会话" actionLabel="项目与会话" onAction={action(onProjects)} />
    {latest.length && homeDeviceId ? <ProgrammingCard>{latest.map((session, index) => {
      const badge = statusLabel(session);
      const name = titleOf(homeDeviceId, session.sessionKey, session.title || '无标题对话');
      return <Pressable key={session.sessionKey} accessibilityRole="button" accessibilityLabel={name}
        onPress={action(() => onSession(homeDeviceId, session))} style={({ pressed }) => [styles.task, index > 0 && styles.divider, pressed && styles.taskPressed]}>
        <ToolBadge tool={session.tool} client={session.client} size={24} />
        <View style={styles.body}><Text style={styles.taskTitle} numberOfLines={1}>{name}</Text>
          <Text style={styles.detail} numberOfLines={1}>{agentDisplayName(sessionAgent(session, agents?.list) ?? session.tool, agents?.list)} · {relTime(session.updatedAt)}</Text></View>
        {badge ? <View style={[styles.pill, badge.style]}><Text style={[styles.pillText, badge.style]}>{badge.text}</Text></View> : <Icon name="chevronRight" size={15} color={d.faint} />}
      </Pressable>;
    })}</ProgrammingCard>
      : <ProgrammingCard soft><View style={styles.empty}>{entry?.loading ? <SkeletonGroup label="正在读取任务" style={{ alignSelf: 'stretch' }}><SkeletonRows rows={3} avatar={24} /></SkeletonGroup>
        : <><Icon name={entry?.error ? 'alert' : 'chat'} size={20} color={d.faint} /><Text style={styles.emptyText}>{entry?.error ? '任务未更新，下拉重试' : hasComputer ? '还没有任务' : '绑定电脑后，这里会显示最近的任务'}</Text></>}</View></ProgrammingCard>}

    </> : null}
    {showPromo && !directOnly ? <Pressable accessibilityRole="link" accessibilityLabel={`推荐：${PROMO.name}`} onPress={() => void openPromo('remote-home')} style={({ pressed }) => [styles.promo, pressed && styles.taskPressed]}>
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
  hero: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingLeft: 12, paddingRight: 14, borderRadius: 20, overflow: 'hidden', backgroundColor: t.surface,
    borderWidth: StyleSheet.hairlineWidth, borderColor: t.line },
  heroEmpty: { flexDirection: 'column', paddingTop: 22, paddingBottom: 16, paddingHorizontal: 16, gap: 8, backgroundColor: t.surface2 },
  stage: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  heroText: { flex: 1, minWidth: 0, gap: 4 },
  heroName: { color: t.text, fontSize: 15.5, lineHeight: 21, fontWeight: '600', letterSpacing: -0.2 },
  heroStatus: { flexDirection: 'row', alignItems: 'center' },
  heroLinkText: { color: t.muted, fontSize: 11.5 },
  heroCta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, height: 42, alignSelf: 'stretch', marginTop: 12, borderRadius: 12, backgroundColor: t.ink },
  heroCtaText: { color: t.onInk, fontSize: 14, fontWeight: '600' },
  demoEntry: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10, paddingHorizontal: 12, borderRadius: 16, backgroundColor: t.accentSoft, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line }, demoIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface }, demoTitle: { color: t.text, fontSize: 13, fontWeight: '600' },
  body: { flex: 1, gap: 4, minWidth: 0 }, detail: { fontSize: 11.5, lineHeight: 16, color: t.muted },
  agents: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  agent: { aspectRatio: 1, padding: 10, borderRadius: 14, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, gap: 5 },
  agentPressed: { backgroundColor: t.surface2, transform: [{ scale: 0.98 }] },
  agentName: { color: t.text, fontSize: 13, lineHeight: 17, fontWeight: '600', flexGrow: 1 }, agentDetail: { color: t.muted, fontSize: 10.5, lineHeight: 14 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.line },
  task: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 52, paddingHorizontal: 14, paddingVertical: 8 }, taskPressed: { backgroundColor: t.press },
  taskTitle: { color: t.text, fontSize: 13.5, fontWeight: '500' },
  pill: { paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center' }, pillText: { fontSize: 11, fontWeight: '500', backgroundColor: 'transparent' },
  pillWarn: { backgroundColor: t.warnSoft, color: t.warn }, pillRun: { backgroundColor: t.accentSoft, color: t.accentText }, pillFail: { backgroundColor: t.badSoft, color: t.bad },
  empty: { minHeight: 80, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 }, emptyText: { color: t.muted, fontSize: 12, textAlign: 'center' },
  footer: { alignItems: 'center', marginTop: 'auto', paddingTop: 16 }, download: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12 }, downloadText: { fontSize: 12, color: t.muted },
  modeTabs: { flexDirection: 'row', alignSelf: 'flex-start', padding: 3, borderRadius: 12, backgroundColor: t.surface2, marginTop: 10 }, modeTab: { minHeight: 30, minWidth: 68, paddingHorizontal: 13, borderRadius: 9, alignItems: 'center', justifyContent: 'center' }, modeTabOn: { backgroundColor: t.surface }, modeTabText: { color: t.muted, fontSize: 12, fontWeight: '600' }, modeTabTextOn: { color: t.accentText },
  pressed: { opacity: 0.86 },
  promo: { marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingLeft: 12, paddingRight: 6, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, backgroundColor: t.surface },
  promoMark: { width: 28, height: 28, borderRadius: 9, backgroundColor: t.surface3, alignItems: 'center', justifyContent: 'center' },
  promoTitle: { color: t.text, fontSize: 13, fontWeight: '600' }, promoTag: { color: t.faint, fontSize: 10.5, fontWeight: '500' },
  promoClose: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
}));
