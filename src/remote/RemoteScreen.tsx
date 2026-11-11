import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useBackAction, useChildBackAction } from './useBackAction';
import { connectionSelection, type ComputerSelection } from './computer-connections';
import { readComputerSelection, saveComputerSelection } from './computer-selection';
import { readPreferredAgent, rememberPreferredAgent } from './agent-preferences';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { Icon } from '../components/Icon';
import { SpaceSwitch } from '../companion/SpaceSwitch';
import { Appear, AppDialog, IconButton, Sheet, showToast, ToastHost } from '../components/ui';
import { useApp } from '../state/AppContext';
import { openSystemPermissionSettings } from '../system-permissions';
import { colors, radius, shadow, desk, themed, useDesk } from '../theme';
import { type AgentId, type SessionInfo, type WorkspaceMode } from './client';

import { remoteDeviceConnected } from './connection-state';
import { ConnectionIndicator } from './ConnectionIndicator';
import { RemoteConnectionDiagnostics } from './RemoteConnectionDiagnostics';
import { connectionDisplayName, pairedComputerCount } from './connections';
import { RemoteHome, sessionAgent } from './RemoteHome';
import { RemoteComputers } from './RemoteComputers';
import { RemoteBotBinding } from './RemoteBotBinding';
import { RemoteApiLibrary } from './RemoteApiLibrary';
import { RemoteWorkspace } from './RemoteWorkspace';
import { NewConversationFlow } from './NewConversationFlow';
import { openDesktopGithub } from './RemoteDownloads';
import { notificationsSupported, retryBackgroundNotifications, setNotificationsEnabled, useBackgroundWatchStatus, useNotificationPermissionGranted, useNotificationsEnabled } from './notifications';
import { setStandbyEnabled, usePushStatus } from './push';
import { ProgrammingAction, ProgrammingCard, ProgrammingField, ProgrammingHeading, ProgrammingPanel, ProgrammingRow, useProgrammingStyles } from './ProgrammingUi';
import { EmptyState } from './parts';
import type { PairQr } from './pairing';
import { directDeliveryScope, getDirectConnectionState, isDirectPairQr, listDirectPairings, pairDirectQr, parseDirectPairQr, reconnectDirect, restoreDirectPairing, subscribeDirectConnection, type DirectPairQr } from './direct-pairing';
import { DirectExperience } from './DirectExperience';
import {
  builtinAgent, fallbackAgentProfiles, sessionWorkspaceMode, validAgentId,
} from './projection';
import {
  getRemoteState, hydrateCachedThread, hubSupportsExplorer, hubSupportsProjectless, loadAgentProfiles, loadClaudeDesktopHistory, loadNativeSessions, loadSessions, pairRemote, pairScannedRemoteQr, parseScannedRemoteQr,
  reloadSavedConnections, setRemoteFocus, setRemoteScreenOpen, useRemote, useSavedConnection, type RemoteState,
} from './store';
import { ThreadView, type ContinueSeed } from './ThreadView';
import { RemoteDemoWorkspace } from './RemoteDemoWorkspace';
import { RemoteDemoFlow } from './RemoteDemoFlow';
import { isSimulatedRemoteDevice, SIMULATED_REMOTE_AGENTS, SIMULATED_REMOTE_DEVICE, SIMULATED_REMOTE_DEVICE_ID, SIMULATED_REMOTE_DEVICE_NAME, SIMULATED_REMOTE_SESSIONS, simulatedAgentsWithApi } from './development-fixture';

import type { SalcaraThreadLink } from './remote-links';

