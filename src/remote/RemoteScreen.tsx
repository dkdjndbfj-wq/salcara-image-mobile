import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { Icon } from '../components/Icon';
import { SpaceSwitch } from '../companion/SpaceSwitch';
import { Appear, AppDialog, IconButton, Sheet, showToast, ToastHost } from '../components/ui';
import { useApp } from '../state/AppContext';
import { colors, radius, shadow, desk, themed, useDesk } from '../theme';
import type { AgentId, AgentProfile, DeviceStatus, SessionInfo } from './client';
import { ApiPicker } from './ApiPicker';
import { ConnectionIndicator } from './ConnectionIndicator';
import { remoteDeviceConnected } from './connection-state';
import { RemoteHome, sessionAgent } from './RemoteHome';
import { RemoteComputers } from './RemoteComputers';
import { RemoteApiLibrary } from './RemoteApiLibrary';
import { RemoteWorkspace } from './RemoteWorkspace';
import { openDesktopGithub } from './RemoteDownloads';
import { notificationsSupported, setNotificationsEnabled, useNotificationsEnabled } from './notifications';
import { setStandbyEnabled, usePushStatus } from './push';
import { ProgrammingAction, ProgrammingCard, ProgrammingField, ProgrammingHeading, ProgrammingPanel, ProgrammingRow, ProgrammingSheet, ProgrammingStatus, useProgrammingStyles } from './ProgrammingUi';
import { EmptyState, osName, ToolBadge } from './parts';
import type { PairQr } from './pairing';
import {
  AGENT_CHOICES, agentApiLabel, agentApiSourceLabel, fallbackAgentProfiles,
} from './projection';
import {
  connectStation, getRemoteState, hydrateCachedThread, lastAgent, loadAgentProfiles, loadSessions, pairRemote, pairRemoteQr, parseRemoteQr, rememberAgent,
  revokeRemoteConnection, setRemoteFocus, setRemoteScreenOpen, useRemote, type RemoteState,
} from './store';
import { ThreadView, type ContinueSeed } from './ThreadView';

type Route = 'home' | 'devices' | 'setup' | 'pairing' | 'connect' | 'opening' | 'workspace';

