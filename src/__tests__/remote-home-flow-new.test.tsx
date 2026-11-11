import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteScreen } from '../remote/RemoteScreen';
import { sessionAgent } from '../remote/RemoteHome';
import type { AgentId, AgentProfile, DeviceStatus, SessionInfo } from '../remote/client';
import type { RemoteState } from '../remote/store';

const mockLoadAgents = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockLoadSessions = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockLoadNative = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockLoadHistory = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockLastAgent = jest.fn<Promise<AgentId>, []>(async () => 'codex');
const mockRememberAgent = jest.fn();
jest.mock('../remote/agent-preferences', () => ({ readPreferredAgent: () => mockLastAgent(),
  rememberPreferredAgent: (_scope: unknown, agent: AgentId) => { mockRememberAgent(agent); return Promise.resolve(); } }));
const mockExplorer = jest.fn();
jest.mock('../remote/project-browser', () => ({ ...jest.requireActual('../remote/project-browser'), projectBrowserRequest: (_transport: string, _device: string, tool: string, mode: string) => (input: unknown) => mockExplorer(tool, mode, input) }));
const mockSetApi = jest.fn();
const mockToast = jest.fn();
const mockSwitchSpace = jest.fn();
const mockConnectStation = jest.fn();
const mockPairQr = jest.fn();
const mockUseConnection = jest.fn();
let mockSavedComputer:import('../remote/computer-connections').ComputerSelection|null=null;
let mockDirectState:import('../remote/direct-pairing').DirectConnectionState={status:'idle'};
let mockDirectPeers:import('../remote/direct-pairing').DirectPairingInfo[]=[];
const mockSaveComputer=jest.fn(),mockReconnectDirect=jest.fn();
jest.mock('../remote/computer-selection',()=>({readComputerSelection:async()=>mockSavedComputer,saveComputerSelection:(...args:unknown[])=>mockSaveComputer(...args)}));
jest.mock('../remote/direct-pairing',()=>({...jest.requireActual('../remote/direct-pairing'),
  getDirectConnectionState:()=>mockDirectState,subscribeDirectConnection:()=>()=>{},restoreDirectPairing:async()=>mockDirectState,
  listDirectPairings:async()=>mockDirectPeers,reconnectDirect:(id:string)=>mockReconnectDirect(id)}));
jest.mock('../remote/DirectExperience',()=>({DirectExperience:()=>{const {Text}=require('react-native');return <Text>直连工作区 {mockDirectState.deviceId}</Text>;}}));
const mockProbeConnections = jest.fn<Promise<Record<string, 'online' | 'offline' | 'unreachable' | 'reauth'>>, []>(async () => ({ paired: 'online' }));
const mockSignOut = jest.fn();
const mockRevoke = jest.fn();
const mockRenameRemote = jest.fn<Promise<void>, [string, string]>(async () => undefined);
const mockRevokeById = jest.fn<Promise<void>, [string]>(async () => undefined);
const mockOpenDesktopGithub = jest.fn();
const mockScreenOpen = jest.fn();
let mockRemote: RemoteState;
let mockMenuActions: Array<{ label: string; onPress: () => void }> = [];
let mockThreadProps: {
  visible: boolean; sessionKey: string | null; deviceId: string | null; agent: AgentProfile | null; verifying?: boolean;
  newProjectPath?: string; newProjectless?: boolean;
  onClose: () => void;
};
const mockQr = { type: 'salcara-remote-pair', version: 1, hubUrl: 'https://station.example/salcara-hub/v1',
  deviceId: 'pc-1', deviceName: '工作电脑', ticket: 'a'.repeat(64), expiresAt: Date.now() + 120_000 };

jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [{ granted: true }, jest.fn()],
  CameraView: (props: unknown) => { const React = require('react'); const { View } = require('react-native'); return React.createElement(View, props); },
}));
jest.mock('react-native', () => {
  const React = require('react'); const actual = jest.requireActual('react-native'); const replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, style, ...props }: Record<string, any>) =>
    React.createElement(actual.View, { ...props, accessible: props.accessible ?? true, accessibilityState: { ...props.accessibilityState, ...(props.disabled !== undefined ? { disabled: props.disabled } : {}) }, style: typeof style === 'function' ? style({ pressed: false }) : style }, typeof children === 'function' ? children({ pressed: false }) : children) });
  return replacement;
});
jest.mock('../components/Icon', () => ({ Icon: () => null }));
// RemoteScreen can pass optional speech configuration to ThreadView. These
// deliberately unrelated phone fixtures must never enter the Agent API catalog.
jest.mock('../state/AppContext', () => ({ useApp: () => ({
  providers: [{ id: 'speech-fixture', name: '手机语音专用', baseUrl: 'https://speech.example', apiKey: '', models: ['speech-only-fixture'] }],
  chatProvider: null, switchSpace: mockSwitchSpace,
}) }));
jest.mock('../companion/SpaceSwitch', () => ({ SpaceSwitch: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react'); const { View } = require('react-native');
  return { SafeAreaView: ({ children }: { children: unknown }) => React.createElement(View, null, children) };
});
jest.mock('../remote/ConnectionIndicator', () => ({ ConnectionIndicator: () => null }));
jest.mock('../remote/RemoteDownloads', () => ({ openDesktopGithub: () => mockOpenDesktopGithub() }));
jest.mock('../remote/useDemandSync', () => ({ useDemandSync: () => undefined }));
jest.mock('../remote/ProgrammingUi', () => {
  const React = require('react'); const { Pressable, Text, View } = require('react-native');
  // Navigation tests own visibility; the native panel animation is covered by
  // programming-ui / programming-sheet-lock, not this controllable host.
  const panel = ({ visible, title, children, footer, headerRight }: Record<string, any>) => visible
    ? React.createElement(View, null, title ? React.createElement(Text, null, title) : null, headerRight, children, footer) : null;
  return { ...jest.requireActual('../remote/ProgrammingUi'), ProgrammingPanel: panel, ProgrammingSheet: panel, ProgrammingAction: ({ label, onPress, disabled, loading, ...props }: Record<string, any>) => {
    return React.createElement(Pressable, { ...props, accessibilityRole: 'button', accessibilityLabel: props.accessibilityLabel ?? label, accessibilityState: { disabled: Boolean(disabled || loading), busy: Boolean(loading) }, disabled: Boolean(disabled || loading), onPress }, React.createElement(Text, null, label));
  } };
});
jest.mock('../remote/RemoteApiLibrary', () => ({
  RemoteApiLibrary: ({ visible, deviceId, onClose }: { visible: boolean; deviceId: string | null; onClose: () => void }) => {
    if (!visible) return null;
    const React = require('react'); const { View, Text, Pressable } = require('react-native');
    return React.createElement(View, null, React.createElement(Text, null, '电脑 API 资源库'),
      React.createElement(Text, null, `当前电脑 API：${deviceId ?? '未选择'}`),
      ...(mockRemote.agents[deviceId ?? '']?.apis ?? []).map(api => React.createElement(Text, { key: api.id }, api.name)),
      React.createElement(Pressable, { accessibilityLabel: '返回 API 资源库', onPress: onClose }, React.createElement(Text, null, '返回 API 资源库')));
  },
}));
jest.mock('../remote/ThreadView', () => ({
  ThreadView: (props: typeof mockThreadProps) => { mockThreadProps = props; return null; },
}));
jest.mock('../remote/store', () => ({
  hubSupportsExplorer: () => true, hubSupportsProjectless: () => true,
  useRemote: () => mockRemote,
  hydrateCachedThread: async () => undefined, hydrateCachedSessions: async () => undefined,
  getRemoteState: () => mockRemote,
  timelineKey: (deviceId:string, sessionKey:string) => `${deviceId}:${sessionKey}`,
  loadAgentProfiles: (...args: unknown[]) => mockLoadAgents(...args),
  loadSessions: (...args: unknown[]) => mockLoadSessions(...args),
  loadNativeSessions: (...args: unknown[]) => mockLoadNative(...args),
  loadClaudeDesktopHistory: (...args: unknown[]) => mockLoadHistory(...args),
  loadMoreSessions: jest.fn(async () => undefined),
  setAgentApi: (...args: unknown[]) => mockSetApi(...args),
  lastAgent: () => mockLastAgent(), rememberAgent: (...args: unknown[]) => mockRememberAgent(...args),
  setRemoteScreenOpen: (...args: unknown[]) => mockScreenOpen(...args),
  setRemoteFocus: (focus: RemoteState['focus']) => { mockRemote.focus = focus; },
  connectStation: (...args: unknown[]) => mockConnectStation(...args),
  pairRemote: jest.fn(), pairScannedRemoteQr: (...args: unknown[]) => mockPairQr(...args), parseScannedRemoteQr: () => mockQr,
  revokeRemoteConnection: (...args: unknown[]) => mockRevoke(...args),
  probeSavedConnections: () => mockProbeConnections(),
  renameRemoteConnection: (...args: [string, string]) => mockRenameRemote(...args),
  revokeRemoteConnectionById: (...args: [string]) => mockRevokeById(...args),
  signOutRemote: (...args: unknown[]) => mockSignOut(...args),
  useSavedConnection: (...args: unknown[]) => mockUseConnection(...args),
}));
jest.mock('../components/ui', () => {
  const React = require('react'); const { View, Text, Pressable } = require('react-native');
  const button = ({ label, onPress, disabled }: { label: string; onPress?: () => void; disabled?: boolean }) =>
    React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: label, onPress, disabled }, React.createElement(Text, null, label));
  const pass = ({ children }: { children: unknown }) => React.createElement(View, null, children);
  return {
    PrimaryButton: button, IconButton: button, Group: pass, Appear: pass,
    MotionPressable: ({ children, onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled }: Record<string, unknown>) =>
      React.createElement(Pressable, { onPress, accessibilityLabel, accessibilityRole, accessibilityState, disabled }, children),
    Sheet: ({ visible, title, children, headerRight, footer }: { visible: boolean; title: string; children: unknown; headerRight: unknown; footer: unknown }) => visible
      ? React.createElement(View, null, React.createElement(Text, null, title), headerRight, children, footer) : null,
    SectionLabel: ({ children }: { children: unknown }) => React.createElement(Text, null, children),
    AppDialog: ({ visible, message, actions }: { visible: boolean; message: string; actions: Array<{ label: string; onPress: () => void; disabled?: boolean }> }) => {
      if (visible) mockMenuActions = actions;
      return visible ? React.createElement(View, null, React.createElement(Text, null, message), ...actions.map((action) => React.createElement(Pressable, { key: action.label, onPress: action.onPress, disabled: action.disabled }, React.createElement(Text, null, action.label)))) : null;
    },
    Sheen: () => null, BrandFill: () => null, ToastHost: () => null, useReducedMotion: () => true,
    showToast: (...args: unknown[]) => mockToast(...args), dismissKeyboardAndBlur: () => undefined,
  };
});

