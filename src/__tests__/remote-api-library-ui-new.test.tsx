import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { ProviderProfile } from '../domain';
import type { DeviceAgents, RemoteState } from '../remote/store';
import { RemoteApiLibrary } from '../remote/RemoteApiLibrary';

let mockRemote: Pick<RemoteState, 'phase' | 'devices' | 'agents' | 'connection' | 'connectionError' | 'connectionId' | 'selectedHubUrl' | 'serviceId' | 'connections' | 'connectionSync'>;
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
const mockConnectionSync = jest.fn();
const mockAgentChange = jest.fn();
const mockToast = jest.fn();
let expectedAgentChanges = 0;
let mockCredentialScope = 'credential-a';
const mockSetting = jest.fn();
let mockRefreshPress: (() => void) | undefined;
const legacyPhone: ProviderProfile = { id: 'existing', name: '旧手机 API', baseUrl: 'https://api.example/v1',
  model: null, chatModel: null, quality: null, aspectRatio: null, resolutionTier: null, createdAt: 1, updatedAt: 1 };
const legacyKeys = { existing: 'old-synthetic-secret' };

jest.mock('../state/AppContext', () => ({ useApp: () => mockUseApp() }));
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote,
  getRemoteState: () => mockRemote,
  loadAgentProfiles: (...args: unknown[]) => mockComputerRefresh(...args),
  syncRemoteConnections: (...args: unknown[]) => mockConnectionSync(...args),
  setAgentApi: (...args: unknown[]) => mockAgentChange(...args),
  apiRemoteProblem: () => '',
  apiStationChoices: () => [],
  remoteDeliveryScope: () => mockCredentialScope,
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
    showToast: (...args: unknown[]) => mockToast(...args),
    dismissKeyboardAndBlur: () => undefined,
  };
});
const catalogue = (loaded = true): DeviceAgents => ({ list: [],
  apis: loaded ? [{ id: 'opaque-pc-api', name: '电脑主力', models: ['not-displayed-model'] }] : [],
  loaded, loading: false });
