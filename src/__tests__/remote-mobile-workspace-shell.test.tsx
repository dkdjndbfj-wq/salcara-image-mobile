import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { BackHandler, Platform } from 'react-native';
import { RemoteScreen } from '../remote/RemoteScreen';
import type { DeviceStatus } from '../remote/client';

let mockDirectProps: any, mockDemoProps: any;
let mockUseRealFrame = false;
let mockNotify = false;
let mockWatchStatus: any = null;
let mockPush = { status: 'unsupported', standby: false };
const mockRetryNotifications = jest.fn();
let mockConnection = { status: 'connected', deviceId: 'direct-pc', deviceName: 'Direct PC' };
const mockRemote: any = { phase: 'setup', connectionId: null, selectedHubUrl: null, serviceId: null,
  connections: [], devices: [], agents: {}, sessions: {}, timelines: {}, approvals: {}, focus: null, connection: 'idle' };
jest.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [{ granted: true }, jest.fn()] }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => {} }));
jest.mock('../companion/SpaceSwitch', () => ({ SpaceSwitch: () => null }));
jest.mock('../state/AppContext', () => ({ useApp: () => ({ providers: [], chatProvider: null, switchSpace: jest.fn() }) }));
jest.mock('../remote/notifications', () => ({ notificationsSupported: () => mockNotify, useNotificationsEnabled: () => mockNotify, useNotificationPermissionGranted: () => mockNotify,
  useBackgroundWatchStatus: () => mockWatchStatus, retryBackgroundNotifications: () => mockRetryNotifications() }));
jest.mock('../remote/push', () => ({ usePushStatus: () => mockPush }));
jest.mock('../remote/store', () => ({ useRemote: () => mockRemote, getRemoteState: () => mockRemote,
  setRemoteScreenOpen: jest.fn(), lastAgent: async () => 'codex', setRemoteFocus: jest.fn() }));
jest.mock('../remote/direct-pairing', () => ({ getDirectConnectionState: () => mockConnection,
  subscribeDirectConnection: () => () => {}, restoreDirectPairing: async () => undefined }));
jest.mock('../remote/ThreadView', () => ({ ThreadView: () => null }));
jest.mock('../remote/RemoteWorkspace', () => ({ RemoteWorkspace: () => null }));
jest.mock('../remote/RemoteComputers', () => ({ RemoteComputers: () => null }));
jest.mock('../remote/RemoteBotBinding', () => ({ RemoteBotBinding: () => null }));
jest.mock('../remote/RemoteApiLibrary', () => ({ RemoteApiLibrary: () => null }));
jest.mock('../remote/DirectExperience', () => ({ DirectExperience: (props: any) => {
  mockDirectProps = props;
  const React = require('react'), { Pressable, Text } = require('react-native');
  const { TabletThreadFrame } = require('../remote/TabletThreadFrame');
  const [open, setOpen] = React.useState(false), [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    if (!mockUseRealFrame) return;
    props.onMobileWorkspaceVisibilityChange?.(visible);
    return () => props.onMobileWorkspaceVisibilityChange?.(false);
  }, [visible, props.onMobileWorkspaceVisibilityChange]);
  if (!mockUseRealFrame) return null;
  return <TabletThreadFrame onRegisterBack={props.onRegisterBack} enabled={false} header={null} navigation={null} workspace={<Text>真实工具容器</Text>}
    mobileWorkspaceOpen={open} onCloseWorkspace={() => setOpen(false)} onWorkspaceVisibilityChange={setVisible}>
    <Pressable accessibilityLabel="打开真实工具容器" onPress={() => setOpen(true)}/>
  </TabletThreadFrame>;
} }));
jest.mock('../remote/RemoteDemoWorkspace', () => ({ RemoteDemoWorkspace: (props: any) => { mockDemoProps = props; return null; } }));
jest.mock('../remote/RemoteHome', () => ({ RemoteHome: ({ onDirect, onDemo, onComputer }: any) => {
  const { Pressable, View } = require('react-native');
  return <View><Pressable accessibilityLabel="进入直连" onPress={onDirect}/><Pressable accessibilityLabel="进入演示" onPress={onDemo}/><Pressable accessibilityLabel="管理电脑" onPress={onComputer}/></View>;
}, sessionAgent: () => 'codex' }));
jest.mock('../remote/RemoteDemoFlow', () => ({ RemoteDemoFlow: ({ onOpenWorkspace }: any) => {
  const { Pressable } = require('react-native');
  return <Pressable accessibilityLabel="进入演示会话" onPress={() => onOpenWorkspace({ agent: { id: 'codex' }, session: { title: 'Example' }, workspaceMode: 'code' })}/>;
} }));
jest.mock('../components/ui', () => {
  const { View, Pressable } = require('react-native');
  return { IconButton: ({ label, onPress }: any) => <Pressable accessibilityLabel={label} onPress={onPress}/>,
    Appear: ({ children }: any) => <View>{children}</View>, AppDialog: () => null, Sheet: () => null, ToastHost: () => null, showToast: jest.fn() };
});
jest.mock('../remote/ProgrammingUi', () => ({ ProgrammingPanel: ({ visible, children }: any) => {
  const { View } = require('react-native'); return visible ? <View>{children}</View> : null;
} }));

