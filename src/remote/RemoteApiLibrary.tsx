import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Icon } from '../components/Icon';
import { IconButton } from '../components/ui';
import { themed, useDesk } from '../theme';
import { remoteDeviceConnected } from './connection-state';
import { getRemoteState, loadAgentProfiles, remoteDeliveryScope, useRemote, type DeviceAgents } from './store';
import type { AgentProfile, RemoteApiOption } from './client';
import { isSimulatedRemoteDevice, SIMULATED_REMOTE_AGENTS, simulatedAgentsWithApi } from './development-fixture';
import { ProgrammingSheet, useProgrammingStyles } from './ProgrammingUi';
import { ApiChoiceMenu, ApiPicker } from './ApiPicker';
import { AgentApiCard } from './AgentApiCard';
import { ApiSourceIcon } from './ApiSourceIcon';
import { ComposerPopover } from './ComposerPopover';
import { RemoteConnectionSyncNotice } from './RemoteConnectionSyncNotice';

type ApiCheck = { agentId: string; state: 'checking' | 'verified' | 'pending'; expectedAccountId?: string };

function confirmsApi(computer: DeviceAgents | undefined, check: ApiCheck) {
  const fresh = computer?.list.find(agent => agent.id === check.agentId);
  if (!computer?.loaded || computer.error || !fresh?.api.configured || fresh.api.pending) return false;
  return check.expectedAccountId === undefined || (check.expectedAccountId
    ? fresh.api.source === 'phone' && fresh.api.accountId === check.expectedAccountId
    : fresh.api.source !== 'phone');
}