const switchableCatalogue = (): DeviceAgents => ({
  list: [{ id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
    api: { name: '电脑主力', model: 'model-a', protocol: 'responses', configured: true, pending: false,
      source: 'phone', accountId: 'api-old' } }],
  apis: [{ id: 'api-old', name: '电脑主力', models: ['model-a'] },
    { id: 'api-new', name: '备用密钥', models: ['model-b'] }],
  loaded: true, loading: false,
});
const noMutations = () => {
  expect(mockUseApp).not.toHaveBeenCalled(); expect(mockReload).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled(); expect(mockListProviders).not.toHaveBeenCalled();
  expect(mockUpsert).not.toHaveBeenCalled(); expect(mockDeleteProvider).not.toHaveBeenCalled();
  expect(mockKeyRead).not.toHaveBeenCalled(); expect(mockKeySave).not.toHaveBeenCalled();
  expect(mockKeyDelete).not.toHaveBeenCalled(); expect(mockDefault).not.toHaveBeenCalled();
  expect(mockSetting).not.toHaveBeenCalled(); expect(mockAgentChange).toHaveBeenCalledTimes(expectedAgentChanges);
};
beforeEach(() => {
  jest.clearAllMocks();
  mockComputerRefresh.mockReset();
  mockAgentChange.mockReset(); expectedAgentChanges = 0; mockCredentialScope = 'credential-a';
  mockRefreshPress = undefined;
  mockRemote = { phase: 'ready', connection: 'open', connectionId: 'saved-pc', connections: [{ id: 'saved-pc', hubUrl: 'https://station.example/salcara-hub/v1', deviceId: 'pc', deviceName: '测试电脑', pairedAt: 1 }], selectedHubUrl: 'https://station.example/salcara-hub/v1', serviceId: 'station', devices: [{ deviceId: 'pc', name: '测试电脑', os: 'windows',
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

test('same-name computer APIs show only Agents assigned to their matching opaque account ID', async () => {
  mockRemote.agents.pc = {
    list: [
      { id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
        api: { name: '主力', model: 'model-a', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api-a' } },
      { id: 'claude', name: 'Claude Code', tool: 'claude', available: true, remoteSendSupported: true,
        api: { name: '主力', model: 'model-b', protocol: 'messages', configured: true, pending: false, source: 'computer', accountId: 'api-b' } },
    ],
    apis: [{ id: 'api-a', name: '主力', models: ['model-a'] }, { id: 'api-b', name: '主力', models: ['model-b'] }],
    loaded: true, loading: false,
  };
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getAllByText('主力').length).toBeGreaterThanOrEqual(2);
  await fireEvent.press(view.getByRole('button', { name: '主力，Codex 使用，查看详情' }));
  expect(view.getByRole('button', { name: '主力，Codex 使用，收起详情' })).toBeTruthy();
  expect(view.getByText('正在使用', { exact: true })).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: '主力，Claude Code 使用，查看详情' }));
  expect(view.getByRole('button', { name: '主力，Claude Code 使用，收起详情' })).toBeTruthy();
  expect(view.getByRole('button', { name: '主力，Codex 使用，查看详情' })).toBeTruthy();
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

test('Agent API controls follow the selected computer, including each current assignment', async () => {
  mockRemote.agents.pc = switchableCatalogue();
  const close = jest.fn();
  const view = await render(<RemoteApiLibrary visible onClose={close} deviceId="pc" />);
  expect(view.getByText('Agent', { exact: true })).toBeTruthy();
  expect(view.getByRole('button', { name: '更换 Codex 的 API' })).toBeTruthy();
  expect(view.queryByRole('button', { name: '核对 Codex 的 API 状态' })).toBeNull();

  mockRemote.devices.push({ ...mockRemote.devices[0], deviceId: 'pc-2', name: '另一台电脑' });
  mockRemote.agents['pc-2'] = { list: [{ ...switchableCatalogue().list[0], id: 'claude', name: 'Claude Code', tool: 'claude',
    api: { ...switchableCatalogue().list[0].api, name: '第二台密钥', accountId: 'api-pc2' } }],
    apis: [{ id: 'api-pc2', name: '第二台密钥', models: ['model-c'] }], loaded: true, loading: false };
  mockRemote.connectionId = 'saved-pc-2';
  await view.rerender(<RemoteApiLibrary visible onClose={close} deviceId="pc-2" />);
  expect(view.getByRole('button', { name: '更换 Claude Code 的 API' })).toBeTruthy();
  expect(view.queryByRole('button', { name: '更换 Codex 的 API' })).toBeNull();
  expect(view.getAllByText('第二台密钥').length).toBeGreaterThan(0);
  expect(view.queryByText('备用密钥')).toBeNull();
});

test.each([['codex', 'Codex'], ['deepseek-harness', 'DeepSeek Harness'], ['hermes', 'Hermes Agent']])('changing %s API sends its computer-local account ID and confirms the resulting assignment', async (id, name) => {
  expectedAgentChanges = 1;
  mockRemote.agents.pc = switchableCatalogue();
  mockRemote.agents.pc.list[0] = { ...mockRemote.agents.pc.list[0], id, name, tool: id };
  mockAgentChange.mockImplementation(async () => {
    const previous = mockRemote.agents.pc;
    const changed = { ...previous.list[0], api: { ...previous.list[0].api, name: '备用密钥', accountId: 'api-new' } };
    mockRemote.agents.pc = { ...previous, list: [changed] };
    return changed;
  });
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: `更换 ${name} 的 API` }));
  expect(view.getByTestId('agent-api-menu')).toBeTruthy();
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  await view.rerender(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(mockAgentChange).toHaveBeenCalledWith('pc', id, 'api-new', '');
  expect(mockComputerRefresh).toHaveBeenCalledWith('pc');
  expect(view.getByText('已生效')).toBeTruthy();
  expect(view.getAllByText('备用密钥').length).toBeGreaterThan(0);
});

test('offline Agent API controls cannot send a change and retain cached assignments', async () => {
  mockRemote.agents.pc = switchableCatalogue();
  mockRemote.devices[0].online = false;
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  const change = view.getByRole('button', { name: '更换 Codex 的 API' });
  expect(change.props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(change);
  expect(view.getAllByText('电脑主力').length).toBeGreaterThan(0);
  expect(mockAgentChange).not.toHaveBeenCalled();
});

test('an unconfirmed switch closes the menu and reads once without resending the change', async () => {
  expectedAgentChanges = 1;
  mockRemote.agents.pc = switchableCatalogue();
  mockAgentChange.mockRejectedValueOnce(new Error('private.example sk-secret'));
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  expect(view.getByText('结果未确认')).toBeTruthy();
  expect(view.queryByTestId('agent-api-menu')).toBeNull();
  expect(view.queryByRole('button', { name: /核对|重试切换/ })).toBeNull();
  expect(mockComputerRefresh).toHaveBeenCalledTimes(1);
  expect(view.getAllByText('电脑主力').length).toBeGreaterThan(0);
  expect(view.queryByText(/private\.example|sk-secret/)).toBeNull();
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(mockComputerRefresh).toHaveBeenCalledWith('pc');
  expect(mockComputerRefresh).toHaveBeenCalledTimes(2);
  expect(mockAgentChange).toHaveBeenCalledTimes(1);
  expect(view.getByText('结果未确认')).toBeTruthy();
  expect(view.queryByText('已生效')).toBeNull();
});

test('a successful command with an unreadable follow-up state remains pending until a later check', async () => {
  expectedAgentChanges = 1;
  mockRemote.agents.pc = switchableCatalogue();
  mockAgentChange.mockResolvedValueOnce({ ...switchableCatalogue().list[0],
    api: { ...switchableCatalogue().list[0].api, name: '备用密钥', accountId: 'api-new' } });
  mockComputerRefresh.mockRejectedValueOnce(new Error('temporarily offline'));
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  expect(view.getByText('结果未确认')).toBeTruthy();
  expect(view.getAllByText('电脑主力').length).toBeGreaterThan(0);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(mockComputerRefresh).toHaveBeenCalledTimes(2);
});

test('a missing command profile never counts as confirmation of the requested API', async () => {
  expectedAgentChanges = 1;
  mockRemote.agents.pc = switchableCatalogue();
  mockAgentChange.mockResolvedValueOnce(undefined);
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  expect(mockAgentChange).toHaveBeenCalledWith('pc', 'codex', 'api-new', '');
  expect(mockComputerRefresh).toHaveBeenCalledWith('pc');
  expect(view.getByText('结果未确认')).toBeTruthy();
  expect(view.queryByText('已生效')).toBeNull();
});

test('following the computer again clears only this Agent override', async () => {
  expectedAgentChanges = 1;
  mockRemote.agents.pc = switchableCatalogue();
  mockAgentChange.mockImplementation(async () => {
    const previous = mockRemote.agents.pc;
    const changed = { ...previous.list[0], api: { ...previous.list[0].api,
      name: '电脑默认 API', source: 'computer' as const, accountId: 'api-old' } };
    mockRemote.agents.pc = { ...previous, list: [changed] };
    return changed;
  });
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '默认 API' }));
  expect(mockAgentChange).toHaveBeenCalledWith('pc', 'codex', '', '');
  expect(view.getByText('已生效')).toBeTruthy();
  expect(view.getByText('电脑默认 API')).toBeTruthy();
});

test('demo computer can preview an Agent API switch locally without sending a remote command', async () => {
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="development-preview-pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: 'Claude Code 开发 API' }));
  expect(view.getByText('已生效')).toBeTruthy();
  expect(view.getAllByText('Claude Code 开发 API').length).toBeGreaterThan(0);
  expect(mockAgentChange).not.toHaveBeenCalled();
  expect(mockComputerRefresh).not.toHaveBeenCalled();
});

test('refreshing the demo catalogue never dispatches a real computer command', async () => {
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="development-preview-pc" />);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(mockComputerRefresh).not.toHaveBeenCalled();
  expect(view.getByText('已保存的 API')).toBeTruthy();
});

