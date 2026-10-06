import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteScreen } from '../remote/RemoteScreen';
import type { AgentId, AgentProfile, DeviceStatus, SessionInfo } from '../remote/client';
import type { RemoteState } from '../remote/store';

const mockLoadAgents = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockLoadSessions = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockLastAgent = jest.fn<Promise<AgentId>, []>(async () => 'codex');
const mockRememberAgent = jest.fn();
const mockSetApi = jest.fn();
const mockToast = jest.fn();
const mockSwitchSpace = jest.fn();
const mockConnectStation = jest.fn();
const mockPairQr = jest.fn();
const mockUseConnection = jest.fn();
const mockSignOut = jest.fn();
const mockRevoke = jest.fn();
const mockOpenDesktopGithub = jest.fn();
const mockScreenOpen = jest.fn();
let mockRemote: RemoteState;
let mockMenuActions: Array<{ label: string; onPress: () => void }> = [];
let mockConnectPress: (() => void) | undefined;
let mockThreadProps: {
  visible: boolean; sessionKey: string | null; deviceId: string | null; agent: AgentProfile | null; verifying?: boolean;
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
    if (label === '连接' || label === '正在连接…') mockConnectPress = onPress;
    return React.createElement(Pressable, { ...props, accessibilityRole: 'button', accessibilityLabel: label, accessibilityState: { disabled: Boolean(disabled || loading), busy: Boolean(loading) }, disabled: Boolean(disabled || loading), onPress }, React.createElement(Text, null, label));
  } };
});
jest.mock('../remote/RemoteApiLibrary', () => ({
  RemoteApiLibrary: ({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
    if (!visible) return null;
    const React = require('react'); const { View, Text, Pressable } = require('react-native');
    return React.createElement(View, null, React.createElement(Text, null, '电脑 API 资源库'),
      React.createElement(Pressable, { accessibilityLabel: '返回 API 资源库', onPress: onClose }, React.createElement(Text, null, '返回 API 资源库')));
  },
}));
jest.mock('../remote/ThreadView', () => ({
  ThreadView: (props: typeof mockThreadProps) => { mockThreadProps = props; return null; },
}));
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote,
  hydrateCachedThread: async () => undefined, hydrateCachedSessions: async () => undefined,
  getRemoteState: () => mockRemote,
  loadAgentProfiles: (...args: unknown[]) => mockLoadAgents(...args),
  loadSessions: (...args: unknown[]) => mockLoadSessions(...args),
  loadMoreSessions: jest.fn(async () => undefined),
  setAgentApi: (...args: unknown[]) => mockSetApi(...args),
  lastAgent: () => mockLastAgent(), rememberAgent: (...args: unknown[]) => mockRememberAgent(...args),
  setRemoteScreenOpen: (...args: unknown[]) => mockScreenOpen(...args),
  setRemoteFocus: (focus: RemoteState['focus']) => { mockRemote.focus = focus; },
  connectStation: (...args: unknown[]) => mockConnectStation(...args),
  pairRemote: jest.fn(), pairScannedRemoteQr: (...args: unknown[]) => mockPairQr(...args), parseScannedRemoteQr: () => mockQr,
  revokeRemoteConnection: (...args: unknown[]) => mockRevoke(...args),
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

beforeEach(() => {
  jest.clearAllMocks();
  mockLastAgent.mockReset(); mockLoadAgents.mockReset(); mockLoadSessions.mockReset();
  mockRemote = readyState();
  mockMenuActions = [];
  mockConnectPress = undefined;
  mockThreadProps = { visible: false, sessionKey: null, deviceId: null, agent: null, onClose: () => undefined };
  mockLastAgent.mockImplementation(async () => 'codex');
  mockLoadAgents.mockImplementation(async () => undefined);
  mockLoadSessions.mockImplementation(async () => undefined);
  mockConnectStation.mockImplementation(async () => {
    mockRemote = { ...unpairedState('pairing'), connections: mockRemote.connections };
  });
  mockPairQr.mockImplementation(async () => { mockRemote = readyState(); });
  mockUseConnection.mockImplementation(async () => undefined);
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
});

test('recent tasks expose waiting and failed states before the approval cache arrives', async () => {
  mockRemote.sessions['pc-1'].list[0].status = 'waiting_approval';
  mockRemote.sessions['pc-1'].list[1].status = 'failed';
  const view = await render(<RemoteScreen visible />);
  expect(view.getByText('待回复')).toBeTruthy(); expect(view.getByText('失败')).toBeTruthy();
});

test.each(['api', 'menu'] as const)('an approval focus closes the %s overlay before opening its original conversation', async overlay => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText(overlay === 'api' ? 'API 管理' : '更多'));
  if (overlay === 'api') expect(view.getByText('电脑 API 资源库')).toBeTruthy();
  else expect(view.getByText('解除这台手机的配对')).toBeTruthy();
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'codex:app' };
  await view.rerender(<RemoteScreen visible />);
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'codex:app' });
  expect(view.queryByText('电脑 API 资源库')).toBeNull(); expect(view.queryByText('解除这台手机的配对')).toBeNull();
});

