import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ProviderProfile } from '../domain';
import type { DeviceAgents, RemoteState } from '../remote/store';
import { RemoteApiLibrary } from '../remote/RemoteApiLibrary';

let mockRemote: Pick<RemoteState, 'phase' | 'devices' | 'agents' | 'connection' | 'connectionError' | 'connectionId' | 'selectedHubUrl' | 'serviceId'>;
const mockUseApp = jest.fn();
const mockReload = jest.fn();
const mockRemove = jest.fn();
const mockUpsert = jest.fn();
const mockListProviders = jest.fn();
const mockDeleteProvider = jest.fn();
const mockKeySave = jest.fn();
const mockKeyRead = jest.fn();
const mockKeyDelete = jest.fn();
const mockDefault = jest.fn();
const mockComputerRefresh = jest.fn();
const mockAgentChange = jest.fn();
const mockSetting = jest.fn();
let mockRefreshPress: (() => void) | undefined;
const legacyPhone: ProviderProfile = { id: 'existing', name: '旧手机 API', baseUrl: 'https://api.example/v1',
  model: null, chatModel: null, quality: null, aspectRatio: null, resolutionTier: null, createdAt: 1, updatedAt: 1 };
const legacyKeys = { existing: 'old-synthetic-secret' };

jest.mock('../state/AppContext', () => ({ useApp: () => mockUseApp() }));
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote,
  loadAgentProfiles: (...args: unknown[]) => mockComputerRefresh(...args),
  setAgentApi: (...args: unknown[]) => mockAgentChange(...args),
}));
jest.mock('../storage/database', () => ({
  listProviders: (...args: unknown[]) => mockListProviders(...args),
  upsertProvider: (...args: unknown[]) => mockUpsert(...args),
  deleteProviderRecord: (...args: unknown[]) => mockDeleteProvider(...args),
  setSetting: (...args: unknown[]) => mockSetting(...args),
}));
jest.mock('../storage/secure-keys', () => ({
  getProviderKey: (...args: unknown[]) => mockKeyRead(...args),
  saveProviderKey: (...args: unknown[]) => mockKeySave(...args),
  deleteProviderKey: (...args: unknown[]) => mockKeyDelete(...args),
}));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => {
  const React = require('react'); const { Pressable, View, Text } = require('react-native');
  const button = (label: string, onPress: () => void, disabled = false) => React.createElement(Pressable, {
    accessibilityRole: 'button', accessibilityLabel: label, disabled, accessibilityState: { disabled }, onPress,
  }, React.createElement(Text, null, label));
  return {
    Sheet: ({ visible, children, headerRight, onClose }: { visible: boolean; children: unknown; headerRight?: unknown; onClose: () => void }) => visible
      ? React.createElement(View, null, button('返回', onClose), headerRight, children) : null,
    IconButton: ({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) => {
      if (label === '刷新 API') mockRefreshPress = onPress;
      return button(label, onPress, disabled);
    },
    dismissKeyboardAndBlur: () => undefined,
  };
});
const catalogue = (loaded = true): DeviceAgents => ({ list: [],
  apis: loaded ? [{ id: 'opaque-pc-api', name: '电脑主力', models: ['not-displayed-model'] }] : [],
  loaded, loading: false });
const noMutations = () => {
  expect(mockUseApp).not.toHaveBeenCalled(); expect(mockReload).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled(); expect(mockListProviders).not.toHaveBeenCalled();
  expect(mockUpsert).not.toHaveBeenCalled(); expect(mockDeleteProvider).not.toHaveBeenCalled();
  expect(mockKeyRead).not.toHaveBeenCalled(); expect(mockKeySave).not.toHaveBeenCalled();
  expect(mockKeyDelete).not.toHaveBeenCalled(); expect(mockDefault).not.toHaveBeenCalled();
  expect(mockSetting).not.toHaveBeenCalled(); expect(mockAgentChange).not.toHaveBeenCalled();
};
beforeEach(() => {
  jest.clearAllMocks();
  mockComputerRefresh.mockReset();
  mockRefreshPress = undefined;
  mockRemote = { phase: 'ready', connection: 'open', connectionId: 'saved-pc', selectedHubUrl: 'https://station.example/salcara-hub/v1', serviceId: 'station', devices: [{ deviceId: 'pc', name: '测试电脑', os: 'windows',
    tools: [], projects: [], online: true, lastSeen: 1 }], agents: { pc: catalogue() } };
  mockComputerRefresh.mockResolvedValue(undefined);
  mockUseApp.mockReturnValue({ providers: [legacyPhone], reloadProviders: mockReload, removeProvider: mockRemove,
    selectChatProvider: mockDefault, selectImageProvider: mockDefault, updateProvider: mockDefault });
  mockListProviders.mockResolvedValue([legacyPhone]); mockKeyRead.mockResolvedValue(legacyKeys.existing);
});
afterEach(noMutations);