function agent(id: AgentId, name: string, tool: AgentProfile['tool']): AgentProfile {
  return { id, name, tool, available: true, remoteSendSupported: true,
    api: { name: `${name} 主力 API`, model: 'fixture-model', protocol: 'responses', configured: true,
      pending: false, source: 'computer', accountId: 'api_00112233445566778899' } };
}

function readyState(): RemoteState {
  const device: DeviceStatus = { deviceId: 'pc-1', name: '工作电脑', os: 'windows', online: true, lastSeen: 1,
    tools: [{ id: 'codex', name: 'Codex', available: true }, { id: 'claude', name: 'Claude Code', available: true }], projects: [] };
  const sessions: SessionInfo[] = [
    { sessionKey: 'codex:app', tool: 'codex', client: 'Codex App', title: '修复购物车', cwd: 'C:\\code\\shop', updatedAt: 3, status: 'idle', controllable: true, controlSurface: 'cli' },
    { sessionKey: 'claude:desktop', tool: 'claude', client: 'Claude Desktop', title: '桌面 Claude 项目', cwd: 'C:\\code\\web', updatedAt: 2, status: 'idle', controllable: true, controlSurface: 'cli' },
    { sessionKey: 'claude:cli', tool: 'claude', client: 'Claude Code', title: '终端 Claude 项目', cwd: 'C:\\code\\api', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' },
  ];
  return { phase: 'ready', serviceId: null, connectionId: 'paired', selectedHubUrl: mockQr.hubUrl,
    connections: [{ id: 'paired', deviceId: 'pc-1', deviceName: '工作电脑', hubUrl: mockQr.hubUrl, pairedAt: 1 }],
    probes: {}, connection: 'open', devices: [device], devicesLoaded: true,
    agents: { 'pc-1': { list: [agent('codex', 'Codex', 'codex'), agent('claude-desktop', 'Claude Desktop', 'claude'), agent('claude', 'Claude Code', 'claude')],
      apis: [{ id: 'api_00112233445566778899', name: '主力', models: ['fixture-model'] }], loading: false, loaded: true } },
    sessions: { 'pc-1': { list: sessions, loading: false, loaded: true } }, timelines: {}, approvals: {}, signingIn: null, focus: null } as RemoteState;
}

function unpairedState(phase: RemoteState['phase'] = 'setup'): RemoteState {
  return { ...readyState(), phase, connectionId: null, selectedHubUrl: phase === 'pairing' ? mockQr.hubUrl : null,
    connections: [], connection: 'idle', devices: [], devicesLoaded: false, agents: {}, sessions: {} };
}

test('global home entry chooses Agent, disk and a new folder before opening the selected Agent editor', async () => {
  mockRemote.devices[0].capabilities = ['workspace.explorer.v1', 'session.projectless.v1'];
  mockExplorer.mockImplementation(async (tool, workspaceMode, input) => ({ tool, workspaceMode, cwd: input.cwd, path: input.path,
    ...(!input.cwd ? { roots: [{ path: 'C:/', name: '本地磁盘 (C:)' }] } : input.action === 'mkdir' ? { project: { path: 'C:/new-project', name: input.name } } : { directory: { path: '', entries: [] } }) }));
  const view = await render(<RemoteScreen />);
  await fireEvent.press(await view.findByLabelText('新建全局会话'));
  expect(view.getByLabelText('选择 Codex')).toBeTruthy(); expect(view.getByLabelText('选择 Claude Code')).toBeTruthy(); expect(mockExplorer).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('选择 Claude Code'));
  await fireEvent.press(await view.findByLabelText('浏览磁盘 C:/'));
  await fireEvent.press(await view.findByLabelText('在此位置新建文件夹'));
  await fireEvent.changeText(view.getByLabelText('新文件夹名称'), 'new-project');
  await fireEvent.press(view.getByLabelText('创建文件夹并使用'));
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: null, agent: { id: 'claude' }, newProjectPath: 'C:/new-project', newProjectless: false });
  expect(mockExplorer.mock.calls.at(-1)).toEqual(['claude', 'code', { action: 'mkdir', cwd: 'C:/', path: '', name: 'new-project' }]);
  await view.unmount();
});

