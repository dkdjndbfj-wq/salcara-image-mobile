import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { RemoteBotBinding, RemoteBotGroups } from '../remote/RemoteBotBinding';
import { botConnectionId, type BotGroupState } from '../remote/connections';
import type { BotGroupResult } from '../remote/bot-group-bindings';
import type { RemoteState } from '../remote/store';

const mockImport = jest.fn(), mockUse = jest.fn(), mockReload = jest.fn(), mockToast = jest.fn();
const mockRefresh = jest.fn(), mockRetry = jest.fn(), mockRevoke = jest.fn();
const mockPreviewIdentity = jest.fn(), mockConfirmIdentity = jest.fn();
let mockRevision = 1;
let mockState: RemoteState;
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../remote/store', () => ({
  getRemoteState: () => mockState, remoteConnectionRevision: () => mockRevision,
  importRemoteBotBinding: (...args: unknown[]) => mockImport(...args),
  refreshRemoteBotGroup: (...args: unknown[]) => mockRefresh(...args), retryRemoteBotGroupBinding: (...args: unknown[]) => mockRetry(...args),
  revokeRemoteBotGroup: (...args: unknown[]) => mockRevoke(...args),
  previewRemoteBotIdentity: (...args: unknown[]) => mockPreviewIdentity(...args), confirmRemoteBotIdentity: (...args: unknown[]) => mockConfirmIdentity(...args),
  reloadSavedConnections: (...args: unknown[]) => mockReload(...args), useSavedConnection: (...args: unknown[]) => mockUse(...args),
}));
jest.mock('../components/ui', () => ({ ...jest.requireActual('../components/ui'), showToast: (...args: unknown[]) => mockToast(...args) }));

const endpoint = 'https://bot.example/salcara-hub/v1';
const binding = { type: 'salcara-hub-bot-binding', version: 1, hubUrl: 'https://bot.example/salcara-hub', groupId: 'group', invite: 'a'.repeat(64), signature: 'b'.repeat(64) };
const device = (deviceId: string, online: boolean) => ({ deviceId, computerId: `physical-${deviceId}`, name: '同名电脑', os: 'windows', lastSeen: 1, tools: [], projects: [], online });
const group: BotGroupState = { id: 'group-record', hubUrl: endpoint, groupId: 'group', generation: 'generation-one', status: 'active', pairedAt: 1,
  pin: { instanceId: 'original-server-instance-full', publicKey: 'A'.repeat(43) + '=' } };
const identityPreview = { id: group.id, generation: group.generation, hubUrl: group.hubUrl, groupId: group.groupId,
  pin: group.pin!, target: { endpoint: group.hubUrl, pin: group.pin! } };