/** Homepage first. Pairing is one explicit entry, never an automatic welcome screen. */
export function RemoteScreen({ visible = true }: { visible?: boolean }) {
  const dk = useDesk();
  const styles = useStyles();
  const remote = useRemote();
  const app = useApp();
  const voice = useMemo(() => ({ providers: app.providers, chatProvider: app.chatProvider }), [app.providers, app.chatProvider]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<AgentId>('codex');
  const [route, setRoute] = useState<Route>('home');
  const [threadKey, setThreadKey] = useState<string | null>(null);
  const [newThread, setNewThread] = useState(false);
  const [seed, setSeed] = useState<ContinueSeed | null>(null);
  const [menu, setMenu] = useState(false);
  const [apiLibrary, setApiLibrary] = useState(false);
  const notify = useNotificationsEnabled();
  const push = usePushStatus();
  const [backgroundHelp, setBackgroundHelp] = useState(false);
  const selectionRevision = useRef(0);
  const returnToHome = useRef(false);
  const scope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId]);
  const navigation = useRef({ route, revision: 0, scope, visible });
  navigation.current.route = route; navigation.current.scope = scope; navigation.current.visible = visible;
  const priorScope = useRef(scope);
  const navigate = (next: Route) => {
    navigation.current = { ...navigation.current, route: next, revision: navigation.current.revision + 1 };
    setRoute(next);
  };
  const profile = remote.connections.find((item) => item.id === remote.connectionId);
  const device = remote.devices.find((item) => item.deviceId === deviceId);
  const agents = deviceId ? remote.agents[deviceId] : undefined;
  const agent = (agents?.list.length ? agents.list : fallbackAgentProfiles(device)).find((item) => item.id === agentId) ?? null;
  const connected = route === 'workspace';
  const step = route;
  const revision = navigation.current.revision;
  const stillHere = (expected: Route, capturedRevision: number, capturedScope?: string) => navigation.current.visible
    && navigation.current.route === expected && navigation.current.revision === capturedRevision
    && (capturedScope === undefined || navigation.current.scope === capturedScope);
  const menuGeneration = useRef({ open: visible && menu, scope, revision });
  if (menuGeneration.current.open !== (visible && menu) || menuGeneration.current.scope !== scope || menuGeneration.current.revision !== revision) menuGeneration.current = { open: visible && menu, scope, revision };
  const renderedMenu = menuGeneration.current;
  const closeMenu = () => { menuGeneration.current = { ...menuGeneration.current, open: false }; setMenu(false); };
  const menuAction = (callback: () => void) => () => {
    if (!navigation.current.visible || navigation.current.scope !== scope || navigation.current.revision !== revision || !menuGeneration.current.open || menuGeneration.current !== renderedMenu) return;
    closeMenu(); callback();
  };
  const chooseAgent = (id: AgentId) => { selectionRevision.current += 1; setAgentId(id); };
  // Confirming Agent/API once per computer is enough; later taps go straight to the conversations.
  const confirmed = useRef(new Set<string>());
  const confirmKey = (id: AgentId, target = deviceId) => `${scope}|${target ?? ''}|${id}`;
  const connectFrom = useRef<'home' | 'workspace'>('home');
  const openAgent = (id: AgentId) => {
    chooseAgent(id); setThreadKey(null); setNewThread(false); returnToHome.current = false;
    if (!device) { navigate('devices'); return; }
    const profile = remote.agents[device.deviceId]?.list.find((item) => item.id === id);
    if (confirmed.current.has(confirmKey(id, device.deviceId)) && remoteDeviceConnected(remote, device) && profile?.available) { navigate('workspace'); return; }
    connectFrom.current = 'home';
    navigate('connect');
  };
  /** Opens a known conversation at once (cached copy first); Agent/API details are verified in background. */
  const openExisting = async (targetDeviceId: string, sessionKey: string, knownSession?: SessionInfo) => {
    const guess: AgentId = knownSession ? sessionAgent(knownSession) : sessionKey.startsWith('claude-desktop:') ? 'claude-desktop' : sessionKey.startsWith('claude:') ? 'claude' : 'codex';
    chooseAgent(guess); setDeviceId(targetDeviceId); setNewThread(false);
    returnToHome.current = true;
    if (sessionKey) void hydrateCachedThread(targetDeviceId, sessionKey);
    setThreadKey(sessionKey || null); navigate('workspace');
    const ownedRevision = navigation.current.revision; const ownedScope = navigation.current.scope;
    try {
      const initial = getRemoteState();
      if (!remoteDeviceConnected(initial, initial.devices.find(item => item.deviceId === targetDeviceId))) return; // read the cached copy; sending waits for the computer
      if (!initial.agents[targetDeviceId]?.loaded) await loadAgentProfiles(targetDeviceId);
      if (!stillHere('workspace', ownedRevision, ownedScope)) return;
      let snapshot = getRemoteState();
      // A deep link may arrive before the session list. Resolve the actual client before choosing its Agent.
      if (sessionKey && !knownSession && !snapshot.sessions[targetDeviceId]?.list.some(item => item.sessionKey === sessionKey)) {
        await loadSessions(targetDeviceId);
        if (!stillHere('workspace', ownedRevision, ownedScope)) return;
        snapshot = getRemoteState();
      }
      const entry = snapshot.sessions[targetDeviceId], historyIdentity = snapshot.agents[targetDeviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity;
      const session = [...(entry?.list ?? []), ...(entry?.native?.list ?? []), ...Object.values(entry?.readOnly ?? {})
        .filter(directory => directory?.identity === historyIdentity).flatMap(directory => directory?.list ?? [])].find(item => item.sessionKey === sessionKey);
      const id = session ? sessionAgent(session) : guess;
      if (id !== guess) chooseAgent(id);
    } catch (error) {
      if (stillHere('workspace', ownedRevision, ownedScope)) showToast(error instanceof Error ? `${error.message}，可先查看记录` : '暂时连不上电脑，可先查看记录', 'alert');
    }
  };
  const openRecent = (targetDeviceId: string, session: SessionInfo) => { void openExisting(targetDeviceId, session.sessionKey, session); };

  useEffect(() => {
    navigation.current.visible = visible;
    setRemoteScreenOpen(visible);
    return () => { navigation.current.visible = false; navigation.current.revision += 1; setRemoteScreenOpen(false); };
  }, [visible]);
  useEffect(() => {
    let active = true; const selectedAt = selectionRevision.current;
    void lastAgent().then(id => { if (active && selectedAt === selectionRevision.current) setAgentId(id); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (priorScope.current === scope) return;
    priorScope.current = scope;
    setDeviceId(null); setThreadKey(null); setNewThread(false); setMenu(false); setApiLibrary(false); returnToHome.current = false;
    // A deliberate station check/QR flow may change the store scope. It owns its own completion guard.
    if (navigation.current.route === 'connect' || navigation.current.route === 'opening' || navigation.current.route === 'workspace') navigate('home');
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (deviceId || remote.phase !== 'ready') return;
    const preferred = remote.devices.find((item) => item.deviceId === profile?.deviceId) ?? (remote.devices.length === 1 ? remote.devices[0] : undefined);
    if (preferred) setDeviceId(preferred.deviceId);
  }, [deviceId, remote.phase, remote.devices, profile?.deviceId]);
  // An approval toast jumps straight into its thread.
  useEffect(() => {
    if (!visible || !remote.focus) return;
    const target = remote.focus;
    const session = remote.sessions[target.deviceId]?.list.find(item => item.sessionKey === target.sessionKey);
    setMenu(false); setApiLibrary(false); setRemoteFocus(null);
    void openExisting(target.deviceId, target.sessionKey, session);
  }, [visible, remote.focus]);

  const back = () => {
    if (route === 'pairing') { navigate('setup'); return true; }
    if (route === 'setup') { navigate('devices'); return true; }
    if (route === 'workspace') { navigate('home'); return true; }
    if (route === 'connect' && connectFrom.current === 'workspace') { connectFrom.current = 'home'; navigate('workspace'); return true; }
    if (route !== 'home') { navigate('home'); return true; }
    return false;
  };
  useEffect(() => {
    if (!visible) return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (threadKey || newThread) return false; // the thread page closes itself
      if (!back()) app.switchSpace('assistant');
      return true;
    });
    return () => subscription.remove();
  });

  return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
    <View style={styles.topBar}>
      {route !== 'home' ? <IconButton icon="chevronLeft" label="返回" onPress={() => { back(); }} /> : <View style={{ width: 40 }} />}
      <View style={{ flex: 1 }} />
      <View style={styles.headerActions}>
        <ConnectionIndicator remote={remote} device={device} />
        <IconButton icon="more" label="更多" onPress={() => setMenu(true)} />
      </View>
      <View pointerEvents="box-none" style={styles.topCenter}><SpaceSwitch space="remote" onSwitch={app.switchSpace} /></View>
    </View>
    <Appear key={`step:${step}`} distance={18} style={{ flex: 1 }}>
      {step === 'home'
        ? <RemoteHome visible={visible && !apiLibrary && !menu} remote={remote} device={device}
          onComputer={() => navigate('devices')} onApi={() => setApiLibrary(true)} onAgent={openAgent} onProjects={() => openAgent(agentId)} onSession={openRecent} onDownload={() => void openDesktopGithub()} />
        : step === 'devices'
          ? <RemoteComputers remote={remote} onBind={() => navigate('setup')} onSelected={(id) => { if (!stillHere('devices', revision)) return; setDeviceId(id); navigate(getRemoteState().phase === 'pairing' ? 'pairing' : 'home'); }} />
        : step === 'setup'
          ? <Setup remote={remote} stillWanted={() => stillHere('setup', revision, scope)} onConnected={() => { if (stillHere('setup', revision)) navigate(getRemoteState().phase === 'pairing' ? 'pairing' : 'home'); }} />
          : step === 'pairing'
            ? remote.selectedHubUrl
              ? <QrPairing key={remote.selectedHubUrl} visible={visible} remote={remote} onChangeStation={() => { if (stillHere('pairing', revision)) navigate('setup'); }} onPaired={() => { if (stillHere('pairing', revision)) navigate('home'); }} />
              : <LegacyPairing onPaired={() => { if (stillHere('pairing', revision)) navigate('home'); }} />
            : step === 'opening'
              ? <View style={styles.center}><ActivityIndicator color={dk.muted} /></View>
            : step === 'workspace' && deviceId && agent
              ? <RemoteWorkspace visible={visible && !threadKey && !newThread && !apiLibrary && !menu} deviceId={deviceId} agent={agent}
                onOpen={(key) => { if (stillHere('workspace', revision, scope)) setThreadKey(key); }}
                onNew={() => { if (stillHere('workspace', revision, scope)) setNewThread(true); }}
                onSettings={() => { if (stillHere('workspace', revision, scope)) { connectFrom.current = 'workspace'; navigate('connect'); } }} />
              : <ConnectView visible={visible && !menu && !apiLibrary} remote={remote} device={device} agentId={agentId}
                onDevice={setDeviceId} onAgent={chooseAgent}
                onConnected={() => { if (!stillHere('connect', revision, scope)) return; void rememberAgent(agentId); confirmed.current.add(confirmKey(agentId)); connectFrom.current = 'home'; navigate('workspace'); }} />}
    </Appear>
    <ThreadView visible={visible && connected && Boolean(threadKey || newThread)} deviceId={deviceId} sessionKey={threadKey} agent={agent}
      voice={voice}
      verifying={!(deviceId && remote.agents[deviceId]?.loaded && !remote.agents[deviceId]?.error && remote.agents[deviceId]?.list.some((item) => item.id === agentId))}
      seed={newThread ? seed : null}
      onContinue={(next) => {
        const claude = deviceId ? remote.agents[deviceId]?.list.find((item) => item.id === 'claude') : undefined;
        if (!claude?.available) { showToast('电脑上需要先安装 Claude Code，才能在手机上继续这个对话', 'alert'); return; }
        chooseAgent('claude'); setSeed(next); setThreadKey(null); setNewThread(true);
      }}
      onClose={() => { setSeed(null); setThreadKey(null); setNewThread(false); if (returnToHome.current) { returnToHome.current = false; navigate('home'); if (deviceId) void loadSessions(deviceId).catch(() => undefined); } }}
      onCreated={(key) => { setSeed(null); setNewThread(false); setThreadKey(key); }} />
    <ProgrammingPanel visible={visible && menu} placement="menu" onClose={closeMenu}>
      <View style={styles.menuList}>
        {[
          ...(route !== 'home' ? [{ label: '编程首页', icon: 'code' as const, onPress: menuAction(() => { setThreadKey(null); setNewThread(false); navigate('home'); }) }] : []),
          ...(connected ? [{ label: '切换 Agent / API', icon: 'regenerate' as const, onPress: menuAction(() => { connectFrom.current = 'workspace'; navigate('connect'); }) }] : []),
          { label: '连接电脑', icon: 'laptop' as const, onPress: menuAction(() => navigate('devices')) },
          { label: 'API 管理', icon: 'key' as const, onPress: menuAction(() => setApiLibrary(true)) },
          { label: '下载电脑端', icon: 'download' as const, onPress: menuAction(() => { void openDesktopGithub(); }) },
        ].map((item) => <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={item.label} onPress={item.onPress} style={({ pressed }) => [styles.menuItem, pressed && styles.menuPressed]}>
          <Icon name={item.icon} size={17} color={dk.text2} /><Text style={styles.menuText}>{item.label}</Text></Pressable>)}
        {notificationsSupported() ? <>
          <View style={styles.menuDivider} />
          <Pressable accessibilityRole="button" accessibilityLabel={`任务通知：${notify ? '已开启' : '已关闭'}`} onPress={() => void setNotificationsEnabled(!notify)} style={({ pressed }) => [styles.menuItem, pressed && styles.menuPressed]}>
            <Icon name="alarm" size={17} color={dk.text2} /><Text style={styles.menuText}>任务通知</Text>
            <View style={[styles.toggle, notify && styles.toggleOn]}><View style={[styles.knob, notify && styles.knobOn]} /></View>
          </Pressable>
          {notify && push.status === 'fcm' ? <View style={styles.menuNote}><Icon name="checkCircle" size={14} color={dk.ok} />
            <Text style={styles.menuNoteText}>App 关闭后也能收到提醒</Text></View> : null}
          {notify && Platform.OS === 'android' && push.status !== 'fcm' && push.status !== 'unsupported' && push.status !== 'unpaired' ? <Pressable accessibilityRole="switch" accessibilityState={{ checked: push.standby }}
            accessibilityLabel="后台待命" accessibilityHint="App 关闭后也保持连接，任务完成时提醒你" onPress={() => void setStandbyEnabled(!push.standby)} style={({ pressed }) => [styles.menuItem, pressed && styles.menuPressed]}>
            <Icon name="bolt" size={17} color={dk.text2} />
            <View style={{ flex: 1 }}><Text style={[styles.menuText, { flex: 0 }]}>后台待命</Text>
              <Text style={styles.menuNoteText}>{push.status === 'no-google' ? '这台手机收不到推送，开启后保持连接' : '中转站未开启推送，开启后保持连接'}</Text></View>
            <View style={[styles.toggle, push.standby && styles.toggleOn]}><View style={[styles.knob, push.standby && styles.knobOn]} /></View>
          </Pressable> : null}
          {notify && Platform.OS === 'android' ? <Pressable accessibilityRole="button" accessibilityLabel="让提醒更及时" onPress={menuAction(() => setBackgroundHelp(true))} style={({ pressed }) => [styles.menuItem, pressed && styles.menuPressed]}>
            <Icon name="lock" size={17} color={dk.text2} /><Text style={styles.menuText}>让提醒更及时</Text></Pressable> : null}
        </> : null}
        {profile ? <>
          <View style={styles.menuDivider} />
          <Pressable accessibilityRole="button" accessibilityLabel="解除这台手机的配对" style={({ pressed }) => [styles.menuItem, pressed && styles.menuPressed]}
            onPress={menuAction(() => { void revokeRemoteConnection().then(() => showToast('已解除配对', 'check')).catch((error: Error) => showToast(error.message, 'alert')); })}>
            <Icon name="logout" size={17} color={dk.bad} /><Text style={[styles.menuText, { color: dk.bad }]}>解除这台手机的配对</Text></Pressable>
        </> : null}
      </View>
    </ProgrammingPanel>
    <AppDialog visible={visible && backgroundHelp} title="让任务提醒更及时" icon="alarm" onClose={() => setBackgroundHelp(false)}
      message={'部分手机（小米、华为、OPPO、vivo 等）会清理后台应用，任务完成时可能收不到提醒。\n\n建议在系统设置里为 Salcara：\n· 允许自启动 / 后台运行\n· 电池优化设为「不限制」\n· 允许通知'}
      actions={[{ label: '稍后', tone: 'secondary', onPress: () => setBackgroundHelp(false) }, { label: '去设置', tone: 'primary', onPress: () => { setBackgroundHelp(false); void Linking.openSettings(); } }]} />
    <RemoteApiLibrary visible={visible && apiLibrary} deviceId={deviceId} onClose={() => setApiLibrary(false)} />
    <ToastHost />
  </SafeAreaView>;
}