test.each(['code', 'work'] as const)('global %s no-folder entry still chooses its Agent first', async mode => {
  mockRemote.devices[0].capabilities = ['session.projectless.v1'];
  const view = await render(<RemoteScreen />);
  if (mode === 'work') await fireEvent.press(await view.findByRole('tab', { name: 'Work' }));
  await fireEvent.press(await view.findByLabelText('新建全局会话'));
  await fireEvent.press(view.getByLabelText('选择 Codex'));
  await fireEvent.press(await view.findByLabelText('不关联文件夹，直接开始'));
  expect(mockThreadProps).toMatchObject({ visible: true, agent: { id: 'codex' }, newProjectPath: '', newProjectless: true });
  expect(mockExplorer).not.toHaveBeenCalled(); await view.unmount();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSavedComputer=null;mockDirectState={status:'idle'};mockDirectPeers=[];mockSaveComputer.mockResolvedValue(undefined);
  mockReconnectDirect.mockImplementation(async(id:string)=>{mockDirectState={status:'connected',deviceId:id,deviceName:mockDirectPeers.find(item=>item.deviceId===id)?.deviceName};return mockDirectState;});
  mockProbeConnections.mockImplementation(async () => ({ paired: 'online' }));
  mockLastAgent.mockReset(); mockLoadAgents.mockReset(); mockLoadSessions.mockReset(); mockLoadNative.mockReset(); mockLoadHistory.mockReset();
  mockRemote = readyState();
  mockMenuActions = [];
  mockThreadProps = { visible: false, sessionKey: null, deviceId: null, agent: null, onClose: () => undefined };
  mockLastAgent.mockImplementation(async () => 'codex');
  mockLoadAgents.mockImplementation(async () => undefined);
  mockLoadSessions.mockImplementation(async () => undefined);
  mockLoadNative.mockImplementation(async () => undefined);
  mockLoadHistory.mockImplementation(async () => undefined);
  mockConnectStation.mockImplementation(async () => {
    mockRemote = { ...unpairedState('pairing'), connections: mockRemote.connections };
  });
  mockPairQr.mockImplementation(async () => { mockRemote = readyState(); });
  mockUseConnection.mockImplementation(async () => undefined);
});

test('restores the chosen direct computer instead of the previous Hub or another native connection', async()=>{
  mockSavedComputer={kind:'direct',deviceId:'direct-B'};
  mockDirectPeers=[{deviceId:'direct-B',deviceName:'书房电脑 B',endpoint:'wss://192.168.1.8/direct',pairedAt:1,pairingScope:'direct:binding-b'}];
  mockDirectState={status:'connected',deviceId:'direct-C',deviceName:'电脑 C'};
  const view=await render(<RemoteScreen visible/>);
  expect(view.getByLabelText('连接电脑').props.accessibilityHint).toContain('书房电脑 B');
  expect(view.getByText('直连 · 未连接')).toBeTruthy();
  expect(view.queryByText('修复购物车')).toBeNull();
  expect(view.queryByLabelText('API 管理')).toBeNull();
  expect(mockLoadSessions).not.toHaveBeenCalled();expect(mockLoadAgents).not.toHaveBeenCalled();
  expect(mockReconnectDirect).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('打开电脑直连'));
  expect(mockReconnectDirect).toHaveBeenCalledWith('direct-B');
  expect(view.getByText('直连工作区 direct-B')).toBeTruthy();
  expect(mockSaveComputer).toHaveBeenLastCalledWith({kind:'direct',deviceId:'direct-B'});
});

test.each(['removed-direct','mismatched-bot'] as const)('a %s saved choice opens device selection without silently falling back',async kind=>{
  mockSavedComputer=kind==='removed-direct'?{kind:'direct',deviceId:'deleted'}:{kind:'bot',connectionId:'old-bot',deviceId:'pc-2'};
  const view=await render(<RemoteScreen visible/>);
  expect(view.getByText('设备管理')).toBeTruthy();
  expect(view.queryByText('修复购物车')).toBeNull();
  expect(mockSaveComputer).toHaveBeenLastCalledWith(null);
  expect(mockUseConnection).not.toHaveBeenCalled();
});

test('phone switches relay A to Bot B to direct C and back to relay A with isolated destinations',async()=>{
  const first=readyState(), bot={id:'bot-B',deviceId:'B',deviceName:'Bot 电脑 B',hubUrl:'https://bot.example/v1',botGroupId:'group-B',pairedAt:2};
  const connections=[...first.connections,bot];
  mockRemote={...first,connections};
  mockDirectPeers=[{deviceId:'direct-C',deviceName:'直连电脑 C',endpoint:'wss://192.168.1.8/direct',pairedAt:1,pairingScope:'direct:binding-c'}];
  mockUseConnection.mockImplementation(async(id:string)=>{
    if(id==='paired'){mockRemote={...first,connections};return;}
    mockRemote={...first,connections,connectionId:bot.id,selectedHubUrl:bot.hubUrl,
      devices:[{...first.devices[0],deviceId:'B',name:bot.deviceName}],
      agents:{B:first.agents['pc-1']},sessions:{B:{loaded:true,loading:false,list:[]}}};
  });
  const view=await render(<RemoteScreen visible/>);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('选择电脑 Bot 电脑 B'));
  expect(view.getByLabelText('连接电脑').props.accessibilityHint).toContain('Bot 电脑 B');
  expect(mockSaveComputer).toHaveBeenLastCalledWith({kind:'bot',connectionId:'bot-B',deviceId:'B'});
  await fireEvent.press(view.getByLabelText('API 管理'));
  expect(view.getByText('当前电脑 API：B')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('返回 API 资源库'));
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText(/^选择直连电脑 直连电脑 C /));
  expect(view.getByText('直连工作区 direct-C')).toBeTruthy();
  expect(mockSaveComputer).toHaveBeenLastCalledWith({kind:'direct',deviceId:'direct-C'});
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.queryByLabelText('API 管理')).toBeNull();
  expect(view.queryByText('修复购物车')).toBeNull();
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('选择电脑 工作电脑'));
  expect(view.getByLabelText('连接电脑').props.accessibilityHint).toContain('工作电脑');
  expect(mockSaveComputer).toHaveBeenLastCalledWith({kind:'relay',connectionId:'paired',deviceId:'pc-1'});
  expect(view.getByText('修复购物车')).toBeTruthy();
  expect(mockReconnectDirect).toHaveBeenCalledTimes(1);
});

test('a late notification switch cannot take over after opening device management',async()=>{
  let finish!:()=>void;
  mockRemote.focus={connectionId:'bot-B',deviceId:'B',sessionKey:'codex:B'};
  mockUseConnection.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  const view=await render(<RemoteScreen visible/>);
  const guard=mockUseConnection.mock.calls[0][2].stillWanted;
  expect(guard()).toBe(true);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  expect(guard()).toBe(false);
  await act(async()=>{finish();});
  expect(view.getByText('设备管理')).toBeTruthy();
  expect(mockRemote.focus).toBeNull();
  expect(mockSaveComputer).not.toHaveBeenCalled();
});