type Route = 'home' | 'devices' | 'setup' | 'pairing' | 'workspace' | 'direct' | 'demo' | 'new-session';
type DemoView = 'flow' | 'workspace';
const DEMO_BINDING_KEY = 'salcara.remote.demo-binding.v1';
const DEMO_API_KEY = 'salcara.remote.demo-apis.v1';
function readDemoBinding() {
  const empty = { bound: false, name: SIMULATED_REMOTE_DEVICE_NAME, selected: false };
  if (Platform.OS !== 'web') return empty;
  try {
    const stored = globalThis.localStorage?.getItem(DEMO_BINDING_KEY);
    if (!stored) return empty;
    const value = JSON.parse(stored) as { bound?: unknown; name?: unknown; selected?: unknown };
    if (value.bound !== true) return empty;
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, 48) : '';
    return { bound: true, name: name || SIMULATED_REMOTE_DEVICE_NAME, selected: value.selected === true };
  } catch { return empty; }
}
function readDemoApiAssignments(): Record<string, string> {
  if (Platform.OS !== 'web') return {};
  try {
    const raw = globalThis.localStorage?.getItem(DEMO_API_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(SIMULATED_REMOTE_AGENTS.flatMap(agent => {
      const accountId = value[agent.id];
      return typeof accountId === 'string' && SIMULATED_REMOTE_AGENTS.some(item => `preview-${item.id}` === accountId)
        ? [[agent.id, accountId]] : [];
    }));
  } catch { return {}; }
}
function isDirectPending(qr: PairQr | DirectPairQr): qr is DirectPairQr {
  return 'mode' in qr && qr.mode === 'direct';
}

/** Homepage first. Pairing is one explicit entry, never an automatic welcome screen. */
export function RemoteScreen({ visible = true }: { visible?: boolean }) {
  const dk = useDesk();
  const styles = useStyles();
  const remote = useRemote();
  const directConnection = useSyncExternalStore(subscribeDirectConnection, getDirectConnectionState, getDirectConnectionState);
  const app = useApp();
  const voice = useMemo(() => ({ providers: app.providers, chatProvider: app.chatProvider }), [app.providers, app.chatProvider]);
  const savedDemo = useMemo(readDemoBinding, []);
  const [deviceId, setDeviceId] = useState<string | null>(savedDemo.selected ? SIMULATED_REMOTE_DEVICE_ID : null);
  const [simulatedBound, setSimulatedBound] = useState(savedDemo.bound);
  const [simulatedDeviceName, setSimulatedDeviceName] = useState(savedDemo.name);
  const [demoApiAssignments, setDemoApiAssignments] = useState(readDemoApiAssignments);
  const simulatedAgents = useMemo(() => simulatedAgentsWithApi(demoApiAssignments), [demoApiAssignments]);
  const [agentId, setAgentId] = useState<AgentId>('codex');
  const [demoAgentId, setDemoAgentId] = useState<AgentId>('codex');
  const [demoFlowAgentId, setDemoFlowAgentId] = useState<AgentId | undefined>(undefined);
  const [demoView, setDemoView] = useState<DemoView>('flow');
  const [demoSession, setDemoSession] = useState<SessionInfo | null>(null);
  const [demoWorkspaceMode, setDemoWorkspaceMode] = useState<WorkspaceMode>('code');
  const [route, setRoute] = useState<Route>('home');
  const [selectedTransport, setSelectedTransportState] = useState<'direct' | 'remote' | null>(null);
  const [directChoice, setDirectChoice] = useState<{deviceId:string;deviceName?:string} | null>(null);
  const [selectionReady, setSelectionReady] = useState(false);
  const selectionTouched = useRef(false), selectionRestored = useRef(false);
  const setSelectedTransport = (kind:'direct'|'remote', choice?:ComputerSelection|null) => {
    selectionTouched.current=true;setSelectionReady(true);setSelectedTransportState(kind);
    const direct=getDirectConnectionState(),snapshot=getRemoteState();
    const selected=snapshot.connections.find(item=>item.id===snapshot.connectionId);
    const target:ComputerSelection|null=choice!==undefined?choice:kind==='direct'&&direct.deviceId?{kind:'direct',deviceId:direct.deviceId}:kind==='remote'&&selected?connectionSelection(selected):null;
    void saveComputerSelection(target).catch(()=>showToast('设备选择未保存，下次打开时请重新选择','alert'));
  };
  const [directMobileWorkspace, setDirectMobileWorkspace] = useState(false);
  const [demoMobileWorkspace, setDemoMobileWorkspace] = useState(false);
  const [threadKey, setThreadKey] = useState<string | null>(null);
  const [newThread, setNewThread] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState('');
  const [newProjectless, setNewProjectless] = useState(false);
  const [directNewRequest, setDirectNewRequest] = useState(0);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('code');
  const [newWorkspaceMode, setNewWorkspaceMode] = useState<WorkspaceMode>('code');
  const [seed, setSeed] = useState<ContinueSeed | null>(null);
  const [menu, setMenu] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [apiLibrary, setApiLibrary] = useState(false);
  const notify = useNotificationsEnabled();
  const notifyPermission = useNotificationPermissionGranted();
  const push = usePushStatus();
  const watchStatus = useBackgroundWatchStatus(visible && menu);
  const [backgroundHelp, setBackgroundHelp] = useState(false);
  const selectionRevision = useRef(0);
  const externalFocusRevision = useRef(0);
  const returnToHome = useRef(false);
  const demoBack = useRef<(() => void) | null>(null);
  const registerDemoBack = useCallback((handler: (() => void) | null) => { demoBack.current = handler; }, []);
  const directBack = useChildBackAction();
  const newFlowBack = useChildBackAction();
  const demoWorkspaceBack = useChildBackAction();
  const scope = JSON.stringify([remote.connectionId, remote.selectedHubUrl, remote.serviceId]);
  const navigation = useRef({ route, revision: 0, scope, visible });
  navigation.current.route = route; navigation.current.scope = scope; navigation.current.visible = visible;
  const priorScope = useRef(scope);
  const navigate = (next: Route) => {
    navigation.current = { ...navigation.current, route: next, revision: navigation.current.revision + 1 };
    setDirectMobileWorkspace(false); setDemoMobileWorkspace(false);
    setRoute(next);
  };
  const profile = remote.connections.find((item) => item.id === remote.connectionId);
  const directTarget = directChoice ?? (directConnection.deviceId ? {deviceId:directConnection.deviceId,deviceName:directConnection.deviceName} : null);
  const directSelected = Boolean(directTarget && (selectedTransport === 'direct' || selectedTransport === null && !profile));
  const relayBackground = !directSelected && !profile?.botGroupId;
  const homeDirect = directTarget ? { ...directTarget, connected: directConnection.deviceId === directTarget.deviceId && directConnection.status === 'connected',
    status: directConnection.deviceId === directTarget.deviceId ? directConnection.status : 'closed' as const } : undefined;
  const device = remote.devices.find((item) => item.deviceId === deviceId);
  const simulatedDevice = simulatedBound && deviceId === SIMULATED_REMOTE_DEVICE_ID ? { ...SIMULATED_REMOTE_DEVICE, name: simulatedDeviceName } : undefined;
  const agents = deviceId ? remote.agents[deviceId] : undefined;
  const agent = (agents?.loaded ? agents.list : fallbackAgentProfiles(device)).find((item) => item.id === agentId) ?? null;
  const connected = route === 'workspace';
  const step = route;
  const revision = navigation.current.revision;
  const reportDirectMobileWorkspace = useCallback((open: boolean) => {
    if (navigation.current.route === 'direct' && navigation.current.revision === revision) setDirectMobileWorkspace(open);
  }, [revision]);
  const reportDemoMobileWorkspace = useCallback((open: boolean) => {
    if (navigation.current.route === 'demo' && navigation.current.revision === revision) setDemoMobileWorkspace(open);
  }, [revision]);
  useEffect(() => { if (directConnection.status !== 'connected') setDirectMobileWorkspace(false); }, [directConnection.status, directConnection.deviceId]);
  useEffect(() => { if (demoView !== 'workspace') setDemoMobileWorkspace(false); }, [demoView]);
  const mobileWorkspaceFullscreen = route === 'direct' && directConnection.status === 'connected' && directMobileWorkspace
    || route === 'demo' && demoView === 'workspace' && demoMobileWorkspace;
  const stillHere = (expected: Route, capturedRevision: number, capturedScope?: string) => navigation.current.visible
    && navigation.current.route === expected && navigation.current.revision === capturedRevision
    && (capturedScope === undefined || navigation.current.scope === capturedScope);
  const rememberDirect = (id:string) => {
    const current = getDirectConnectionState();
    if (current.deviceId !== id || current.status !== 'connected') return false;
    setDirectChoice({deviceId:id,deviceName:current.deviceName}); setSelectedTransport('direct');
    return true;
  };
  const openDirect = async (newConversation = false) => {
    const target = directTarget;
    if (!target) { navigate('devices'); return; }
    const owner = {...navigation.current};
    try {
      const current = getDirectConnectionState();
      if (current.deviceId !== target.deviceId || current.status !== 'connected') await reconnectDirect(target.deviceId, {
        stillWanted: () => stillHere(owner.route, owner.revision, owner.scope),
      });
      if (!stillHere(owner.route,owner.revision,owner.scope)) return;
      if (!rememberDirect(target.deviceId)) throw new Error('直连目标已改变，请重新选择电脑');
      setDirectNewRequest(value => newConversation ? value + 1 : 0);
      navigate('direct');
    } catch(error) { if(stillHere(owner.route,owner.revision,owner.scope)) showToast(error instanceof Error?error.message:'直连失败','alert'); }
  };
  const selectComputer = (selection:ComputerSelection) => {
    if (!stillHere('devices',revision)) return;
    if (selection.kind === 'direct') {
      if (rememberDirect(selection.deviceId)) { setDirectNewRequest(0); setThreadKey(null); setNewThread(false); navigate('direct'); }
      return;
    }
    if (selection.kind === 'demo') {
      setSelectedTransport('remote',null); setDeviceId(selection.deviceId); setDemoView('flow'); setDemoSession(null); navigate('home'); return;
    }
    const current=getRemoteState(), selected=current.connections.find(item=>item.id===selection.connectionId);
    if(current.connectionId!==selection.connectionId || selected?.deviceId!==selection.deviceId
      || (selected.botGroupId?'bot':'relay')!==selection.kind) {showToast('设备连接已改变，请重新选择','alert');return;}
    setSelectedTransport('remote');setDeviceId(selection.deviceId);setThreadKey(null);setNewThread(false);navigate('home');
  };
  const menuGeneration = useRef({ open: visible && menu, scope, revision });
  useEffect(() => {
    if (!visible || remote.phase==='loading' || selectionRestored.current) return;
    let alive=true;
    const ownerRevision=navigation.current.revision;
    const current=()=>alive&&!selectionTouched.current&&navigation.current.revision===ownerRevision;
    void (async()=>{
      const selected=await readComputerSelection();
      if(!current()||!selected)return;
      if(selected.kind==='direct'){
        const peers=await listDirectPairings();
        if(!current())return;
        const peer=peers.find(item=>item.deviceId===selected.deviceId);
        if(peer){setDirectChoice({deviceId:peer.deviceId,deviceName:peer.deviceName});setSelectedTransportState('direct');return;}
      }else if(selected.kind!=='demo'){
        const snapshot=getRemoteState(),profile=snapshot.connections.find(item=>item.id===selected.connectionId&&item.deviceId===selected.deviceId&&(item.botGroupId?'bot':'relay')===selected.kind);
        if(profile&&snapshot.connectionId===profile.id){setSelectedTransportState('remote');setDeviceId(profile.deviceId);return;}
      }
      if(current()) { setSelectedTransportState('remote'); navigate('devices'); void saveComputerSelection(null).catch(()=>undefined); }
    })().catch(()=>{if(current())navigate('devices');}).finally(()=>{if(alive){selectionRestored.current=true;setSelectionReady(true);}});
    return()=>{alive=false;};
  },[visible,remote.phase]);
  if (menuGeneration.current.open !== (visible && menu) || menuGeneration.current.scope !== scope || menuGeneration.current.revision !== revision) menuGeneration.current = { open: visible && menu, scope, revision };
  const renderedMenu = menuGeneration.current;
  const closeMenu = () => { menuGeneration.current = { ...menuGeneration.current, open: false }; setMenu(false); };
  const menuAction = (callback: () => void) => () => {
    if (!navigation.current.visible || navigation.current.scope !== scope || navigation.current.revision !== revision || !menuGeneration.current.open || menuGeneration.current !== renderedMenu) return;
    closeMenu(); callback();
  };
  const chooseAgent = (id: AgentId, targetDeviceId = deviceId) => {
    selectionRevision.current += 1; setAgentId(id);
    const snapshot = getRemoteState(), selected = snapshot.connections.find(item => item.id === snapshot.connectionId);
    if (targetDeviceId && selected?.deviceId === targetDeviceId) {
      void rememberPreferredAgent({ kind: 'remote', connectionId: selected.id, deviceId: targetDeviceId }, id).catch(() => undefined);
    }
  };
  const openSimulatedSession = (id: AgentId, session?: SessionInfo, mode = workspaceMode) => {
    const selected = session ?? [...SIMULATED_REMOTE_SESSIONS]
      .filter((item) => sessionAgent(item, simulatedAgents) === id && sessionWorkspaceMode(item) === mode)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    setDemoAgentId(id); setDemoSession(selected ?? null); setDemoWorkspaceMode(selected ? sessionWorkspaceMode(selected) : mode);
    setDemoView(selected ? 'workspace' : 'flow');
    navigate('demo');
  };
  const openSimulatedAgent = (id: AgentId, mode = workspaceMode) => {
    setDemoAgentId(id); setDemoFlowAgentId(id); setDemoSession(null); setDemoWorkspaceMode(mode); setDemoView('flow');
    navigate('demo');
  };
  // The homepage already owns the active computer and connection status. An Agent card
  // therefore opens that computer's directory directly; settings remain available inside it.
  const openAgentOnDevice = (id: AgentId, targetDeviceId: string, mode: WorkspaceMode) => {
    setSelectedTransport('remote',isSimulatedRemoteDevice(targetDeviceId)?null:undefined); chooseAgent(id, targetDeviceId); setDeviceId(targetDeviceId); setWorkspaceMode(mode);
    setThreadKey(null); setNewThread(false); returnToHome.current = false;
    if (isSimulatedRemoteDevice(targetDeviceId)) { openSimulatedAgent(id, mode); return; }
    navigate('workspace');
  };
  const openAgent = (id: AgentId) => {
    if (directSelected) { void openDirect(); return; }
    const selectedDeviceId = simulatedDevice?.deviceId ?? profile?.deviceId ?? deviceId ?? remote.devices[0]?.deviceId;
    if (selectedDeviceId) {
      const catalog = remote.agents[selectedDeviceId];
      if (catalog?.loaded && !catalog.list.some(item => item.id === id && item.available)) {
        showToast('当前电脑未安装此 Agent', 'alert'); return;
      }
      openAgentOnDevice(id, selectedDeviceId, workspaceMode); return;
    }
    navigate('devices');
  };
  const openProjects = () => {
    if (directSelected) { void openDirect(); return; }
    if (simulatedDevice) { setDemoFlowAgentId(undefined); setDemoSession(null); setDemoView('flow'); navigate('demo'); return; }
    const targetDeviceId = profile?.deviceId ?? deviceId ?? remote.devices[0]?.deviceId;
    if (!targetDeviceId) { navigate('devices'); return; }
    const openFromCatalog = (snapshot: RemoteState) => {
      const catalog = snapshot.agents[targetDeviceId];
      const selected = catalog?.list.find(item => item.id === agentId && item.available)
        ?? catalog?.list.find(item => item.available);
      if (selected) openAgentOnDevice(selected.id, targetDeviceId, workspaceMode);
      else showToast('这台电脑没有可用的 Agent', 'alert');
    };
    if (remote.agents[targetDeviceId]?.loaded) { openFromCatalog(remote); return; }
    const ownedRevision = navigation.current.revision;
    const ownedScope = navigation.current.scope;
    void loadAgentProfiles(targetDeviceId).then(() => {
      if (stillHere('home', ownedRevision, ownedScope)) openFromCatalog(getRemoteState());
    }).catch((error: Error) => {
      if (stillHere('home', ownedRevision, ownedScope)) showToast(error.message, 'alert');
    });
  };
  const openGlobalNew = () => {
    if (directSelected) { void openDirect(true); return; }
    const targetDeviceId = profile?.deviceId ?? deviceId;
    if (!targetDeviceId) { navigate('devices'); return; }
    setDeviceId(targetDeviceId); setThreadKey(null); setNewThread(false); navigate('new-session');
    void loadAgentProfiles(targetDeviceId).catch(() => undefined);
  };
  /** Opens a known conversation at once (cached copy first); Agent/API details are verified in background. */
  const openExisting = async (targetDeviceId: string, sessionKey: string, knownSession?: SessionInfo, expectedSource?: Pick<SalcaraThreadLink, 'agentId' | 'surface' | 'sessionScope'>) => {
    if (sessionKey.length > 512 || /[|\p{Cc}\p{Cf}]/u.test(sessionKey)) return;
    if (knownSession && knownSession.sessionKey !== sessionKey) return;
    const sourceMatches = (session: SessionInfo) => !expectedSource?.surface
      || session.controlSurface === expectedSource.surface && (expectedSource.surface !== 'read-only' || session.sessionScope === expectedSource.sessionScope);
    const namespace = sessionKey.slice(0, sessionKey.indexOf(':'));
    if (!validAgentId(namespace) || !sessionKey.includes(':') || !sessionKey.slice(sessionKey.indexOf(':') + 1)) return;
    const hint = { sessionKey, tool: namespace === 'claude-desktop' ? 'claude' : namespace,
      client: expectedSource?.agentId === 'claude-desktop' || namespace === 'claude-desktop' ? 'Claude Desktop' : expectedSource?.surface === 'desktop' ? 'Codex App' : '' };
    let initial = getRemoteState();
    const directoryRows = (snapshot: RemoteState) => {
      const entry = snapshot.sessions[targetDeviceId];
      const historyIdentity = snapshot.agents[targetDeviceId]?.list.find(item => item.id === 'claude-desktop')?.desktopHistory?.identity;
      return [...(entry?.list ?? []), ...(entry?.native?.list ?? []), ...Object.values(entry?.readOnly ?? {})
        .filter(directory => directory?.identity === historyIdentity).flatMap(directory => directory?.list ?? [])];
    };
    const findExpectedSession = (snapshot: RemoteState) => {
      const exact = directoryRows(snapshot).filter(item => item.sessionKey === sessionKey && sourceMatches(item));
      if (expectedSource && !expectedSource.surface && new Set(exact.map(item => `${item.controlSurface ?? ''}|${item.sessionScope ?? ''}`)).size > 1) return undefined;
      return exact[0];
    };
    let resolvedSession = expectedSource ? findExpectedSession(initial) : knownSession;
    if (expectedSource && !resolvedSession) {
      if (!remoteDeviceConnected(initial, initial.devices.find(item => item.deviceId === targetDeviceId))) {
        showToast('链接对应的会话不在手机缓存中', 'alert'); return;
      }
      const owner = { route: navigation.current.route, revision: navigation.current.revision, scope: navigation.current.scope, selection: selectionRevision.current };
      const ownerStillCurrent = () => stillHere(owner.route, owner.revision, owner.scope) && owner.selection === selectionRevision.current;
      try {
        if (!initial.agents[targetDeviceId]?.loaded) await loadAgentProfiles(targetDeviceId);
        if (!ownerStillCurrent()) return;
        initial = getRemoteState();
        const sourceProfile = initial.agents[targetDeviceId]?.list ?? [];
        const hintedAgent = sessionAgent(hint, sourceProfile);
        if (!hintedAgent || hintedAgent !== expectedSource.agentId) { showToast('链接中的 Agent 与会话标识不匹配', 'alert'); return; }
        if (expectedSource.surface === 'desktop') await loadNativeSessions(targetDeviceId);
        else if (expectedSource.surface === 'read-only' && expectedSource.sessionScope) await loadClaudeDesktopHistory(targetDeviceId, expectedSource.sessionScope);
        else await loadSessions(targetDeviceId, expectedSource.agentId);
        if (!ownerStillCurrent()) return;
        resolvedSession = findExpectedSession(getRemoteState());
        if (!resolvedSession || sessionAgent(resolvedSession, getRemoteState().agents[targetDeviceId]?.list ?? []) !== expectedSource.agentId) {
          showToast('链接对应的会话当前不可用', 'alert'); return;
        }
      } catch (error) {
        if (ownerStillCurrent()) showToast(error instanceof Error ? error.message : '无法读取链接对应的会话', 'alert');
        return;
      }
    }
    const sessionForOpening = expectedSource ? resolvedSession : knownSession;
    const profileForOpening = initial.agents[targetDeviceId]?.list;
    let guess = sessionAgent(sessionForOpening ?? hint, initial.agents[targetDeviceId]?.loaded ? profileForOpening : undefined);
    if (expectedSource?.agentId && guess && guess !== expectedSource.agentId) return;
    // Built-in cached threads keep their instant, unsendable read experience.
    // Unknown namespaces wait for their exact adapter instead of mounting a
    // Codex/Claude composer while the registration is being read.
    if (!guess && !builtinAgent(namespace) && !initial.agents[targetDeviceId]?.loaded
      && remoteDeviceConnected(initial, initial.devices.find(item => item.deviceId === targetDeviceId))) {
      const owner = { route: navigation.current.route, revision: navigation.current.revision, scope: navigation.current.scope, selection: selectionRevision.current };
      try { await loadAgentProfiles(targetDeviceId); } catch { return; }
      if (!stillHere(owner.route, owner.revision, owner.scope) || owner.selection !== selectionRevision.current) return;
      initial = getRemoteState();
      guess = sessionAgent(hint, initial.agents[targetDeviceId]?.list ?? []);
    }
    if (!guess) return;
    if (sessionForOpening) setWorkspaceMode(sessionWorkspaceMode(sessionForOpening));
    setSelectedTransport('remote'); chooseAgent(guess, targetDeviceId); setDeviceId(targetDeviceId); setNewThread(false);
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
      if (sessionKey && !sessionForOpening && !expectedSource && !snapshot.sessions[targetDeviceId]?.list.some(item => item.sessionKey === sessionKey)) {
        await loadSessions(targetDeviceId);
        if (!stillHere('workspace', ownedRevision, ownedScope)) return;
        snapshot = getRemoteState();
      }
      let session = sessionForOpening ?? findExpectedSession(snapshot);
      if (!session && !expectedSource) {
        await loadSessions(targetDeviceId);
        if (!stillHere('workspace', ownedRevision, ownedScope)) return;
        snapshot = getRemoteState(); session = findExpectedSession(snapshot);
      }
      if (expectedSource?.surface && !session) {
        setThreadKey(null); setNewThread(false); navigate('home'); showToast('链接对应的会话当前不可用', 'alert'); return;
      }
      const id = sessionAgent(session ?? hint, snapshot.agents[targetDeviceId]?.list ?? []);
      if (!id) { setThreadKey(null); setNewThread(false); navigate('home'); return; }
      if (expectedSource?.agentId && id !== expectedSource.agentId) {
        setThreadKey(null); setNewThread(false); navigate('home'); showToast('链接中的 Agent 与会话不匹配', 'alert'); return;
      }
      if (id !== guess) chooseAgent(id, targetDeviceId);
    } catch (error) {
      if (stillHere('workspace', ownedRevision, ownedScope)) showToast(error instanceof Error ? `${error.message}，可先查看记录` : '暂时连不上电脑，可先查看记录', 'alert');
    }
  };
  const openRecent = (targetDeviceId: string, session: SessionInfo) => {
    if (isSimulatedRemoteDevice(targetDeviceId)) {
      const id = sessionAgent(session, simulatedAgents) ?? demoAgentId;
      openSimulatedSession(id, session);
      return;
    }
    void openExisting(targetDeviceId, session.sessionKey, session);
  };

  useEffect(() => {
    navigation.current.visible = visible;
    setRemoteScreenOpen(visible);
    return () => { navigation.current.visible = false; navigation.current.revision += 1; setRemoteScreenOpen(false); };
  }, [visible]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try {
      if (simulatedBound) globalThis.localStorage?.setItem(DEMO_BINDING_KEY, JSON.stringify({ bound: true, name: simulatedDeviceName, selected: deviceId === SIMULATED_REMOTE_DEVICE_ID }));
      else globalThis.localStorage?.removeItem(DEMO_BINDING_KEY);
    } catch { /* The preview stays usable when browser storage is disabled. */ }
  }, [simulatedBound, simulatedDeviceName, deviceId]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    try {
      if (simulatedBound) globalThis.localStorage?.setItem(DEMO_API_KEY, JSON.stringify(demoApiAssignments));
      else globalThis.localStorage?.removeItem(DEMO_API_KEY);
    } catch { /* The preview stays usable when browser storage is disabled. */ }
  }, [simulatedBound, demoApiAssignments]);
  useEffect(() => {
    if (!visible) return;
    if (typeof restoreDirectPairing === 'function') void restoreDirectPairing().catch(() => undefined);
  }, [visible]);
  useEffect(() => {
    // Restore only the active computer's preference. A delayed disk read must
    // not replace an explicitly opened Agent, conversation or different route.
    if (directSelected || !deviceId || !remote.connectionId || profile?.deviceId !== deviceId
      || navigation.current.route !== 'home' && navigation.current.route !== 'devices') return;
    let active = true; const selectedAt = selectionRevision.current, owner = { ...navigation.current };
    setAgentId('codex');
    void readPreferredAgent({ kind: 'remote', connectionId: remote.connectionId, deviceId }).then(id => {
      if (active && selectedAt === selectionRevision.current && stillHere(owner.route, owner.revision, owner.scope)) setAgentId(id ?? 'codex');
    }).catch(() => undefined);
    return () => { active = false; };
  }, [remote.connectionId, deviceId, directSelected, profile?.deviceId]);
  useEffect(() => {
    if (priorScope.current === scope) return;
    priorScope.current = scope;
    setDeviceId(current => current === SIMULATED_REMOTE_DEVICE_ID && simulatedBound ? current : profile?.deviceId ?? (simulatedBound ? SIMULATED_REMOTE_DEVICE_ID : null));
    setThreadKey(null); setNewThread(false); setMenu(false); setApiLibrary(false); returnToHome.current = false;
    // A deliberate station check/QR flow may change the store scope. It owns its own completion guard.
    if (navigation.current.route === 'workspace' || navigation.current.route === 'new-session') navigate('home');
  }, [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (remote.phase !== 'ready') return;
    if (deviceId === SIMULATED_REMOTE_DEVICE_ID && simulatedBound) return;
    // A station handover may assign a different credential-scoped device ID.
    // Do not keep sending the old station's ID just because the local React
    // state was already populated before the handover completed.  At the same
    // time, keep a valid selection untouched during ordinary refreshes.
    const activeDeviceExists = Boolean(deviceId && remote.devices.some((item) => item.deviceId === deviceId));
    if (deviceId && !activeDeviceExists && profile?.deviceId) {
      setDeviceId(profile.deviceId);
      return;
    }
    if (deviceId) return;
    const preferred = remote.devices.find((item) => item.deviceId === profile?.deviceId) ?? (remote.devices.length === 1 ? remote.devices[0] : undefined);
    if (preferred) setDeviceId(preferred.deviceId);
  }, [deviceId, remote.phase, remote.devices, profile?.deviceId, simulatedBound]);
  // A tapped approval alert opens its matching thread.
  useEffect(() => {
    if (!visible || !remote.focus) return;
    const target = remote.focus;
    setMenu(false); setApiLibrary(false); setRemoteFocus(null);
    if ('home' in target) { setThreadKey(null); setNewThread(false); navigate('home'); return; }
    if (target.connectionId && target.connectionId !== remote.connectionId) {
      setThreadKey(null); setNewThread(false); navigate('home');
      const revision = ++externalFocusRevision.current;
      const owner = { route: navigation.current.route, revision: navigation.current.revision };
      const stillWanted = () => externalFocusRevision.current === revision && stillHere(owner.route, owner.revision);
      void useSavedConnection(target.connectionId, false, { stillWanted }).then(() => {
        if (!stillWanted()) return;
        const current = getRemoteState();
        if (current.connectionId !== target.connectionId || !current.devices.some(item => item.deviceId === target.deviceId)) {
          showToast('链接对应的电脑当前不可用', 'alert'); return;
        }
        setRemoteFocus({ ...target });
      }).catch((error: Error) => {
        if (stillWanted()) showToast(error.message || '无法切换到链接对应的电脑', 'alert');
      });
      return;
    }
    externalFocusRevision.current += 1;
    if (target.connectionId && remote.connections.find(item => item.id === target.connectionId)?.deviceId !== target.deviceId) {
      showToast('链接中的电脑与当前配对不一致', 'alert'); return;
    }
    const session = remote.sessions[target.deviceId]?.list.find(item => item.sessionKey === target.sessionKey);
    void openExisting(target.deviceId, target.sessionKey, session, target.agentId ? {
      agentId: target.agentId, surface: target.surface, sessionScope: target.sessionScope,
    } : undefined);
  }, [visible, remote.focus, remote.connectionId]);

  const back = () => {
    if (route === 'new-session') { if (!newFlowBack.handle()) navigate('home'); return true; }
    if (route === 'pairing') { navigate(pairedComputerCount(remote.connections) || simulatedBound ? 'devices' : 'home'); return true; }
    if (route === 'direct') { if (!directBack.handle()) navigate('home'); return true; }
    if (route === 'setup') { navigate('devices'); return true; }
    if (route === 'devices') { navigate('home'); return true; }
    if (route === 'workspace') { navigate('home'); return true; }
    if (route === 'demo') {
      if (demoView === 'workspace') {
        if (!demoWorkspaceBack.handle()) { setDemoView('flow'); setDemoSession(null); }
        return true;
      }
      if (demoBack.current) demoBack.current(); else navigate('home');
      return true;
    }
    if (route !== 'home') { navigate('home'); return true; }
    return false;
  };
  const closeThread = () => {
    setSeed(null); setThreadKey(null); setNewThread(false);
    if (returnToHome.current) {
      returnToHome.current = false; navigate('home');
      if (deviceId) void loadSessions(deviceId).catch(() => undefined);
    }
  };
  useBackAction(() => {
      if (backgroundHelp) { setBackgroundHelp(false); return true; }
      if (menu) { closeMenu(); return true; }
      // Native Modals normally own these events; keep their transition fallback inside the app.
      if (apiLibrary) { setApiLibrary(false); return true; }
      if (diagnosticsOpen) { setDiagnosticsOpen(false); return true; }
      if (connected && (threadKey || newThread)) { closeThread(); return true; }
      if (!back()) app.switchSpace('assistant');
      return true;
  }, undefined, visible);

  return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
    {!mobileWorkspaceFullscreen && route !== 'new-session' ? <View style={styles.topBar}>
      {route !== 'home' && route !== 'demo' ? <IconButton icon="chevronLeft" label="返回" onPress={() => { back(); }} /> : <View style={{ width: 40 }} />}
      <View style={{ flex: 1 }} />
      {route === 'home' || route === 'workspace' || route === 'direct' ? <IconButton icon="compose" label="新建全局会话" onPress={openGlobalNew} /> : null}
      {device && !directSelected && !isSimulatedRemoteDevice(device.deviceId) && route !== 'direct' && route !== 'demo' ? <ConnectionIndicator remote={remote} device={device} onPress={() => setDiagnosticsOpen(true)} /> : null}
      {route !== 'home' ? <View style={styles.headerActions}>
        <IconButton icon="more" label="更多" onPress={() => setMenu(true)} />
      </View> : null}
      {route === 'home' && !apiLibrary ? <View pointerEvents="box-none" style={styles.topCenter}><SpaceSwitch space="remote" onSwitch={app.switchSpace} /></View> : null}
    </View> : null}
    <Appear key={`step:${step}`} distance={18} style={{ flex: 1 }}>
      {step === 'home' && !selectionReady ? <View style={{flex:1,alignItems:'center',justifyContent:'center'}}><ActivityIndicator accessibilityLabel="正在读取设备" color={dk.muted}/></View> : step === 'home'
          ? <RemoteHome visible={visible && !apiLibrary && !menu} remote={remote} device={device} simulatedDevice={simulatedDevice}
          simulatedAgents={simulatedDevice ? simulatedAgents : undefined} simulatedSessions={simulatedDevice ? SIMULATED_REMOTE_SESSIONS : undefined}
          directDevice={homeDirect} directSelected={directSelected}
          onDirect={() => { void openDirect(); }}
          workspaceMode={workspaceMode} onWorkspaceModeChange={setWorkspaceMode}
          onComputer={() => navigate(pairedComputerCount(remote.connections) || directTarget || simulatedDevice ? 'devices' : 'pairing')} onDemo={() => { setDemoFlowAgentId(undefined); setDemoSession(null); setDemoView('flow'); navigate('demo'); }} onApi={() => setApiLibrary(true)} onAgent={openAgent}
          onProjects={openProjects} onSession={openRecent} onDownload={() => void openDesktopGithub()} />
        : step === 'devices'
          ? <RemoteComputers visible={visible} remote={remote} selectedDeviceId={deviceId} directConnection={directConnection} directSelected={directSelected} selectedDirectDeviceId={directTarget?.deviceId}
            isNavigationCurrent={() => stillHere('devices', revision, scope)}
            onDirectRemoved={(id,removedScope)=>{
              if (!stillHere('devices', revision, scope) || directTarget?.deviceId !== id) return;
              const current = getDirectConnectionState();
              if (current.deviceId === id && removedScope && directDeliveryScope() && directDeliveryScope() !== removedScope) return;
              setDirectChoice(null);setSelectedTransport('remote');
            }}
            demoComputer={Platform.OS === 'web' && simulatedBound} demoComputerName={simulatedDeviceName} onDemoRename={setSimulatedDeviceName}
            onDemoForget={() => { setSimulatedBound(false); setDeviceId(profile?.deviceId ?? null); setSimulatedDeviceName(SIMULATED_REMOTE_DEVICE_NAME); setDemoApiAssignments({}); navigate('home'); }}
            onBind={() => navigate('pairing')} onSelected={selectComputer} />
        : step === 'setup'
          ? <QrPairing visible={visible} remote={remote} autoScan onBotPaired={(selection) => {
              if (!stillHere('setup', revision)) return;
              const current=getRemoteState();if(selection.kind!=='bot'||current.connectionId!==selection.connectionId)return;
              setSelectedTransport('remote'); setDeviceId(selection.deviceId); navigate('home');
            }} onPaired={(direct) => {
              if (!stillHere('setup', revision)) return;
              if (direct) { const current=getDirectConnectionState(); if(!current.deviceId || !rememberDirect(current.deviceId)) return; }
              else { setSelectedTransport('remote'); const snapshot = getRemoteState(); setDeviceId(snapshot.connections.find(item => item.id === snapshot.connectionId)?.deviceId ?? null); }
              navigate(direct ? 'direct' : 'home');
            }} onSimulatedPaired={() => {
              if (!stillHere('setup', revision)) return;
              setSelectedTransport('remote',null); setSimulatedBound(true); setDeviceId(SIMULATED_REMOTE_DEVICE_ID);
              navigate('home');
            }} />
          : step === 'pairing'
            ? <QrPairing visible={visible} remote={remote} autoScan simulateWebPairing={Platform.OS === 'web'} onChangeStation={() => { if (stillHere('pairing', revision)) navigate('setup'); }} onBotPaired={(selection) => {
                if (!stillHere('pairing', revision)) return;
                const current=getRemoteState();if(selection.kind!=='bot'||current.connectionId!==selection.connectionId)return;
                setSelectedTransport('remote'); setDeviceId(selection.deviceId); navigate('home');
              }} onPaired={(direct) => {
                if (!stillHere('pairing', revision)) return;
                if (direct) { const current=getDirectConnectionState(); if(!current.deviceId || !rememberDirect(current.deviceId)) return; }
              else { setSelectedTransport('remote'); const snapshot = getRemoteState(); setDeviceId(snapshot.connections.find(item => item.id === snapshot.connectionId)?.deviceId ?? null); }
                navigate(direct ? 'direct' : 'home');
              }} onSimulatedPaired={() => {
                if (!stillHere('pairing', revision)) return;
                setSelectedTransport('remote',null); setSimulatedBound(true); setDeviceId(SIMULATED_REMOTE_DEVICE_ID);
                navigate('home');
              }} />
            : step === 'direct'
              ? <DirectExperience workspaceMode={workspaceMode} newConversationRequest={directNewRequest} onMobileWorkspaceVisibilityChange={reportDirectMobileWorkspace} onRegisterBack={directBack.register} />
            : step === 'new-session' && deviceId
              ? <NewConversationFlow key={JSON.stringify([scope, deviceId, workspaceMode])} scopeKey={scope} deviceId={deviceId} deviceName={device?.name} transport="remote" mode={workspaceMode}
                agents={agents?.loaded ? agents.list : []} loading={Boolean(agents?.loading)} error={agents?.error} online={remoteDeviceConnected(remote, device)}
                explorerAvailable={typeof hubSupportsExplorer === 'function' && hubSupportsExplorer() && Boolean(device?.capabilities?.includes('workspace.explorer.v1'))}
                projectlessAvailable={typeof hubSupportsProjectless === 'function' && hubSupportsProjectless() && Boolean(device?.capabilities?.includes('session.projectless.v1'))}
                onRefresh={() => { void loadAgentProfiles(deviceId).catch(() => undefined); }} onRegisterBack={newFlowBack.register} onClose={() => navigate('home')}
                onComplete={selection => { if (!stillHere('new-session', revision, scope)) return; chooseAgent(selection.agent.id); setNewProjectPath(selection.cwd); setNewProjectless(selection.projectless === true); setNewWorkspaceMode(workspaceMode); setSeed(null); setThreadKey(null); setNewThread(true); returnToHome.current = true; navigate('workspace'); }} />
            : step === 'demo'
              ? demoView === 'flow'
                ? <RemoteDemoFlow visible={visible} computer={{ ...SIMULATED_REMOTE_DEVICE, name: simulatedDeviceName }} agents={simulatedAgents} sessions={SIMULATED_REMOTE_SESSIONS} initialAgentId={demoFlowAgentId} initialWorkspaceMode={demoWorkspaceMode} onRegisterBack={registerDemoBack}
                    onBack={() => { setDemoFlowAgentId(undefined); setDemoSession(null); navigate('home'); }}
                    onOpenWorkspace={({ agent: selectedAgent, session, workspaceMode: selectedMode }) => {
                      setDemoAgentId(selectedAgent.id); setDemoFlowAgentId(selectedAgent.id); setDemoSession(session); setDemoWorkspaceMode(selectedMode); setDemoView('workspace');
                    }} />
                : <RemoteDemoWorkspace computerName={simulatedDeviceName} agentName={simulatedAgents.find(item => item.id === demoAgentId)?.name} agentId={demoAgentId} sessionKey={demoSession?.sessionKey} projectPath={demoSession?.cwd} sessions={SIMULATED_REMOTE_SESSIONS}
                    sessionTitle={demoSession?.title} workspaceMode={demoWorkspaceMode} onMobileWorkspaceVisibilityChange={reportDemoMobileWorkspace} onRegisterBack={demoWorkspaceBack.register} onBack={() => { setDemoView('flow'); setDemoSession(null); }} />
            : step === 'workspace' && deviceId && !agent
              ? <View style={styles.page}><EmptyState icon="alert" title="Agent 暂不可用" detail="这台电脑的 Agent 列表已变化，请返回首页重新选择。" /></View>
            : step === 'workspace' && deviceId && agent
              ? <RemoteWorkspace visible={visible && !threadKey && !newThread && !apiLibrary && !menu} deviceId={deviceId} agent={agent} workspaceMode={workspaceMode} onWorkspaceModeChange={setWorkspaceMode}
                onOpen={(key) => { if (stillHere('workspace', revision, scope)) setThreadKey(key); }}
                onNew={(mode, cwd, projectless) => { if (stillHere('workspace', revision, scope) && (cwd || projectless)) { setSeed(null); setNewProjectless(projectless === true); setNewProjectPath(projectless ? '' : cwd); setNewWorkspaceMode(mode); setNewThread(true); } }}
                onSettings={() => { if (stillHere('workspace', revision, scope)) setApiLibrary(true); }} />
              : <View style={styles.page}><EmptyState icon="laptop" title="请选择电脑" detail="返回首页选择已绑定的电脑和 Agent。" /></View>}
    </Appear>
    {diagnosticsOpen ? <RemoteConnectionDiagnostics visible={visible && route !== 'direct' && route !== 'demo'} remote={remote} device={device} onClose={() => setDiagnosticsOpen(false)} /> : null}
    <ThreadView visible={visible && connected && Boolean(threadKey || newThread)} deviceId={deviceId} sessionKey={threadKey} agent={agent} workspaceMode={newThread ? newWorkspaceMode : workspaceMode} onWorkspaceModeChange={setWorkspaceMode} activeSpace={app.space} onSwitchSpace={app.switchSpace}
      onAgentSettings={() => setApiLibrary(true)} agentSettingsOpen={apiLibrary}
      voice={voice}
      verifying={!(deviceId && remote.agents[deviceId]?.loaded && !remote.agents[deviceId]?.error && remote.agents[deviceId]?.list.some((item) => item.id === agentId))}
      seed={newThread ? seed : null} newProjectPath={newThread ? newProjectPath : undefined} newProjectless={newThread && newProjectless}
      onContinue={(next) => {
        const claude = deviceId ? remote.agents[deviceId]?.list.find((item) => item.id === 'claude') : undefined;
        if (!claude?.available) { showToast('电脑上需要先安装 Claude Code，才能在手机上继续这个对话', 'alert'); return; }
        chooseAgent('claude'); setWorkspaceMode('code'); setNewWorkspaceMode('code'); setSeed(next); setNewProjectless(false); setNewProjectPath(next.cwd ?? ''); setThreadKey(null); setNewThread(true);
      }}
      onClose={closeThread}
      onNew={(mode, cwd, projectless) => { if (!cwd && !projectless) { showToast('请返回目录选择新会话的开始方式', 'alert'); return; } setSeed(null); setNewProjectless(projectless === true); setNewProjectPath(projectless ? '' : cwd!); setNewWorkspaceMode(mode ?? workspaceMode); setThreadKey(null); setNewThread(true); }}
      onCreated={(key) => { setSeed(null); setNewThread(false); setThreadKey(key); }} />
    <ProgrammingPanel visible={visible && menu} placement="menu" onClose={closeMenu}>
      <View style={styles.menuList}>
        {notificationsSupported() ? <>
          <Pressable accessibilityRole="button" accessibilityLabel={`任务通知：${notify ? '已开启' : '已关闭'}`} onPress={() => void setNotificationsEnabled(!notify)} style={({ pressed }) => [styles.menuItem, pressed && styles.menuPressed]}>
            <Icon name="alarm" size={17} color={dk.text2} /><Text style={styles.menuText}>任务通知</Text>
            <View style={[styles.toggle, notify && styles.toggleOn]}><View style={[styles.knob, notify && styles.knobOn]} /></View>
          </Pressable>
          {notify && (!notifyPermission || push.status === 'permission') ? <Pressable accessibilityRole="button" accessibilityLabel="打开系统通知设置" onPress={() => void openSystemPermissionSettings()} style={styles.menuNote}>
            <Icon name="info" size={14} color={dk.muted} /><Text style={styles.menuNoteText}>系统通知未允许 · 去设置</Text></Pressable> : null}
          {notify && !directSelected && notifyPermission && push.status === 'fcm' ? <View style={styles.menuNote}><Icon name="checkCircle" size={14} color={dk.ok} />
            <Text style={styles.menuNoteText}>推送已登记，送达仍受网络和系统限制</Text></View> : null}
          {notify && !directSelected && Platform.OS === 'ios' && push.status !== 'fcm' && push.status !== 'unpaired' && push.status !== 'permission' ? <View style={styles.menuNote}><Icon name={push.status === 'error' ? 'alert' : 'info'} size={14} color={push.status === 'error' ? dk.bad : dk.muted} />
            <Text style={styles.menuNoteText}>{push.status === 'unconfigured' ? '此版本尚未配置 iOS 推送' : push.status === 'hub-off' ? '中转站尚未启用推送' : '推送连接暂时不可用'}</Text></View> : null}
          {notify && relayBackground && notifyPermission && Platform.OS === 'android' && push.status !== 'fcm' && push.status !== 'unsupported' && push.status !== 'unpaired' && push.status !== 'permission' ? <Pressable accessibilityRole="switch" accessibilityState={{ checked: push.standby }}
            accessibilityLabel="后台待命" accessibilityHint="在系统允许时保持后台连接；强行停止后需要重新打开 App" onPress={() => void setStandbyEnabled(!push.standby)} style={({ pressed }) => [styles.menuItem, styles.menuDetailedItem, pressed && styles.menuPressed]}>
            <Icon name="bolt" size={17} color={dk.text2} />
            <View style={{ flex: 1, gap: 3 }}><Text style={[styles.menuText, { flex: 0 }]}>后台待命</Text>
              <Text style={styles.menuNoteText}>{push.status === 'error' ? '推送连接暂时不可用' : push.status === 'no-google' ? '这台手机收不到推送，开启后保持连接' : '中转站未开启推送，开启后保持连接'}</Text></View>
            <View style={[styles.toggle, push.standby && styles.toggleOn]}><View style={[styles.knob, push.standby && styles.knobOn]} /></View>
          </Pressable> : null}
          {notify && relayBackground && notifyPermission && Platform.OS === 'android' && push.standby && push.status !== 'fcm' && watchStatus ? <View style={styles.menuNote}>
            <Icon name={watchStatus.running && watchStatus.standby ? 'checkCircle' : 'info'} size={14} color={watchStatus.running && watchStatus.standby ? dk.ok : dk.muted} />
            <Text style={styles.menuNoteText}>{watchStatus.running && watchStatus.standby ? watchStatus.reason === 'storage' ? '后台待命运行中，但本机恢复存储未就绪；系统回收后请重新打开 App' : '后台待命运行中，退到后台后继续关注任务' : watchStatus.reason === 'authentication' ? '后台连接凭据已失效，请重新连接电脑' : watchStatus.reason === 'expired' ? '后台待命已到期，重新开启后继续接收提醒' : watchStatus.reason === 'restricted' ? '系统限制了后台运行，请检查设置后重试' : '后台待命尚未运行，可重试或检查系统设置'}</Text>
          </View> : null}
          {notify && relayBackground && notifyPermission && Platform.OS === 'android' && push.standby && push.status !== 'fcm' && watchStatus && !watchStatus.running ? <Pressable accessibilityRole="button" accessibilityLabel="重新连接任务提醒" onPress={() => void retryBackgroundNotifications()} style={({ pressed }) => [styles.menuItem, pressed && styles.menuPressed]}>
            <Icon name="regenerate" size={17} color={dk.text2} /><Text style={styles.menuText}>重新连接任务提醒</Text>
          </Pressable> : null}
          {notify && directSelected ? <View style={styles.menuNote}><Icon name="info" size={14} color={dk.muted} /><Text style={styles.menuNoteText}>电脑直连没有服务端推送，请保持 App 打开查看任务进展。</Text></View> : null}
          {notify && !directSelected && profile?.botGroupId && Platform.OS === 'android' && push.status !== 'fcm' ? <View style={styles.menuNote}><Icon name="info" size={14} color={dk.muted}/><Text style={styles.menuNoteText}>Bot 暂不支持后台待命，请返回 App 查看任务进展。</Text></View> : null}
          {notify && relayBackground && Platform.OS === 'android' ? <Pressable accessibilityRole="button" accessibilityLabel="让提醒更及时" onPress={menuAction(() => setBackgroundHelp(true))} style={({ pressed }) => [styles.menuItem, pressed && styles.menuPressed]}>
            <Icon name="lock" size={17} color={dk.text2} /><Text style={styles.menuText}>让提醒更及时</Text></Pressable> : null}
        </> : <View style={styles.menuNote}><Text style={styles.menuNoteText}>当前版本不支持系统任务通知。</Text></View>}
      </View>
    </ProgrammingPanel>
    <AppDialog visible={visible && backgroundHelp} title="让任务提醒更及时" icon="alarm" onClose={() => setBackgroundHelp(false)}
      message={'部分手机会限制后台应用，任务提醒可能延迟。系统回收进程后，Salcara 会在系统允许重启服务时尝试恢复连接；强行停止、重启手机或厂商限制后，请重新打开 App。\n\n任务观察最长 2 小时；后台待命的恢复凭据最长保留 7 天，打开 App 后再次进入后台会续期。关闭通知、停止待命或解除配对会清除相应恢复凭据。\n\n可在系统设置中允许通知和后台运行；若需要更及时的提醒，可将电池优化设为「不限制」。'}
      actions={[{ label: '稍后', tone: 'secondary', onPress: () => setBackgroundHelp(false) }, { label: '去设置', tone: 'primary', onPress: () => { setBackgroundHelp(false); void openSystemPermissionSettings(); } }]} />
    <RemoteApiLibrary visible={visible && apiLibrary} deviceId={deviceId} simulatedAgents={simulatedAgents}
      onSimulatedApiChange={(agentId, accountId) => setDemoApiAssignments(previous => ({ ...previous, [agentId]: accountId }))}
      computerName={simulatedDevice ? simulatedDeviceName : profile?.deviceId === deviceId ? connectionDisplayName(profile) : undefined}
      onClose={() => setApiLibrary(false)} />
    <ToastHost />
  </SafeAreaView>;
}