// ——— step 1: station ———

function Setup({ remote, onConnected, stillWanted }: { remote: RemoteState; onConnected: () => void; stillWanted: () => boolean }) {
  const p = useProgrammingStyles();
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setError(null);
    try { await connectStation(url, stillWanted); onConnected(); } catch (reason) { if (stillWanted()) setError((reason as Error).message); }
  };
  return <ScrollView contentContainerStyle={p.page} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
    <ProgrammingHeading title="绑定电脑" subtitle="填写电脑端「手机远程」里显示的中转站地址" step="01 / 02" />
    <ProgrammingCard soft><ProgrammingField first label="中转站地址" value={url} onChangeText={setUrl} keyboardType="url"
      placeholder="https://salcara.top" editable={!remote.signingIn} onSubmitEditing={() => void connect()} /></ProgrammingCard>
    <ProgrammingAction label={remote.signingIn === 'station' ? '正在检查…' : '下一步'} loading={remote.signingIn === 'station'}
      disabled={!url.trim() || Boolean(remote.signingIn)} onPress={() => void connect()} style={{ marginTop: 16 }} />
    {error ? <Text accessibilityRole="alert" style={p.error}>{error}</Text> : null}
    <Text style={p.note}>下一步扫描电脑上的二维码。地址只用于连接，不会上传密钥。</Text>
  </ScrollView>;
}

