import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { RemoteBotBinding } from '../remote/RemoteBotBinding';
import { botConnectionId, type RemoteConnection } from '../remote/connections';
import type { RemoteState } from '../remote/store';

const mockBind = jest.fn(), mockSave = jest.fn(), mockUse = jest.fn(), mockReload = jest.fn(), mockToast = jest.fn();
let mockRevision = 1;
let mockState: RemoteState;
jest.mock('../remote/client', () => ({ ...jest.requireActual('../remote/client'), bindBotPhone: (...args: unknown[]) => mockBind(...args) }));
jest.mock('../remote/connections', () => ({ ...jest.requireActual('../remote/connections'), saveBotConnections: (...args: unknown[]) => mockSave(...args) }));
jest.mock('../remote/phone-identity', () => ({ phoneIdentity: async () => 'f'.repeat(64) }));
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../remote/store', () => ({
  getRemoteState: () => mockState, remoteConnectionRevision: () => mockRevision,
  reloadSavedConnections: (...args: unknown[]) => mockReload(...args), useSavedConnection: (...args: unknown[]) => mockUse(...args),
}));
jest.mock('../components/ui', () => ({ ...jest.requireActual('../components/ui'), showToast: (...args: unknown[]) => mockToast(...args) }));

const endpoint = 'https://bot.example/salcara-hub/v1';
const binding = { type: 'salcara-hub-bot-binding', version: 1, hubUrl: 'https://bot.example/salcara-hub', groupId: 'group', invite: 'a'.repeat(64), signature: 'b'.repeat(64) };
const device = (deviceId: string, online: boolean) => ({ deviceId, name: `电脑 ${deviceId}`, tools: [], projects: [], online });
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
  mockState = { connections: [], connectionId: null, selectedHubUrl: null, signingIn: null, connection: 'idle' } as unknown as RemoteState;
  mockBind.mockReset().mockResolvedValue({ groupId: 'group', botToken: 'c'.repeat(64), devices: [device('a', false), device('b', true)] });
  mockSave.mockReset().mockImplementation(async (profiles: RemoteConnection[]) => { mockState = { ...mockState, connections: profiles }; return profiles; });
  mockReload.mockReset().mockImplementation(async () => mockState.connections);
  mockUse.mockReset().mockImplementation(async (id: string) => {
    const profile = mockState.connections.find(item => item.id === id)!;
    mockState = { ...mockState, connectionId: id, selectedHubUrl: profile.hubUrl, connection: 'open' }; mockRevision++;
  });
});

test('Bot import saves every group member and returns the exact active online profile, including transport', async () => {
  const { onBound } = await importBot();
  await waitFor(() => expect(onBound).toHaveBeenCalledTimes(1));
  const profiles = mockSave.mock.calls[0][0] as RemoteConnection[];
  expect(profiles.map(item => item.id)).toEqual(['a', 'b'].map(id => botConnectionId(endpoint, id, 'group')));
  expect(profiles.every(item => item.hubUrl === endpoint && item.botGroupId === 'group')).toBe(true);
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
  const pending = deferred<unknown>(); mockBind.mockReturnValue(pending.promise);
  const { onBound } = await importBot();
  mockRevision++;
  await act(async () => pending.resolve({ groupId: 'group', botToken: 'c'.repeat(64), devices: [device('a', true)] }));
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(mockUse).not.toHaveBeenCalled();
  expect(onBound).not.toHaveBeenCalled();
});

test('leaving the import page while binding is in flight cannot activate a saved profile', async () => {
  const pending = deferred<unknown>(); mockBind.mockReturnValue(pending.promise);
  const { view, onBound } = await importBot();
  await view.unmount();
  await act(async () => pending.resolve({ groupId: 'group', botToken: 'c'.repeat(64), devices: [device('a', true)] }));
  expect(mockSave).toHaveBeenCalledTimes(1);
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
