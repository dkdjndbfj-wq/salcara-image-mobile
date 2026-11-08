import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { RemoteState } from '../remote/store';
import { RemoteApiLibrary } from '../remote/RemoteApiLibrary';

const mockPress = new Map<string, () => void>();
jest.mock('react-native', () => {
  const React = require('react'), native = jest.requireActual('react-native');
  return Object.create(Object.getPrototypeOf(native), {
    ...Object.getOwnPropertyDescriptors(native),
    Pressable: { configurable: true, enumerable: true, value: React.forwardRef((props: any, ref: any) => {
      if (props.accessibilityLabel && props.onPress) mockPress.set(props.accessibilityLabel, props.onPress);
      return React.createElement(native.Pressable, { ...props, ref });
    }) },
  });
});

let mockRemote: Pick<RemoteState, 'phase' | 'devices' | 'agents' | 'connection' | 'connectionId' | 'selectedHubUrl' | 'serviceId' | 'connections'>;
const mockRead = jest.fn(), mockChange = jest.fn();
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote,
  getRemoteState: () => mockRemote,
  loadAgentProfiles: (...args: unknown[]) => mockRead(...args),
  setAgentApi: (...args: unknown[]) => mockChange(...args),
  remoteDeliveryScope: () => 'fixture-credentials',
  apiRemoteProblem: () => '', apiStationChoices: () => [],
  syncRemoteConnections: jest.fn(),
}));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => {
  const React = require('react'), { Pressable, View, Text } = require('react-native');
  const button = (label: string, onPress: () => void, disabled = false) => React.createElement(Pressable, {
    accessibilityRole: 'button', accessibilityLabel: label, accessibilityState: { disabled }, disabled, onPress,
  }, React.createElement(Text, null, label));
  return {
    Sheet: ({ visible, children, headerRight, onClose }: any) => visible
      ? React.createElement(View, null, button('返回', onClose), headerRight, children) : null,
    IconButton: ({ label, onPress, disabled }: any) => button(label, onPress, disabled),
    showToast: jest.fn(), dismissKeyboardAndBlur: () => undefined,
  };
});

beforeEach(() => {
  jest.clearAllMocks(); mockPress.clear(); mockRead.mockReset().mockResolvedValue(undefined); mockChange.mockReset();
  mockRemote = {
    phase: 'ready', connection: 'open', connectionId: 'saved-pc', serviceId: 'station', selectedHubUrl: 'https://station.example/salcara-hub/v1',
    connections: [{ id: 'saved-pc', hubUrl: 'https://station.example/salcara-hub/v1', deviceId: 'pc', deviceName: '测试电脑', pairedAt: 1 }],
    devices: [{ deviceId: 'pc', name: '测试电脑', os: 'windows', online: true, lastSeen: 1, tools: [], projects: [] }],
    agents: { pc: { loaded: true, loading: false, list: [{ id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
      api: { name: '主力 API', model: 'fixture-model', protocol: 'responses', configured: true, pending: false, source: 'phone', accountId: 'api-a' } }],
      apis: [{ id: 'api-a', name: '主力 API', models: [] }, { id: 'api-b', name: '备用 API', models: [] }, { id: 'api-c', name: '第三个 API', models: [] }] } },
  };
});

test('a retained refresh cannot read during a new switch or replace its latest pending target', async () => {
  mockChange.mockRejectedValueOnce(new Error('first result unconfirmed'));
  const props = { visible: true, deviceId: 'pc', onClose: jest.fn() };
  const view = await render(<RemoteApiLibrary {...props} />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用 API' }));
  expect(view.getByText('结果未确认')).toBeTruthy();
  expect(view.queryByTestId('agent-api-menu')).toBeNull();
  expect(mockRead).toHaveBeenCalledTimes(1);
  const oldRefresh = mockPress.get('刷新 API')!;
  let rejectSwitch!: (error: Error) => void;
  mockChange.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSwitch = reject; }));
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '第三个 API' }));
  await act(async () => { oldRefresh(); });
  expect(mockRead).toHaveBeenCalledTimes(1);
  expect(mockChange).toHaveBeenLastCalledWith('pc', 'codex', 'api-c', '');
  await act(async () => { rejectSwitch(new Error('second result unconfirmed')); });
  expect(view.queryByTestId('agent-api-menu')).toBeNull();
  expect(mockRead).toHaveBeenCalledTimes(2);
  // Even the retained refresh must compare the latest requested target, api-c.
  mockRemote.agents.pc.list[0].api.accountId = 'api-b';
  await act(async () => { oldRefresh(); });
  expect(mockRead).toHaveBeenCalledTimes(3);
  expect(view.queryByText('已生效')).toBeNull();
  expect(view.getByText('结果未确认')).toBeTruthy();
  mockRemote.agents.pc.list[0].api.accountId = 'api-c';
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(mockRead).toHaveBeenCalledTimes(4);
  expect(view.getByText('已生效')).toBeTruthy();
  expect(mockChange).toHaveBeenCalledTimes(2);
  await view.unmount();
});