test('a notification can switch from an open workspace to the exact Bot conversation',async()=>{
  const first=readyState(),bot={id:'bot-B',deviceId:'B',deviceName:'电脑 B',hubUrl:'https://bot.example/v1',botGroupId:'group-B',pairedAt:2};
  const session={...first.sessions['pc-1'].list[0],sessionKey:'codex:bot-task',title:'B 的任务'};
  const view=await render(<RemoteScreen visible/>);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  let finish!:()=>void;
  mockUseConnection.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
  mockRemote={...first,connections:[...first.connections,bot],focus:{connectionId:bot.id,deviceId:'B',sessionKey:session.sessionKey}};
  await view.rerender(<RemoteScreen visible/>);
  const guard=mockUseConnection.mock.calls[0][2].stillWanted;
  mockRemote={...mockRemote,focus:null,connectionId:bot.id,selectedHubUrl:bot.hubUrl,
    devices:[{...first.devices[0],deviceId:'B',name:bot.deviceName}],agents:{B:first.agents['pc-1']},sessions:{B:{loaded:true,loading:false,list:[session]}}};
  await view.rerender(<RemoteScreen visible/>);
  expect(guard()).toBe(true);
  await act(async()=>{finish();});
  await view.rerender(<RemoteScreen visible/>);
  expect(mockThreadProps).toMatchObject({visible:true,deviceId:'B',sessionKey:'codex:bot-task'});
  expect(mockSaveComputer).toHaveBeenLastCalledWith({kind:'bot',connectionId:bot.id,deviceId:'B'});
});

test.each(['setup', 'pairing', 'ready'] as const)('first entry remains on the home page when connection phase is %s', async (phase) => {
  mockRemote = phase === 'ready' ? readyState() : unpairedState(phase);
  const view = await render(<RemoteScreen visible />);
  expect(view.getByLabelText('连接电脑')).toBeTruthy();
  expect(view.getByLabelText('API 管理')).toBeTruthy();
  expect(view.getByLabelText('项目与会话')).toBeTruthy();
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(view.queryByText('扫描二维码')).toBeNull();
  expect(view.queryByLabelText('中转站地址')).toBeNull();
  expect(view.queryByText('准备连接')).toBeNull();
  expect(mockLoadAgents).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled();
  expect(mockThreadProps.visible).toBe(false);
}, 15_000);

test('recent tasks expose waiting and failed states before the approval cache arrives', async () => {
  mockRemote.sessions['pc-1'].list[0].status = 'waiting_approval';
  mockRemote.sessions['pc-1'].list[1].status = 'failed';
  const view = await render(<RemoteScreen visible />);
  expect(view.getByText('待回复')).toBeTruthy(); expect(view.getByText('失败')).toBeTruthy();
});

test.each(['api', 'menu'] as const)('an approval focus closes the %s overlay before opening its original conversation', async overlay => {
  const view = await render(<RemoteScreen visible />);
  if (overlay === 'menu') await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByLabelText(overlay === 'api' ? 'API 管理' : '更多'));
  if (overlay === 'api') expect(view.getByText('电脑 API 资源库')).toBeTruthy();
  else expect(view.getByText('当前版本不支持系统任务通知。')).toBeTruthy();
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'codex:app' };
  await view.rerender(<RemoteScreen visible />);
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'codex:app' });
  expect(view.queryByText('电脑 API 资源库')).toBeNull(); expect(view.queryByText('当前版本不支持系统任务通知。')).toBeNull();
});

test('a notification with an unverified source returns to the remote home without opening another task', async () => {
  const view = await render(<RemoteScreen visible />);
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'codex:app' };
  await view.rerender(<RemoteScreen visible />);
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'codex:app' });
  mockLoadSessions.mockClear(); mockLoadAgents.mockClear();
  mockRemote.focus = { home: true };
  await view.rerender(<RemoteScreen visible />);
  expect(mockThreadProps).toMatchObject({ visible: false, sessionKey: null });
  expect(mockLoadSessions).not.toHaveBeenCalled();
});

test('changing station clears an open API overlay rather than reopening it over the new station', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('API 管理'));
  mockRemote = { ...mockRemote, serviceId: 'new-station' };
  await view.rerender(<RemoteScreen visible />);
  expect(view.queryByText('电脑 API 资源库')).toBeNull();
});

test('hiding programming also hides API management opened from the Agent directory', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByLabelText('API 管理'));
  expect(view.getByText('电脑 API 资源库')).toBeTruthy();
  await view.rerender(<RemoteScreen visible={false} />);
  expect(view.queryByText('电脑 API 资源库')).toBeNull();
});

test.each(['hidden', 'scope', 'menu', 'closed', 'reopened', 'unmounted'] as const)('queued directory settings cannot reopen API management after %s', async condition => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  const settings = view.getByLabelText('API 管理').props.onPress as () => void;
  if (condition === 'hidden') await view.rerender(<RemoteScreen visible={false} />);
  else if (condition === 'scope') { mockRemote = { ...mockRemote, serviceId: 'another-relay' }; await view.rerender(<RemoteScreen visible />); }
  else if (condition === 'menu') await fireEvent.press(view.getByLabelText('更多'));
  else if (condition === 'unmounted') await view.unmount();
  else {
    await fireEvent.press(view.getByLabelText('返回'));
    if (condition === 'reopened') await fireEvent.press(view.getByLabelText('打开 Codex'));
  }
  mockLoadAgents.mockClear(); mockLoadSessions.mockClear();
  await act(async () => settings());
  if (condition !== 'unmounted') expect(view.queryByText('电脑 API 资源库')).toBeNull();
  expect(mockLoadAgents).not.toHaveBeenCalled(); expect(mockLoadSessions).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled(); expect(mockThreadProps.visible).toBe(false);
});

test('repeated directory API management presses open one library without reconnecting or applying a key', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  const settings = view.getByLabelText('API 管理').props.onPress as () => void;
  mockLoadAgents.mockClear(); mockLoadSessions.mockClear();
  await act(async () => { settings(); settings(); });
  expect(view.getAllByText('电脑 API 资源库')).toHaveLength(1);
  expect(view.getByText('当前电脑 API：pc-1')).toBeTruthy();
  expect(mockLoadAgents).not.toHaveBeenCalled(); expect(mockLoadSessions).not.toHaveBeenCalled();
  expect(mockConnectStation).not.toHaveBeenCalled(); expect(mockSetApi).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('返回 API 资源库'));
  expect(view.getByText('修复购物车')).toBeTruthy();
  expect(view.getByLabelText('在 shop 中新建 Code 对话')).toBeTruthy();
  expect(mockThreadProps).toMatchObject({ visible: false, agent: { id: 'codex' } });
});

test('homepage API count comes only from the active computer catalog', async () => {
  const view = await render(<RemoteScreen visible />);
  expect(view.getByText('1 个 API · 电脑密钥库')).toBeTruthy();
  expect(view.queryByText('手机语音专用')).toBeNull();
  expect(view.queryByText('speech-only-fixture')).toBeNull();
  expect(view.queryByText(/手机 API/)).toBeNull();
  expect(view.queryByText('添加 API')).toBeNull();
  mockRemote = { ...mockRemote, agents: { ...mockRemote.agents, 'pc-1': { ...mockRemote.agents['pc-1'], error: 'catalog unavailable' } } };
  await view.rerender(<RemoteScreen visible />);
  expect(view.queryByText('1 个 API · 电脑密钥库')).toBeNull();
  expect(view.getByText('电脑保存的密钥')).toBeTruthy();
});

test('desktop download opens the external helper from home without another setup page', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('下载电脑端'));
  expect(mockOpenDesktopGithub).toHaveBeenCalledTimes(1);
  expect(view.queryByText('选择安装包')).toBeNull();
  expect(view.queryByLabelText('下载站地址')).toBeNull();
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
});

