import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { RemoteScreen } from '../remote/RemoteScreen';
import { readPreferredAgent, rememberPreferredAgent } from '../remote/agent-preferences';

let mockRemote: any, mockWorkspace: any, mockReadGate: Promise<void> | undefined;
const mockSettings = new Map<string, string | null>(), mockDirect = { status: 'idle' };
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => {
  const value = mockSettings.get(key) ?? null;
  if (key.startsWith('remote_agent_preference_v2_')) await mockReadGate;
  return value;
}, setSetting: async (key: string, value: string | null) => { mockSettings.set(key, value); } }));
jest.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: true }, jest.fn()] }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../companion/SpaceSwitch', () => ({ SpaceSwitch: () => null }));
jest.mock('../state/AppContext', () => ({ useApp: () => ({ providers: [], chatProvider: null, switchSpace: jest.fn() }) }));
jest.mock('../remote/notifications', () => ({ notificationsSupported: () => false, useNotificationsEnabled: () => false,
  useNotificationPermissionGranted: () => false, useBackgroundWatchStatus: () => null }));
jest.mock('../remote/push', () => ({ usePushStatus: () => ({ status: 'unsupported' }) }));
jest.mock('../remote/store', () => ({ useRemote: () => mockRemote, getRemoteState: () => mockRemote,
  setRemoteScreenOpen: jest.fn(), setRemoteFocus: jest.fn() }));
jest.mock('../remote/direct-pairing', () => ({ getDirectConnectionState: () => mockDirect, subscribeDirectConnection: () => () => {},
  restoreDirectPairing: async () => undefined }));
jest.mock('../remote/ThreadView', () => ({ ThreadView: () => null }));
jest.mock('../remote/RemoteWorkspace', () => ({ RemoteWorkspace: (props: any) => { mockWorkspace = props; return null; } }));
jest.mock('../remote/RemoteComputers', () => ({ RemoteComputers: () => null }));
jest.mock('../remote/RemoteBotBinding', () => ({ RemoteBotBinding: () => null }));
jest.mock('../remote/RemoteApiLibrary', () => ({ RemoteApiLibrary: () => null }));
jest.mock('../remote/DirectExperience', () => ({ DirectExperience: () => null }));
jest.mock('../remote/RemoteHome', () => ({ RemoteHome: ({ onProjects, onAgent }: any) => {
  const { View, Pressable } = require('react-native');
  return <View><Pressable accessibilityLabel="项目与会话" onPress={onProjects}/><Pressable accessibilityLabel="打开 Codex" onPress={() => onAgent('codex')}/></View>;
}, sessionAgent: () => 'codex' }));
jest.mock('../components/ui', () => {
  const { View, Pressable } = require('react-native');
  return { IconButton: ({ label, onPress }: any) => <Pressable accessibilityLabel={label} onPress={onPress}/>,
    Appear: ({ children }: any) => <View>{children}</View>, AppDialog: () => null, Sheet: () => null, ToastHost: () => null, showToast: jest.fn() };
});
jest.mock('../remote/ProgrammingUi', () => ({ ProgrammingPanel: () => null }));
const connections = [
  { id: 'relay-a', hubUrl: 'https://hub.example/v1', deviceId: 'pc-a', deviceName: 'Same name', pairedAt: 1 },
  { id: 'relay-b', hubUrl: 'https://hub.example/v1', deviceId: 'pc-b', deviceName: 'Same name', pairedAt: 2 },
  { id: 'bot-a', hubUrl: 'https://hub.example/v1', deviceId: 'pc-a', deviceName: 'Same name', botGroupId: 'group-a', pairedAt: 3 },
];
const scope = (index: number) => ({ kind: 'remote' as const, connectionId: connections[index].id, deviceId: connections[index].deviceId });
const agents = ['codex', 'claude'].map(id => ({ id, tool: id, name: id, available: true, api: { configured: true, pending: false } }));
function switchTo(index: number) {
  const target = connections[index];
  mockRemote = { ...mockRemote, connectionId: target.id, selectedHubUrl: target.hubUrl,
    devices: [{ deviceId: target.deviceId, name: target.deviceName, online: true, tools: [], projects: [] }],
    agents: { [target.deviceId]: { loaded: true, list: agents, apis: [] } } };
}
beforeEach(() => {
  mockSettings.clear(); mockReadGate = undefined; mockWorkspace = undefined;
  mockRemote = { phase: 'ready', serviceId: null, connections, connection: 'open', sessions: {}, timelines: {}, approvals: {}, focus: null, probes: {} };
  switchTo(0);
});
async function openProjects(view: Awaited<ReturnType<typeof render>>, expected: string) {
  await fireEvent.press(view.getByLabelText('项目与会话'));
  await waitFor(() => expect(mockWorkspace.agent.id).toBe(expected));
}

test('switching same-Hub same-name computers and Bot modes restores only the exact saved Agent', async () => {
  await rememberPreferredAgent(scope(0), 'claude'); await rememberPreferredAgent(scope(1), 'codex'); await rememberPreferredAgent(scope(2), 'codex');
  const view = await render(<RemoteScreen/>); await openProjects(view, 'claude');
  for (const index of [1, 2, 0]) {
    await fireEvent.press(view.getByLabelText('返回')); switchTo(index); await view.rerender(<RemoteScreen/>);
    await openProjects(view, index === 0 ? 'claude' : 'codex');
  }
  await view.unmount();
});

test('a delayed saved Agent cannot overwrite a later explicit card selection', async () => {
  await rememberPreferredAgent(scope(0), 'claude');
  let release!: () => void; mockReadGate = new Promise(resolve => { release = resolve; });
  const view = await render(<RemoteScreen/>);
  await fireEvent.press(view.getByLabelText('打开 Codex')); expect(mockWorkspace.agent.id).toBe('codex');
  await act(async () => release());
  expect(mockWorkspace.agent.id).toBe('codex'); expect(await readPreferredAgent(scope(0))).toBe('codex');
  await view.unmount();
});

test('legacy global preference never chooses the new computer Agent and explicit selection persists across remount', async () => {
  mockSettings.set('remote_last_agent_v1', 'claude');
  let view = await render(<RemoteScreen/>); await openProjects(view, 'codex'); await view.unmount();
  await rememberPreferredAgent(scope(0), 'claude');
  view = await render(<RemoteScreen/>); await openProjects(view, 'claude'); await view.unmount();
});