// ——— QR pairing ———

export function QrPairing({ visible, remote, onPaired, onBotPaired, onSimulatedPaired, simulateWebPairing = false, autoScan = false }: { visible: boolean; remote: RemoteState; onChangeStation?: () => void; onPaired?: (direct?: boolean) => void; onBotPaired?: (selection: ComputerSelection) => void; onSimulatedPaired?: () => void; simulateWebPairing?: boolean; autoScan?: boolean }) {
  const p = useProgrammingStyles();
  const dk = useDesk();
  const styles = useStyles();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [pending, setPending] = useState<PairQr | DirectPairQr | null>(null);
  const directState = useSyncExternalStore(subscribeDirectConnection, getDirectConnectionState, getDirectConnectionState);
  const directResult = directState.deviceId ? directState : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanGate = useRef(false);
  const confirmGate = useRef(false);
  const startGate = useRef(false);
  const autoStarted = useRef(false);
  const isVisible = useRef(visible); isVisible.current = visible;
  useEffect(() => () => { isVisible.current = false; scanGate.current = true; }, []);
  useEffect(() => { if (!visible) { setScanning(false); setPending(null); scanGate.current = true; autoStarted.current = false; } }, [visible]);
  const start = async () => {
    if (!isVisible.current || confirmGate.current || startGate.current) return;
    startGate.current = true;
    try {
      const allowed = permission?.granted ? permission : await requestPermission();
      if (!isVisible.current) return;
      if (!allowed.granted) { setError('请允许相机权限，用来扫描电脑上的二维码'); return; }
      setError(null); setPending(null); scanGate.current = false; setScanning(true);
    } catch { if (isVisible.current) setError('相机无法启动，请检查权限或重试'); }
    finally { startGate.current = false; }
  };
  useEffect(() => { if (visible && autoScan && !autoStarted.current) { autoStarted.current = true; void start(); } }, [visible, autoScan]); // eslint-disable-line react-hooks/exhaustive-deps
  const scan = ({ data, type }: { data: string; type?: string }) => {
    if (type && type !== 'qr') return;
    if (scanGate.current || !visible) return;
    scanGate.current = true; setScanning(false);
    try { setPending(isDirectPairQr(data) ? parseDirectPairQr(data) : parseScannedRemoteQr(data)); }
    catch (reason) { setError((reason as Error).message); }
  };
  const confirm = async () => {
    if (!isVisible.current || !pending || confirmGate.current) return;
    confirmGate.current = true;
    setBusy(true); setError(null);
    try {
      if (isDirectPending(pending)) {
        const result = await pairDirectQr(pending);
        if (!isVisible.current) return;
        setPending(null);
        if (result.status !== 'connected') setError(result.error ?? '电脑直连未就绪');
        else { showToast('电脑已通过局域网 / VPN 直连', 'check'); onPaired?.(true); }
      } else {
        await pairScannedRemoteQr(pending, () => isVisible.current);
        if (!isVisible.current) return;
        setPending(null); showToast('电脑配对成功', 'check'); onPaired?.(false);
      }
    }
    catch (reason) { setPending(null); setError((reason as Error).message); }
    finally { confirmGate.current = false; setBusy(false); }
  };
  const directPending = pending && isDirectPending(pending) ? pending : null;
  return <>
    <ScrollView contentContainerStyle={p.page}>
      <ProgrammingHeading title="扫码连接" subtitle="首次绑定电脑时扫描一次，之后无需重复扫码" step={autoScan ? '01 / 01' : '02 / 02'} />
      <ProgrammingCard soft><View style={styles.scanPreview}>
        <View style={styles.scanFrame}>
          {(['tl', 'tr', 'bl', 'br'] as const).map(corner => <View key={corner} style={[styles.scanCorner, styles[corner]]} />)}
          <Icon name="laptop" size={34} color={dk.text2} strokeWidth={1.3} />
        </View>
        <Text style={p.detail}>只连接你自己的电脑</Text></View></ProgrammingCard>
      {directResult ? <ProgrammingCard style={{ marginTop: 12 }}>
        <ProgrammingRow first icon={directResult.status === 'connected' ? 'checkCircle' : directResult.status === 'error' ? 'alert' : 'laptop'} title={directResult.deviceName || directResult.deviceId || '电脑直连'}
          detail={directResult.status === 'connected' ? '直连身份验证完成' : directResult.status === 'connecting' || directResult.status === 'authenticating' ? '正在建立直连' : directResult.status === 'closed' ? '直连已断开' : directResult.error || '直连不可用'} />
        {directResult.status === 'connected' ? <View style={styles.directNotice}><Text style={p.detail}>直连已就绪，会话与消息将通过这条加密连接传输。</Text></View> : null}
      </ProgrammingCard> : null}
      <ProgrammingAction label={directResult?.status === 'connected' ? '重新扫码' : '扫描二维码'} icon="scan" disabled={busy} onPress={() => void start()} style={{ marginTop: 18 }} />
      {simulateWebPairing && onSimulatedPaired ? <ProgrammingAction tone="secondary" label="模拟扫描电脑二维码" icon="laptop" disabled={busy} onPress={() => { setError(null); onSimulatedPaired(); }} style={{ marginTop: 10 }} /> : null}
      {permission && !permission.granted && !permission.canAskAgain ? <ProgrammingAction tone="secondary" label="打开相机权限设置" onPress={() => void openSystemPermissionSettings()} style={{ marginTop: 10 }} /> : null}
      {error ? <Text accessibilityRole="alert" style={p.error}>{error}</Text> : null}
      <Text style={p.note}>打开电脑端「手机远程」显示的二维码。绑定完成后会自动保存这台电脑。</Text>
      <RemoteBotBinding remote={remote} visible={visible} onBound={(id) => onBotPaired ? onBotPaired(id) : onPaired?.(false)} />
    </ScrollView>
    <Sheet visible={visible && scanning} presentation="page" scroll={false} title="扫描二维码" onClose={() => { scanGate.current = true; setScanning(false); }}>
      {visible && scanning && permission?.granted ? <CameraView testID="remote-qr-camera" style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scan}
        onMountError={() => { scanGate.current = true; setScanning(false); setError('相机无法启动，请检查权限或重试'); }} /> : null}
    </Sheet>
    <AppDialog visible={visible && Boolean(pending)} title="连接这台电脑？" icon="laptop" dismissible={!busy} onClose={() => { if (!busy) setPending(null); }}
      message={directPending
        ? '将通过局域网 / VPN 加密直连连接这台电脑。会话与消息只走此直连，不经过 Salcara Hub；不支持公网 NAT 穿透。'
        : '配对后可在手机上查看会话、发送任务与批准操作。'}
      actions={[
        { label: '取消', tone: 'secondary', disabled: busy, onPress: () => setPending(null) },
        { label: busy ? '正在连接…' : directPending ? '建立直连' : '连接', tone: 'primary', disabled: busy, onPress: () => void confirm() },
      ]}>
      {pending ? <View style={styles.pairDevice}><Icon name="laptop" size={16} color={dk.text2} />
        <View style={{ flex: 1, minWidth: 0 }}><Text style={p.name} numberOfLines={1}>{directPending?.deviceName || pending.deviceName || pending.deviceId}</Text>
          <Text style={p.detail} numberOfLines={1}>{directPending ? `直连 · ${new URL(directPending.urls[0]).host}` : isDirectPending(pending) ? '' : new URL(pending.hubUrl).host}</Text></View></View> : null}
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