test('the Agent menu has no duplicate navigation or device management actions', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByLabelText('更多'));
  for (const label of ['编程首页', '切换 Agent', '连接电脑', '连接诊断', '下载电脑端', '解除当前电脑配对']) {
    expect(view.queryByLabelText(label)).toBeNull();
  }
  // The single API entry belongs to the underlying Agent directory, not the menu.
  expect(view.getAllByLabelText('API 管理')).toHaveLength(1);
  expect(view.getByText('当前版本不支持系统任务通知。')).toBeTruthy();
  expect(mockOpenDesktopGithub).not.toHaveBeenCalled();
});
test('first computer entry opens scanning directly and keeps Bot connection at the bottom of the pairing page', async () => {
  mockRemote = unpairedState();
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  expect(view.getByText('扫码连接')).toBeTruthy();
  expect(view.queryByText('绑定新电脑')).toBeNull();
  expect(view.getByTestId('remote-qr-camera')).toBeTruthy();
  expect(view.queryByLabelText('中转站地址')).toBeNull();
  await act(async () => view.getByTestId('remote-qr-camera').props.onBarcodeScanned({ data: 'fixture', type: 'qr' }));
  await fireEvent.press(view.getByText('连接'));
  await view.rerender(<RemoteScreen visible />);
  expect(mockPairQr).toHaveBeenCalledWith(mockQr, expect.any(Function));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(view.queryByText('扫描二维码')).toBeNull();
  expect(view.queryByText('准备连接')).toBeNull();
});

test('computer management preserves saved paired records even without an active connection', async () => {
  mockRemote = { ...unpairedState('pairing'), connections: readyState().connections };
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  expect(view.getByText('工作电脑')).toBeTruthy();
  expect(view.getByText('设备管理')).toBeTruthy();
  expect(view.getByText('管理')).toBeTruthy();
  expect(view.getByText('绑定新电脑')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
});

test('direct scanner returns to computer management without unpairing saved computers', async () => {
  mockRemote = { ...unpairedState(), connections: readyState().connections };
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByText('绑定新电脑'));
  expect(view.getByTestId('remote-qr-camera')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.queryByLabelText('中转站地址')).toBeNull();
  expect(view.getByText('绑定新电脑')).toBeTruthy();
  expect(view.getByText('工作电脑')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(mockRemote.connections).toHaveLength(1);
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
});

test('selecting a saved computer restores it and returns to home, without automatically launching an Agent', async () => {
  mockRemote = { ...unpairedState(), connections: readyState().connections };
  mockUseConnection.mockImplementation(async () => { mockRemote = readyState(); });
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('选择电脑 工作电脑'));
  await view.rerender(<RemoteScreen visible />);
  expect(mockUseConnection).toHaveBeenCalledWith('paired', false, expect.objectContaining({stillWanted:expect.any(Function)}));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(view.queryByText('准备连接')).toBeNull();
  expect(mockLoadAgents).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('a computer with backup stations asks for an explicit connection before switching', async () => {
  const primary = { ...readyState().connections[0], computerId: 'physical-work' };
  const backup = { ...primary, id: 'offline-backup', deviceId: 'pc-backup', hubUrl: 'https://backup.example/salcara-hub/v1' };
  mockRemote = { ...unpairedState(), connections: [backup, primary] };
  mockProbeConnections.mockResolvedValue({ paired: 'online', 'offline-backup': 'unreachable' });
  mockUseConnection.mockImplementation(async () => { mockRemote = { ...readyState(), connections: [backup, primary] }; });
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('选择电脑 工作电脑'));
  expect(mockUseConnection).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('切换到中转站 station.example pc-1'));
  expect(mockUseConnection).toHaveBeenCalledWith('paired', false, expect.objectContaining({stillWanted:expect.any(Function)}));
  expect(mockUseConnection).not.toHaveBeenCalledWith('offline-backup');
});

test('opening a Work Agent uses the computer selected on the homepage and shows its Work directory', async () => {
  const first = readyState();
  const second = readyState();
  const secondHub = 'https://station-two.example/salcara-hub/v1';
  second.connectionId = 'paired-secondary'; second.selectedHubUrl = secondHub;
  second.connections = [{ id: 'paired-secondary', deviceId: 'pc-2', deviceName: '另一台电脑', hubUrl: secondHub, pairedAt: 2, computerId: 'physical-pc-2' }];
  second.devices = [{ ...first.devices[0], deviceId: 'pc-2', name: '另一台电脑' }];
  second.agents = { 'pc-2': { ...first.agents['pc-1'], list: [agent('codex', 'Codex', 'codex')], apis: [
    { id: 'api_secondary', name: '第二台主力', models: ['fixture-model'] },
    { id: 'api_spare', name: '第二台备用', models: ['fixture-model'] },
  ] } };
  second.agents['pc-2'].list[0].api = { ...second.agents['pc-2'].list[0].api, name: '第二台主力', accountId: 'api_secondary' };
  second.sessions = { 'pc-2': { list: [{ sessionKey: 'codex:work-secondary', tool: 'codex', client: 'Codex CLI', title: '另一台电脑的工作任务', cwd: '', updatedAt: 4,
    status: 'idle', controllable: true, controlSurface: 'cli', workspaceMode: 'work' }], loading: false, loaded: true } };
  mockRemote = { ...first, connections: [...first.connections, { id: 'paired-secondary', deviceId: 'pc-2', deviceName: '另一台电脑', hubUrl: secondHub, pairedAt: 2, computerId: 'physical-pc-2' }], devices: [...first.devices, ...second.devices] };
  mockUseConnection.mockImplementation(async () => { mockRemote = second; });
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('Work'));
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('选择电脑 另一台电脑'));
  await view.rerender(<RemoteScreen visible />);
  expect(view.getByLabelText('连接电脑').props.accessibilityHint).toContain('另一台电脑');
  expect(view.getByText('2 个 API · 电脑密钥库')).toBeTruthy();
  expect(view.queryByText('Codex 主力 API')).toBeNull();
  expect(view.queryByText('修复购物车')).toBeNull();
  await fireEvent.press(view.getByLabelText('API 管理'));
  expect(view.getByText('当前电脑 API：pc-2')).toBeTruthy();
  expect(view.getAllByText('第二台主力').length).toBeGreaterThan(0);
  expect(view.getByText('第二台备用')).toBeTruthy();
  expect(view.queryByText('主力')).toBeNull();
  await fireEvent.press(view.getByLabelText('返回 API 资源库'));

  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByText('第二台主力')).toBeTruthy();
  expect(view.getByText('另一台电脑的工作任务')).toBeTruthy();
  expect(view.queryByText('切换电脑')).toBeNull();
  expect(view.queryByText('准备连接')).toBeNull();
  expect(mockUseConnection).toHaveBeenCalledWith('paired-secondary', false, expect.objectContaining({stillWanted:expect.any(Function)}));
  expect(view.queryByText('修复购物车')).toBeNull();
  expect(mockThreadProps.visible).toBe(false);
}, 15_000);

