import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Icon } from '../components/Icon';
import { AppDialog, showToast } from '../components/ui';
import { themed, useDesk } from '../theme';
import { remoteConnectionState, remoteDeviceConnected, savedConnectionHealthLabel } from './connection-state';
import { connectionDisplayName, computerGroupKey, pairedComputerCount, type RemoteConnection } from './connections';
import { getRemoteState, useSavedConnection, probeSavedConnections, renameRemoteConnection, revokeRemoteConnectionById, type RemoteState, type SavedConnectionHealth } from './store';
import { listDirectPairings, getDirectConnectionState, reconnectDirect, forgetDirectPairing, type DirectConnectionState, type DirectPairingInfo } from './direct-pairing';
import { connectionKind, connectionModeLabel, connectionModeIcon, connectionSelection, type ComputerSelection } from './computer-connections';
import { ProgrammingAction, ProgrammingCard, ProgrammingHeading, ProgrammingPanel, ProgrammingRow, useProgrammingStyles } from './ProgrammingUi';
import { SIMULATED_REMOTE_COMPUTER_ENABLED, SIMULATED_REMOTE_DEVICE_ID, SIMULATED_REMOTE_DEVICE_NAME } from './development-fixture';
import { RemoteConnectionSyncNotice } from './RemoteConnectionSyncNotice';

const DEVICE_ONLINE = '#12A86B';
const DEVICE_OFFLINE = '#B45353';
const stationHost = (url: string) => { try { return new URL(url).host; } catch { return '已保存连接'; } };
const samePairing = (current: RemoteConnection, previous: RemoteConnection) => current.id === previous.id
  && current.hubUrl === previous.hubUrl && current.deviceId === previous.deviceId && current.botGroupId === previous.botGroupId
  && current.computerId === previous.computerId && current.pairedAt === previous.pairedAt;
const sameDirectPairing = (current: DirectPairingInfo, previous: DirectPairingInfo) => current.deviceId === previous.deviceId
  && current.pairingScope === previous.pairingScope && current.pairedAt === previous.pairedAt && current.endpoint === previous.endpoint;

