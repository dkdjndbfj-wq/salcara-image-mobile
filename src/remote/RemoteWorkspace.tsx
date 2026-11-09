import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { useReducedMotion } from '../components/MotionPressable';
import { themed, useDesk } from '../theme';
import type { AgentProfile, SessionInfo, ClaudeDesktopScope, WorkspaceMode } from './client';
import { remoteDeviceConnected } from './connection-state';
import { relTime } from './parts';
import { ProgrammingAction, useProgrammingStyles } from './ProgrammingUi';
import { agentSessions, agentSupports, desktopLiveFor, groupSessionsByProject, matchesSearch, originTag, sessionKeyAgentId, sessionWorkspaceMode, type SessionProjectGroup } from './projection';
import { hubSupportsProjectless, hubSupportsSessionActions, loadMoreSessions, loadNativeSessions, loadSessions, loadClaudeDesktopHistory, remoteDeliveryScope, selectSessionDirectory, timelineKey, useRemote } from './store';
import { useDemandSync } from './useDemandSync';
import { useThreadTitles } from './thread-titles';
import { SkeletonGroup, SkeletonRows } from '../components/Skeleton';
import { SessionQuickActionsSheet } from './SessionQuickActionsSheet';
import { ArchivedSessions } from './ArchivedSessions';
import { directorySessionActivities } from './directory-session-activity';
import { DirectorySessionStatus } from './DirectorySessionStatus';
import {conversationReadScope} from './conversation-unread';
import {useConversationResultIndex} from './ConversationUnread';
import { AgentDirectoryHeading } from './AgentDirectoryHeading';
import { sidebarSessionStatus } from './sidebar-session-status';
import { conversationFontFamily } from './conversation-typography';

import { ProjectBrowser } from './ProjectBrowser';
import { projectBrowserRequest } from './project-browser';

const PER_PROJECT = 6;
type ProjectSection = SessionProjectGroup & { data: SessionInfo[] };