test('switching computers disables missing Agents and opens only the new computer directory', async () => {
  const first = readyState();
  const secondHub = 'https://station-two.example/salcara-hub/v1';
  const secondConnection = { id: 'paired-secondary', deviceId: 'pc-2', deviceName: '另一台电脑', hubUrl: secondHub, pairedAt: 2 };
  const second: RemoteState = { ...first, connectionId: secondConnection.id, selectedHubUrl: secondHub,
    connections: [...first.connections, secondConnection],
    devices: [{ ...first.devices[0], deviceId: 'pc-2', name: '另一台电脑' }],
    agents: { 'pc-2': { list: [{ ...agent('claude', 'Claude Code', 'claude'),
      api: { ...agent('claude', 'Claude Code', 'claude').api, name: '第二台 Claude API', accountId: 'api_pc2' } }],
      apis: [{ id: 'api_pc2', name: '第二台 Claude API', models: ['fixture-model'] }], loading: false, loaded: true } },
    sessions: { 'pc-2': { list: [{ sessionKey: 'claude:work-pc2', tool: 'claude', client: 'Claude Code', title: '第二台的 Work 会话',
      cwd: '', updatedAt: 5, status: 'idle', controllable: true, controlSurface: 'cli', workspaceMode: 'work' }], loading: false, loaded: true } } };
  mockRemote = { ...first, connections: second.connections, devices: [...first.devices, ...second.devices] };
  mockUseConnection.mockImplementation(async () => { mockRemote = second; });

  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('Work'));
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('选择电脑 另一台电脑'));
  await view.rerender(<RemoteScreen visible />);
  expect(view.getByLabelText('打开 Codex').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('打开 Claude Code').props.accessibilityState.disabled).toBe(false);
  expect(view.getByText('第二台 Claude API')).toBeTruthy();
  expect(view.queryByText('修复购物车')).toBeNull();

  await fireEvent.press(view.getByLabelText('项目与会话'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.getByText('第二台 Claude API')).toBeTruthy();
  expect(view.getByText('第二台的 Work 会话')).toBeTruthy();
  expect(view.queryByText('修复购物车')).toBeNull();
  expect(mockThreadProps.visible).toBe(false);
}, 15_000);

test('computer manager renames a phone-only label and confirms one-computer revocation', async () => {
  mockRemote = readyState();
  mockRenameRemote.mockClear(); mockRevokeById.mockClear();
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('管理设备 工作电脑'));
  await fireEvent.press(view.getByText('编辑设备名称'));
  await fireEvent.changeText(view.getByLabelText('电脑备注名'), '客厅主机');
  await fireEvent.press(view.getByText('保存'));
  expect(mockRenameRemote).toHaveBeenCalledWith('paired', '客厅主机');

  await fireEvent.press(view.getByLabelText('管理设备 工作电脑'));
  await fireEvent.press(view.getByText('删除中转站连接'));
  const revokeAction = mockMenuActions.find(action => action.label === '删除连接');
  expect(revokeAction).toBeTruthy();
  await act(async () => { revokeAction!.onPress(); });
  expect(mockRevokeById).toHaveBeenCalledWith('paired');
});

test.each(['missing-device', 'offline-device'] as const)('selecting the current paired computer retries restoration when it has a %s', async (condition) => {
  mockRemote = { ...readyState(), agents: {}, sessions: {} };
  if (condition === 'missing-device') {
    mockRemote.devices = [];
    mockRemote.connection = 'error';
    mockRemote.connectionError = '连接中断';
  } else mockRemote.devices[0].online = false;
  mockUseConnection.mockImplementation(async () => { mockRemote = readyState(); });
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('选择电脑 工作电脑'));
  await view.rerender(<RemoteScreen visible />);
  expect(mockUseConnection).toHaveBeenCalledTimes(1);
  expect(mockUseConnection).toHaveBeenCalledWith('paired', false, expect.objectContaining({stillWanted:expect.any(Function)}));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.queryByText('准备连接')).toBeNull();
  expect(view.getByText('Codex 主力 API')).toBeTruthy();
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('computer API entry can be opened and closed before pairing without phone library access', async () => {
  mockRemote = unpairedState();
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('API 管理'));
  expect(view.getByText('电脑 API 资源库')).toBeTruthy();
  expect(mockConnectStation).not.toHaveBeenCalled();
  expect(mockPairQr).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('返回 API 资源库'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
});

test('direct binding scanner does not repeat the saved computer list from management', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  expect(view.getByLabelText('选择电脑 工作电脑')).toBeTruthy();
  await fireEvent.press(view.getByText('绑定新电脑'));
  expect(view.queryByLabelText('中转站地址')).toBeNull();
  expect(view.getByTestId('remote-qr-camera')).toBeTruthy();
  expect(view.queryByLabelText('选择电脑 工作电脑')).toBeNull();
  expect(view.queryByText('已配对的电脑')).toBeNull();
  expect(mockUseConnection).not.toHaveBeenCalled();
});

test('Agent entry opens its directory directly and switching returns home to choose the next Agent', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.getByText('修复购物车')).toBeTruthy();
  expect(view.queryByRole('radio')).toBeNull();
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(view.getByLabelText('打开 Claude Code')).toBeTruthy();
  expect(view.queryByTestId('remote-workspace')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开 Claude Code'));
  expect(view.getByText('终端 Claude 项目')).toBeTruthy();
  expect(view.queryByText('修复购物车')).toBeNull();
  expect(view.queryByRole('radio')).toBeNull();
  expect(view.queryByText('准备连接')).toBeNull();
  expect(view.getByText('Claude Code 主力 API')).toBeTruthy();
  expect(mockSetApi).not.toHaveBeenCalled();
});

test.each(['existing', 'new'] as const)('switching Agent clears the %s conversation and rejects former directory settings', async kind => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  const oldSettings = view.getByLabelText('API 管理').props.onPress as () => void;
  await fireEvent.press(view.getByLabelText(kind === 'existing' ? '修复购物车' : '在 shop 中新建 Code 对话'));
  expect(mockThreadProps.visible).toBe(true);
  await act(async () => mockThreadProps.onClose());
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Claude Code')).toBeTruthy();
  expect(mockThreadProps).toMatchObject({ visible: false, sessionKey: null });
  await fireEvent.press(view.getByLabelText('打开 Claude Code'));
  mockLoadAgents.mockClear(); mockLoadSessions.mockClear();
  await act(async () => oldSettings());
  expect(view.queryByText('电脑 API 资源库')).toBeNull();
  expect(view.getByText('终端 Claude 项目')).toBeTruthy();
  expect(mockThreadProps).toMatchObject({ visible: false, sessionKey: null, agent: { id: 'claude' } });
  expect(mockLoadAgents).not.toHaveBeenCalled(); expect(mockLoadSessions).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled();
});

test.each([
  ['Codex', 'codex'], ['Claude Code', 'claude'], ['Claude Desktop', 'claude-desktop'],
] as const)('home %s card opens the matching Agent directory without applying a key', async (name, id) => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText(`打开 ${name}`));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.getByText(`${name} 主力 API`)).toBeTruthy();
  expect(mockThreadProps.agent?.id).toBe(id);
  expect(mockThreadProps.visible).toBe(false);
  expect(mockSetApi).not.toHaveBeenCalled();
  expect(view.queryByRole('radio')).toBeNull();
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
});

test('an Agent removed from the live computer catalog shows a clear recoverable state', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  mockRemote = { ...mockRemote, agents: { ...mockRemote.agents, 'pc-1': { ...mockRemote.agents['pc-1'], list: [] } } };
  await view.rerender(<RemoteScreen visible />);
  expect(view.getByText('Agent 暂不可用')).toBeTruthy();
  expect(view.getByLabelText('返回')).toBeTruthy();
});

test('project and session entry sends an unpaired user to computers, not straight to scanner', async () => {
  mockRemote = unpairedState();
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('项目与会话'));
  expect(view.getByText('绑定新电脑')).toBeTruthy();
  expect(view.queryByText('扫描二维码')).toBeNull();
});

