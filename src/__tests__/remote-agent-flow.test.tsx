import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { RemoteScreen } from '../remote/RemoteScreen';
import type { AgentProfile, DeviceStatus, SessionInfo } from '../remote/client';
import type { RemoteState } from '../remote/store';

const mockLoadAgents = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadSessions = jest.fn(async (..._args: unknown[]) => undefined);
const mockSetApi = jest.fn(async (..._args: unknown[]) => undefined);
const mockToast = jest.fn();
let mockThreadProps: { visible: boolean; sessionKey: string | null; deviceId: string | null; agent: AgentProfile | null };
let mockRemote: RemoteState;

jest.mock('expo-camera', () => ({ useCameraPermissions: () => [{ granted: true }, jest.fn()], CameraView: () => null }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
const mockSwitchSpace = jest.fn();
jest.mock('../state/AppContext', () => ({ useApp: () => ({ providers: [], switchSpace: mockSwitchSpace }) }));
jest.mock('../companion/SpaceSwitch', () => ({ SpaceSwitch: () => null }));
jest.mock('../remote/computer-selection', () => ({
  readComputerSelection: async () => ({ kind: 'relay', deviceId: 'pc-1', connectionId: 'paired' }),
  saveComputerSelection: jest.fn(async () => undefined),
}));
jest.mock('react-native-safe-area-context', () => {
  const React = require('react'); const { View } = require('react-native');
  return { SafeAreaView: ({ children }: { children: unknown }) => React.createElement(View, null, children) };
});
jest.mock('../remote/ConnectionIndicator', () => ({ ConnectionIndicator: () => null }));
jest.mock('../remote/useDemandSync', () => ({ useDemandSync: () => undefined }));
jest.mock('../remote/ThreadView', () => ({
  ThreadView: (props: typeof mockThreadProps) => { mockThreadProps = props; return null; },
}));
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote,
  hydrateCachedThread: async () => undefined, hydrateCachedSessions: async () => undefined,
  getRemoteState: () => mockRemote,
  probeSavedConnections: jest.fn(async () => ({ paired: 'online' })),
  timelineKey: (deviceId: string, sessionKey: string) => `${deviceId}|${sessionKey}`,
  loadAgentProfiles: (...args: unknown[]) => mockLoadAgents(...args),
  loadSessions: (...args: unknown[]) => mockLoadSessions(...args),
  setAgentApi: (...args: unknown[]) => mockSetApi(...args),
  lastAgent: async () => 'codex', rememberAgent: async () => undefined,
  setRemoteScreenOpen: jest.fn(), setRemoteFocus: jest.fn(),
  connectStation: jest.fn(), pairRemote: jest.fn(), pairRemoteQr: jest.fn(), parseRemoteQr: jest.fn(),
  revokeRemoteConnection: jest.fn(), signOutRemote: jest.fn(), useSavedConnection: jest.fn(),
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
    AppDialog: () => null, Sheen: () => null, BrandFill: () => null, ToastHost: () => null,
    useReducedMotion: () => true,
    showToast: (...args: unknown[]) => mockToast(...args), dismissKeyboardAndBlur: () => undefined,
  };
});