test('the unified directory shows only computer API names, without tabs or credential controls', async () => {
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByText('电脑主力')).toBeTruthy(); expect(view.getByText(/测试电脑/)).toBeTruthy();
  expect(view.queryByText('旧手机 API')).toBeNull();
  expect(view.queryByRole('tab')).toBeNull(); expect(view.queryByText('手机 API')).toBeNull();
  expect(view.queryByText('电脑 API')).toBeNull(); expect(view.queryByText('opaque-pc-api')).toBeNull();
  expect(view.queryByText('not-displayed-model')).toBeNull(); expect(view.queryByText('old-synthetic-secret')).toBeNull();
  expect(view.queryByLabelText('API Key')).toBeNull();
  expect(view.queryByRole('button', { name: '添加 API' })).toBeNull();
  expect(view.queryByRole('button', { name: /编辑|删除|保存/ })).toBeNull();
  expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test('explicit refresh is read-only and does not change the Agent API or phone defaults', async () => {
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(mockComputerRefresh).toHaveBeenCalledTimes(1); expect(mockComputerRefresh).toHaveBeenCalledWith('pc');
  noMutations();
});

test('a missing catalogue is read once on open and is not polled on rerender', async () => {
  mockRemote.agents.pc = catalogue(false);
  const close = jest.fn(); const view = await render(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  expect(mockComputerRefresh).toHaveBeenCalledTimes(1);
  await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  expect(mockComputerRefresh).toHaveBeenCalledTimes(1);
});

test('a hidden directory does not read any catalogue', async () => {
  mockRemote.agents.pc = catalogue(false);
  await render(<RemoteApiLibrary visible={false} onClose={jest.fn()} deviceId="pc" />);
  expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test('an empty computer vault directs adding on the computer without a fake Add button', async () => {
  mockRemote.agents.pc.apis = [];
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByText('在电脑端添加 API')).toBeTruthy();
  expect(view.queryByRole('button', { name: '添加 API' })).toBeNull();
  expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test('an unpaired user sees one binding empty state and no refresh command', async () => {
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} />);
  expect(view.getByText('绑定电脑后查看 API')).toBeTruthy();
  expect(view.queryByRole('button', { name: '刷新 API' })).toBeNull();
  expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test('offline cached metadata stays visible and refresh is disabled', async () => {
  mockRemote.devices[0].online = false;
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByText('电脑主力')).toBeTruthy(); expect(view.getByText('电脑当前离线')).toBeTruthy();
  const refresh = view.getByRole('button', { name: '刷新 API' });
  expect(refresh.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(refresh); expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test('offline without a cache never queues a read command', async () => {
  mockRemote.devices[0].online = false; mockRemote.agents.pc = catalogue(false);
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByText('电脑当前离线')).toBeTruthy(); expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test.each(['error', 'idle', 'connecting', 'retrying'] as const)('Hub %s does not fetch or allow refresh even with a cached online computer', async (connection) => {
  mockRemote.connection = connection; mockRemote.agents.pc = catalogue(false);
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByText('当前未连接')).toBeTruthy();
  const refresh = view.getByRole('button', { name: '刷新 API' });
  expect(refresh.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(refresh); expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test('a transport error blocks reads even when the last connection flag was open', async () => {
  mockRemote.connectionError = 'network disconnected'; mockRemote.agents.pc = catalogue(false);
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByText('当前未连接')).toBeTruthy();
  expect(view.getByRole('button', { name: '刷新 API' }).props.accessibilityState.disabled).toBe(true);
  expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test('failed reads are concise, hide internal data and can be manually retried', async () => {
  mockRemote.agents.pc = catalogue(false);
  mockComputerRefresh.mockRejectedValueOnce(new Error('https://private.example sk-internal-fixture'));
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByText('暂时无法读取，请重试')).toBeTruthy();
  expect(view.queryByText(/private\.example|sk-internal/)).toBeNull();
  expect(mockComputerRefresh).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(mockComputerRefresh).toHaveBeenCalledTimes(2);
});

test('same-tick duplicate refresh cannot create simultaneous reads', async () => {
  let settle!: () => void; mockComputerRefresh.mockReturnValueOnce(new Promise<void>((resolve) => { settle = resolve; }));
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByRole('button', { name: '刷新 API' })).toBeTruthy();
  const onPress = mockRefreshPress!;
  await act(async () => { onPress(); onPress(); });
  expect(mockComputerRefresh).toHaveBeenCalledTimes(1);
  expect(view.getByRole('button', { name: '刷新 API' }).props.accessibilityState.disabled).toBe(true);
  await act(async () => { settle(); });
});

test('closing during a read does not block navigation or show a late error on reopen', async () => {
  let reject!: (error: Error) => void; mockComputerRefresh.mockReturnValueOnce(new Promise<void>((_, no) => { reject = no; }));
  const close = jest.fn(); const view = await render(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  await fireEvent.press(view.getByRole('button', { name: '返回' })); expect(close).toHaveBeenCalledTimes(1);
  await view.rerender(<RemoteApiLibrary visible={false} onClose={close} deviceId="pc" />);
  await act(async () => { reject(new Error('late failure')); });
  await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  expect(view.queryByText('暂时无法读取，请重试')).toBeNull();
});

test('a previous computer read cannot inject an error into the newly selected computer', async () => {
  let reject!: (error: Error) => void; mockComputerRefresh.mockReturnValueOnce(new Promise<void>((_, no) => { reject = no; }));
  const close = jest.fn(); const view = await render(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  mockRemote.devices.push({ ...mockRemote.devices[0], deviceId: 'pc-2', name: '另一台电脑' });
  mockRemote.agents['pc-2'] = { ...catalogue(), apis: [{ id: 'opaque-pc-2-api', name: '第二台主力', models: [] }] };
  await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc-2" />);
  await act(async () => { reject(new Error('old device failed')); });
  expect(view.getByText('第二台主力')).toBeTruthy();
  expect(view.queryByText('暂时无法读取，请重试')).toBeNull();
});

test('changing station with the same device ID ignores a late previous-station error', async () => {
  let reject!: (error: Error) => void; mockComputerRefresh.mockReturnValueOnce(new Promise<void>((_, no) => { reject = no; }));
  const close = jest.fn(); const view = await render(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  mockRemote.connectionId = 'another-pc'; mockRemote.selectedHubUrl = 'https://other-station.example/salcara-hub/v1'; mockRemote.serviceId = 'other-station';
  mockRemote.agents.pc = { ...catalogue(), apis: [{ id: 'new-station-opaque', name: '新站主力', models: [] }] };
  await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  await act(async () => { reject(new Error('old station failure')); });
  expect(view.getByText('新站主力')).toBeTruthy();
  expect(view.queryByText('暂时无法读取，请重试')).toBeNull();
  expect(view.getByRole('button', { name: '刷新 API' }).props.accessibilityState.disabled).toBe(false);
});

test('legacy phone providers and SecureStore values are neither read nor removed', async () => {
  const providerBefore = { ...legacyPhone }; const keysBefore = { ...legacyKeys };
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  await fireEvent.press(view.getByRole('button', { name: '返回' }));
  noMutations(); expect(legacyPhone).toEqual(providerBefore); expect(legacyKeys).toEqual(keysBefore);
});

test.each(['closed', 'reopened', 'station', 'device', 'offline', 'unmounted'] as const)('queued API refresh checks the latest %s generation before dispatch', async condition => {
  const close = jest.fn(); const view = await render(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  const oldRefresh = mockRefreshPress!;
  if (condition === 'closed') await fireEvent.press(view.getByLabelText('返回'));
  else if (condition === 'reopened') {
    await view.rerender(<RemoteApiLibrary visible={false} onClose={close} deviceId="pc" />);
    await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  } else if (condition === 'station') {
    mockRemote.serviceId = 'new-relay'; await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  } else if (condition === 'device') {
    mockRemote.devices.push({ ...mockRemote.devices[0], deviceId: 'pc-2' }); mockRemote.agents['pc-2'] = catalogue();
    await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc-2" />);
  } else if (condition === 'offline') {
    mockRemote.devices[0].online = false; await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  } else await view.unmount();
  await act(async () => oldRefresh()); expect(mockComputerRefresh).not.toHaveBeenCalled();
});