// ——— step 2: QR pairing ———

export function QrPairing({ visible, remote, onChangeStation, onPaired }: { visible: boolean; remote: RemoteState; onChangeStation: () => void; onPaired?: () => void }) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<PairQr | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanGate = useRef(false);
  const confirmGate = useRef(false);
  const isVisible = useRef(visible); isVisible.current = visible;
  useEffect(() => () => { isVisible.current = false; scanGate.current = true; }, []);
  useEffect(() => { if (!visible) { setScanning(false); setPending(null); scanGate.current = true; } }, [visible]);
  const start = async () => {
    if (!isVisible.current || confirmGate.current) return;
    const allowed = permission?.granted ? permission : await requestPermission();
    if (!isVisible.current) return;
    if (!allowed.granted) { setError('请允许相机权限，用来扫描电脑上的二维码'); return; }
    setError(null); setPending(null); scanGate.current = false; setScanning(true);
  };
  const scan = ({ data, type }: { data: string; type?: string }) => {
    if (type && type !== 'qr') return;
    if (scanGate.current || !visible) return;
    scanGate.current = true; setScanning(false);
    try { setPending(parseRemoteQr(data)); } catch (reason) { setError((reason as Error).message); }
  };
  const confirm = async () => {
    if (!isVisible.current || !pending || confirmGate.current) return;
    confirmGate.current = true;
    setBusy(true); setError(null);
    try { await pairRemoteQr(pending); if (!isVisible.current) return; setPending(null); showToast('电脑配对成功', 'check'); onPaired?.(); }
    catch (reason) { setPending(null); setError((reason as Error).message); }
    finally { confirmGate.current = false; setBusy(false); }
  };
  const host = remote.selectedHubUrl ? new URL(remote.selectedHubUrl).host : '';
  return <>
    <ScrollView contentContainerStyle={p.page}>
      <ProgrammingHeading title="扫码连接" subtitle="打开电脑端「手机远程」，扫描它的二维码" step="02 / 02" />
      <ProgrammingCard soft><View style={styles.scanPreview}>
        <View style={styles.scanFrame}>
          {(['tl', 'tr', 'bl', 'br'] as const).map(corner => <View key={corner} style={[styles.scanCorner, styles[corner]]} />)}
          <Icon name="laptop" size={34} color={dk.text2} strokeWidth={1.3} />
        </View>
        <Text style={p.detail}>只连接你自己的电脑</Text></View></ProgrammingCard>
      <ProgrammingCard style={{ marginTop: 12 }}><ProgrammingRow first icon="server" title={host || '中转站'} detail="当前中转站"
        trailing={<Pressable accessibilityRole="button" accessibilityLabel="换一个中转站" disabled={busy} onPress={onChangeStation} style={styles.smallLink}><Text style={styles.link}>更换</Text></Pressable>} /></ProgrammingCard>
      <ProgrammingAction label="扫描二维码" icon="scan" disabled={busy} onPress={() => void start()} style={{ marginTop: 18 }} />
      {permission && !permission.granted && !permission.canAskAgain ? <ProgrammingAction tone="secondary" label="打开相机权限设置" onPress={() => void Linking.openSettings()} style={{ marginTop: 10 }} /> : null}
      {error ? <Text accessibilityRole="alert" style={p.error}>{error}</Text> : null}
      <Text style={p.note}>二维码 5 分钟内有效，仅能使用一次。</Text>
    </ScrollView>
    <Sheet visible={visible && scanning} presentation="page" scroll={false} title="扫描二维码" onClose={() => { scanGate.current = true; setScanning(false); }}>
      {visible && scanning && permission?.granted ? <CameraView testID="remote-qr-camera" style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scan}
        onMountError={() => { scanGate.current = true; setScanning(false); setError('相机无法启动，请检查权限或重试'); }} /> : null}
    </Sheet>
    <AppDialog visible={visible && Boolean(pending)} title="连接这台电脑？" icon="laptop" dismissible={!busy} onClose={() => { if (!busy) setPending(null); }}
      message="配对后可在手机上查看会话、发送任务与批准操作。"
      actions={[
        { label: '取消', tone: 'secondary', disabled: busy, onPress: () => setPending(null) },
        { label: busy ? '正在连接…' : '连接', tone: 'primary', disabled: busy, onPress: () => void confirm() },
      ]}>
      {pending ? <View style={styles.pairDevice}><Icon name="laptop" size={16} color={dk.text2} />
        <View style={{ flex: 1, minWidth: 0 }}><Text style={p.name} numberOfLines={1}>{pending.deviceName}</Text><Text style={p.detail} numberOfLines={1}>{new URL(pending.hubUrl).host}</Text></View></View> : null}
    </AppDialog>
  </>;
}