test('changing station clears an open API overlay rather than reopening it over the new station', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('API 管理'));
  mockRemote = { ...mockRemote, serviceId: 'new-station' };
  await view.rerender(<RemoteScreen visible />);
  expect(view.queryByText('电脑 API 资源库')).toBeNull();
});

test('hiding programming also hides an open connection API picker', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex')); await fireEvent.press(view.getByLabelText('更换 API'));
  expect(view.getByText('更换 API')).toBeTruthy();
  await view.rerender(<RemoteScreen visible={false} />);
  expect(view.queryByText('更换 API')).toBeNull();
});

test.each(['hidden', 'scope', 'closed', 'reopened', 'unmounted'] as const)('queued menu unpair cannot revoke the current pairing after it was %s', async condition => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('更多'));
  const revoke = view.getByLabelText('解除这台手机的配对').props.onPress as () => void;
  if (condition === 'hidden') await view.rerender(<RemoteScreen visible={false} />);
  else if (condition === 'scope') { mockRemote = { ...mockRemote, serviceId: 'new-station' }; await view.rerender(<RemoteScreen visible />); }
  else if (condition === 'unmounted') await view.unmount();
  else {
    const apiEntries = view.getAllByLabelText('API 管理');
    await fireEvent.press(apiEntries[apiEntries.length - 1]); // the menu row closes the menu
    if (condition === 'reopened') await fireEvent.press(view.getByLabelText('更多'));
  }
  await act(async () => revoke());
  expect(mockRevoke).not.toHaveBeenCalled();
});

test.each(['hidden', 'scope', 'menu', 'offline', 'unmounted'] as const)('queued connection presses do not read or enter an Agent after %s', async condition => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex')); const connect = mockConnectPress!;
  if (condition === 'hidden') await view.rerender(<RemoteScreen visible={false} />);
  else if (condition === 'scope') { mockRemote = { ...mockRemote, serviceId: 'another-relay' }; await view.rerender(<RemoteScreen visible />); }
  else if (condition === 'menu') await fireEvent.press(view.getByLabelText('更多'));
  else if (condition === 'offline') { mockRemote.devices[0].online = false; await view.rerender(<RemoteScreen visible />); }
  else await view.unmount();
  mockLoadAgents.mockClear();
  await act(async () => connect());
  expect(mockLoadAgents).not.toHaveBeenCalled(); expect(mockThreadProps.visible).toBe(false);
});