test('project and session entry opens the selected Agent directory directly', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('项目与会话'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.getByText('修复购物车')).toBeTruthy();
  expect(view.queryByText('准备连接')).toBeNull();
  expect(view.queryByText('新对话')).toBeNull();
});

test('API management closes to the original Agent directory before returning home without unpairing', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByText('修复购物车'));
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'codex:app' });
  await act(async () => mockThreadProps.onClose());
  expect(mockThreadProps.visible).toBe(false);
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('API 管理'));
  expect(view.getByText('电脑 API 资源库')).toBeTruthy();
  expect(view.getByText('当前电脑 API：pc-1')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('返回 API 资源库'));
  expect(view.queryByText('电脑 API 资源库')).toBeNull();
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.getByText('修复购物车')).toBeTruthy();
  expect(mockThreadProps).toMatchObject({ visible: false, sessionKey: null, agent: { id: 'codex' } });
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(mockSignOut).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
});

test('late saved Agent restoration cannot overwrite a user-selected home card', async () => {
  let resolveAgent!: (id: AgentId) => void;
  mockLastAgent.mockImplementation(() => new Promise((resolve) => { resolveAgent = resolve; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Claude Code'));
  await act(async () => resolveAgent('codex'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(mockThreadProps.agent?.id).toBe('claude');
});

test('a focused Desktop session opens its exact Agent without reading a saved directory preference', async () => {
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'claude:desktop' };
  await render(<RemoteScreen visible />);
  expect(mockLastAgent).not.toHaveBeenCalled();
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'claude:desktop', deviceId: 'pc-1' });
  expect(mockThreadProps.agent?.id).toBe('claude-desktop');
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('home recent session uses its actual Desktop client rather than the last selected Agent', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('桌面 Claude 项目'));
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'claude:desktop', deviceId: 'pc-1' });
  expect(mockThreadProps.agent?.id).toBe('claude-desktop');
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('a cold recent session opens at once and stays unsendable until fresh Agent/API metadata arrives', async () => {
  let complete!: () => void;
  mockRemote.agents = {};
  const pending = new Promise<void>((resolve) => { complete = () => {
    mockRemote.agents = readyState().agents;
    resolve();
  }; });
  mockLoadAgents.mockImplementation(() => pending);
  const view = await render(<RemoteScreen visible />);
  expect(mockLoadAgents).toHaveBeenCalledWith('pc-1');
  await fireEvent.press(view.getByLabelText('桌面 Claude 项目'));
  expect(mockLoadAgents).toHaveBeenCalledWith('pc-1');
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'claude:desktop', deviceId: 'pc-1', verifying: true });
  await act(async () => complete());
  // Production useRemote subscribes via useSyncExternalStore. This fixture
  // directly mutates its snapshot, so explicitly deliver the store update.
  await view.rerender(<RemoteScreen visible />);
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'claude:desktop', deviceId: 'pc-1', verifying: false });
  expect(mockThreadProps.agent).toMatchObject({ id: 'claude-desktop', api: { name: 'Claude Desktop 主力 API', source: 'computer' } });
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('failed recent-session Agent metadata keeps the thread readable but never sendable with a fallback login', async () => {
  mockRemote.agents = {};
  mockLoadAgents.mockRejectedValue(new Error('没有读到 Agent 信息'));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('桌面 Claude 项目'));
  expect(mockLoadAgents).toHaveBeenCalledWith('pc-1');
  expect(mockThreadProps).toMatchObject({ visible: true, verifying: true });
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('a recent-session metadata response cannot reopen a thread after leaving and returning to home', async () => {
  let complete!: () => void;
  mockRemote.agents = {};
  mockLoadAgents.mockImplementation(() => new Promise((resolve) => { complete = () => {
    mockRemote.agents = readyState().agents;
    resolve();
  }; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('桌面 Claude 项目'));
  await fireEvent.press(view.getByLabelText('返回'));
  await fireEvent.press(view.getByLabelText('连接电脑'));
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  await act(async () => complete());
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(mockThreadProps.visible).toBe(false);
});

test('a cold recent-session request is cancelled when the station changes even if the device id is identical', async () => {
  let complete!: () => void;
  mockRemote.agents = {};
  mockLoadAgents.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('桌面 Claude 项目'));
  mockRemote = { ...readyState(), connectionId: 'different-pair', selectedHubUrl: 'https://other.example/salcara-hub/v1',
    connections: [{ ...readyState().connections[0], id: 'different-pair', hubUrl: 'https://other.example/salcara-hub/v1' }],
    agents: {}, sessions: {} };
  await view.rerender(<RemoteScreen visible />);
  await act(async () => complete());
  expect(mockThreadProps.visible).toBe(false);
  expect(view.queryByText('桌面 Claude 项目')).toBeNull();
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
});

test('a station handover with a new credential-scoped device id follows the new computer', async () => {
  const view = await render(<RemoteScreen visible />);
  const next = readyState();
  next.connectionId = 'station-b';
  next.selectedHubUrl = 'https://station-b.example/salcara-hub/v1';
  next.connections = [{ ...next.connections[0], id: 'station-b', hubUrl: next.selectedHubUrl, deviceId: 'pc-b' }];
  next.devices = [{ ...next.devices[0], deviceId: 'pc-b' }];
  next.agents = { 'pc-b': { ...next.agents['pc-1'] } };
  next.sessions = { 'pc-b': { ...next.sessions['pc-1'] } };
  mockRemote = next;
  await view.rerender(<RemoteScreen visible />);

  // If the old local device ID survived the scope change, opening an Agent
  // would show the previous computer's project directory.
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.queryByText('等待电脑上线')).toBeNull();
  expect(view.getByText('修复购物车')).toBeTruthy();
});

test('cold focused Desktop session loads metadata without reading a saved directory Agent', async () => {
  let complete!: () => void;
  mockRemote.agents = {};
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'claude:desktop' };
  mockLoadAgents.mockImplementation(() => new Promise((resolve) => { complete = () => {
    mockRemote.agents = readyState().agents;
    resolve();
  }; }));
  const view = await render(<RemoteScreen visible />);
  expect(mockLoadAgents).toHaveBeenCalledWith('pc-1');
  expect(mockThreadProps).toMatchObject({ visible: true, verifying: true });
  expect(mockLastAgent).not.toHaveBeenCalled();
  await act(async () => { complete(); });
  await view.rerender(<RemoteScreen visible />);
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'claude:desktop' });
  expect(mockThreadProps.agent).toMatchObject({ id: 'claude-desktop', api: { source: 'computer' } });
});