beforeEach(() => { mockUseRealFrame = false; mockDirectProps = undefined; mockDemoProps = undefined; mockConnection = { status: 'connected', deviceId: 'direct-pc', deviceName: 'Direct PC' };
  mockNotify = false; mockWatchStatus = null; mockPush = { status: 'unsupported', standby: false }; mockRetryNotifications.mockClear(); });

test('Direct mobile workspace hides the outer header and restores it on close or disconnect', async () => {
  const view = await render(<RemoteScreen/>);
  await fireEvent.press(view.getByLabelText('进入直连'));
  expect(view.getByLabelText('返回')).toBeTruthy();
  await act(async () => mockDirectProps.onMobileWorkspaceVisibilityChange(true));
  expect(view.queryByLabelText('返回')).toBeNull(); expect(view.queryByLabelText('更多')).toBeNull();
  await act(async () => mockDirectProps.onMobileWorkspaceVisibilityChange(false));
  expect(view.getByLabelText('返回')).toBeTruthy();
  await act(async () => mockDirectProps.onMobileWorkspaceVisibilityChange(true));
  mockConnection = { ...mockConnection, status: 'disconnected' };
  await view.rerender(<RemoteScreen/>);
  expect(view.getByLabelText('返回')).toBeTruthy();
  mockConnection = { ...mockConnection, status: 'connected' };
  await view.rerender(<RemoteScreen/>);
  expect(view.getByLabelText('返回')).toBeTruthy();
});

test('a former Direct route cannot hide the header after returning and reopening', async () => {
  const view = await render(<RemoteScreen/>);
  await fireEvent.press(view.getByLabelText('进入直连'));
  const stale = mockDirectProps.onMobileWorkspaceVisibilityChange;
  await fireEvent.press(view.getByLabelText('返回'));
  await fireEvent.press(view.getByLabelText('进入直连'));
  await act(async () => stale(true));
  expect(view.getByLabelText('返回')).toBeTruthy();
  await act(async () => mockDirectProps.onMobileWorkspaceVisibilityChange(true));
  expect(view.queryByLabelText('返回')).toBeNull();
});

test('demo mobile workspace consumes the whole page and leaving its conversation restores the directory header', async () => {
  const view = await render(<RemoteScreen/>);
  await fireEvent.press(view.getByLabelText('进入演示'));
  await fireEvent.press(view.getByLabelText('进入演示会话'));
  expect(view.getByLabelText('更多')).toBeTruthy();
  await act(async () => mockDemoProps.onMobileWorkspaceVisibilityChange(true));
  expect(view.queryByLabelText('更多')).toBeNull();
  await act(async () => mockDemoProps.onBack());
  expect(view.getByLabelText('更多')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('进入演示会话'));
  expect(view.getByLabelText('更多')).toBeTruthy();
});

test('Android back closes the phone workspace before the Direct route', async () => {
  mockUseRealFrame = true;
  const handlers: Array<Parameters<typeof BackHandler.addEventListener>[1]> = [];
  const subscription = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    handlers.push(handler);
    return { remove: () => { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); } };
  });
  const view = await render(<RemoteScreen/>);
  try {
    await fireEvent.press(view.getByLabelText('进入直连'));
    await fireEvent.press(view.getByLabelText('打开真实工具容器'));
    expect(view.queryByLabelText('更多')).toBeNull();
    expect(view.getByText('真实工具容器')).toBeTruthy();
    await act(async () => { for (const handler of [...handlers].reverse()) { if (handler({type:'hardwareBackPress',timeStamp:Date.now()})) break; } });
    expect(view.getByLabelText('打开真实工具容器')).toBeTruthy();
    expect(view.queryByLabelText('进入直连')).toBeNull();
    expect(view.queryByText('真实工具容器')).toBeNull();
    expect(view.getByLabelText('更多')).toBeTruthy();
  } finally { await view.unmount(); subscription.mockRestore(); }
});

test('a stale full-screen visibility report never lets system Back fall through to native exit', async () => {
  const handlers = new Set<Parameters<typeof BackHandler.addEventListener>[1]>();
  const subscription = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    handlers.add(handler); return { remove: () => { handlers.delete(handler); } };
  });
  const view = await render(<RemoteScreen/>);
  try {
    await fireEvent.press(view.getByLabelText('进入直连'));
    await act(async () => mockDirectProps.onMobileWorkspaceVisibilityChange(true));
    let consumed = false;
    await act(async () => { for (const handler of [...handlers].reverse()) {
      if (handler({type:'hardwareBackPress',timeStamp:Date.now()})) { consumed = true; break; }
    } });
    expect(consumed).toBe(true);
    expect(view.getByLabelText('进入直连')).toBeTruthy();
  } finally { await view.unmount(); subscription.mockRestore(); }
});