function agent(id: AgentProfile['id'], name: string, tool: AgentProfile['tool'], available = true): AgentProfile {
  return { id, name, tool, available, remoteSendSupported: available,
    api: { name: `${name} 主力 API`, model: 'gpt-5-codex', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_00112233445566778899' } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockThreadProps = { visible: false, sessionKey: null, deviceId: null, agent: null };
  const device: DeviceStatus = { deviceId: 'pc-1', name: '工作电脑', os: 'windows', online: true, lastSeen: 1,
    tools: [{ id: 'codex', name: 'Codex', available: true }, { id: 'claude', name: 'Claude Code', available: true }], projects: [] };
  const sessions: SessionInfo[] = [
    { sessionKey: 'codex:app', tool: 'codex', client: 'Codex App', title: '桌面上开的对话', cwd: 'C:\\code\\shop', updatedAt: 3, status: 'running', controllable: true, controlSurface: 'cli' },
    { sessionKey: 'codex:cli', tool: 'codex', client: 'Codex CLI', title: '终端里开的对话', cwd: 'C:\\code\\api', updatedAt: 2, status: 'idle', controllable: true, controlSurface: 'cli' },
    { sessionKey: 'claude:one', tool: 'claude', client: 'Claude Code', title: 'Claude 的对话', cwd: 'C:\\code\\api', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' },
  ];
  sessions.push({ sessionKey: 'codex:work', tool: 'codex', client: 'Codex CLI', title: '整理本周工作计划', cwd: '', updatedAt: 4, status: 'idle', controllable: true, controlSurface: 'cli', workspaceMode: 'work' });
  mockRemote = { phase: 'ready', serviceId: null, connectionId: 'paired', selectedHubUrl: 'https://station.example/salcara-hub/v1',
    connections: [{ id: 'paired', deviceId: 'pc-1', deviceName: '工作电脑', hubUrl: 'https://station.example/salcara-hub/v1', pairedAt: 1 }],
    probes: {}, connection: 'open', devices: [device], devicesLoaded: true,
    agents: { 'pc-1': { list: [agent('codex', 'Codex', 'codex'), agent('claude', 'Claude Code', 'claude')], apis: [{ id: 'api_00112233445566778899', name: '主力', models: ['gpt-5-codex'] }], loading: false, loaded: true } },
    sessions: { 'pc-1': { list: sessions, loading: false, loaded: true } }, timelines: {}, approvals: {}, signingIn: null, focus: null,
  } as RemoteState;
});

test('a homepage Agent opens its current computer directory directly, grouped by project', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.queryByText('准备连接')).toBeNull();
  expect(view.queryByText('连接')).toBeNull();
  expect(view.getByLabelText('新建 Code 对话')).toBeTruthy();
  // Codex App and CLI threads share one list, like the Codex sidebar; Claude sessions stay out.
  expect(view.getByText('桌面上开的对话')).toBeTruthy();
  expect(view.getByText('终端里开的对话')).toBeTruthy();
  expect(view.queryByText('Claude 的对话')).toBeNull();
  expect(view.queryByText('整理本周工作计划')).toBeNull();
  expect(view.getByText('shop')).toBeTruthy();
  expect(view.getByText('api')).toBeTruthy();
  await fireEvent.press(view.getByText('桌面上开的对话'));
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'codex:app', deviceId: 'pc-1' });
  expect(mockThreadProps.agent?.id).toBe('codex');
  expect(mockSetApi).not.toHaveBeenCalled();
});

test('choosing Claude Code lists only Claude sessions', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Claude Code'));
  expect(view.getByText('Claude 的对话')).toBeTruthy();
  expect(view.queryByText('桌面上开的对话')).toBeNull();
});

test('a missing Agent is unavailable on the homepage and cannot open a directory', async () => {
  mockRemote.agents['pc-1'].list = [agent('codex', 'Codex', 'codex', false), agent('claude', 'Claude Code', 'claude')];
  const view = await render(<RemoteScreen visible />);
  const unavailable = view.getByLabelText('打开 Codex');
  expect(unavailable.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(unavailable);
  expect(view.queryByLabelText('新建 Code 对话')).toBeNull();
});

test('new thread opens the composer for the connected agent', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  await fireEvent.press(view.getByLabelText('新建 Code 对话'));
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: null, deviceId: 'pc-1' });
});

test('the homepage API management changes an Agent API using only its opaque handle', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('API 管理'));
  await fireEvent.press(view.getByLabelText('更换 Codex 的 API'));
  await fireEvent.press(view.getByRole('radio', { name: '主力' }));
  expect(view.queryByText('使用这个设置')).toBeNull();
  expect(mockSetApi).toHaveBeenCalledWith('pc-1', 'codex', 'api_00112233445566778899', '');
  expect(mockThreadProps.visible).toBe(false);
});

test('the Work homepage opens only that Agent Work sessions without a second connection step', async () => {
  const view = await render(<RemoteScreen visible />);
  await fireEvent.press(view.getByLabelText('Work'));
  await fireEvent.press(view.getByLabelText('打开 Codex'));
  expect(view.getByText('整理本周工作计划')).toBeTruthy();
  expect(view.queryByText('桌面上开的对话')).toBeNull();
  expect(view.queryByText('终端里开的对话')).toBeNull();
  expect(view.queryByText('Claude 的对话')).toBeNull();
  expect(view.queryByText('准备连接')).toBeNull();
  expect(view.getByLabelText('新建 Work 对话')).toBeTruthy();
  await fireEvent.press(view.getByText('整理本周工作计划'));
  expect(mockThreadProps).toMatchObject({ visible: true, sessionKey: 'codex:work', deviceId: 'pc-1' });
  expect(mockThreadProps.agent?.id).toBe('codex');
  expect(mockSetApi).not.toHaveBeenCalled();
});