test('failed focused-session metadata opens the thread read-only instead of a sendable fallback', async () => {
  mockRemote.agents = {};
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'claude:desktop' };
  mockLoadAgents.mockRejectedValueOnce(new Error('没有读到 Agent 信息'));
  await render(<RemoteScreen visible />);
  expect(mockLoadAgents).toHaveBeenCalledWith('pc-1');
  expect(mockThreadProps).toMatchObject({ visible: true, verifying: true });
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('a cold focused session resolves its actual Desktop client from a fresh session list', async () => {
  mockRemote.agents = {};
  mockRemote.sessions = {};
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'claude:desktop' };
  mockLoadAgents.mockImplementation(async () => { mockRemote.agents = readyState().agents; });
  mockLoadSessions.mockImplementation(async () => { mockRemote.sessions = readyState().sessions; });
  await render(<RemoteScreen visible />);
  expect(mockLoadAgents).toHaveBeenCalledWith('pc-1');
  expect(mockLoadSessions).toHaveBeenCalledWith('pc-1');
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'claude:desktop' });
  expect(mockThreadProps.agent?.id).toBe('claude-desktop');
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('a shared link reads the exact Codex desktop directory and does not probe the CLI list', async () => {
  mockRemote.sessions['pc-1'].native = { loaded: false, loading: false, list: [] };
  mockRemote.focus = { deviceId: 'pc-1', connectionId: 'paired', agentId: 'codex', surface: 'desktop', sessionKey: 'codex:native-link' };
  mockLoadNative.mockImplementation(async () => {
    mockRemote.sessions['pc-1'].native = { loaded: true, loading: false,
      list: [{ sessionKey: 'codex:native-link', tool: 'codex', client: 'Codex App', title: 'Native link', cwd: 'C:\\fixture', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'desktop' }] };
  });
  await render(<RemoteScreen visible />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(mockLoadNative).toHaveBeenCalledWith('pc-1');
  expect(mockLoadSessions).not.toHaveBeenCalled();
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'codex:native-link', agent: { id: 'codex' } });
});

test('returning home while the session directory is loading prevents a late result reopening it', async () => {
  let complete!: () => void;
  mockLoadSessions.mockImplementation(() => new Promise((resolve) => { complete = () => {
    mockRemote.sessions['pc-1'].list = readyState().sessions['pc-1'].list;
    resolve();
  }; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  await act(async () => complete());
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(view.queryByTestId('remote-workspace')).toBeNull();
  expect(mockThreadProps.visible).toBe(false);
});

test('a late previous-station directory result cannot open its session at a new station', async () => {
  let complete!: () => void;
  mockLoadSessions.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  mockRemote = { ...readyState(), connectionId: 'different-pair', selectedHubUrl: 'https://other.example/salcara-hub/v1',
    connections: [{ ...readyState().connections[0], id: 'different-pair', hubUrl: 'https://other.example/salcara-hub/v1' }],
    sessions: {}, agents: {} };
  await view.rerender(<RemoteScreen visible />);
  await act(async () => complete());
  expect(view.queryByTestId('remote-workspace')).toBeNull();
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(mockThreadProps.visible).toBe(false);
});

test('offline computer still shows cached sessions but cannot start a remote conversation', async () => {
  mockRemote.devices[0].online = false;
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.getByText('修复购物车')).toBeTruthy();
  expect(view.getByLabelText('在 shop 中新建 Code 对话').props.accessibilityState.disabled).toBe(true);
});

test('session routing preserves an exact registered extension and rejects mismatched or unregistered namespaces', () => {
  const hermes = agent('hermes', 'Hermes', 'hermes');
  expect(sessionAgent({ sessionKey: 'hermes:task', tool: 'hermes', client: 'Claude Desktop' }, [hermes])).toBe('hermes');
  expect(sessionAgent({ sessionKey: 'hermes:task', tool: 'hermes', client: 'Hermes' })).toBeNull();
  expect(sessionAgent({ sessionKey: 'hermes:task', tool: 'claude', client: 'Claude Code' }, [hermes])).toBeNull();
  expect(sessionAgent({ sessionKey: 'codex:task', tool: 'claude', client: 'Claude Desktop' })).toBeNull();
  expect(sessionAgent({ sessionKey: 'claude-desktop:local-fixture', tool: 'claude', client: 'Claude Desktop' })).toBe('claude-desktop');
  expect(sessionAgent({ sessionKey: 'hermes:', tool: 'hermes', client: 'Hermes' }, [hermes])).toBeNull();
  expect(sessionAgent({ sessionKey: 'hermes:task|other', tool: 'hermes', client: 'Hermes' }, [hermes])).toBeNull();
  expect(sessionAgent({ sessionKey: 'hermes:task\n', tool: 'hermes', client: 'Hermes' }, [hermes])).toBeNull();
});

test('a registered extension recent conversation never mounts a Claude or Codex composer', async () => {
  mockRemote.agents['pc-1'].list.push(agent('hermes', 'Hermes', 'hermes'));
  mockRemote.sessions['pc-1'].list.unshift({ ...readyState().sessions['pc-1'].list[0], sessionKey: 'hermes:task', tool: 'hermes', client: 'Hermes', title: 'Hermes fixture', updatedAt: 4 });
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('Hermes fixture'));
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'hermes:task', agent: { id: 'hermes', tool: 'hermes' } });
  expect(mockSetApi).not.toHaveBeenCalled();
});

test.each(['unregistered', 'wrong-tool'] as const)('a %s recent conversation cannot inherit a built-in composer', async variant => {
  mockRemote.sessions['pc-1'].list.unshift({ ...readyState().sessions['pc-1'].list[0], sessionKey: 'hermes:task', tool: variant === 'wrong-tool' ? 'codex' : 'hermes', client: 'Hermes', title: 'Unsafe fixture', updatedAt: 4 });
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('Unsafe fixture'));
  expect(mockThreadProps.visible).toBe(false);
  expect(mockLoadAgents).not.toHaveBeenCalled();
  expect(mockLoadSessions).not.toHaveBeenCalled();
});

test('a cold extension focus waits for its exact profile before mounting and keeps the requested namespace', async () => {
  let complete!: () => void;
  mockRemote.agents = {};
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'hermes:task' };
  const pending = new Promise<void>(resolve => { complete = () => {
    mockRemote.agents = { 'pc-1': { ...readyState().agents['pc-1'], list: [...readyState().agents['pc-1'].list, agent('hermes', 'Hermes', 'hermes')] } };
    resolve();
  }; });
  mockLoadAgents.mockImplementation(() => pending);
  const view = await render(<RemoteScreen visible />);
  expect(mockLoadAgents).toHaveBeenCalledWith('pc-1');
  expect(mockThreadProps.visible).toBe(false);
  await act(async () => complete());
  await view.rerender(<RemoteScreen visible />);
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'hermes:task', agent: { id: 'hermes' } });
});

test('a late cold extension profile cannot select a composer after a station change', async () => {
  let complete!: () => void;
  mockRemote.agents = {};
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'hermes:task' };
  mockLoadAgents.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const view = await render(<RemoteScreen visible />);
  mockRemote = { ...readyState(), connectionId: 'different-pair', selectedHubUrl: 'https://other.example/salcara-hub/v1', agents: {}, sessions: {} };
  await view.rerender(<RemoteScreen visible />);
  await act(async () => complete());
  expect(mockThreadProps.visible).toBe(false);
});

test('Agent directory keeps an exact extension profile instead of substituting a built-in Agent', async () => {
  mockLastAgent.mockImplementation(async () => 'hermes');
  mockRemote.agents['pc-1'].list.push(agent('hermes', 'Hermes', 'hermes'));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('项目与会话'));
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.getByText('Hermes 主力 API')).toBeTruthy();
  expect(view.queryByText('Codex 主力 API')).toBeNull();
});

test('a saved Agent absent from this computer falls back to an available Agent in its own catalog', async () => {
  mockLastAgent.mockImplementation(async () => 'hermes');
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('项目与会话'));
  expect(view.queryByText('准备连接')).toBeNull();
  expect(view.getByTestId('remote-workspace')).toBeTruthy();
  expect(view.getByText('Codex 主力 API')).toBeTruthy();
  expect(view.queryByText('Hermes 主力 API')).toBeNull();
  expect(mockLoadAgents).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled();
});