function LegacyPairing({ onPaired }: { onPaired?: () => void }) {
  const p = useProgrammingStyles();
  const [code, setCode] = useState(''); const [busy, setBusy] = useState(false);
  const pair = async () => { setBusy(true); try { await pairRemote(code); onPaired?.(); } catch (error) { showToast((error as Error).message, 'alert'); } finally { setBusy(false); } };
  return <ScrollView contentContainerStyle={p.page}><ProgrammingHeading title="输入配对码" subtitle="适用于旧版电脑端" />
    <ProgrammingCard soft><ProgrammingField first label="配对码" value={code} onChangeText={(value) => setCode(value.toUpperCase().replace(/[^A-Z2-7]/g, '').slice(0, 8))} autoCapitalize="characters" maxLength={8} placeholder="输入 8 位配对码" /></ProgrammingCard>
    <ProgrammingAction label={busy ? '配对中…' : '配对电脑'} loading={busy} onPress={() => void pair()} disabled={busy || code.length !== 8} style={{ marginTop: 16 }} />
  </ScrollView>;
}

// ——— step 3: agent + API ———

function ConnectView({ visible, remote, device, agentId, onDevice, onAgent, onConnected }: {
  visible: boolean; remote: RemoteState; device?: DeviceStatus; agentId: AgentId;
  onDevice: (id: string) => void; onAgent: (id: AgentId) => void; onConnected: () => void;
}) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const [connecting, setConnecting] = useState(false);
  const [picking, setPicking] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const metadata = device ? remote.agents[device.deviceId] : undefined;
  const online = remoteDeviceConnected(remote, device);
  const profiles = metadata?.list.length ? metadata.list : fallbackAgentProfiles(device);
  const agent = profiles.find((item) => item.id === agentId) ?? profiles[0];
  const scope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId, device?.deviceId, agentId]);
  const generation = useRef({ visible, scope });
  if (generation.current.visible !== visible || generation.current.scope !== scope) generation.current = { visible, scope };
  const rendered = generation.current;
  const mounted = useRef(true);
  const flight = useRef<object | null>(null);
  const onlineRef = useRef(online); onlineRef.current = online;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canOperate = () => mounted.current && generation.current === rendered && generation.current.visible;
  const choose = (callback: () => void) => () => { if (canOperate() && !flight.current) callback(); };
  useEffect(() => {
    if (visible && device && online && !metadata?.loading && !metadata?.loaded) void loadAgentProfiles(device.deviceId).catch(() => undefined);
  }, [visible, device?.deviceId, online, metadata?.loading, metadata?.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    if (!device || !canOperate() || !onlineRef.current || flight.current) return;
    const token = {}; flight.current = token;
    setConnecting(true);
    try {
      await loadAgentProfiles(device.deviceId);
      if (!canOperate()) return;
      const snapshot = getRemoteState();
      const fresh = snapshot.agents[device.deviceId]?.list.find((item) => item.id === agentId);
      if (!remoteDeviceConnected(snapshot, snapshot.devices.find((item) => item.deviceId === device.deviceId))) throw new Error('电脑不在线，请确认 Salcara Bridge 正在运行');
      if (!fresh?.available) throw new Error(`电脑上没有找到 ${agent.name}，请先在电脑上安装`);
      // The visible workspace owns its single directory read, so show its loading
      // state immediately instead of prefetching and then requesting it twice.
      onConnected();
    } catch (error) { if (canOperate()) showToast((error as Error).message, 'alert'); }
    finally { if (flight.current === token) flight.current = null; if (mounted.current) setConnecting(false); }
  };

  if (!remote.devicesLoaded) return <View style={styles.center}><ActivityIndicator color={dk.muted} /></View>;
  if (!device) return <View style={styles.page}>
    {remote.devices.length > 1 ? <DeviceList devices={remote.devices} onPick={(id) => { if (canOperate() && !flight.current) onDevice(id); }} />
      : <EmptyState icon="laptop" title="等待电脑上线" detail="在已配对的电脑上打开 Salcara Bridge，上线后会自动出现。" />}
  </View>;

  const choice = AGENT_CHOICES.find(item => item.id === agentId) ?? AGENT_CHOICES[0];
  return <ScrollView contentContainerStyle={p.page} showsVerticalScrollIndicator={false}>
    <ProgrammingHeading title="准备连接" subtitle="确认这次使用的电脑、Agent 与 API" />
    <ProgrammingCard>
      <ProgrammingRow first icon="laptop" title={device.name} accessibilityLabel={remote.devices.length > 1 ? `切换电脑，当前 ${device.name}` : device.name}
        onPress={remote.devices.length > 1 ? choose(() => setDevicesOpen(true)) : undefined} disabled={connecting}
        detail={<ProgrammingStatus tone={online ? 'online' : device.online ? 'pending' : 'offline'} text={online ? `在线 · ${osName(device.os)}` : device.online ? '正在连接…' : '离线'} />}
        trailing={remote.devices.length > 1 ? <Text style={styles.link}>切换</Text> : null} />
      <ProgrammingRow accessibilityRole="radio" checked accessibilityLabel={choice.name} disabled={connecting} onPress={choose(() => setAgentsOpen(true))}
        leading={<View style={styles.agentGlyph}><ToolBadge tool={choice.tool} client={choice.client} size={24} /></View>} title={choice.name}
        detail={metadata?.loaded && !agent?.available ? '电脑上未安装' : choice.detail}
        trailing={<Pressable accessibilityRole="button" accessibilityLabel="更换 Agent" disabled={connecting} onPress={choose(() => setAgentsOpen(true))} style={styles.smallLink}><Text style={styles.link}>更换</Text></Pressable>} />
      <ProgrammingRow icon="key" accessibilityLabel="更换 API" onPress={choose(() => { if (online && metadata?.loaded) setPicking(true); })} disabled={connecting || !online || !metadata?.loaded}
        title={metadata?.loading && !metadata.loaded ? '正在读取…' : agentApiLabel(agent)} detail={agentApiSourceLabel(agent.api.source)}
        trailing={online && metadata?.loaded ? <Text style={styles.link}>更换</Text> : null} />
    </ProgrammingCard>
    {metadata?.error ? <Text style={[styles.error, { marginTop: 10, paddingHorizontal: 4 }]}>{metadata.error}</Text> : null}

    <ProgrammingAction label={connecting ? '正在连接…' : online ? '连接' : '等待电脑上线'} icon={online ? 'link' : undefined} loading={connecting}
      disabled={!online || connecting} onPress={() => void connect()} style={{ marginTop: 18 }} />

    <ApiPicker visible={visible && picking} deviceId={device.deviceId} agent={agent} apis={metadata?.apis ?? []} onClose={() => setPicking(false)} />
    <ProgrammingSheet compact visible={visible && agentsOpen} title="更换 Agent" onClose={() => setAgentsOpen(false)}>
      <View style={styles.choiceList}>{['codex', 'claude', 'claude-desktop'].map((id) => {
        const option = AGENT_CHOICES.find(item => item.id === id)!;
        const checked = id === agentId;
        return <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked }} accessibilityLabel={option.name}
          onPress={choose(() => { onAgent(option.id); setAgentsOpen(false); })} style={({ pressed }) => [styles.choice, checked && styles.choiceOn, pressed && !checked && styles.choicePressed]}>
          <ToolBadge tool={option.tool} client={option.client} size={26} /><View style={p.body}><Text style={[p.name, checked && { color: dk.text, fontWeight: '600' }]}>{option.name}</Text><Text style={p.detail} numberOfLines={1}>{option.detail}</Text></View>
          {checked ? <Icon name="check" size={16} color={dk.text2} /> : null}</Pressable>;
      })}</View>
    </ProgrammingSheet>
    <ProgrammingSheet compact visible={visible && devicesOpen} title="选择电脑" onClose={() => setDevicesOpen(false)}>
      <DeviceList devices={remote.devices} selected={device.deviceId} onPick={(id) => { if (canOperate() && !flight.current) { setDevicesOpen(false); onDevice(id); } }} />
    </ProgrammingSheet>
  </ScrollView>;
}

