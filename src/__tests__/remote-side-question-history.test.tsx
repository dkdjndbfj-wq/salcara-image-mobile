import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import { SideQuestionHistoryPanel } from '../remote/SideQuestionHistoryPanel';
import type { SideQuestionTransport } from '../remote/SideQuestionPanel';
import { connectionId, deliveryCredentialId, forgetConnection, saveConnection, type RemoteConnection } from '../remote/connections';
import { sideQuestionHistoryScopes } from '../remote/side-question-history';
import { createSideQuestionConversation, deleteLocalSideQuestionConversation, loadSideQuestionConversations, resetSideQuestionConversationsForTests,
  submitSideQuestionConversation, updateSideQuestionDraft } from '../remote/side-question-conversations';

const mockSettings = new Map<string, string>(), mockSecrets = new Map<string, string>();
let mockFailHistory = false;
let mockDelayWrite: ((key: string, value: string) => Promise<void>) | undefined;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (mockFailHistory && key.startsWith('remote_side_pairing_history_')) throw new Error('disk full'); await mockDelayWrite?.(key, value ?? ''); if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'private', getItemAsync: async (key: string) => mockSecrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mockSecrets.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecrets.delete(key); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => jest.requireActual('node:crypto').randomUUID() }));
jest.mock('react-native/Libraries/AppState/AppState', () => ({ __esModule: true, default: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
jest.mock('../components/MessageContent', () => ({ MessageContent: ({ text }: { text: string }) => { const { Text } = require('react-native'); return <Text>{text}</Text>; } }));
const profile = (computerId = 'physical-a', deviceId = 'pc'): RemoteConnection => ({ id: connectionId('https://example.com/salcara-hub/v1', deviceId), hubUrl: 'https://example.com/salcara-hub/v1', deviceId, deviceName: '电脑', computerId, pairedAt: 1 });
const tokenA = 'a'.repeat(64), tokenB = 'b'.repeat(64), tokenC = 'c'.repeat(64);
const scope = (token: string, source = profile(), account = 'account-a', session = 'codex:one') => JSON.stringify([`${source.id}|credential:${deliveryCredentialId(token)}`, source.deviceId, session, 'codex', { tool: 'codex', entrypoint: 'codex-cli' }, 'api', account]);
const transport = (): SideQuestionTransport => ({ isCurrent: () => true, ask: jest.fn(), remove: jest.fn(), read: jest.fn(async chainId => {
  const value = { chainId, sessionKey: 'codex:one', revision: 'r', available: true, contextScope: 'loadedSnapshot' as const, contextMessages: 1, contextTruncated: false, turns: [] };
  return { scope: 'runtime-new', value, conversation: value };
}) });
async function seedOld() {
  await saveConnection(profile(), tokenA);
  const state = await createSideQuestionConversation(scope(tokenA), 'codex:one');
  await submitSideQuestionConversation(state.scope, state.activeId!, { question: '旧问题' }, async operationId => ({ sessionKey: 'codex:one', operationId, state: 'completed', answer: '旧回答', contextScope: 'loadedSnapshot', contextMessages: 1, contextTruncated: false }));
  await updateSideQuestionDraft(state.scope, state.activeId!, '旧草稿');
  await saveConnection(profile(), tokenB);
  return state;
}
beforeEach(() => { mockSettings.clear(); mockSecrets.clear(); mockFailHistory = false; mockDelayWrite = undefined; resetSideQuestionConversationsForTests(); });

test('verified re-pair links old local text and survives repeated rotations without sharing API or session scopes', async () => {
  await seedOld(); await saveConnection(profile(), tokenC);
  expect(await sideQuestionHistoryScopes(scope(tokenC), profile().id, profile().computerId)).toEqual([scope(tokenB), scope(tokenA)]);
  expect(await sideQuestionHistoryScopes(scope(tokenC, profile(), 'different-account'), profile().id, profile().computerId)).toEqual([scope(tokenB, profile(), 'different-account'), scope(tokenA, profile(), 'different-account')]);
  expect((await loadSideQuestionConversations(scope(tokenA, profile(), 'different-account'))).conversations).toEqual([]);
  expect((await loadSideQuestionConversations(scope(tokenA, profile(), 'account-a', 'codex:other'))).conversations).toEqual([]);
  expect(await sideQuestionHistoryScopes(scope('d'.repeat(64)), profile().id, profile().computerId)).toEqual([]);
});

test('same device label on another physical computer or station cannot discover old history', async () => {
  await saveConnection(profile(), tokenA); await saveConnection(profile('physical-b'), tokenB);
  expect(await sideQuestionHistoryScopes(scope(tokenB), profile().id, 'physical-b')).toEqual([]);
  expect(await sideQuestionHistoryScopes(scope(tokenB), profile().id, undefined)).toEqual([]);
  expect(await sideQuestionHistoryScopes(scope(tokenB, profile('physical-a', 'other-device')), profile('physical-a', 'other-device').id, 'physical-a')).toEqual([]);
});

test('failed history persistence leaves the old local credential intact for retry', async () => {
  await saveConnection(profile(), tokenA); mockFailHistory = true;
  await expect(saveConnection(profile(), tokenB)).rejects.toThrow('disk full');
  expect(JSON.parse(mockSecrets.get(`remote-device-${profile().id}`)!).token).toBe(tokenA);
  mockFailHistory = false; await saveConnection(profile(), tokenB);
  expect(await sideQuestionHistoryScopes(scope(tokenB), profile().id, profile().computerId)).toEqual([scope(tokenA)]);
});

test('explicit unpair removes execution credentials but retains local history discoverable after verified re-pair', async () => {
  const previous = await seedOld(); await forgetConnection(profile(), tokenB);
  expect(mockSecrets.has(`remote-device-${profile().id}`)).toBe(false);
  await saveConnection(profile(), tokenC);
  expect(await sideQuestionHistoryScopes(scope(tokenC), profile().id, profile().computerId)).toEqual([scope(tokenB), scope(tokenA)]);
  expect((await loadSideQuestionConversations(previous.scope)).conversations[0].exchanges[0].answer).toBe('旧回答');
});

test('re-pair displays history and draft read-only, never reads/sends/deletes the old chain through the new transport', async () => {
  const previous = await seedOld(); resetSideQuestionConversationsForTests(); const live = transport();
  const node = () => <SideQuestionHistoryPanel visible scopeKey={scope(tokenB)} authorizationScope="runtime-new" sessionKey="codex:one" transport={live}
    loadHistoryScopes={() => sideQuestionHistoryScopes(scope(tokenB), profile().id, profile().computerId)} />;
  let view = await render(node());
  expect(view.getByText('旧回答')).toBeTruthy(); expect(view.getByLabelText('侧问问题').props.value).toBe('旧草稿');
  expect(view.getByLabelText('侧问问题').props.editable).toBe(false);
  await fireEvent.press(view.getByLabelText('发送侧问'));
  expect(live.read).not.toHaveBeenCalled(); expect(live.ask).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('新建侧问')); expect(live.read).toHaveBeenCalledTimes(1);
  const current = await loadSideQuestionConversations(scope(tokenB));
  expect(current.conversations).toHaveLength(1); expect(live.read).toHaveBeenCalledWith(current.activeId, expect.any(AbortSignal), { create: true });
  await fireEvent.press(view.getByLabelText('打开侧问 2')); expect(view.getByText('旧回答')).toBeTruthy();
  await view.unmount(); resetSideQuestionConversationsForTests(); view = await render(node());
  expect(view.getByText('旧回答')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('删除侧问')); await fireEvent.press(view.getByText('删除侧问'));
  expect(live.remove).not.toHaveBeenCalled(); expect((await loadSideQuestionConversations(previous.scope)).conversations).toEqual([]);
  await view.unmount(); view = await render(node()); expect(view.queryByText('旧回答')).toBeNull(); await view.unmount();
});

test('late history discovery from a departed connection cannot replace the current panel', async () => {
  await seedOld(); let finish!: (scopes: string[]) => void; const live = transport();
  const view = await render(<SideQuestionHistoryPanel visible scopeKey={scope(tokenB)} authorizationScope="runtime-new" sessionKey="codex:one" transport={live}
    loadHistoryScopes={() => new Promise(resolve => { finish = resolve; })} />);
  const other = scope(tokenC, profile('physical-b', 'other'));
  await view.rerender(<SideQuestionHistoryPanel visible scopeKey={other} authorizationScope="other" sessionKey="codex:one" transport={live} loadHistoryScopes={async () => []} />);
  await act(() => finish([scope(tokenA)])); expect(view.queryByText('旧回答')).toBeNull(); expect(live.read).not.toHaveBeenCalled(); await view.unmount();
});

test('a slow earlier history tab selection cannot replace the last click or its persisted selection', async () => {
  await seedOld(); const fresh = await createSideQuestionConversation(scope(tokenB), 'codex:one');
  await updateSideQuestionDraft(scope(tokenB), fresh.activeId!, '新草稿'); const live = transport();
  const node = () => <SideQuestionHistoryPanel visible scopeKey={scope(tokenB)} authorizationScope="runtime-new" sessionKey="codex:one" transport={live}
    loadHistoryScopes={() => sideQuestionHistoryScopes(scope(tokenB), profile().id, profile().computerId)} />;
  let view = await render(node());
  let release!: () => void, began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  mockDelayWrite = async (_key, value) => {
    const row = JSON.parse(value);
    if (row.scope === scope(tokenA) && Array.isArray(row.conversations)) { mockDelayWrite = undefined; began(); await new Promise<void>(resolve => { release = resolve; }); }
  };
  await fireEvent.press(view.getByLabelText('打开侧问 2')); await started;
  await fireEvent.press(view.getByLabelText('打开侧问 1')); await act(() => release());
  expect(view.getByLabelText('侧问问题').props.editable).toBe(true); expect(view.getByLabelText('侧问问题').props.value).toBe('新草稿');
  await view.unmount(); view = await render(node()); expect(view.getByLabelText('侧问问题').props.editable).toBe(true); await view.unmount();
});