test.each(['pending', 'unconfigured', 'read-error'] as const)('%s state cannot be reported as a verified API assignment', async state => {
  expectedAgentChanges = 1;
  mockRemote.agents.pc = switchableCatalogue();
  mockAgentChange.mockRejectedValueOnce(new Error('receipt lost'));
  mockComputerRefresh.mockImplementation(async () => {
    const entry = mockRemote.agents.pc;
    mockRemote.agents.pc = { ...entry, error: state === 'read-error' ? 'Read failed' : undefined,
      list: entry.list.map(agent => ({ ...agent, api: { ...agent.api, pending: state === 'pending', configured: state !== 'unconfigured' } })) };
  });
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  expect(mockComputerRefresh).toHaveBeenCalledTimes(1);
  expect(view.getByText('结果未确认')).toBeTruthy();
  expect(view.queryByText('已生效')).toBeNull();
});

test('an unresolved target survives closing the sheet and returning from another computer', async () => {
  expectedAgentChanges = 1;
  mockRemote.agents.pc = switchableCatalogue();
  mockAgentChange.mockRejectedValueOnce(new Error('not acknowledged'));
  const onClose = jest.fn();
  const view = await render(<RemoteApiLibrary visible onClose={onClose} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  await view.rerender(<RemoteApiLibrary visible={false} onClose={onClose} deviceId="pc" />);
  mockRemote.devices.push({ ...mockRemote.devices[0], deviceId: 'pc-2' });
  mockRemote.agents['pc-2'] = switchableCatalogue();
  await view.rerender(<RemoteApiLibrary visible onClose={onClose} deviceId="pc-2" />);
  expect(view.queryByText('结果未确认')).toBeNull();
  await view.rerender(<RemoteApiLibrary visible onClose={onClose} deviceId="pc" />);
  expect(view.getByText('结果未确认')).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(view.getByText('结果未确认')).toBeTruthy();
  expect(view.queryByText('已生效')).toBeNull();
  mockRemote.agents.pc.list[0].api.accountId = 'api-new';
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(view.getByText('已生效')).toBeTruthy();
});

test('a catalogue read failure still allows the top-level read-only refresh', async () => {
  mockRemote.agents.pc = { ...switchableCatalogue(), error: 'Read failed' };
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(mockComputerRefresh).toHaveBeenCalledWith('pc');
  expect(view.getByText('结果未确认')).toBeTruthy();
});

test('confirming another Agent preserves the first Agent unresolved target', async () => {
  expectedAgentChanges = 2;
  mockRemote.agents.pc = switchableCatalogue();
  mockRemote.agents.pc.list.push({ ...switchableCatalogue().list[0], id: 'claude', name: 'Claude Code', apiFamily: 'claude', api: { ...switchableCatalogue().list[0].api } });
  mockAgentChange.mockRejectedValueOnce(new Error('not acknowledged'));
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  expect(view.queryByTestId('agent-api-menu')).toBeNull();
  mockAgentChange.mockImplementationOnce(async () => {
    const changed = { ...mockRemote.agents.pc.list[1], api: { ...mockRemote.agents.pc.list[1].api, accountId: 'api-new', name: '备用密钥' } };
    mockRemote.agents.pc.list[1] = changed;
    return changed;
  });
  await fireEvent.press(view.getByRole('button', { name: '更换 Claude Code 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  expect(view.getByText('结果未确认')).toBeTruthy();
  expect(view.getByText('已生效')).toBeTruthy();
});

test('partial station sync offers a retry without hiding the paired computer API directory', async () => {
  mockRemote.connectionSync = { connectionId: 'saved-pc', loading: false, failed: [{ hubUrl: 'https://offline.example', message: 'unreachable' }] };
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.getByText('电脑主力')).toBeTruthy();
  expect(view.getByText('1 个连接暂未同步，已绑定的电脑仍可使用')).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: '重试同步电脑连接' }));
  expect(mockConnectionSync).toHaveBeenCalledWith(true);
  await view.rerender(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc-2" />);
  expect(view.queryByRole('button', { name: '重试同步电脑连接' })).toBeNull();
});

test('re-pairing the same device cannot inherit an old credential pending API check', async () => {
  expectedAgentChanges = 1;
  mockRemote.agents.pc = switchableCatalogue();
  mockAgentChange.mockRejectedValueOnce(new Error('not acknowledged'));
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  expect(view.getByText('结果未确认')).toBeTruthy();
  mockCredentialScope = 'credential-b';
  await view.rerender(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(view.queryByText('结果未确认')).toBeNull();
  expect(view.getByRole('button', { name: '更换 Codex 的 API' }).props.accessibilityState.disabled).toBe(false);
});


test('opening offline reads the catalogue once after reconnection', async () => {
  mockRemote.agents.pc = catalogue(false); mockRemote.devices[0].online = false;
  const view = await render(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(mockComputerRefresh).not.toHaveBeenCalled();
  mockRemote.devices[0].online = true;
  await view.rerender(<RemoteApiLibrary visible onClose={jest.fn()} deviceId="pc" />);
  expect(mockComputerRefresh).toHaveBeenCalledTimes(1);
});


test('closing during a switch preserves its exact target until a later status check', async () => {
  expectedAgentChanges = 1; mockRemote.agents.pc = switchableCatalogue();
  let reject!: (error: Error) => void;
  mockAgentChange.mockReturnValueOnce(new Promise((_, no) => { reject = no; }));
  const onClose = jest.fn(); const view = await render(<RemoteApiLibrary visible onClose={onClose} deviceId="pc" />);
  await fireEvent.press(view.getByRole('button', { name: '更换 Codex 的 API' }));
  await fireEvent.press(view.getByRole('radio', { name: '备用密钥' }));
  await view.rerender(<RemoteApiLibrary visible={false} onClose={onClose} deviceId="pc" />);
  await act(async () => reject(new Error('connection lost')));
  expect(mockComputerRefresh).not.toHaveBeenCalled();
  await view.rerender(<RemoteApiLibrary visible onClose={onClose} deviceId="pc" />);
  expect(view.getByText('结果未确认')).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(view.queryByText('已生效')).toBeNull();
  expect(view.getByText('结果未确认')).toBeTruthy();
  mockRemote.agents.pc.list[0].api.accountId = 'api-new';
  await fireEvent.press(view.getByRole('button', { name: '刷新 API' }));
  expect(view.getByText('已生效')).toBeTruthy();
});