test('same-tick repeated connection presses share one request', async () => {
  let finish!: () => void;
  mockLoadAgents.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex')); const connect = mockConnectPress!;
  await act(async () => { connect(); connect(); });
  expect(mockLoadAgents).toHaveBeenCalledTimes(1);
  await act(async () => finish()); expect(view.getByText('新对话')).toBeTruthy();
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

test('desktop download menu uses the same helper and closes without creating a download page', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('更多'));
  const entries = view.getAllByText('下载电脑端');
  expect(entries).toHaveLength(2); // homepage entry plus the menu action
  await fireEvent.press(entries[1]);
  expect(mockOpenDesktopGithub).toHaveBeenCalledTimes(1);
  expect(view.queryByText('选择安装包')).toBeNull();
  expect(view.queryByText('关闭')).toBeNull();
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
});

test('computer entry is separate from binding, and pairing completion returns to home', async () => {
  mockRemote = unpairedState();
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('连接电脑'));
  expect(view.getByText('绑定新电脑')).toBeTruthy();
  expect(view.queryByLabelText('中转站地址')).toBeNull();
  await fireEvent.press(view.getByText('绑定新电脑'));
  expect(view.queryByLabelText('中转站地址')).toBeNull();
  expect(mockConnectStation).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-qr-camera')).toBeTruthy();
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
  expect(mockUseConnection).toHaveBeenCalledWith('paired');
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(view.queryByText('准备连接')).toBeNull();
  expect(mockLoadAgents).not.toHaveBeenCalled();
  expect(mockSetApi).not.toHaveBeenCalled();
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
  expect(mockUseConnection).toHaveBeenCalledWith('paired');
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByText('准备连接')).toBeTruthy();
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

test('Agent confirmation shows the chosen tool once and only offers alternatives on request', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getAllByRole('radio')).toHaveLength(1);
  expect(view.getByRole('radio', { name: 'Codex' })).toBeTruthy();
  expect(view.queryByRole('radio', { name: 'Claude Code' })).toBeNull();
  await fireEvent.press(view.getByLabelText('更换 Agent'));
  await fireEvent.press(view.getByRole('radio', { name: 'Claude Code' }));
  expect(view.getAllByRole('radio')).toHaveLength(1);
  expect(view.getByText('Claude Code 主力 API')).toBeTruthy();
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('connecting locks Agent, computer and API choices so one request cannot enter a different tool', async () => {
  let finish!: () => void;
  mockLoadAgents.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByText('连接'));
  expect(view.getByRole('radio', { name: 'Codex' }).props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('更换 Agent').props.accessibilityState.disabled).toBe(true);
  expect(view.getByLabelText('更换 API').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('更换 Agent'));
  expect(view.queryByRole('radio', { name: 'Claude Code' })).toBeNull();
  await act(async () => finish());
  expect(mockThreadProps.agent?.id).toBe('codex');
  expect(view.getByText('新对话')).toBeTruthy();
});

test.each([
  ['Codex', 'codex'], ['Claude Code', 'claude'], ['Claude Desktop', 'claude-desktop'],
] as const)('home %s card opens that Agent and API confirmation without applying a key', async (name, id) => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText(`打开 ${name}`));
  expect(view.getByRole('radio', { name }).props.accessibilityState.checked).toBe(true);
  expect(view.getByText(`${name} 主力 API`)).toBeTruthy();
  expect(mockThreadProps.agent?.id).toBe(id);
  expect(mockThreadProps.visible).toBe(false);
  expect(mockSetApi).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
});

test('project and session entry sends an unpaired user to computers, not straight to scanner', async () => {
  mockRemote = unpairedState();
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('项目与会话'));
  expect(view.getByText('绑定新电脑')).toBeTruthy();
  expect(view.queryByText('扫描二维码')).toBeNull();
});

test('project and session entry keeps the existing Agent/API confirmation before the workspace', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('项目与会话'));
  expect(view.getByText('准备连接')).toBeTruthy();
  expect(view.queryByText('新对话')).toBeNull();
  await fireEvent.press(view.getByText('连接'));
  expect(view.getByText('新对话')).toBeTruthy();
});