/** Saved pairings remain manageable while a computer is offline or its connection was interrupted. */
export function RemoteComputers({ visible = true, remote, selectedDeviceId, directConnection, directSelected = false, selectedDirectDeviceId, isNavigationCurrent, onDirectRemoved, onSelected, onBind, demoComputer = false, demoComputerName = SIMULATED_REMOTE_DEVICE_NAME, onDemoRename, onDemoForget }: { visible?: boolean; remote: RemoteState; selectedDeviceId?: string | null; directConnection?: DirectConnectionState; directSelected?: boolean; selectedDirectDeviceId?: string; isNavigationCurrent?: () => boolean; onDirectRemoved?: (deviceId:string,pairingScope?:string)=>void; onSelected: (selection: ComputerSelection) => void; onBind: () => void; demoComputer?: boolean; demoComputerName?: string; onDemoRename?: (name: string) => void; onDemoForget?: () => void }) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const { width } = useWindowDimensions();
  const [gridWidth, setGridWidth] = useState(Math.max(0, width - 48));
  const columns = gridWidth >= 640 ? 4 : gridWidth >= 480 ? 3 : gridWidth >= 320 ? 2 : 1;
  const cardWidth = Math.max(0, (gridWidth - (columns - 1) * 12) / columns);
  const [busy, setBusy] = useState<string | null>(null);
  const [manage, setManage] = useState<RemoteConnection | null>(null);
  const [switching, setSwitching] = useState<RemoteConnection | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<RemoteConnection | null>(null);
  const [health, setHealth] = useState<Record<string, SavedConnectionHealth | 'checking'>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [directPairings, setDirectPairings] = useState<DirectPairingInfo[]>([]);
  const [directError, setDirectError] = useState('');
  const [manageDirect, setManageDirect] = useState<DirectPairingInfo | null>(null);
  const [revokeDirect, setRevokeDirect] = useState<DirectPairingInfo | null>(null);
  const alive = useRef(true); const gate = useRef(false);
  const activity = useRef({visible,revision:0});
  if(activity.current.visible!==visible)activity.current={visible,revision:activity.current.revision+1};
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const computerGroups = useMemo(() => {
    const groups = new Map<string, RemoteConnection[]>();
    for (const profile of remote.connections) {
      const key = computerGroupKey(profile);
      groups.set(key, [...(groups.get(key) ?? []), profile]);
    }
    return [...groups].map(([key, connections]) => ({ key, connections }));
  }, [remote.connections]);
  const computers = pairedComputerCount(remote.connections);
  const showDemoComputer = SIMULATED_REMOTE_COMPUTER_ENABLED && demoComputer;
  const demoActive = !directSelected && showDemoComputer && selectedDeviceId === SIMULATED_REMOTE_DEVICE_ID;
  const visibleComputers = computers + directPairings.length + (showDemoComputer ? 1 : 0);
  const computerCards = computerGroups.map(group => ({ ...group, profile: group.connections.find(value => value.id === remote.connectionId)
    ?? group.connections.find(value => health[value.id] === 'online')
    ?? group.connections.find(value => health[value.id] === 'offline') ?? group.connections[0] }));
  const nameCounts = new Map<string, number>();
  for (const name of [...computerCards.map(card => connectionDisplayName(card.profile)), ...directPairings.map(pairing => pairing.deviceName || '直连电脑')]) {
    const key = name.trim().toLocaleLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const hasSameName = (name: string) => (nameCounts.get(name.trim().toLocaleLowerCase()) ?? 0) > 1;
  const managedConnections = manage ? remote.connections.filter(item => computerGroupKey(item) === computerGroupKey(manage)) : [];
  const switchConnections = switching ? remote.connections.filter(item => computerGroupKey(item) === computerGroupKey(switching)) : [];
  const revokedBotDevices = confirmRevoke?.botGroupId ? remote.connections.filter(item => item.hubUrl === confirmRevoke.hubUrl && item.botGroupId === confirmRevoke.botGroupId) : [];
  useEffect(() => {
    if (!visible) return;
    let current = true;
    void listDirectPairings().then(items => { if (current) { setDirectPairings(items); setDirectError(''); } })
      .catch(() => { if (current) setDirectError('直连设备记录未读取，请下拉重试'); });
    return () => { current = false; };
  }, [visible, refreshRevision, directConnection?.deviceId, directConnection?.status]);
  useEffect(() => {
    if (!visible) { setRefreshing(false); return; }
    let active = true;
    setHealth(Object.fromEntries(remote.connections.map(profile => [profile.id, 'checking' as const])));
    void probeSavedConnections().then(result => { if (active) setHealth(result); }).catch(() => {
      if (active) setHealth(Object.fromEntries(remote.connections.map(profile => [profile.id, 'unreachable' as const])));
    }).finally(() => { if (active) setRefreshing(false); });
    return () => { active = false; };
  }, [visible, remote.connections, refreshRevision]);
  const select = async (profile: RemoteConnection) => {
    if (gate.current || !visible) return;
    const owner=activity.current;
    const stillWanted=()=>alive.current&&owner===activity.current&&activity.current.visible;
    const snapshot = getRemoteState();
    if (!snapshot.connections.some(item => samePairing(item, profile))) {
      showToast('这条连接已改变，请重新选择电脑', 'alert'); return;
    }
    const device = snapshot.devices.find(item => item.deviceId === profile.deviceId);
    if (profile.id === snapshot.connectionId && snapshot.phase === 'ready' && !snapshot.signingIn && remoteDeviceConnected(snapshot, device)) { onSelected(connectionSelection(profile)); return; }
    gate.current = true; setBusy(profile.id);
    try {
      await useSavedConnection(profile.id, false, {stillWanted, requireOnline:true});
      const current = getRemoteState();
      if (current.connectionId !== profile.id || current.phase !== 'ready' || current.signingIn
        || current.selectedHubUrl !== profile.hubUrl || current.connection !== 'open' || current.connectionError
        || !remoteDeviceConnected(current, current.devices.find(item=>item.deviceId===profile.deviceId))
        || !current.connections.some(item => samePairing(item, profile))) {
        throw new Error('未切换到这台电脑，请重新选择对应连接');
      }
      if (stillWanted()) onSelected(connectionSelection(profile));
    }
    catch (error) { if (stillWanted()) showToast((error as Error).message, 'alert'); }
    finally { gate.current = false; if (alive.current) setBusy(null); }
  };
  const selectDirect = async (pairing: DirectPairingInfo) => {
    if (gate.current || !visible) return;
    const owner=activity.current;
    const stillWanted=()=>alive.current&&owner===activity.current&&activity.current.visible;
    gate.current = true; setBusy(`direct:${pairing.deviceId}`);
    try {
      const current = getDirectConnectionState();
      if (current.deviceId !== pairing.deviceId || current.status !== 'connected') await reconnectDirect(pairing.deviceId, { stillWanted });
      const connected = getDirectConnectionState();
      if (connected.deviceId !== pairing.deviceId || connected.status !== 'connected') throw new Error('未连接到这台直连电脑，请重新选择');
      if (stillWanted()) onSelected({ kind: 'direct', deviceId: pairing.deviceId });
    } catch (error) { if (stillWanted()) showToast(error instanceof Error ? error.message : '直连失败', 'alert'); }
    finally { gate.current = false; if (alive.current) setBusy(null); }
  };
  const removeDirect = async () => {
    if (!visible || !revokeDirect || managementBusy || gate.current) return;
    const owner = activity.current;
    const stillWanted = () => alive.current && owner === activity.current && activity.current.visible && (isNavigationCurrent?.() ?? true);
    if (!stillWanted()) return;
    if (!directPairings.some(item => sameDirectPairing(item, revokeDirect))) {
      setRevokeDirect(null); setManageDirect(null); showToast('直连绑定已改变，请刷新后重新确认', 'alert'); return;
    }
    const target = { ...revokeDirect };
    gate.current = true; setManagementBusy(true);
    try {
      await forgetDirectPairing(target.deviceId, target);
      if (stillWanted()) { onDirectRemoved?.(target.deviceId, target.pairingScope); setRevokeDirect(null); setManageDirect(null); showToast('直连已解除', 'check'); }
    }
    catch (error) { if (stillWanted()) showToast(error instanceof Error ? error.message : '无法解除直连', 'alert'); }
    finally { gate.current = false; if (alive.current) { setManagementBusy(false); setRefreshRevision(value => value + 1); } }
  };
  const rename = (profile: RemoteConnection) => {
    setManage(null);
    // The platform prompt is intentionally not used; the in-app editor below is accessible and shared by iOS/Android.
    setEditing(profile);
    setName(connectionDisplayName(profile));
  };
  const [editing, setEditing] = useState<RemoteConnection | null>(null);
  const [name, setName] = useState('');
  const [managementBusy, setManagementBusy] = useState(false);
  const [demoManage, setDemoManage] = useState(false);
  const [demoEditing, setDemoEditing] = useState(false);
  const [demoNameDraft, setDemoNameDraft] = useState('');
  const [demoConfirmRevoke, setDemoConfirmRevoke] = useState(false);
  useEffect(() => {
    if (visible) return;
    setManage(null); setSwitching(null); setConfirmRevoke(null); setEditing(null);
    setManageDirect(null); setRevokeDirect(null);
    setDemoManage(false); setDemoEditing(false); setDemoConfirmRevoke(false);
  }, [visible]);
  const pairingIsCurrent = (profile: RemoteConnection) => {
    if (getRemoteState().connections.some(item => samePairing(item, profile))) return true;
    showToast('这条连接已改变，请重新选择电脑', 'alert');
    return false;
  };
  const saveName = async () => {
    if (!visible || !editing || managementBusy || gate.current) return;
    if (!pairingIsCurrent(editing)) { setEditing(null); return; }
    const owner = activity.current;
    const stillWanted = () => alive.current && owner === activity.current && activity.current.visible;
    gate.current = true; setManagementBusy(true);
    try { await renameRemoteConnection(editing.id, name); if (stillWanted()) { setEditing(null); showToast('备注名已保存', 'check'); } }
    catch (error) { if (stillWanted()) showToast((error as Error).message, 'alert'); }
    finally { gate.current = false; if (alive.current) setManagementBusy(false); }
  };
  const revoke = async () => {
    if (!visible || !confirmRevoke || managementBusy || gate.current) return;
    if (!pairingIsCurrent(confirmRevoke)) { setConfirmRevoke(null); return; }
    const owner = activity.current;
    const stillWanted = () => alive.current && owner === activity.current && activity.current.visible;
    gate.current = true; setManagementBusy(true);
    try { await revokeRemoteConnectionById(confirmRevoke.id); if (stillWanted()) { setConfirmRevoke(null); setManage(null); showToast('连接已解除', 'check'); } }
    catch (error) { if (stillWanted()) showToast((error as Error).message, 'alert'); }
    finally { gate.current = false; if (alive.current) setManagementBusy(false); }
  };
  const checkAgain = () => { if (visible) { setRefreshing(true); setRefreshRevision(value => value + 1); } };
  const saveDemoName = () => {
    const next = demoNameDraft.trim().replace(/\s+/g, ' ');
    if (!next) { showToast('请输入设备名称', 'alert'); return; }
    if (Array.from(next).length > 48) { showToast('设备名称最多 48 个字符', 'alert'); return; }
    onDemoRename?.(next);
    setDemoEditing(false);
    showToast('设备名称已更新', 'check');
  };
  return <>
    <ScrollView contentContainerStyle={[p.page, styles.managementPage]} showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={checkAgain} tintColor={dk.muted} />}>
      <View style={styles.managementHeader}>
        <View style={styles.managementHeading}><ProgrammingHeading title="设备管理" subtitle={visibleComputers ? '按电脑选择连接方式' : '绑定电脑后，可以在这里管理设备'} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel="绑定新电脑" accessibilityHint="扫描电脑二维码" disabled={Boolean(busy) || Boolean(remote.signingIn)} onPress={onBind} style={({ pressed }) => [styles.scanAction, pressed && styles.deviceCardPressed]}>
          <Icon name="scan" size={20} color={dk.text2} />
          <Text style={styles.hiddenLegacy}>绑定新电脑</Text>
        </Pressable>
      </View>
      {!directSelected ? <RemoteConnectionSyncNotice remote={remote} deviceId={selectedDeviceId} /> : null}
      {directError ? <Text accessibilityRole="alert" style={p.error}>{directError}</Text> : null}
      <View style={styles.deviceGrid} onLayout={event => setGridWidth(event.nativeEvent.layout.width)}>
      {showDemoComputer ? <View style={[styles.deviceCard, { width: cardWidth }, demoActive && styles.deviceCardCurrent]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`选择电脑 ${demoComputerName}`} onPress={() => onSelected({kind:'demo',deviceId:SIMULATED_REMOTE_DEVICE_ID})} disabled={Boolean(busy) || demoManage || demoEditing} style={({ pressed }) => [styles.cardMain, pressed && styles.deviceCardPressed]}>
          <View style={styles.deviceCardTop}><View style={[styles.deviceIcon, styles.deviceIconCurrent]}><Icon name="laptop" size={22} color={dk.onInk} /></View><Icon name="chevronRight" size={17} color={dk.faint} /></View>
          <Text style={styles.deviceCardName}>{demoComputerName}</Text>
          <View style={styles.deviceCardStatus}><View style={[styles.statusDot, { backgroundColor: DEVICE_ONLINE }]} /><Text style={styles.deviceCardStatusText}>在线 · Windows</Text></View>
          <Text style={styles.deviceCardDetail}>开发预览 · 不会操作真实电脑</Text>
        </Pressable>
        <View style={styles.deviceCardFooter}><Text style={[styles.currentLabel, !demoActive && styles.availableLabel]}>{demoActive ? '当前 · 演示' : '演示'}</Text><View style={styles.cardFooterActions}><Pressable accessibilityRole="button" accessibilityLabel={`管理设备 ${demoComputerName}`} onPress={() => setDemoManage(true)} style={styles.manageButton}><Text style={styles.manageButtonText}>管理</Text></Pressable></View></View>
      </View> : null}
      {directPairings.map(pairing => {
        const current = directSelected && (selectedDirectDeviceId ?? directConnection?.deviceId) === pairing.deviceId;
        const connected = directConnection?.deviceId === pairing.deviceId && directConnection.status === 'connected';
        const connecting = busy === `direct:${pairing.deviceId}`;
        const name = pairing.deviceName || '直连电脑';
        const actionName = `${name}${hasSameName(name) ? ` ${pairing.deviceId.slice(-6)}` : ''}`;
        return <View key={`direct:${pairing.deviceId}`} style={[styles.deviceCard, {width:cardWidth}, current && styles.deviceCardCurrent]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`选择直连电脑 ${name} ${pairing.deviceId.slice(-6)}`} disabled={Boolean(busy)} onPress={() => void selectDirect(pairing)} style={({pressed}) => [styles.cardMain, pressed && styles.deviceCardPressed]}>
            <View style={styles.deviceCardTop}><View style={[styles.deviceIcon,current && styles.deviceIconCurrent]}><Icon name="laptop" size={22} color={current?dk.onInk:dk.text2}/></View>{connecting?<ActivityIndicator size="small" color={dk.muted}/>:<Icon name="chevronRight" size={17} color={dk.faint}/>}</View>
            <Text style={styles.deviceCardName}>{name}</Text>
            <View style={styles.modeBadge}><Icon name="link" size={13} color={dk.text2}/><Text style={styles.modeText}>直连</Text></View>
            <View style={styles.deviceCardStatus}><View style={[styles.statusDot,{backgroundColor:connected?DEVICE_ONLINE:dk.faint}]}/><Text style={styles.deviceCardStatusText}>{connecting?'正在连接':connected?'已连接':'未连接'}</Text></View>
            <Text numberOfLines={2} style={styles.deviceCardDetail}>{stationHost(pairing.endpoint)} · {pairing.deviceId.slice(-6)}</Text>
          </Pressable>
          <View style={styles.deviceCardFooter}><Text style={[styles.currentLabel,!current && styles.availableLabel]}>{current?'当前 · 直连':'可切换'}</Text><View style={styles.cardFooterActions}>
            <Pressable accessibilityRole="button" accessibilityLabel={`管理直连 ${actionName}`} disabled={Boolean(busy)} onPress={()=>setManageDirect(pairing)} style={styles.manageButton}><Text style={styles.manageButtonText}>管理</Text></Pressable>
          </View></View>
        </View>;
      })}
      {computerCards.length ? computerCards.map((group) => {
        const item = group.profile;
        const current = item.id === remote.connectionId && !demoActive && !directSelected;
        const changing = group.connections.some(profile=>profile.id===busy);
        const device = current ? remote.devices.find(value => value.deviceId === item.deviceId) : undefined;
        const healthState = health[item.id] ?? 'checking';
        const online = current ? remoteDeviceConnected(remote, device) : healthState === 'online';
        const displayName = connectionDisplayName(item);
        const sameName = hasSameName(displayName);
        const actionName = `${displayName}${sameName ? ` ${item.deviceId.slice(-6)}` : ''}`;
        const host = stationHost(item.hubUrl);
        const mode = connectionKind(item), modes = [...new Set(group.connections.map(connectionKind))];
        const stateLabel = savedConnectionHealthLabel(healthState, mode === 'bot');
        const info = current ? online ? '在线' : remote.connection === 'error' || remote.connectionError ? remoteConnectionState(remote, device).label
          : remote.connection === 'connecting' || remote.connection === 'retrying' ? '正在连接'
            : remote.connection === 'open' && device && !device.online ? '电脑离线' : '未连接' : stateLabel;
        const open = () => { if (group.connections.length > 1) setSwitching(item); else void select(item); };
        return <View key={group.key} style={[styles.deviceCard, { width: cardWidth }, current && styles.deviceCardCurrent]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`选择电脑 ${actionName}`} accessibilityHint={modes.map(connectionModeLabel).join('、')} disabled={Boolean(busy) || Boolean(manage)} onPress={open} style={({ pressed }) => [styles.cardMain, pressed && styles.deviceCardPressed]}>
            <View style={styles.deviceCardTop}><View style={[styles.deviceIcon, current && styles.deviceIconCurrent]}><Icon name="laptop" size={22} color={current ? dk.onInk : dk.text2} /></View>{changing ? <ActivityIndicator size="small" color={dk.muted} /> : <Icon name="chevronRight" size={17} color={dk.faint} />}</View>
            <Text style={styles.deviceCardName}>{displayName}</Text>
            <View style={styles.modes}>{modes.map(kind=><View key={kind} style={styles.modeBadge}><Icon name={connectionModeIcon(kind)} size={13} color={dk.text2}/><Text style={styles.modeText}>{connectionModeLabel(kind)}</Text></View>)}</View>
            <View style={styles.deviceCardStatus}><View style={[styles.statusDot, { backgroundColor: online ? DEVICE_ONLINE : DEVICE_OFFLINE }]} /><Text style={styles.deviceCardStatusText}>{changing?'正在切换':info}</Text></View>
            <Text numberOfLines={2} style={styles.deviceCardDetail}>{host}{sameName ? ` · ${item.deviceId.slice(-6)}` : ''}{group.connections.length > 1 ? ` · ${group.connections.length} 条连接` : ''}</Text>
          </Pressable>
          <View style={styles.deviceCardFooter}><Text style={[styles.currentLabel, !current && styles.availableLabel]}>{current ? `当前 · ${connectionModeLabel(mode)}` : '可切换'}</Text><View style={styles.cardFooterActions}><Pressable accessibilityRole="button" accessibilityLabel={`管理设备 ${actionName}`} disabled={Boolean(busy)} onPress={() => setManage(item)} style={styles.manageButton}><Text style={styles.manageButtonText}>管理</Text></Pressable></View></View>
        </View>;
      }) : null}
      </View>
      {!visibleComputers && !directError ? <ProgrammingCard soft><View style={styles.empty}><View style={p.glyph}><Icon name="laptop" size={20} color={dk.text2} /></View>
        <Text style={p.name}>还没有绑定电脑</Text><Text style={[p.detail, { textAlign: 'center' }]}>在电脑上安装 Salcara 电脑端，然后在这里扫码绑定</Text></View></ProgrammingCard> : null}
      <Text style={p.note}>同名电脑可通过地址和设备尾号区分。</Text>
    </ScrollView>
    <ProgrammingPanel visible={Boolean(switching)} title="切换连接" subtitle={switching ? connectionDisplayName(switching) : undefined} onClose={() => setSwitching(null)}>
      {switchConnections.map((profile,index)=>{
        const active=profile.id===remote.connectionId&&!directSelected&&!demoActive;
        const mode=connectionKind(profile), station=stationHost(profile.hubUrl);
        const status=health[profile.id];
        const detail=savedConnectionHealthLabel(status, mode==='bot');
        return <ProgrammingRow key={profile.id} first={index===0} icon={connectionModeIcon(mode)} title={`${connectionModeLabel(mode)} · ${station}`} detail={active?`当前 · ${detail}`:detail}
          accessibilityLabel={`${active?'当前':'切换到'}${connectionModeLabel(mode)} ${station} ${profile.deviceId}`} trailing={active?'check':'chevron'}
          onPress={()=>{setSwitching(null);void select(profile);}}/>;
      })}
    </ProgrammingPanel>
    <ProgrammingPanel visible={Boolean(manage)} title="管理设备" subtitle={manage ? connectionDisplayName(manage) : undefined} onClose={() => setManage(null)}>
      {manage ? <>
        <>
          <Text style={[p.sectionTitle, { paddingHorizontal: 4, paddingTop: 2 }]}>连接方式</Text>
          {managedConnections.map((profile, index) => {
            const station = stationHost(profile.hubUrl);
            const active = profile.id === remote.connectionId && !directSelected && !demoActive;
            const mode = connectionKind(profile);
            return <ProgrammingRow key={profile.id} first={index === 0} icon={connectionModeIcon(mode)} title={`${connectionModeLabel(mode)} · ${station}`} detail={`${active ? '当前连接' : '已绑定'}${profile.botGroupId ? ` · 组 ${profile.botGroupId}` : ''}`}
              accessibilityLabel={`${active ? '当前' : '切换到'}${connectionModeLabel(mode)} ${station} ${profile.deviceId}`} onPress={() => { setManage(null); void select(profile); }} trailing={active ? 'check' : 'chevron'} />;
          })}
        </>
        <ProgrammingRow icon="edit" title="编辑设备名称" detail={manage.alias ? `电脑原名：${manage.deviceName}` : '修改这台设备在手机上的备注名'} onPress={() => rename(manage)} trailing="chevron" />
        <ProgrammingRow icon="info" title="配对信息" detail={<View style={{ gap: 2 }}>
          <Text style={p.detail} numberOfLines={1}>设备标识 · {manage.deviceId}</Text>
          <Text style={p.detail}>连接方式 · {connectionModeLabel(connectionKind(manage))}</Text>
          <Text style={p.detail} numberOfLines={1}>地址 · {stationHost(manage.hubUrl)}</Text>
          <Text style={p.detail} numberOfLines={1}>绑定于 · {new Date(manage.pairedAt).toLocaleDateString()}</Text>
        </View>} />
        <ProgrammingAction label={manage.botGroupId?'解除 Bot 组':'删除中转站连接'} icon="trash" tone="danger" onPress={() => { setManage(null); setConfirmRevoke(manage); }} style={{ marginTop: 8 }} />
      </> : null}
    </ProgrammingPanel>
    <ProgrammingPanel visible={Boolean(manageDirect)} title="直连设备" subtitle={manageDirect?.deviceName} onClose={()=>setManageDirect(null)}>
      {manageDirect?<>
        <ProgrammingRow first icon="link" title="直连" detail={stationHost(manageDirect.endpoint)} onPress={()=>{const target=manageDirect;setManageDirect(null);void selectDirect(target);}} trailing="chevron"/>
        <ProgrammingRow icon="info" title="配对信息" detail={<View style={{gap:2}}><Text style={p.detail}>设备标识 · {manageDirect.deviceId}</Text><Text style={p.detail}>绑定于 · {new Date(manageDirect.pairedAt).toLocaleDateString()}</Text></View>}/>
        <ProgrammingAction label="解除直连" icon="trash" tone="danger" onPress={()=>{setRevokeDirect(manageDirect);setManageDirect(null);}} style={{marginTop:8}}/>
      </>:null}
    </ProgrammingPanel>
    <ProgrammingPanel visible={demoManage} title="管理设备" subtitle={demoComputerName} onClose={() => setDemoManage(false)}>
      <ProgrammingRow first icon="edit" title="编辑设备名称" detail="修改当前演示设备在手机上的显示名称" onPress={() => { setDemoNameDraft(demoComputerName); setDemoManage(false); setDemoEditing(true); }} trailing="chevron" />
      <ProgrammingRow icon="info" title="设备状态" detail="开发预览 · 不会操作真实电脑" />
      <ProgrammingAction label="删除设备" icon="trash" tone="danger" onPress={() => { setDemoManage(false); setDemoConfirmRevoke(true); }} style={{ marginTop: 8 }} />
    </ProgrammingPanel>
    <ProgrammingPanel visible={demoEditing} title="编辑设备名称" subtitle="只影响当前演示" onClose={() => setDemoEditing(false)} footer={<ProgrammingAction label="保存" onPress={saveDemoName} />}>
      <View style={styles.nameEditor}>
        <TextInput accessibilityLabel="演示设备名称" autoCapitalize="words" autoCorrect={false} maxLength={48} value={demoNameDraft} onChangeText={setDemoNameDraft} placeholder="例如：家里电脑、公司电脑" placeholderTextColor={dk.faint} style={styles.nameInput} />
        <Text style={p.detail}>演示名称会同步显示在编程首页和会话页面。</Text>
      </View>
    </ProgrammingPanel>
    <ProgrammingPanel visible={Boolean(editing)} title="手机备注名" subtitle="只影响这台手机里的显示" onClose={() => { if (!managementBusy) setEditing(null); }} footer={<ProgrammingAction label={managementBusy ? '正在保存…' : '保存'} loading={managementBusy} onPress={() => void saveName()} />}>
      <View style={styles.nameEditor}>
        <Text accessibilityRole="header" style={p.name}>电脑原名：{editing?.deviceName}</Text>
        <TextInput accessibilityLabel="电脑备注名" autoCapitalize="words" autoCorrect={false} maxLength={48} value={name} onChangeText={setName} placeholder="例如：家里电脑、公司电脑" placeholderTextColor={dk.faint} style={styles.nameInput} />
        <Text style={p.detail}>清空并保存会恢复电脑端名称。相同电脑的备用连接共用这个备注名。</Text>
      </View>
    </ProgrammingPanel>
    <AppDialog visible={Boolean(confirmRevoke)} title={confirmRevoke?.botGroupId?'解除这个 Bot 组？':'删除中转站连接？'} icon="trash"
      message={confirmRevoke?.botGroupId ? `此 Bot 组共用手机凭据，将同时解除 ${revokedBotDevices.length} 台电脑的 Bot 连接：${revokedBotDevices.map(connectionDisplayName).join('、')}。这些电脑的中转站和直连记录会保留。`
        : '将删除这台电脑的中转站连接及其备用站点。Bot 和直连记录会保留。'}
      onClose={() => { if (!managementBusy) setConfirmRevoke(null); }}
      actions={[{ label: '取消', tone: 'secondary', disabled: managementBusy, onPress: () => setConfirmRevoke(null) },
        { label: managementBusy ? '正在解除…' : confirmRevoke?.botGroupId?'解除 Bot 组':'删除连接', tone: 'danger', disabled: managementBusy, onPress: () => void revoke() }]} />
    <AppDialog visible={Boolean(revokeDirect)} title="解除这台电脑的直连？" message="将删除手机保存的直连配对。中转站和 Bot 连接会保留。" icon="trash" onClose={()=>{if(!managementBusy)setRevokeDirect(null);}}
      actions={[{label:'取消',tone:'secondary',disabled:managementBusy,onPress:()=>setRevokeDirect(null)},{label:managementBusy?'正在解除…':'解除直连',tone:'danger',disabled:managementBusy,onPress:()=>void removeDirect()}]}/>
    <AppDialog visible={demoConfirmRevoke} title="删除演示设备？" icon="trash"
      message="删除后会回到编程首页，之后可以再次使用模拟绑定。"
      onClose={() => setDemoConfirmRevoke(false)}
      actions={[{ label: '取消', tone: 'secondary', onPress: () => setDemoConfirmRevoke(false) },
        { label: '删除设备', tone: 'danger', onPress: () => { setDemoConfirmRevoke(false); onDemoForget?.(); } }]} />
  </>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  managementPage: { gap: 14 },
  managementHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  managementHeading: { flex: 1, minWidth: 0 },
  scanAction: { width: 42, height: 42, marginTop: 6, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface2 },
  hiddenLegacy: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  glyphCurrent: { backgroundColor: d.ink },
  empty: { paddingVertical: 28, paddingHorizontal: 24, alignItems: 'center', gap: 10 },
  deviceGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' },
  deviceCard: { flexGrow: 0, flexShrink: 0, minHeight: 190, padding: 13, borderRadius: 17, backgroundColor: d.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: d.line, justifyContent: 'space-between', gap: 7 },
  deviceCardCurrent: { borderColor: d.ink, backgroundColor: d.surface2 },
  cardMain: { flex: 1, gap: 7 },
  deviceCardPressed: { backgroundColor: d.press },
  deviceCardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  deviceIcon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: d.surface2 },
  deviceIconCurrent: { backgroundColor: d.ink },
  deviceCardName: { color: d.text, fontSize: 16, lineHeight: 21, fontWeight: '600', marginTop: 2 },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  modeBadge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 6, backgroundColor: d.surface2 },
  modeText: { color: d.text2, fontSize: 11, fontWeight: '500' },
  deviceCardStatus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  deviceCardStatusText: { flex: 1, color: d.muted, fontSize: 11.5, lineHeight: 16 },
  deviceCardDetail: { color: d.muted, fontSize: 11, lineHeight: 16, minHeight: 32 },
  deviceCardFooter: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginTop: 6, paddingTop: 11, borderTopWidth: StyleSheet.hairlineWidth, borderColor: d.line },
  cardFooterActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  manageButton: { minHeight: 30, paddingHorizontal: 10, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface2 },
  manageButtonText: { color: d.text2, fontSize: 12, fontWeight: '600' },
  currentLabel: { color: d.accentText, fontSize: 11.5, fontWeight: '600' },
  availableLabel: { color: d.muted },
  nameEditor: { gap: 10, paddingHorizontal: 4, paddingVertical: 8 },
  nameInput: { minHeight: 46, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: d.lineStrong, backgroundColor: d.surface2, paddingHorizontal: 12, color: d.text, fontSize: 15 },
}));