/** The programming API directory is the computer's vault metadata, never a phone key store. */
export function RemoteApiLibrary({ visible, onClose, deviceId, computerName, simulatedAgents, onSimulatedApiChange }: {
  visible: boolean; onClose: () => void; deviceId?: string | null; computerName?: string;
  simulatedAgents?: AgentProfile[]; onSimulatedApiChange?: (agentId: string, accountId: string) => void;
}) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const remote = useRemote();
  const { width, fontScale = 1 } = useWindowDimensions();
  const [gridWidth, setGridWidth] = useState(0);
  const availableWidth = gridWidth || Math.max(0, Math.min(width, 560) - 36);
  const textScale = Math.max(1, fontScale);
  // Fit the longest card: two name lines, API field, status, icon and spacing.
  const apiFieldHeight = Math.max(26, 16 * textScale + 8);
  const minimumCardSize = Math.ceil(60 + 50 * textScale + apiFieldHeight);
  const preferredColumns = availableWidth >= 480 ? 3 : 2;
  const columns = Math.max(1, Math.min(preferredColumns, Math.floor((availableWidth + 10) / (minimumCardSize + 10))));
  const cardSize = (availableWidth - (columns - 1) * 10) / columns;
  // The web preview has a deliberately local computer fixture. Keep it in the
  // same shape as a real catalogue so this management page is useful before a
  // Bridge is connected, while never writing it into the remote store.
  const simulated = isSimulatedRemoteDevice(deviceId);
  const [demoAssignments, setDemoAssignments] = useState<Record<string, string>>({});
  const simulatedComputer = useMemo<DeviceAgents | undefined>(() => {
    if (!simulated) return undefined;
    const apis: RemoteApiOption[] = [];
    for (const agent of SIMULATED_REMOTE_AGENTS) {
      const id = `preview-${agent.id}`;
      if (!apis.some((item) => item.id === id)) apis.push({ id, name: agent.api.name, models: agent.api.model ? [agent.api.model] : [] });
    }
    const list = simulatedAgents ?? simulatedAgentsWithApi(demoAssignments);
    return { list, apis, loaded: true, loading: false };
  }, [simulated, demoAssignments, simulatedAgents]);
  const computer = simulated ? simulatedComputer : deviceId ? remote.agents[deviceId] : undefined;
  const device = remote.devices.find((item) => item.deviceId === deviceId);
  const online = simulated ? true : remoteDeviceConnected(remote, device);
  const scope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId, remoteDeliveryScope?.()]);
  const apiScope = JSON.stringify([deviceId, scope]);
  const offlineText = remote.connection === 'open' && !remote.connectionError ? '电脑当前离线' : '当前未连接';
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedApi, setExpandedApi] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const apiAnchor = useRef<View>(null);
  const [apiAnchorRevision, setApiAnchorRevision] = useState(0);
  const updateApiAnchor = useCallback(() => setApiAnchorRevision(value => value + 1), []);
  const switchRequest = useRef<string | null>(null);
  const pendingFailureCheck = useRef<{ requestId: string; generation: object; deviceId: string; scope: string; agentId: string; expectedAccountId: string } | null>(null);
  const [switchingAgent, setSwitchingAgent] = useState<string | null>(null);
  // Keep unresolved attempts per computer and Agent when a sheet is closed or a
  // different computer is selected. Opening another row must not erase them.
  const [checks, setChecks] = useState<Record<string, ApiCheck>>({});
  const checkKey = (agentId: string) => JSON.stringify([apiScope, agentId]);
  const setCheck = (check: ApiCheck) => setChecks(previous => ({ ...previous, [checkKey(check.agentId)]: check }));
  useEffect(() => {
    const verified = Object.entries(checks).filter(([, check]) => check.state === 'verified');
    if (!verified.length) return;
    const timer = setTimeout(() => setChecks(previous => {
      const next = { ...previous };
      for (const [key, check] of verified) if (next[key] === check) delete next[key];
      return next;
    }), 3000);
    return () => clearTimeout(timer);
  }, [checks]);
  const revision = useRef(0);
  const request = useRef<object | null>(null);
  const checkRequest = useRef<object | null>(null);
  const generation = useRef({ visible, deviceId, scope });
  if (generation.current.visible !== visible || generation.current.deviceId !== deviceId || generation.current.scope !== scope) generation.current = { visible, deviceId, scope };
  const rendered = generation.current;
  const current = useRef({ visible, deviceId, scope, online, loading: computer?.loading }); current.current = { visible, deviceId, scope, online, loading: computer?.loading };
  useEffect(() => () => { current.current.visible = false; generation.current = { ...generation.current, visible: false }; }, []);

  const refresh = async () => {
    if (generation.current !== rendered || !current.current.visible || !deviceId || current.current.deviceId !== deviceId || current.current.scope !== scope || !current.current.online || current.current.loading || request.current || checkRequest.current || switchRequest.current) return;
    const owned = revision.current;
    const token = {};
    request.current = token;
    setReading(true); setError(null);
    const stillHere = () => generation.current === rendered && current.current.visible && current.current.deviceId === deviceId && current.current.scope === scope && revision.current === owned;
    try {
      if (!simulated) await loadAgentProfiles(deviceId);
      if (stillHere()) {
        const fresh = simulated ? simulatedComputer : getRemoteState().agents[deviceId];
        setChecks(previous => Object.fromEntries(Object.entries(previous).map(([key, check]) =>
          key === checkKey(check.agentId) ? [key, { ...check, state: confirmsApi(fresh, check) ? 'verified' : 'pending' }] : [key, check])));
      }
    } catch {
      if (stillHere()) setError('暂时无法读取，请重试');
    } finally {
      if (request.current === token) request.current = null;
      if (stillHere()) setReading(false);
    }
  };

  useEffect(() => {
    revision.current += 1;
    request.current = null; setReading(false); setError(null);
    checkRequest.current = null;
    pendingFailureCheck.current = null;
    setChecks(previous => Object.fromEntries(Object.entries(previous)
      .filter(([, check]) => check.state !== 'verified')
      .map(([key, check]) => [key, check.state === 'checking' ? { ...check, state: 'pending' } : check])));
    setSelectedAgentId(null); setExpandedApi(null);
    // One demand read per open/switch. Cached catalogues need no repeated request.
    if (visible && online && !computer?.loaded && !computer?.loading && !computer?.error) void refresh();
    return () => { revision.current += 1; request.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, deviceId, scope]);

  // Opening offline must recover once when this computer reconnects.
  const previousOnline = useRef(online);
  useEffect(() => {
    const reconnected = !previousOnline.current && online;
    previousOnline.current = online;
    if (reconnected && visible && !computer?.loaded && !computer?.loading) void refresh();
  }, [visible, online, deviceId, scope]);

  const loading = reading || computer?.loading === true;
  const failed = Boolean(error || computer?.error);
  const emptyText = !deviceId ? '绑定电脑后查看 API'
    : loading ? '正在读取…'
    : failed ? error ?? '暂时无法读取，请重试'
    : !online ? '连接电脑后查看 API'
    : computer?.loaded ? '在电脑端添加 API'
    : '刷新读取 API';

  const close = () => { current.current.visible = false; generation.current = { ...generation.current, visible: false }; onClose(); };
  const deviceName = computerName ?? device?.name ?? (simulated ? 'Salcara 开发电脑' : undefined);
  const activeAgents = (computer?.list ?? []).filter((agent) => agent.api.source !== 'tool' && agent.api.name);
  const apiCount = computer?.apis.length ?? 0;
  const selectedAgent = computer?.list.find(agent => agent.id === selectedAgentId);
  // RN Web's layout observer can miss position-only moves when a status
  // appears. Include the card state as well as native layout events.
  const pickerAnchorRevision = JSON.stringify([apiAnchorRevision, cardSize, fontScale, selectedAgentId,
    selectedAgent?.name, selectedAgent?.api.pending, Boolean(computer?.error), switchingAgent,
    selectedAgent ? checks[checkKey(selectedAgent.id)]?.state : null]);
  const sharedWith = selectedAgent?.apiFamily ? (computer?.list ?? []).filter(agent => agent.id !== selectedAgent.id && agent.apiFamily === selectedAgent.apiFamily).map(agent => agent.name) : [];
  const pickerBlocked = !online ? '电脑离线，请连接后再切换'
    : loading ? '正在读取配置，请稍候' : failed ? '请先刷新电脑配置'
    : selectedAgent?.api.pending ? 'API 正在切换，请稍候'
    : selectedAgent && !selectedAgent.available ? '请先在电脑端启用此 Agent' : undefined;
  const verifyAgent = async (agentId: string, expectedAccountId?: string) => {
    if (!deviceId || simulated || !current.current.online || current.current.loading || !current.current.visible || generation.current !== rendered || checkRequest.current || request.current) return;
    const token = {};
    checkRequest.current = token;
    setCheck({ agentId, state: 'checking', expectedAccountId });
    try {
      await loadAgentProfiles(deviceId);
      if (checkRequest.current !== token || generation.current !== rendered || !current.current.visible) return;
      const matches = confirmsApi(getRemoteState().agents[deviceId], { agentId, expectedAccountId, state: 'checking' });
      setCheck({ agentId, state: matches ? 'verified' : 'pending', expectedAccountId });
    } catch {
      if (checkRequest.current === token && generation.current === rendered && current.current.visible) {
        setCheck({ agentId, state: 'pending', expectedAccountId });
      }
    } finally {
      if (checkRequest.current === token) checkRequest.current = null;
    }
  };
  const switchDemoApi = (agentId: string, accountId: string) => {
    if (onSimulatedApiChange) onSimulatedApiChange(agentId, accountId);
    else setDemoAssignments(previous => ({ ...previous, [agentId]: accountId }));
    setCheck({ agentId, state: 'verified' });
    setSelectedAgentId(null);
  };
  return <><ProgrammingSheet visible={visible} title="Agent 配置" onClose={close} maxContentWidth={560}
    headerRight={deviceId ? <IconButton icon="regenerate" label="刷新 API" size={44}
      disabled={!online || loading || Boolean(checkRequest.current || switchRequest.current)} onPress={() => void refresh()} /> : undefined}>
    {deviceId && deviceName ? <View style={styles.computerLine}>
      <View style={styles.computerIcon}><Icon name="laptop" size={18} color={dk.text2} strokeWidth={1.6} /></View>
      <Text style={styles.computerName} numberOfLines={1}>{deviceName}</Text>
      <View style={styles.connectionStatus}><View style={[styles.statusDot, { backgroundColor: online ? dk.ok : dk.faint }]} />
        <Text style={styles.connectionText}>{online ? '已连接' : offlineText}</Text></View>
    </View> : null}
    {!simulated ? <RemoteConnectionSyncNotice remote={remote} deviceId={deviceId} /> : null}
    {computer?.list.length ? <View style={styles.agentSection}>
      <View style={styles.listHeading}><Text style={styles.listTitle}>Agent</Text><Text style={styles.listCount}>{computer.list.length}</Text></View>
      <View style={styles.cardGrid} onLayout={event => { const next = event.nativeEvent.layout.width; if (next > 0 && Math.abs(next - gridWidth) > 0.5) setGridWidth(next); }}>{computer.list.map(agent => {
        const check = checks[checkKey(agent.id)];
        const switching = switchingAgent === checkKey(agent.id);
        const syncing = loading || check?.state === 'checking';
        const status = switching ? '切换中…' : syncing ? '正在同步…'
          : check?.state === 'pending' || computer.error ? '结果未确认' : agent.api.pending ? '切换中…'
          : check?.state === 'verified' && confirmsApi(computer, check) ? '已生效'
          : !agent.available ? '电脑端未启用' : !agent.api.configured ? '未配置' : '';
        const disabled = !online || loading || Boolean(checkRequest.current || switchRequest.current) || !agent.available || !computer.loaded || Boolean(computer.error || agent.api.pending);
        const shared = agent.apiFamily ? computer.list.filter(item => item.id !== agent.id && item.apiFamily === agent.apiFamily).map(item => item.name) : [];
        return <AgentApiCard key={agent.id} agent={agent} size={cardSize}
          status={status} shared={shared} unconfirmed={status === '结果未确认'} disabled={disabled} syncing={syncing}
          switching={switching} expanded={selectedAgentId === agent.id} anchorRef={selectedAgentId === agent.id ? apiAnchor : undefined}
          onAnchorLayout={selectedAgentId === agent.id ? updateApiAnchor : undefined}
          onChoose={() => { if (generation.current === rendered && current.current.visible && current.current.online && !current.current.loading && !switchRequest.current) setSelectedAgentId(agent.id); }} />;
      })}</View>
    </View> : null}
    {deviceId ? <View style={styles.catalogueHeading}><Text style={styles.listTitle}>已保存的 API</Text>
      {loading ? <ActivityIndicator size="small" color={dk.muted} /> : <Text style={styles.listCount}>{apiCount}</Text>}
    </View> : null}
    {computer?.apis.length ? <View style={styles.apiList}>{computer.apis.map(api => {
      const users = activeAgents.filter(agent => agent.api.accountId === api.id).map(agent => agent.name);
      const rowKey = JSON.stringify([apiScope, api.id]);
      return <ApiRow key={rowKey} api={api} users={users} expanded={visible && expandedApi === rowKey}
        onPress={() => setExpandedApi(current => current === rowKey ? null : rowKey)}
        onClose={() => setExpandedApi(current => current === rowKey ? null : current)} />;
    })}</View> : <View style={styles.empty}>
      {loading ? <ActivityIndicator size="small" color={dk.muted} /> : null}
      <Text accessibilityRole={failed ? 'alert' : undefined} style={styles.emptyText}>{emptyText}</Text>
    </View>}
    {computer?.apis.length && failed ? <Text accessibilityRole="alert" style={p.error}>{error ?? '暂时无法读取，请重试'}</Text> : null}
    {deviceId ? <Text style={styles.helpText}>新增 API 或安装 Agent，可在电脑端操作，或连接电脑直连后打开「管理电脑」。密钥保存在电脑端，修改后刷新即可。</Text> : null}
  </ProgrammingSheet>
  {selectedAgent && deviceId && !simulated ? <ApiPicker visible={visible} deviceId={deviceId} agent={selectedAgent} apis={computer?.apis ?? []}
    anchorRef={apiAnchor} anchorRevision={pickerAnchorRevision} sharedWith={sharedWith} blocked={pickerBlocked} onClose={() => setSelectedAgentId(null)}
    onSubmitted={selectedAccountId => setCheck({ agentId: selectedAgent.id, state: 'pending', expectedAccountId: selectedAccountId })}
    onBusyChange={(busy, requestId) => {
      if (busy) { switchRequest.current = requestId; setSwitchingAgent(checkKey(selectedAgent.id)); }
      else if (switchRequest.current === requestId) {
        switchRequest.current = null; setSwitchingAgent(null);
        const pending = pendingFailureCheck.current;
        if (pending?.requestId === requestId) {
          pendingFailureCheck.current = null;
          // A failed write receives one read only after its mutation lock ends.
          // Leaving or changing computers must never dispatch that old read.
          if (generation.current === pending.generation && current.current.visible && current.current.deviceId === pending.deviceId && current.current.scope === pending.scope) {
            void verifyAgent(pending.agentId, pending.expectedAccountId);
          }
        }
      }
    }}
    onChanged={(_profile, selectedAccountId) => { setSelectedAgentId(null); void verifyAgent(selectedAgent.id, selectedAccountId); }}
    onFailed={selectedAccountId => {
      if (generation.current !== rendered || !current.current.visible || current.current.deviceId !== deviceId || current.current.scope !== scope) return;
      setCheck({ agentId: selectedAgent.id, state: 'pending', expectedAccountId: selectedAccountId });
      if (switchRequest.current) pendingFailureCheck.current = { requestId: switchRequest.current, generation: rendered, deviceId, scope,
        agentId: selectedAgent.id, expectedAccountId: selectedAccountId };
      setSelectedAgentId(null);
    }} /> : null}
  {selectedAgent && simulated ? <ApiChoiceMenu visible={visible} anchorRef={apiAnchor} anchorRevision={pickerAnchorRevision} apis={computer?.apis ?? []} sharedWith={sharedWith}
    defaultApiName={selectedAgent.api.source !== 'phone' ? selectedAgent.api.name : undefined}
    current={selectedAgent.api.source === 'phone' ? selectedAgent.api.accountId ?? '' : ''}
    onClose={() => setSelectedAgentId(null)} onSelect={id => {
      const currentId = selectedAgent.api.source === 'phone' ? selectedAgent.api.accountId ?? '' : '';
      if (id === currentId) setSelectedAgentId(null); else switchDemoApi(selectedAgent.id, id);
    }} /> : null}
  </>;
}