test('notification menu distinguishes saved standby from native service failure and exposes retry', async () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'android');
  const previousRemote = { ...mockRemote };
  Object.assign(mockRemote, {
    phase: 'ready', connection: 'open', connectionId: 'hub-connection', selectedHubUrl: 'https://hub.example',
    connections: [{ id: 'hub-connection', hubUrl: 'https://hub.example', deviceId: 'hub-pc', deviceName: 'Hub PC', pairedAt: 1 }],
    devices: [{ deviceId: 'hub-pc', name: 'Hub PC', os: 'windows', tools: [], projects: [], online: true, lastSeen: 1 } satisfies DeviceStatus],
  });
  mockNotify = true; mockPush = { status: 'hub-off', standby: true };
  mockWatchStatus = { running: false, standby: false, recoveryReady: false, expiresAt: 0, reason: 'restricted' };
  let view: Awaited<ReturnType<typeof render>> | undefined;
  try {
    view = await render(<RemoteScreen/>);
    await fireEvent.press(view.getByLabelText('管理电脑'));
    await fireEvent.press(view.getByLabelText('更多'));
    expect(view.getByRole('switch', { name: '后台待命' }).props.accessibilityState).toEqual({ checked: true });
    expect(view.queryByText('电脑直连没有服务端推送，请保持 App 打开查看任务进展。')).toBeNull();
    expect(view.getByText('系统限制了后台运行，请检查设置后重试')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('重新连接任务提醒'));
    expect(mockRetryNotifications).toHaveBeenCalledTimes(1);
    mockWatchStatus = { ...mockWatchStatus, running: true, standby: true, reason: '' };
    await view.rerender(<RemoteScreen/>);
    expect(view.getByText('后台待命运行中，退到后台后继续关注任务')).toBeTruthy();
    expect(view.queryByLabelText('重新连接任务提醒')).toBeNull();
    mockWatchStatus = { ...mockWatchStatus, reason: 'storage' };
    await view.rerender(<RemoteScreen/>);
    expect(view.getByText('后台待命运行中，但本机恢复存储未就绪；系统回收后请重新打开 App')).toBeTruthy();
  } finally { await view?.unmount(); Object.assign(mockRemote, previousRemote); platform.restore(); }
});

test('Direct mode explains that it has no server push even when notifications are enabled', async () => {
  const platform = jest.replaceProperty(Platform, 'OS', 'android');
  mockNotify = true; mockPush = { status: 'hub-off', standby: true };
  mockWatchStatus = { running: false, standby: false, recoveryReady: false, expiresAt: 0, reason: 'restricted' };
  const view = await render(<RemoteScreen/>);
  try {
    await fireEvent.press(view.getByLabelText('进入直连'));
    await fireEvent.press(view.getByLabelText('更多'));
    expect(view.getByText('电脑直连没有服务端推送，请保持 App 打开查看任务进展。')).toBeTruthy();
    expect(view.queryByRole('switch', { name: '后台待命' })).toBeNull();
    expect(view.queryByLabelText('重新连接任务提醒')).toBeNull();
    expect(view.queryByText('系统限制了后台运行，请检查设置后重试')).toBeNull();
  } finally { await view.unmount(); platform.restore(); }
});

test('Android system back closes the notification menu before returning to the existing parent route', async () => {
  mockNotify = true;
  const handlers: Array<Parameters<typeof BackHandler.addEventListener>[1]> = [];
  const subscription = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    handlers.push(handler);
    return { remove: () => { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1); } };
  });
  const pressBack = () => act(async () => { for (const handler of [...handlers].reverse()) {
    if (handler({ type: 'hardwareBackPress', timeStamp: Date.now() })) break;
  } });
  const view = await render(<RemoteScreen/>);
  try {
    await fireEvent.press(view.getByLabelText('进入直连'));
    await fireEvent.press(view.getByLabelText('更多'));
    expect(view.getByLabelText('任务通知：已开启')).toBeTruthy();
    await pressBack();
    expect(view.queryByLabelText('任务通知：已开启')).toBeNull();
    expect(view.getByLabelText('更多')).toBeTruthy();
    expect(view.queryByLabelText('进入直连')).toBeNull();
    await pressBack();
    expect(view.getByLabelText('进入直连')).toBeTruthy();
    expect(view.queryByLabelText('更多')).toBeNull();
  } finally { await view.unmount(); subscription.mockRestore(); }
});