const result = (devices = [device('a', false), device('b', true)]): BotGroupResult => ({ group, devices,
  profiles: devices.map(item => ({ id: botConnectionId(endpoint, item.deviceId, group.groupId), hubUrl: endpoint,
    deviceId: item.deviceId, deviceName: item.name, computerId: item.computerId, botGroupId: group.groupId, botGeneration: group.generation, pairedAt: 1 })) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function importBot(onBound = jest.fn()) {
  const view = await render(<RemoteBotBinding remote={mockState} onBound={onBound} />);
  await fireEvent.press(view.getByRole('button', { name: 'Bot 连接' }));
  await fireEvent.changeText(view.getByLabelText('Bot 绑定 JSON'), JSON.stringify(binding));
  await fireEvent.press(view.getByRole('button', { name: '导入并绑定' }));
  return { view, onBound };
}
beforeEach(() => {
  jest.clearAllMocks(); mockRevision = 1;
  mockState = { connections: [], botGroups: [], connectionId: null, selectedHubUrl: null, signingIn: null, connection: 'idle' } as unknown as RemoteState;
  mockImport.mockReset().mockImplementation(async () => { const value = result(); mockState = { ...mockState, connections: value.profiles, botGroups: [value.group] }; return value; });
  mockRefresh.mockReset().mockResolvedValue(result()); mockRetry.mockReset().mockResolvedValue(result()); mockRevoke.mockReset().mockResolvedValue(undefined);
  mockPreviewIdentity.mockReset().mockResolvedValue(identityPreview); mockConfirmIdentity.mockReset().mockResolvedValue(result());
  mockReload.mockReset().mockImplementation(async () => mockState.connections);
  mockUse.mockReset().mockImplementation(async (id: string) => {
    const profile = mockState.connections.find(item => item.id === id)!;
    mockState = { ...mockState, connectionId: id, selectedHubUrl: profile.hubUrl, connection: 'open' }; mockRevision++;
  });
});

test('Bot import uses durable group members and returns the exact active online profile, including transport', async () => {
  const { onBound } = await importBot();
  await waitFor(() => expect(onBound).toHaveBeenCalledTimes(1));
  expect(mockImport).toHaveBeenCalledWith(binding);
  const profiles = mockState.connections;
  expect(profiles.map(item => item.id)).toEqual(['a', 'b'].map(id => botConnectionId(endpoint, id, 'group')));
  expect(profiles.every(item => item.hubUrl === endpoint && item.botGroupId === 'group')).toBe(true);
  expect(profiles.map(item => item.computerId)).toEqual(['physical-a', 'physical-b']);
  expect(mockUse).toHaveBeenCalledWith(profiles[1].id, false, expect.objectContaining({ stillWanted: expect.any(Function) }));
  expect(onBound).toHaveBeenCalledWith({ kind: 'bot', connectionId: profiles[1].id, deviceId: 'b' });
});

test('a delayed activation cannot report a different computer as successful', async () => {
  mockUse.mockImplementation(async () => { mockState = { ...mockState, connectionId: 'another-connection', connection: 'open', selectedHubUrl: endpoint }; });
  const { view, onBound } = await importBot();
  await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(/Bot 组已保存/));
  expect(onBound).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
});

test('selecting another connection during binding saves the group without stealing the current route', async () => {
  const pending = deferred<BotGroupResult>(); mockImport.mockReturnValue(pending.promise);
  const { onBound } = await importBot();
  mockRevision++;
  await act(async () => pending.resolve(result([device('a', true)])));
  expect(mockImport).toHaveBeenCalledTimes(1);
  expect(mockUse).not.toHaveBeenCalled();
  expect(onBound).not.toHaveBeenCalled();
});

test('leaving the import page while binding is in flight cannot activate a saved profile', async () => {
  const pending = deferred<BotGroupResult>(); mockImport.mockReturnValue(pending.promise);
  const { view, onBound } = await importBot();
  await view.unmount();
  await act(async () => pending.resolve(result([device('a', true)])));
  expect(mockImport).toHaveBeenCalledTimes(1);
  expect(mockUse).not.toHaveBeenCalled();
  expect(onBound).not.toHaveBeenCalled();
});

test('leaving during connection activation invalidates its guard and suppresses onBound', async () => {
  const pending = deferred<void>(); mockUse.mockReturnValue(pending.promise);
  const { view, onBound } = await importBot();
  await waitFor(() => expect(mockUse).toHaveBeenCalledTimes(1));
  const guard = mockUse.mock.calls[0][2].stillWanted;
  expect(guard()).toBe(true);
  await view.unmount(); expect(guard()).toBe(false);
  await act(async () => pending.resolve());
  expect(onBound).not.toHaveBeenCalled();
});

test('binding an empty group succeeds without inventing or selecting a computer', async () => {
  mockImport.mockResolvedValue(result([]));
  const { onBound } = await importBot();
  await waitFor(() => expect(mockToast).toHaveBeenCalledWith('Bot 组已绑定，等待电脑加入', 'check'));
  expect(mockUse).not.toHaveBeenCalled(); expect(onBound).not.toHaveBeenCalled();
});

test('a pending group exposes separate read and explicit retry actions without activation', async () => {
  mockState = { ...mockState, botGroups: [{ ...group, status: 'pending' }] };
  const view = await render(<RemoteBotGroups remote={mockState} />);
  expect(view.getByText(/绑定结果待确认/)).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: '查询绑定状态' }));
  await waitFor(() => expect(mockRefresh).toHaveBeenCalledWith(group.id, expect.any(Function)));
  expect(mockRetry).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: '重试原绑定' }));
  await waitFor(() => expect(mockRetry).toHaveBeenCalledWith(group.id));
  expect(mockUse).not.toHaveBeenCalled();
});

test('an empty active group and an unresolved revocation stay manageable', async () => {
  mockState = { ...mockState, botGroups: [group] };
  const view = await render(<RemoteBotGroups remote={mockState} />);
  expect(view.getByText(/已绑定，等待电脑加入/)).toBeTruthy();
  expect(view.getByRole('button', { name: '刷新组电脑' })).toBeTruthy();
  mockState = { ...mockState, botGroups: [{ ...group, status: 'revoking' }] };
  await view.rerender(<RemoteBotGroups remote={mockState} />);
  expect(view.getByText(/解除待确认，已暂停/)).toBeTruthy();
  expect(view.getByRole('button', { name: '重试解除 Bot 组' })).toBeTruthy();
  expect(view.queryByRole('button', { name: '刷新组电脑' })).toBeNull();
});

test('an old group confirmation cannot revoke a newer binding generation', async () => {
  mockState = { ...mockState, botGroups: [group] };
  const view = await render(<RemoteBotGroups remote={mockState} />);
  await fireEvent.press(view.getByRole('button', { name: '解除 Bot 组' }));
  mockState = { ...mockState, botGroups: [{ ...group, generation: 'generation-two' }] };
  await fireEvent.press(view.getByRole('button', { name: '确认解除 Bot 组' }));
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalledWith('Bot 绑定已改变，请刷新后重新确认', 'alert');
});

