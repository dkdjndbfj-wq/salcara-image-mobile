import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from '../components/Icon';
import { colors, desk, themed, useDesk } from '../theme';
import type { AgentProfile, SessionInfo, ClaudeDesktopScope } from './client';
import { remoteDeviceConnected } from './connection-state';
import { relTime, ToolBadge } from './parts';
import { ProgrammingAction, ProgrammingHeading, useProgrammingStyles } from './ProgrammingUi';
import { agentSessions, desktopLiveFor, groupSessionsByProject, matchesSearch, originTag, type SessionProjectGroup } from './projection';
import { loadMoreSessions, loadNativeSessions, loadSessions, loadClaudeDesktopHistory, selectSessionDirectory, useRemote } from './store';
import { useDemandSync } from './useDemandSync';
import { useThreadTitles } from './thread-titles';

const PER_PROJECT = 6;
type ProjectSection = SessionProjectGroup & { data: SessionInfo[] };

/** The original computer session directory; opening a row never creates a task or changes its API. */
export function RemoteWorkspace({ visible, deviceId, agent, onOpen, onNew, onSettings }: {
  visible: boolean; deviceId: string; agent: AgentProfile;
  onOpen: (key: string) => void; onNew: () => void; onSettings: () => void;
}) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const remote = useRemote();
  const titleOf = useThreadTitles();
  const device = remote.devices.find(item => item.deviceId === deviceId);
  const online = remoteDeviceConnected(remote, device);
  const stored = remote.sessions[deviceId];
  const desktopAvailable = agent.id === 'codex' && Boolean(agent.desktopLive?.capabilities?.list);
  const baseScope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId, deviceId, agent.id]);
  const initialNative = agent.id === 'codex' && (stored?.directorySurface ? stored.directorySurface === 'desktop' : desktopAvailable);
  const [directoryChoice, setDirectoryChoice] = useState({ scope: baseScope, native: initialNative });
  const native = directoryChoice.scope === baseScope ? directoryChoice.native : initialNative;
  const history = agent.id === 'claude-desktop' ? agent.desktopHistory : undefined;
  const [claudeChoice, setClaudeChoice] = useState<{ scope: string; source: ClaudeDesktopScope | 'code' }>({ scope: baseScope, source: history ? 'desktop-chat' : 'code' });
  const claudeSource = claudeChoice.scope === baseScope ? claudeChoice.source : history ? 'desktop-chat' : 'code';
  const readOnly = agent.id === 'claude-desktop' && claudeSource !== 'code' ? claudeSource : undefined;
  const historyValid = Boolean(readOnly && history?.scopes.includes(readOnly));
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
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
  const refresh = () => { void load().catch(() => undefined); };
  useEffect(() => {
    if (!visible || !online || native && !desktopValid || readOnly && !historyValid) { entranceRead.current = null; return; }
    if (entranceRead.current === rendered || entry?.loading || page?.loading) return;
    entranceRead.current = rendered; refresh();
  }, [visible, scope, agent.id, online, desktopValid, historyValid, entry?.loading, page?.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setQuery(''); setExpanded({}); }, [scope, agent.id]);

  const pending = useMemo(() => new Set(Object.values(remote.approvals).filter(item => item.deviceId === deviceId).map(item => item.sessionKey)), [remote.approvals, deviceId]);
  const directory = useMemo(() => agentSessions(entry?.list ?? [], agent), [entry?.list, agent.id, agent.tool]);
  const agentList = useMemo(() => directory.filter(item => !item.parentSessionKey && (readOnly ? item.sessionScope === readOnly : item.controlSurface !== 'read-only')), [directory, readOnly]);
  const list = useMemo(() => agentList.filter(item => matchesSearch(item, query)), [agentList, query]);
  const groups = useMemo(() => groupSessionsByProject(list, { nativeOrder: native, nativeSessionOrder: native ? list.map(item => item.sessionKey) : undefined }), [list, native]);
  const searching = Boolean(query.trim());
  const sections: ProjectSection[] = groups.map(group => ({ ...group, data: searching || expanded[group.key] ? group.sessions : group.sessions.slice(0, PER_PROJECT) }));
  // Retain the existing foreground demand refresh, including running tasks hidden by a search.
  useDemandSync(visible && online, directory.some(item => item.status === 'running' || item.status === 'waiting_approval'), () => load(false, true));

  const status = !online ? '电脑离线' : readOnly && !historyValid ? '桌面历史不可用' : native && !desktopValid ? '桌面连接已断开' : entry?.error ? '没有更新会话' : '';
  const empty = readOnly && !historyValid ? <View style={styles.empty}><Text style={p.name}>桌面历史不可用</Text></View> : native && !desktopValid ? <View style={styles.empty}><Text style={p.name}>桌面连接已断开</Text></View>
    : entry?.loading || (online && !entry?.loaded && !entry?.error)
    ? <View style={styles.empty}><ActivityIndicator testID="remote-workspace-loading" color={dk.muted} /><Text style={p.detail}>正在读取会话</Text></View>
    : entry?.error ? <View style={styles.empty}><Text style={p.name}>没有读到对话</Text>{online ? <ProgrammingAction label="重试" tone="secondary" onPress={refresh} style={styles.retry} /> : <Text style={p.detail}>电脑上线后重试</Text>}</View>
      : searching ? <View style={styles.empty}><Icon name="search" size={24} color={dk.faint} /><Text style={p.name}>没有匹配的对话</Text>{page?.nextCursor ? <Text style={p.detail}>只搜索了已加载的对话，可在下方加载更多</Text> : null}</View>
        : <View style={styles.empty}><Icon name="chat" size={24} color={dk.faint} /><Text style={p.name}>{online ? '还没有对话' : '电脑离线'}</Text>{!online ? <Text style={p.detail}>上线后刷新会话</Text> : null}</View>;

  return <View style={styles.screen} testID="remote-workspace">
    <SectionList<SessionInfo, ProjectSection> testID="remote-workspace-list" sections={sections}
      keyExtractor={item => item.sessionKey} contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false} stickySectionHeadersEnabled={false} keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag" refreshing={Boolean(entry?.loading && agentList.length && !page?.nextCursor)} onRefresh={refresh}
      ListHeaderComponent={<View>
        <ProgrammingHeading title={agent.name} subtitle={device?.name} />
        {agent.id === 'codex' && (desktopAvailable || stored?.native || native) ? <View style={styles.directoryTabs}>
          {([{ label: '桌面', native: true }, { label: '全部', native: false }] as const).map(choice => <Pressable key={choice.label}
            accessibilityRole="radio" accessibilityLabel={`${choice.label}对话`} accessibilityState={{ checked: native === choice.native }}
            onPress={() => { if (canOperate()) { selectSessionDirectory(deviceId, choice.native ? 'desktop' : 'all'); setDirectoryChoice({ scope: baseScope, native: choice.native }); } }}
            style={[styles.directoryTab, native === choice.native && styles.directoryTabOn]}><Text style={[styles.directoryLabel, native === choice.native && styles.directoryLabelOn]}>{choice.label}</Text></Pressable>)}
        </View> : null}
        {agent.id === 'claude-desktop' && (history || readOnly) ? <View style={styles.directoryTabs}>
          {(['desktop-chat', 'desktop-cowork', 'code'] as const).filter(source => source !== 'code' || agent.remoteSendSupported).map(source => <Pressable key={source}
            accessibilityRole="radio" accessibilityLabel={`${source === 'desktop-chat' ? 'Chat' : source === 'desktop-cowork' ? 'Cowork' : 'Code'}对话`} accessibilityState={{ checked: claudeSource === source }}
            onPress={() => { if (canOperate()) setClaudeChoice({ scope: baseScope, source }); }} style={[styles.directoryTab, claudeSource === source && styles.directoryTabOn]}>
            <Text style={[styles.directoryLabel, claudeSource === source && styles.directoryLabelOn]}>{source === 'desktop-chat' ? 'Chat' : source === 'desktop-cowork' ? 'Cowork' : 'Code'}</Text></Pressable>)}
        </View> : null}
        {!readOnly ? <Pressable accessibilityRole="button" accessibilityLabel="更换 Agent / API" onPress={() => { if (canOperate()) onSettings(); }} style={styles.api}>
          <Icon name="key" size={15} color={dk.muted} /><Text style={styles.apiLabel} numberOfLines={1}>{agent.api.name || 'API'}</Text><Icon name="chevronRight" size={14} color={dk.muted} />
        </Pressable> : null}
        {!native && !readOnly && agent.remoteSendSupported ? <ProgrammingAction label="新对话" icon="plus" disabled={!online} onPress={() => { if (canOperate() && active.current.online) onNew(); }} style={styles.newAction} /> : null}
        <View style={styles.search}><Icon name="search" size={16} color={dk.muted} />
          <TextInput accessibilityLabel="搜索对话" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false}
            placeholder="搜索对话" placeholderTextColor={dk.muted} style={styles.searchInput} />
          {query ? <Pressable accessibilityRole="button" accessibilityLabel="清除搜索" onPress={() => setQuery('')} hitSlop={8}><Icon name="close" size={14} color={dk.muted} /></Pressable> : null}
        </View>
        {status && agentList.length ? <View style={styles.status}><Text style={p.detail}>{status}</Text>{online && entry?.error ? <Pressable accessibilityRole="button" accessibilityLabel="重试读取会话" onPress={refresh} style={styles.smallRetry}><Text style={styles.link}>重试</Text></Pressable> : null}</View> : null}
      </View>}
      ListEmptyComponent={empty}
      ListFooterComponent={page?.nextCursor || page?.error ? <View style={styles.pagination}>
        {page.error ? <Text style={p.error}>没有读到更多对话</Text> : null}
        {searching && page.nextCursor ? <Text style={p.note}>搜索只包含已加载的 {agentList.length} 个对话，加载更多可以搜到更早的</Text> : null}
        {page.nextCursor ? <ProgrammingAction label={page.error ? '重试更多对话' : '更多对话'} tone="secondary" loading={page.loading}
          disabled={!online || Boolean(entry?.loading) || page.loading} onPress={() => { void load(true).catch(() => undefined); }} /> : null}
      </View> : null}
      renderSectionHeader={({ section }) => <View style={styles.project}><Icon name="archive" size={14} color={dk.muted} /><View style={styles.projectBody}>
        <Text style={styles.projectName} numberOfLines={1}>{section.name}</Text>{section.path ? <Text style={styles.projectPath} numberOfLines={1}>{section.path}</Text> : null}
      </View></View>}
      renderSectionFooter={({ section }) => !searching && section.sessions.length > PER_PROJECT
        ? <Pressable accessibilityRole="button" accessibilityLabel={`${expanded[section.key] ? '收起' : '显示全部'} ${section.name} 的对话`}
          onPress={() => { if (canOperate()) setExpanded(current => ({ ...current, [section.key]: !current[section.key] })); }} style={styles.more}>
          <Text style={styles.link}>{expanded[section.key] ? '收起' : `显示全部 ${section.sessions.length} 个`}</Text>
        </Pressable> : null}
      renderItem={({ item }) => {
        const awaiting = pending.has(item.sessionKey) || item.status === 'waiting_approval';
        const running = item.status === 'running';
        const failed = item.status === 'failed';
        const origin = originTag(item.client);
        const name = titleOf(deviceId, item.sessionKey, item.title || '无标题对话');
        return <Pressable testID={`remote-workspace-session-${item.sessionKey}`} accessibilityRole="button" accessibilityLabel={name}
          accessibilityState={{ disabled: native && !desktopValid }} disabled={native && !desktopValid}
          onPress={() => { if (canOperate() && (!active.current.native || active.current.desktopValid)) onOpen(item.sessionKey); }}
          style={({ pressed }) => [styles.thread, pressed && styles.pressed]}>
          <ToolBadge tool={item.tool} client={item.client} size={34} />
          <View style={styles.threadBody}><Text style={styles.threadTitle} numberOfLines={1}>{name}</Text>
            {origin || desktopLiveFor(agent, item.sessionKey) ? <Text style={styles.origin} numberOfLines={1}>{desktopLiveFor(agent, item.sessionKey) ? '桌面授权中' : origin}</Text> : null}
          </View>
          <Text style={[styles.time, awaiting && styles.awaiting, running && styles.running, failed && styles.failed]}>{awaiting ? '待回复' : running ? '运行中' : failed ? '失败' : relTime(item.updatedAt)}</Text>
        </Pressable>;
      }}
      initialNumToRender={12} maxToRenderPerBatch={12} windowSize={7}
    />
  </View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  screen: { flex: 1 }, content: { paddingHorizontal: 24, paddingBottom: 28, flexGrow: 1 },
  directoryTabs: { flexDirection: 'row', gap: 6, marginTop: -12, marginBottom: 16 }, directoryTab: { minHeight: 36, paddingHorizontal: 16, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  directoryTabOn: { backgroundColor: d.accentSoft }, directoryLabel: { fontSize: 12, color: d.muted }, directoryLabelOn: { color: d.accentText },
  api: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: -12 }, apiLabel: { flex: 1, color: d.muted, fontSize: 12 },
  newAction: { marginTop: 12, marginBottom: 14 }, search: { height: 42, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, borderRadius: 16, backgroundColor: d.surface2 },
  searchInput: { flex: 1, minWidth: 0, color: d.text, fontSize: 13, paddingVertical: 0 },
  status: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, smallRetry: { minHeight: 40, justifyContent: 'center' },
  project: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 22, paddingBottom: 8 }, projectBody: { flex: 1, minWidth: 0, gap: 3 },
  projectName: { color: d.text, fontSize: 12.5, fontWeight: '500' }, projectPath: { color: d.faint, fontSize: 10.5, lineHeight: 15 },
  thread: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderRadius: 12 }, threadBody: { flex: 1, minWidth: 0, gap: 4 },
  threadTitle: { color: d.text, fontSize: 13.5, lineHeight: 19 }, origin: { color: d.muted, fontSize: 10.5, lineHeight: 15 }, time: { color: d.muted, fontSize: 10.5 },
  awaiting: { color: d.warn }, running: { color: d.accentText }, failed: { color: d.bad }, pressed: { backgroundColor: d.surface2 },
  more: { minHeight: 40, paddingLeft: 44, justifyContent: 'center' }, link: { color: d.accentText, fontSize: 11.5 },
  empty: { flex: 1, minHeight: 160, paddingTop: 38, alignItems: 'center', gap: 14 }, retry: { minWidth: 150, marginTop: 4 },
  pagination: { paddingTop: 18, gap: 10 },
}));