test('return follows thread, workspace, API confirmation, then home without unpairing', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByText('连接'));
  await fireEvent.press(view.getByText('修复购物车'));
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'codex:app' });
  await act(async () => mockThreadProps.onClose());
  expect(mockThreadProps.visible).toBe(false);
  expect(view.getByText('新对话')).toBeTruthy();
  // The conversation list returns straight to the homepage.
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
  expect(view.getByRole('radio', { name: 'Claude Code' }).props.accessibilityState.checked).toBe(true);
  expect(mockThreadProps.agent?.id).toBe('claude');
});

test('a focused Desktop session takes precedence over late saved Agent restoration', async () => {
  let resolveAgent!: (id: AgentId) => void;
  mockLastAgent.mockImplementation(() => new Promise((resolve) => { resolveAgent = resolve; }));
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'claude:desktop' };
  await render(<RemoteScreen visible />);
  await act(async () => resolveAgent('codex'));
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
  mockLoadAgents.mockImplementation(() => new Promise((resolve) => { complete = () => {
    mockRemote.agents = readyState().agents;
    resolve();
  }; }));
  const view = await render(<RemoteScreen visible />);
  expect(mockLoadAgents).not.toHaveBeenCalled();
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
  mockLoadAgents.mockRejectedValueOnce(new Error('没有读到 Agent 信息'));
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
  // would incorrectly fall back to the empty “等待电脑上线” state.
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByText('准备连接')).toBeTruthy();
  expect(view.queryByText('等待电脑上线')).toBeNull();
});

test('cold focused Desktop session loads metadata before entering and ignores a late saved Agent', async () => {
  let complete!: () => void;
  let resolveAgent!: (id: AgentId) => void;
  mockRemote.agents = {};
  mockRemote.focus = { deviceId: 'pc-1', sessionKey: 'claude:desktop' };
  mockLastAgent.mockImplementation(() => new Promise((resolve) => { resolveAgent = resolve; }));
  mockLoadAgents.mockImplementation(() => new Promise((resolve) => { complete = () => {
    mockRemote.agents = readyState().agents;
    resolve();
  }; }));
  const view = await render(<RemoteScreen visible />);
  expect(mockLoadAgents).toHaveBeenCalledWith('pc-1');
  expect(mockThreadProps).toMatchObject({ visible: true, verifying: true });
  await act(async () => { complete(); resolveAgent('codex'); });
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

test('returning to home while connection is pending prevents its late completion opening workspace', async () => {
  let complete!: () => void;
  mockLoadAgents.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByText('连接'));
  await fireEvent.press(view.getByLabelText('返回'));
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  await act(async () => complete());
  expect(view.getByLabelText('打开 Codex')).toBeTruthy();
  expect(view.queryByText('新对话')).toBeNull();
  expect(mockThreadProps.visible).toBe(false);
});

test('a late previous-station connection cannot reopen workspace at a new station with the same device id', async () => {
  let complete!: () => void;
  mockLoadAgents.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByText('连接'));
  mockRemote = { ...readyState(), connectionId: 'different-pair', selectedHubUrl: 'https://other.example/salcara-hub/v1',
    connections: [{ ...readyState().connections[0], id: 'different-pair', hubUrl: 'https://other.example/salcara-hub/v1' }],
    sessions: {}, agents: {} };
  await view.rerender(<RemoteScreen visible />);
  await act(async () => complete());
  expect(view.queryByText('新对话')).toBeNull();
  expect(view.queryByText('修复购物车')).toBeNull();
  expect(mockThreadProps.visible).toBe(false);
});

test('offline computer remains manageable but cannot start a remote workspace', async () => {
  mockRemote.devices[0].online = false;
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByRole('button', { name: '等待电脑上线' }).props.accessibilityState.disabled).toBe(true);
  expect(mockLoadAgents).not.toHaveBeenCalled();
});