test('a legacy group previews complete copyable identity fields before explicit confirmation', async () => {
  mockState = { ...mockState, botGroups: [{ ...group, pin: undefined }] };
  const view = await render(<RemoteBotGroups remote={mockState} />);
  expect(view.getByText(/安全身份待确认，原绑定凭据保留/)).toBeTruthy();
  expect(view.queryByRole('button', { name: '刷新组电脑' })).toBeNull();
  await fireEvent.press(view.getByRole('button', { name: '确认服务器身份' }));
  await waitFor(() => expect(view.getByRole('button', { name: '已核对，确认此身份' })).toBeTruthy());
  const text = view.getByText(/服务器身份\s+original-server-instance-full/);
  expect(text.props.children).toContain(group.pin!.publicKey);
  expect(text.props.selectable).toBe(true);
  expect(mockPreviewIdentity).toHaveBeenCalledWith(group.id);
  expect(mockConfirmIdentity).not.toHaveBeenCalled(); expect(mockRefresh).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: '已核对，确认此身份' }));
  await waitFor(() => expect(mockConfirmIdentity).toHaveBeenCalledWith(group.id, identityPreview, expect.any(Function)));
  expect(mockImport).not.toHaveBeenCalled(); expect(mockRetry).not.toHaveBeenCalled(); expect(mockUse).not.toHaveBeenCalled();
});

test('canceling an in-flight identity confirmation invalidates its dispatch guard', async () => {
  mockState = { ...mockState, botGroups: [{ ...group, pin: undefined }] };
  const pending = deferred<BotGroupResult>(); mockConfirmIdentity.mockReturnValue(pending.promise);
  const view = await render(<RemoteBotGroups remote={mockState} />);
  await fireEvent.press(view.getByRole('button', { name: '确认服务器身份' }));
  await fireEvent.press(view.getByRole('button', { name: '已核对，确认此身份' }));
  const guard = mockConfirmIdentity.mock.calls[0][2]; expect(guard()).toBe(true);
  await fireEvent.press(view.getByRole('button', { name: '取消' }));
  expect(guard()).toBe(false);
  await act(async () => pending.resolve(result()));
  expect(mockToast).not.toHaveBeenCalled(); expect(mockUse).not.toHaveBeenCalled();
});

test('a late anonymous identity preview cannot reopen after leaving and returning to the page', async () => {
  mockState = { ...mockState, botGroups: [{ ...group, pin: undefined }] };
  const pending = deferred<typeof identityPreview>(); mockPreviewIdentity.mockReturnValue(pending.promise);
  const view = await render(<RemoteBotGroups remote={mockState} />);
  await fireEvent.press(view.getByRole('button', { name: '确认服务器身份' }));
  await view.rerender(<RemoteBotGroups remote={mockState} visible={false} />);
  await act(async () => pending.resolve(identityPreview));
  await view.rerender(<RemoteBotGroups remote={mockState} visible />);
  expect(view.queryByRole('button', { name: '已核对，确认此身份' })).toBeNull();
  expect(mockConfirmIdentity).not.toHaveBeenCalled();
});

test('a group reset while identity confirmation is pending invalidates the original guard', async () => {
  mockState = { ...mockState, botGroups: [{ ...group, pin: undefined }] };
  const pending = deferred<BotGroupResult>(); mockConfirmIdentity.mockReturnValue(pending.promise);
  const view = await render(<RemoteBotGroups remote={mockState} />);
  await fireEvent.press(view.getByRole('button', { name: '确认服务器身份' }));
  await fireEvent.press(view.getByRole('button', { name: '已核对，确认此身份' }));
  const guard = mockConfirmIdentity.mock.calls[0][2]; expect(guard()).toBe(true);
  mockState = { ...mockState, botGroups: [{ ...group, status: 'revoked' }] };
  expect(guard()).toBe(false);
  await act(async () => pending.resolve(result()));
  expect(mockToast).not.toHaveBeenCalled();
});

test('hiding a retained binding page invalidates its identity confirmation without unmounting', async () => {
  mockState = { ...mockState, botGroups: [{ ...group, pin: undefined }] };
  const pending = deferred<BotGroupResult>(); mockConfirmIdentity.mockReturnValue(pending.promise);
  const onBound = jest.fn();
  const view = await render(<RemoteBotBinding remote={mockState} onBound={onBound} visible />);
  await fireEvent.press(view.getByRole('button', { name: '确认服务器身份' }));
  await fireEvent.press(view.getByRole('button', { name: '已核对，确认此身份' }));
  const guard = mockConfirmIdentity.mock.calls[0][2]; expect(guard()).toBe(true);
  await view.rerender(<RemoteBotBinding remote={mockState} onBound={onBound} visible={false} />);
  expect(guard()).toBe(false);
  await view.rerender(<RemoteBotBinding remote={mockState} onBound={onBound} visible />);
  expect(guard()).toBe(false);
  await act(async () => pending.resolve(result()));
  expect(mockToast).not.toHaveBeenCalled(); expect(onBound).not.toHaveBeenCalled();
});

test('hiding and reopening a retained import page cannot activate a late binding response', async () => {
  const pending = deferred<BotGroupResult>(); mockImport.mockReturnValue(pending.promise);
  const { view, onBound } = await importBot();
  await view.rerender(<RemoteBotBinding remote={mockState} onBound={onBound} visible={false} />);
  await view.rerender(<RemoteBotBinding remote={mockState} onBound={onBound} visible />);
  await act(async () => pending.resolve(result()));
  expect(mockUse).not.toHaveBeenCalled(); expect(onBound).not.toHaveBeenCalled();
});