test.each(['unavailable', 'pending', 'offline'] as const)('an already open API menu rechecks %s before accepting a retained selection', async condition => {
  const props = { visible: true, deviceId: 'pc', onClose: jest.fn() };
  const view = await render(<RemoteApiLibrary {...props} />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  const oldSelect = mockPress.get('备用 API')!;
  if (condition === 'unavailable') mockRemote.agents.pc.list[0].available = false;
  else if (condition === 'pending') mockRemote.agents.pc.list[0].api.pending = true;
  else mockRemote.devices[0].online = false;
  await view.rerender(<RemoteApiLibrary {...props} />);
  expect(view.getByRole('radio', { name: '备用 API' }).props.accessibilityState.disabled).toBe(true);
  await act(async () => { oldSelect(); });
  await fireEvent.press(view.getByRole('radio', { name: '备用 API' }));
  expect(mockChange).not.toHaveBeenCalled();
  expect(mockRead).not.toHaveBeenCalled();
  await view.unmount();
});

test('a failure automatically reads the exact attempted API once after the switch lock ends', async () => {
  mockChange.mockRejectedValueOnce(new Error('receipt lost'));
  mockRead.mockImplementationOnce(async () => {
    mockRemote.agents.pc.list[0].api = { ...mockRemote.agents.pc.list[0].api, accountId: 'api-b', name: '备用 API' };
  });
  const view = await render(<RemoteApiLibrary visible deviceId="pc" onClose={jest.fn()} />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用 API' }));
  expect(view.queryByTestId('agent-api-menu')).toBeNull();
  expect(view.queryByRole('button', { name: /核对|重试切换/ })).toBeNull();
  expect(mockRead).toHaveBeenCalledTimes(1);
  expect(mockChange).toHaveBeenCalledTimes(1);
  expect(view.getByText('已生效')).toBeTruthy();
  await view.unmount();
});

test.each(['closed', 'reopened', 'station', 'device', 'offline', 'unmounted'] as const)('a late failed switch cannot trigger its automatic read after %s', async condition => {
  let reject!: (error: Error) => void;
  mockChange.mockReturnValueOnce(new Promise((_resolve, no) => { reject = no; }));
  const props = { visible: true, deviceId: 'pc', onClose: jest.fn() };
  const view = await render(<RemoteApiLibrary {...props} />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用 API' }));
  if (condition === 'closed' || condition === 'reopened') {
    await view.rerender(<RemoteApiLibrary {...props} visible={false} />);
    if (condition === 'reopened') await view.rerender(<RemoteApiLibrary {...props} />);
  } else if (condition === 'station') {
    mockRemote.serviceId = 'another-station';
    await view.rerender(<RemoteApiLibrary {...props} />);
  } else if (condition === 'device') {
    mockRemote.devices.push({ ...mockRemote.devices[0], deviceId: 'pc-2' });
    mockRemote.agents['pc-2'] = { ...mockRemote.agents.pc };
    await view.rerender(<RemoteApiLibrary {...props} deviceId="pc-2" />);
  } else if (condition === 'offline') {
    mockRemote.devices[0].online = false;
    await view.rerender(<RemoteApiLibrary {...props} />);
  } else await view.unmount();
  await act(async () => reject(new Error('late result')));
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockChange).toHaveBeenCalledTimes(1);
  if (condition !== 'unmounted') await view.unmount();
});

test('an automatic read stays read-only and cannot confirm another computer after a scope change', async () => {
  let settleRead!: () => void;
  mockChange.mockRejectedValueOnce(new Error('receipt lost'));
  mockRead.mockReturnValueOnce(new Promise<void>(resolve => { settleRead = resolve; }));
  const props = { visible: true, deviceId: 'pc', onClose: jest.fn() };
  const view = await render(<RemoteApiLibrary {...props} />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用 API' }));
  expect(view.getByText('正在同步…')).toBeTruthy();
  expect(mockRead).toHaveBeenCalledTimes(1);
  mockRemote.devices.push({ ...mockRemote.devices[0], deviceId: 'pc-2' });
  mockRemote.agents['pc-2'] = { ...mockRemote.agents.pc };
  await view.rerender(<RemoteApiLibrary {...props} deviceId="pc-2" />);
  mockRemote.agents.pc.list[0].api.accountId = 'api-b';
  await act(async () => settleRead());
  expect(view.queryByText('已生效')).toBeNull();
  expect(view.queryByText('结果未确认')).toBeNull();
  expect(mockRead).toHaveBeenCalledTimes(1);
  expect(mockChange).toHaveBeenCalledTimes(1);
  await view.unmount();
});