const useStyles = themed((c, d) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: d.bg },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, height: 56 },
  topCenter: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  center: { paddingVertical: 64, alignItems: 'center' },
  choiceList: { gap: 6 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingHorizontal: 12, paddingVertical: 9, borderRadius: 14, backgroundColor: d.surface2, borderWidth: 1, borderColor: 'transparent' },
  choiceOn: { backgroundColor: d.surface, borderColor: d.ink }, choicePressed: { backgroundColor: d.surface3 },
  menuList: { marginHorizontal: -6, gap: 4, flexShrink: 0 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingHorizontal: 12, borderRadius: 12 },
  menuDetailedItem: { paddingVertical: 10, minHeight: 76, flexShrink: 0 },
  menuPressed: { backgroundColor: d.press }, menuText: { flex: 1, fontSize: 14, color: d.text, fontWeight: '500' },
  menuNote: { flexDirection: 'row', alignItems: 'flex-start', flexShrink: 0, gap: 6, paddingHorizontal: 12, paddingVertical: 6 },
  menuNoteText: { flexShrink: 1, fontSize: 11.5, lineHeight: 16, color: d.muted },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: d.line, marginVertical: 6, marginHorizontal: 12 },
  toggle: { width: 40, height: 24, borderRadius: 12, backgroundColor: d.surface3, padding: 2 }, toggleOn: { backgroundColor: d.accent },
  knob: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 }, knobOn: { transform: [{ translateX: 16 }] },
  pairDevice: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, padding: 12, borderRadius: 12, backgroundColor: d.surface2 },
  directNotice: { paddingHorizontal: 14, paddingBottom: 12 },
  page: { paddingHorizontal: 16, paddingBottom: 40 }, 
  error: { color: d.bad, fontSize: 13, lineHeight: 19 }, 
  link: { color: d.accentText, fontSize: 12.5, fontWeight: '500' }, 
  scanPreview: { alignItems: 'center', gap: 12, paddingVertical: 22 }, scanFrame: { width: 112, height: 112, backgroundColor: d.surface, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  scanCorner: { position: 'absolute', width: 22, height: 22, borderColor: d.ink },
  tl: { top: 14, left: 14, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 9 }, tr: { top: 14, right: 14, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 9 },
  bl: { bottom: 14, left: 14, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 9 }, br: { bottom: 14, right: 14, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 9 },
  agentGlyph: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },  smallLink: { minHeight: 44, paddingLeft: 12, justifyContent: 'center' },
}));