/** The original computer session directory; opening a row never creates a task or changes its API. */
export function RemoteWorkspace({ visible, deviceId, agent, workspaceMode = 'code', onWorkspaceModeChange = () => undefined, onOpen, onNew, onSettings }: {
  visible: boolean; deviceId: string; agent: AgentProfile;
  workspaceMode?: WorkspaceMode; onWorkspaceModeChange?: (mode: WorkspaceMode) => void;
  onOpen: (key: string) => void; onNew: (mode: WorkspaceMode, cwd: string, projectless?: true) => void; onSettings: () => void;
}) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const reduced = useReducedMotion();
  const styles = useStyles();
  const remote = useRemote();
  const titleOf = useThreadTitles();
  const device = remote.devices.find(item => item.deviceId === deviceId);
  const online = remoteDeviceConnected(remote, device);
  const stored = remote.sessions[deviceId];
  const desktopAvailable = agent.id === 'codex' && Boolean(agent.desktopLive?.capabilities?.list);
  const pairingScope = typeof remoteDeliveryScope === 'function' ? remoteDeliveryScope() : '';
  const baseScope = JSON.stringify([pairingScope, remote.connectionId, remote.selectedHubUrl, remote.serviceId, deviceId, agent.id, workspaceMode]);
  const initialNative = agent.id === 'codex' && (stored?.directorySurface ? stored.directorySurface === 'desktop' : desktopAvailable);
  const [directoryChoice, setDirectoryChoice] = useState({ scope: baseScope, native: initialNative });
  const native = directoryChoice.scope === baseScope ? directoryChoice.native : initialNative;
  const history = agent.id === 'claude-desktop' ? agent.desktopHistory : undefined;
  const [claudeChoice, setClaudeChoice] = useState<{ scope: string; source: ClaudeDesktopScope | 'code' }>({ scope: baseScope, source: workspaceMode === 'work' && history ? 'desktop-chat' : 'code' });
  const claudeSource = claudeChoice.scope === baseScope ? claudeChoice.source : workspaceMode === 'work' && history ? 'desktop-chat' : 'code';
  const readOnly = agent.id === 'claude-desktop' && claudeSource !== 'code' ? claudeSource : undefined;
  const historyValid = Boolean(readOnly && history?.scopes.includes(readOnly));
  const archivesAllowed = !native && !readOnly && online && typeof hubSupportsSessionActions === 'function' && hubSupportsSessionActions()
    && agentSupports(agent, agent.id, 'archivedSessions');
  const historyEntry = readOnly ? stored?.readOnly?.[readOnly] : undefined;
  const [, setLeaseClock] = useState(0);
  const desktopValid = desktopAvailable && (agent.desktopLive?.expiresAt ?? 0) > Date.now();
  const entry = readOnly ? historyEntry?.identity === history?.identity ? historyEntry : undefined : native ? stored?.native : stored;
  const scope = JSON.stringify([baseScope, readOnly ? [readOnly, history?.identity] : native ? 'desktop' : 'all']);
  const page = readOnly ? historyEntry?.identity === history?.identity ? historyEntry : undefined : native ? stored?.native : stored?.pages?.[agent.id];
  // A selected desktop directory stays selected when its lease expires. Never
  // replace it with history/CLI merely because a timer or status update fires.
  useEffect(() => {
    if (!visible || !native || !agent.desktopLive) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const left = agent.desktopLive!.expiresAt - Date.now();
      if (left <= 0) { setLeaseClock(value => value + 1); return; }
      timer = setTimeout(check, Math.min(left, 86400000));
    };
    check(); return () => clearTimeout(timer);
  }, [visible, native, agent.desktopLive?.expiresAt]);
  const [projectBrowser, setProjectBrowser] = useState(false);
  const projectRequest = useMemo(() => projectBrowserRequest('remote', deviceId, agent.tool, workspaceMode), [scope]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [directoryView, setDirectoryView] = useState<'sessions' | 'archived'>('sessions');
  const [actionSession, setActionSession] = useState<{ session: SessionInfo; connectionId: string | null } | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const generation = useRef({ visible, scope });
  if (generation.current.visible !== visible || generation.current.scope !== scope) generation.current = { visible, scope };
  const rendered = generation.current;
  const active = useRef({ visible, deviceId, online, scope, agentId: agent.id, native, desktopValid, readOnly, historyValid, loading: Boolean(entry?.loading), page });
  active.current = { visible, deviceId, online, scope, agentId: agent.id, native, desktopValid, readOnly, historyValid, loading: Boolean(entry?.loading), page };
  const inFlight = useRef<{ scope: string; preservePages: boolean; promise: Promise<void> } | null>(null);
  const entranceRead = useRef<object | null>(null);
  useEffect(() => { active.current.visible = visible; return () => { active.current.visible = false; }; }, [visible]);

  const canOperate = () => active.current.visible && generation.current === rendered;
  const load = (more = false, preservePages = false): Promise<void> => {
    const target = active.current;
    if (!canOperate() || !target.online || target.native && !target.desktopValid || target.readOnly && !target.historyValid) return Promise.resolve();
    if (inFlight.current?.scope === target.scope && (preservePages || !inFlight.current.preservePages)) return inFlight.current.promise;
    if (target.loading || target.page?.loading || (more && !target.page?.nextCursor)) return Promise.resolve();
    const pending = Promise.resolve().then(() => {
      if (!canOperate() || !active.current.online || active.current.deviceId !== target.deviceId || active.current.scope !== target.scope) return;
      return target.readOnly ? loadClaudeDesktopHistory(target.deviceId, target.readOnly, more, preservePages ? { preservePages: true } : undefined)
        : target.native ? loadNativeSessions(target.deviceId, more, preservePages ? { preservePages: true } : undefined) : more ? loadMoreSessions(target.deviceId, target.agentId)
        : preservePages ? loadSessions(target.deviceId, target.agentId, { preservePages: true }) : loadSessions(target.deviceId, target.agentId);
    });
    const request = { scope: target.scope, preservePages, promise: pending };
    inFlight.current = request;
    void pending.finally(() => { if (inFlight.current === request) inFlight.current = null; }).catch(() => undefined);
    return pending;
  };
  const refresh = (manual = false) => {
    if (!canOperate()) return Promise.resolve();
    if (manual) setManualRefreshing(true);
    const request = load();
    void request.catch(() => undefined).finally(() => { if (manual && canOperate()) setManualRefreshing(false); });
    return request;
  };
  useEffect(() => {
    if (!visible || !online || native && !desktopValid || readOnly && !historyValid) { entranceRead.current = null; return; }
    if (entranceRead.current === rendered || entry?.loading || page?.loading) return;
    entranceRead.current = rendered; refresh();
  }, [visible, scope, agent.id, online, desktopValid, historyValid, entry?.loading, page?.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setProjectBrowser(false); setQuery(''); setExpanded({}); setCollapsedProjects({}); setDirectoryView('sessions'); setActionSession(null); }, [scope, agent.id]);
  useEffect(() => { setManualRefreshing(false); }, [visible, scope]);

  const pending = useMemo(() => new Set(Object.values(remote.approvals).filter(item => item.deviceId === deviceId).map(item => item.sessionKey)), [remote.approvals, deviceId]);
  const directory = useMemo(() => agentSessions(entry?.list ?? [], agent), [entry?.list, agent.id, agent.tool]);
  const visibleDirectory = useMemo(() => directory.filter(item => readOnly ? item.sessionScope === readOnly : item.controlSurface !== 'read-only'), [directory, readOnly]);
  const modeDirectory = useMemo(() => visibleDirectory.filter(item => sessionWorkspaceMode(item) === workspaceMode), [visibleDirectory, workspaceMode]);
  const activities = useMemo(() => directorySessionActivities(modeDirectory, agent, workspaceMode, { pending,
    statusFor: row => sidebarSessionStatus(row, remote.timelines[timelineKey(deviceId, row.sessionKey)]) }), [modeDirectory, agent.id, agent.tool, workspaceMode, pending, remote.timelines, deviceId]);
  const agentList = useMemo(() => modeDirectory.filter(item => !item.parentSessionKey), [modeDirectory]);
  const resultScope=conversationReadScope(pairingScope,deviceId,agent,workspaceMode);
  useConversationResultIndex(agentList.map(session=>({scope:resultScope,session,timeline:remote.timelines[timelineKey(deviceId,session.sessionKey)],active:visible&&online})));
  const matches = (item: SessionInfo) => matchesSearch(item, query, titleOf(deviceId, item.sessionKey, item.title));
  const list = useMemo(() => agentList.filter(matches), [agentList, query, titleOf, deviceId]);
  const groups = useMemo(() => groupSessionsByProject(list, { nativeOrder: native, nativeSessionOrder: native ? list.map(item => item.sessionKey) : undefined,
    caseSensitivePaths: device?.os !== 'windows' }), [list, native, device?.os]);
  const searching = Boolean(query.trim());
  const sections: ProjectSection[] = groups.map(group => ({ ...group, data: !searching && collapsedProjects[group.key] ? []
    : searching || expanded[group.key] ? group.sessions : group.sessions.slice(0, PER_PROJECT) }));
  // Retain the existing foreground demand refresh, including running tasks hidden by a search.
  useDemandSync(visible && online, directory.some(item => item.status === 'running' || item.status === 'waiting_approval'), () => load(false, true));

  const status = !online ? '电脑离线' : readOnly && !historyValid ? '桌面历史不可用' : native && !desktopValid ? '桌面连接已断开' : entry?.error ? '没有更新会话' : '';
  const empty = readOnly && !historyValid ? <View style={styles.empty}><Text style={p.name}>桌面历史不可用</Text></View> : native && !desktopValid ? <View style={styles.empty}><Text style={p.name}>桌面连接已断开</Text></View>
    : entry?.loading || (online && !entry?.loaded && !entry?.error)
    ? <SkeletonGroup testID="remote-workspace-loading" label="正在读取会话" style={{ paddingHorizontal: 16, paddingTop: 8 }}><SkeletonRows rows={6} avatar={28} /></SkeletonGroup>
    : entry?.error ? <View style={styles.empty}><Text style={p.name}>没有读到对话</Text>{online ? <ProgrammingAction label="重试" tone="secondary" onPress={refresh} style={styles.retry} /> : <Text style={p.detail}>电脑上线后重试</Text>}</View>
      : searching ? <View style={styles.empty}><Icon name="search" size={24} color={dk.faint} /><Text style={p.name}>没有匹配的对话</Text>{page?.nextCursor ? <Text style={p.detail}>只搜索了已加载的内容，可在下方加载更多</Text> : null}</View>
        : <View style={styles.empty}><Icon name="chat" size={24} color={dk.faint} /><Text style={p.name}>{online ? '还没有对话' : '电脑离线'}</Text>{!online ? <Text style={p.detail}>上线后刷新会话</Text> : null}</View>;

  const directoryHeader = <View>
    <AgentDirectoryHeading agentName={agent.name} deviceName={device?.name} mode={workspaceMode} disabled={!online}
      onNewProject={directoryView !== 'archived' && !native && !readOnly && agent.remoteSendSupported ? () => { if (canOperate() && active.current.online) setProjectBrowser(true); } : undefined} />
    {archivesAllowed ? <View style={styles.modeTabs} accessibilityRole="tablist">
      {([{ id: 'sessions', label: '对话' }, { id: 'archived', label: '已归档' }] as const).map(item => <Pressable key={item.id}
        accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected: directoryView === item.id }}
        onPress={() => { if (canOperate()) setDirectoryView(item.id); }} style={[styles.modeTab, directoryView === item.id && styles.modeTabOn]}>
        <Text style={[styles.directoryLabel, directoryView === item.id && styles.directoryLabelOn]}>{item.label}</Text>
      </Pressable>)}
    </View> : null}
    {directoryView !== 'archived' ? <>
      {agent.id === 'codex' && (desktopAvailable || stored?.native || native) ? <View style={styles.directoryTabs}>
        {([{ label: '桌面', native: true }, { label: '全部', native: false }] as const).map(choice => <Pressable key={choice.label}
          accessibilityRole="radio" accessibilityLabel={`${choice.label}对话`} accessibilityState={{ checked: native === choice.native }}
          onPress={() => { if (canOperate()) { selectSessionDirectory(deviceId, choice.native ? 'desktop' : 'all'); setDirectoryChoice({ scope: baseScope, native: choice.native }); } }}
          style={[styles.directoryTab, native === choice.native && styles.directoryTabOn]}><Text style={[styles.directoryLabel, native === choice.native && styles.directoryLabelOn]}>{choice.label}</Text></Pressable>)}
      </View> : null}
      {agent.id === 'claude-desktop' && (history || readOnly) ? <View style={styles.directoryTabs}>
        {(['desktop-chat', 'desktop-cowork', 'code'] as const).filter(source => workspaceMode === 'code' ? source === 'code' && agent.remoteSendSupported : source !== 'code').map(source => <Pressable key={source}
          accessibilityRole="radio" accessibilityLabel={`${source === 'desktop-chat' ? 'Chat' : source === 'desktop-cowork' ? 'Cowork' : 'Code'}对话`} accessibilityState={{ checked: claudeSource === source }}
          onPress={() => { if (canOperate()) setClaudeChoice({ scope: baseScope, source }); }} style={[styles.directoryTab, claudeSource === source && styles.directoryTabOn]}>
          <Text style={[styles.directoryLabel, claudeSource === source && styles.directoryLabelOn]}>{source === 'desktop-chat' ? 'Chat' : source === 'desktop-cowork' ? 'Cowork' : 'Code'}</Text></Pressable>)}
      </View> : null}
      {!readOnly ? <Pressable accessibilityRole="button" accessibilityLabel="API 管理" onPress={() => { if (canOperate()) onSettings(); }} style={styles.api}>
        <Icon name="key" size={15} color={dk.muted} /><Text style={styles.apiLabel} numberOfLines={1}>{agent.api.name || 'API'}</Text><Icon name="chevronRight" size={14} color={dk.muted} />
      </Pressable> : null}
      <View style={styles.search}><Icon name="search" size={16} color={dk.muted} />
        <TextInput accessibilityLabel="搜索对话" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
          placeholder="搜索对话" placeholderTextColor={dk.muted} style={styles.searchInput} />
        {query ? <Pressable accessibilityRole="button" accessibilityLabel="清除搜索" onPress={() => setQuery('')} hitSlop={8}><Icon name="close" size={14} color={dk.muted} /></Pressable> : null}
      </View>
      {status && visibleDirectory.length ? <View style={styles.status}><Text style={p.detail}>{status}</Text>{online && entry?.error ? <Pressable accessibilityRole="button" accessibilityLabel="重试读取会话" onPress={() => { void refresh(true); }} style={styles.smallRetry}><Text style={styles.link}>重试</Text></Pressable> : null}</View> : null}
    </> : null}
  </View>;

  if (projectBrowser && visible) return <ProjectBrowser key={scope} scopeKey={scope} tool={agent.tool} mode={workspaceMode} request={projectRequest}
    projectlessUnavailable={agent.id === 'claude-desktop' ? '此桌面入口需要项目文件夹。也可以返回选择 Claude Code，再开始独立会话。' : typeof hubSupportsProjectless !== 'function' || !hubSupportsProjectless() || !device?.capabilities?.includes('session.projectless.v1') ? '电脑或中转站尚不支持此方式。可以先选择文件夹，或更新电脑端和中转站后再试。' : undefined}
    onProjectless={() => { if (canOperate() && active.current.online) { setProjectBrowser(false); onNew(workspaceMode, '', true); } }}
    onClose={() => { if (canOperate()) setProjectBrowser(false); }} onSelect={project => { if (canOperate() && active.current.online) { setProjectBrowser(false); onNew(workspaceMode, project.path); } }} />;
  return <View style={styles.screen} testID="remote-workspace">
    {directoryView === 'archived' && archivesAllowed ? <View style={styles.archivedPage}>
      <View style={styles.archivedHeader}>{directoryHeader}</View>
      <ArchivedSessions key={`${scope}:archived`} deviceId={deviceId} tool={agent.tool} onRestored={key => {
        if (!canOperate()) return;
        setDirectoryView('sessions'); onOpen(key);
      }} />
    </View> : <SectionList<SessionInfo, ProjectSection> testID="remote-workspace-list" sections={sections}
      keyExtractor={item => item.sessionKey} contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false} stickySectionHeadersEnabled={false} keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag" refreshing={manualRefreshing} onRefresh={() => { void refresh(true); }}
      ListHeaderComponent={directoryHeader}
      ListEmptyComponent={groups.length ? null : empty}
      ListFooterComponent={page?.nextCursor || page?.error ? <View style={styles.pagination}>
        {page.error ? <Text style={p.error}>没有读到更多对话</Text> : null}
        {searching && page.nextCursor ? <Text style={p.note}>搜索只包含已加载的 {agentList.length} 项，加载更多可以搜到更早的</Text> : null}
        {page.nextCursor ? <ProgrammingAction label={page.error ? '重试更多对话' : '更多对话'} tone="secondary" loading={page.loading}
          disabled={!online || Boolean(entry?.loading) || page.loading} onPress={() => { void load(true).catch(() => undefined); }} /> : null}
      </View> : null}
      renderSectionHeader={({ section }) => {
        const collapsed = !searching && collapsedProjects[section.key] === true;
        return <View><Pressable accessibilityRole="button" accessibilityLabel={`${collapsed ? '展开' : '折叠'} ${section.name} 对话`}
          accessibilityState={{ expanded: !collapsed }} onPress={() => {
            if (!canOperate() || searching) return;
            setCollapsedProjects(current => ({ ...current, [section.key]: !current[section.key] }));
          }} style={styles.project}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} color={dk.muted} />
          <Icon name={section.key === '__temporary' ? 'chat' : 'folder'} size={17} color={dk.muted} /><View style={styles.projectBody}>
            <Text style={styles.projectName} numberOfLines={1}>{section.name}</Text>{section.path&&groups.some(other=>other.key!==section.key&&other.name===section.name) ? <Text style={styles.projectPath} numberOfLines={1}>{section.path}</Text> : null}
          </View><Text style={styles.projectCount}>{section.sessions.length}</Text>
        </Pressable>{(section.path || section.projectless) && !native && !readOnly && agent.remoteSendSupported ? <Pressable accessibilityRole="button" accessibilityLabel={`在 ${section.name} 中新建 ${workspaceMode === 'code' ? 'Code' : 'Work'} 对话`} disabled={!online} onPress={() => { if (canOperate() && active.current.online) onNew(workspaceMode, section.path, ...(section.projectless ? [true as const] : [])); }} style={styles.more}><Text style={styles.link}>新建会话</Text></Pressable> : null}</View>;
      }}
      renderSectionFooter={({ section }) => !searching && section.sessions.length > PER_PROJECT
        ? <Pressable accessibilityRole="button" accessibilityLabel={`${expanded[section.key] ? '收起' : '显示全部'} ${section.name} 的对话`}
          onPress={() => { if (canOperate()) setExpanded(current => ({ ...current, [section.key]: !current[section.key] })); }} style={styles.more}>
          <Text style={styles.link}>{expanded[section.key] ? '收起' : `显示全部 ${section.sessions.length} 个`}</Text>
        </Pressable> : null}
      renderItem={({ item }) => {
        const activity = activities.get(item.sessionKey) ?? { status: item.status, includesChildren: false };
        const origin = originTag(item.client);
        const name = titleOf(deviceId, item.sessionKey, item.title || '无标题对话');
        return <Pressable testID={`remote-workspace-session-${item.sessionKey}`} accessibilityRole="button" accessibilityLabel={name} accessibilityHint="长按打开会话操作"
          accessibilityState={{ disabled: native && !desktopValid }}
          onLongPress={() => { if (canOperate()) setActionSession({ session: item, connectionId: remote.connectionId }); }}
          onPress={() => { if (canOperate() && (!active.current.native || active.current.desktopValid)) onOpen(item.sessionKey); }}
          style={({ pressed }) => [styles.thread, pressed && styles.pressed]}>
          <View style={{width:18}}/>
          <View style={styles.threadBody}><Text style={styles.threadTitle} numberOfLines={1}>{name}</Text>
            {origin || desktopLiveFor(agent, item.sessionKey) ? <Text style={styles.origin} numberOfLines={1}>{desktopLiveFor(agent, item.sessionKey) ? '桌面授权中' : origin}</Text> : null}
          </View>
          <DirectorySessionStatus activity={activity} title={name} active={visible && online && (!native || desktopValid)} reduced={reduced} fallback={relTime(item.updatedAt)} result={{scope:resultScope,session:item,timeline:remote.timelines[timelineKey(deviceId,item.sessionKey)],active:visible&&online}} />
        </Pressable>;
      }}
      initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
    />}
    {actionSession ? <SessionQuickActionsSheet visible deviceId={deviceId} connectionId={actionSession.connectionId}
      deviceName={device?.name} agent={agent} session={actionSession.session}
      onClose={() => setActionSession(null)} onArchive={() => { setActionSession(null); if (archivesAllowed) setDirectoryView('archived'); }} onOpenSession={key => {
        if (!canOperate() || active.current.native && (!active.current.desktopValid || !agent.desktopLive?.capabilities?.read || !agent.desktopLive.sessionKeys.includes(key))) return;
        onOpen(key);
      }} onOpenFork={key => { if (canOperate() && sessionKeyAgentId(key) === agent.tool && agent.remoteSendSupported) onOpen(key); }} /> : null}
  </View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  screen: { flex: 1 }, archivedPage: { flex: 1, minHeight: 0 }, archivedHeader:{paddingHorizontal:16}, content: { paddingHorizontal: 16, paddingBottom: 24, flexGrow: 1 },
  modeTabs: { flexDirection: 'row', alignSelf: 'flex-start', padding: 3, borderRadius: 10, backgroundColor: d.surface2, marginBottom: 8 }, modeTab: { minHeight: 32, minWidth: 72, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }, modeTabOn: { backgroundColor: d.surface },
  directoryTabs: { flexDirection: 'row', gap: 6, marginBottom: 8 }, directoryTab: { minHeight: 32, paddingHorizontal: 12, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  directoryTabOn: { backgroundColor: d.accentSoft }, directoryLabel: { fontSize: 12, color: d.muted }, directoryLabelOn: { color: d.accentText },
  api: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 }, apiLabel: { flex: 1, color: d.muted, fontSize: 12 },
  search: { height: 36, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 11, borderRadius: 10, backgroundColor: d.surface2 },
  searchInput: { flex: 1, minWidth: 0, color: d.text, fontSize: 13, paddingVertical: 0 },
  status: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, smallRetry: { minHeight: 40, justifyContent: 'center' },
  project: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 22, paddingBottom: 8 }, projectBody: { flex: 1, minWidth: 0, gap: 3 },
  projectName: { color: d.text, fontSize: 12.5, fontWeight: '500' }, projectPath: { color: d.faint, fontSize: 10.5, lineHeight: 15 }, projectCount: { color: d.faint, fontSize: 10.5, fontVariant: ['tabular-nums'] },
  thread: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7,paddingHorizontal:8, borderRadius: 10 }, threadBody: { flex: 1, minWidth: 0, gap: 4 },
  threadTitle: { fontFamily:conversationFontFamily,color: d.text, fontSize: 13, lineHeight: 19 }, origin: { color: d.muted, fontSize: 10.5, lineHeight: 15 }, pressed: { backgroundColor: d.surface2 },
  more: { minHeight: 40, paddingLeft: 44, justifyContent: 'center' }, link: { color: d.accentText, fontSize: 11.5 },
  empty: { flex: 1, minHeight: 160, paddingTop: 38, alignItems: 'center', gap: 14 }, retry: { minWidth: 150, marginTop: 4 },
  pagination: { paddingTop: 18, gap: 10 },
}));