function DeviceList({ devices, selected, onPick }: { devices: DeviceStatus[]; selected?: string; onPick: (id: string) => void }) {
  return <ProgrammingCard>{devices.map((item, index) => <ProgrammingRow key={item.deviceId} first={index === 0} accessibilityRole="radio" checked={item.deviceId === selected}
    accessibilityLabel={`${item.name} ${item.online ? '在线' : '离线'}`} onPress={() => onPick(item.deviceId)} icon="laptop" title={item.name}
    detail={<ProgrammingStatus tone={item.online ? 'online' : 'offline'} text={`${item.online ? '在线' : '离线'} · ${osName(item.os)}`} />}
    trailing={item.deviceId === selected ? 'check' : null} />)}</ProgrammingCard>;
}



const useStyles = themed((c, d) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: d.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, height: 56 },
  topCenter: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  center: { paddingVertical: 64, alignItems: 'center' },
  choiceList: { gap: 6 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, backgroundColor: d.surface2, borderWidth: 1, borderColor: 'transparent' },
  choiceOn: { backgroundColor: d.surface, borderColor: d.ink }, choicePressed: { backgroundColor: d.surface3 },
  menuList: { marginHorizontal: -6, marginVertical: -4 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingHorizontal: 12, borderRadius: 12 },
  menuPressed: { backgroundColor: d.press }, menuText: { flex: 1, fontSize: 14, color: d.text, fontWeight: '500' },
  menuNote: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 6, marginTop: -4 },
  menuNoteText: { fontSize: 11.5, lineHeight: 16, color: d.muted },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: d.line, marginVertical: 6, marginHorizontal: 12 },
  toggle: { width: 40, height: 24, borderRadius: 12, backgroundColor: d.surface3, padding: 2 }, toggleOn: { backgroundColor: d.accent },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 }, knobOn: { transform: [{ translateX: 16 }] },
  pairDevice: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, padding: 12, borderRadius: 12, backgroundColor: d.surface2 },
  page: { paddingHorizontal: 16, paddingBottom: 40 }, 
  error: { color: d.bad, fontSize: 13, lineHeight: 19 }, 
  link: { color: d.accentText, fontSize: 12.5, fontWeight: '500' }, 
  scanPreview: { alignItems: 'center', gap: 12, paddingVertical: 22 }, scanFrame: { width: 112, height: 112, backgroundColor: d.surface, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  scanCorner: { position: 'absolute', width: 22, height: 22, borderColor: d.ink },
  tl: { top: 14, left: 14, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 9 }, tr: { top: 14, right: 14, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 9 },
  bl: { bottom: 14, left: 14, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 9 }, br: { bottom: 14, right: 14, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 9 },
  agentGlyph: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },  smallLink: { minHeight: 44, paddingLeft: 12, justifyContent: 'center' },   
}));