/** A compact resource row. API secrets and model identifiers never render here. */
function ApiRow({ api, users, expanded, onPress, onClose }: { api: RemoteApiOption; users: string[]; expanded: boolean; onPress: () => void; onClose: () => void }) {
  const dk = useDesk();
  const styles = useStyles();
  const anchor = useRef<View>(null);
  const modelCount = api.models.length ? `${api.models.length} 个模型` : '暂无模型信息';
  const userSummary = users.length ? `${users.join('、')} 使用` : '尚未分配 Agent';
  return <><View ref={anchor} testID={`saved-api-card-${api.id}`} style={[styles.apiRow, expanded && { borderColor: dk.faint }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${api.name}，${userSummary}，${expanded ? '收起详情' : '查看详情'}`}
      accessibilityState={{ expanded }} onPress={onPress} style={({ pressed }) => [styles.apiRowButton, pressed && styles.apiRowPressed]}>
      <View style={styles.apiIcon}><ApiSourceIcon sourceType={api.sourceType} size={18} color={dk.text2} /></View>
      <View style={styles.apiBody}>
        <Text style={styles.apiName} numberOfLines={2}>{api.name}</Text>
        <Text style={styles.apiDescription} numberOfLines={1}>{modelCount}</Text>
      </View>
      <Icon name="chevronDown" size={12} color={dk.faint} strokeWidth={1.6} />
    </Pressable>
  </View><ComposerPopover visible={expanded} anchorRef={anchor} onClose={onClose} width={248} placement="bottom" align="end" testID="api-detail-menu" accessibilityLabel="API 详情">
    <View style={styles.apiDetail}>
      <Text style={styles.detailTitle}>{api.name}</Text>
      <View style={styles.detailRow}><Text style={styles.detailLabel}>模型</Text><Text style={styles.detailValue}>{modelCount}</Text></View>
      <View style={styles.detailRow}><Text style={styles.detailLabel}>正在使用</Text><Text style={styles.detailValue}>{users.length ? users.join('、') : '暂无 Agent'}</Text></View>
      <View style={styles.detailNote}><Icon name="lock" size={13} color={dk.faint} /><Text style={styles.detailNoteText}>密钥保存在电脑端</Text></View>
    </View>
  </ComposerPopover></>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  computerLine: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 24, minHeight: 36 },
  computerIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface2 },
  computerName: { flex: 1, minWidth: 0, color: d.text2, fontSize: 13, lineHeight: 19 },
  connectionStatus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  connectionText: { color: d.muted, fontSize: 11.5, lineHeight: 16 },
  listHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 0 },
  listTitle: { color: d.muted, fontSize: 12, lineHeight: 18, fontWeight: '500' },
  listCount: { color: d.muted, fontSize: 12, lineHeight: 18 },
  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  apiList: { gap: 8 },
  apiRow: { borderWidth: StyleSheet.hairlineWidth, borderColor: d.line, borderRadius: 14, backgroundColor: d.surface, overflow: 'hidden' },
  apiRowButton: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 12, paddingVertical: 10 },
  apiIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: d.surface2, alignItems: 'center', justifyContent: 'center' },
  apiBody: { flex: 1, minWidth: 0, gap: 3 },
  apiRowPressed: { backgroundColor: d.press },
  apiName: { color: d.text, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  apiDescription: { color: d.muted, fontSize: 11, lineHeight: 16 },
  apiDetail: { gap: 11, padding: 14 },
  detailTitle: { color: d.text, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18 },
  detailLabel: { color: d.muted, fontSize: 11.5, lineHeight: 17 },
  detailValue: { flex: 1, color: d.text2, fontSize: 11.5, lineHeight: 17, textAlign: 'right' },
  detailNote: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingTop: 3 },
  detailNoteText: { color: d.faint, fontSize: 11, lineHeight: 16 },
  empty: { minHeight: 80, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 18 },
  emptyText: { fontSize: 12.5, color: d.muted },
  helpText: { color: d.muted, fontSize: 11.5, lineHeight: 18, marginTop: 18 },
  catalogueHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, marginBottom: 8 },
  agentSection: { gap: 10 },
}));
