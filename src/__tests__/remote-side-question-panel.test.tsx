import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { SideQuestionPanel, type SideQuestionTransport } from '../remote/SideQuestionPanel';
import { loadSideQuestionConversations, resetSideQuestionConversationsForTests } from '../remote/side-question-conversations';
import type { SideQuestionResult, SideQuestionReading, SideQuestionRemoteConversation } from '../remote/side-question';
const mockSettings = new Map<string, string>();
async function readMountedConversations(scope: string) { let result: Awaited<ReturnType<typeof loadSideQuestionConversations>> | undefined; await act(async () => { result = await loadSideQuestionConversations(scope); }); return result!; }
let mockPendingWrite: (() => Promise<void>) | undefined;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null, setSetting: async (key: string, value: string) => {
  if (mockPendingWrite && value.includes('"state":"sending"')) { const wait = mockPendingWrite; mockPendingWrite = undefined; await wait(); }
  mockSettings.set(key, value);
} }));
jest.mock('expo-crypto', () => ({ randomUUID: () => jest.requireActual('node:crypto').randomUUID() }));
jest.mock('react-native/Libraries/AppState/AppState', () => ({ __esModule: true, default: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) } }));
let mockSend: (() => void) | undefined;
jest.mock('react-native/Libraries/Components/Pressable/Pressable', () => {
  const React = require('react'), { View } = require('react-native');
  return { __esModule: true, default: (props: any) => { if (props.accessibilityLabel === '发送侧问') mockSend = props.onPress; return React.createElement(View, props); } };
});
jest.mock('../components/MessageContent', () => ({ MessageContent: ({ text }: { text: string }) => { const { Text } = require('react-native'); return <Text>{text}</Text>; } }));
const remote = (chainId: string, turns: SideQuestionRemoteConversation['turns'] = []): SideQuestionRemoteConversation => ({ chainId, sessionKey: 'codex:one', revision: `r${turns.length}`, available: true,
  contextScope: 'loadedSnapshot', contextMessages: 4, contextTruncated: false, turns, lastOperationId: turns[turns.length - 1]?.operationId });
let transport: SideQuestionTransport, saved: Map<string, SideQuestionRemoteConversation>;
const node = (scopeKey = 'one', visible = true) => <SideQuestionPanel visible={visible} scopeKey={scopeKey} authorizationScope={`runtime:${scopeKey}`} sessionKey="codex:one" transport={transport} />;
beforeEach(() => {
  resetSideQuestionConversationsForTests(); mockSettings.clear(); mockPendingWrite = undefined; saved = new Map(); jest.replaceProperty(AppState, 'currentState', 'active');
  transport = {
    isCurrent: () => true, remove: jest.fn(async () => undefined),
    read: jest.fn(async chainId => { const value = saved.get(chainId) ?? remote(chainId); saved.set(chainId, value); return { scope: 'runtime:one', value, conversation: value }; }),
    ask: jest.fn(async (reading, input, operationId): Promise<SideQuestionResult> => {
      const previous = reading.conversation!, value = remote(previous.chainId, [...previous.turns, { operationId, ...input, answer: '独立回答', state: 'completed', createdAt: Date.now() }]); saved.set(value.chainId, value);
      return { sessionKey: value.sessionKey, operationId, state: 'completed', answer: '独立回答', contextScope: value.contextScope, contextMessages: value.contextMessages,
        contextTruncated: value.contextTruncated, conversation: value };
    }),
  };
});
afterEach(() => jest.restoreAllMocks());

test('inline questions fold without losing draft, confirmed head or main page interaction', async () => {
  const view = await render(node()); expect(transport.read).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('新建侧问')); expect(transport.ask).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-side-question-inline')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '解释这里'); await fireEvent.press(view.getByLabelText('发送侧问'));
  expect(view.getByText('独立回答')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '保留追问草稿'); await fireEvent.press(view.getByLabelText('收起侧问'));
  expect(view.queryByLabelText('侧问问题')).toBeNull(); await fireEvent.press(view.getByLabelText('展开侧问'));
  expect(view.getByLabelText('侧问问题').props.value).toBe('保留追问草稿');
  await fireEvent.press(view.getByLabelText('发送侧问'));
  expect(transport.ask).toHaveBeenLastCalledWith(expect.objectContaining({ value: expect.objectContaining({ revision: 'r1' }) }), expect.objectContaining({ previousOperationId: expect.any(String), question: '保留追问草稿' }), expect.any(String));
  await view.unmount();
});

test('compact keyboard presentation keeps expansion and draft, with one reachable send and refresh action', async () => {
  const editing = jest.fn(), node = (compactComposer = false) => <SideQuestionPanel visible scopeKey="one" authorizationScope="runtime:one" sessionKey="codex:one" transport={transport} availableHeight={210} compactComposer={compactComposer} onEditingChange={editing} />;
  const view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问')); await fireEvent.changeText(view.getByLabelText('侧问问题'), '小屏草稿');
  await fireEvent(view.getByLabelText('侧问问题'), 'focus'); expect(editing).toHaveBeenLastCalledWith(true);
  await view.rerender(node(true)); expect(view.getByLabelText('侧问问题').props.value).toBe('小屏草稿'); expect(view.getAllByLabelText('发送侧问')).toHaveLength(1); expect(view.getAllByLabelText('刷新侧问结果')).toHaveLength(1);
  expect((await readMountedConversations('one')).expanded).toBe(true); expect(transport.ask).not.toHaveBeenCalled();
  await view.rerender(node(false)); expect(view.getByLabelText('侧问问题').props.value).toBe('小屏草稿'); expect(view.getByLabelText('收起侧问')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送侧问')); expect(transport.ask).toHaveBeenCalledTimes(1); await view.unmount();
});

test('collapse during send retains the eventual answer and unread indication', async () => {
  let finish!: (value: SideQuestionResult) => void, operation = '';
  transport.ask = jest.fn((_reading, _input, operationId) => { operation = operationId; return new Promise(done => { finish = done; }); });
  const view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问'));
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '问题'); const send = mockSend!; await act(() => { send(); send(); });
  expect(transport.ask).toHaveBeenCalledTimes(1); await fireEvent.press(view.getByLabelText('收起侧问'));
  await act(() => finish({ sessionKey: 'codex:one', operationId: operation, state: 'completed', answer: '后台回答', contextScope: 'loadedSnapshot', contextMessages: 4, contextTruncated: false }));
  expect(view.getByText(/新回答/)).toBeTruthy(); await fireEvent.press(view.getByLabelText('展开侧问')); expect(view.getByText('后台回答')).toBeTruthy(); await view.unmount();
});

test('restart restores history and draft but performs only a read to regain authorization', async () => {
  let view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问'));
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '问题'); await fireEvent.press(view.getByLabelText('发送侧问'));
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '未发送'); await view.unmount(); resetSideQuestionConversationsForTests();
  view = await render(node()); expect(view.getByText('独立回答')).toBeTruthy(); expect(view.getByLabelText('侧问问题').props.value).toBe('未发送');
  expect(transport.ask).toHaveBeenCalledTimes(1); expect(transport.read).toHaveBeenLastCalledWith(expect.any(String), expect.any(AbortSignal), { create: false }); await view.unmount();
});

test('unconfirmed result is durable and refresh does not replay a request', async () => {
  transport.ask = jest.fn(async (_reading, _input, operationId): Promise<SideQuestionResult> => ({ sessionKey: 'codex:one', operationId, state: 'unconfirmed', answer: '', error: '结果待确认', contextScope: 'loadedSnapshot', contextMessages: 4, contextTruncated: false }));
  const view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问'));
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '问题'); await fireEvent.press(view.getByLabelText('发送侧问'));
  expect(view.getByText('结果待确认')).toBeTruthy(); await fireEvent.press(view.getByLabelText('刷新侧问结果')); await fireEvent.press(view.getByLabelText('发送侧问'));
  expect(transport.ask).toHaveBeenCalledTimes(1); expect((await readMountedConversations('one')).conversations[0].pending?.state).toBe('unconfirmed');
  await fireEvent.press(view.getByLabelText('新建侧问'));
  expect((await readMountedConversations('one')).conversations).toHaveLength(2); expect(view.getByLabelText('侧问问题').props.value).toBe('');
  await fireEvent.press(view.getByLabelText('打开侧问 1')); expect(view.getByLabelText('侧问问题').props.value).toBe('问题'); expect(transport.ask).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('deletion requires the explicit confirmation and removes only the selected side conversation', async () => {
  const view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问')); await fireEvent.changeText(view.getByLabelText('侧问问题'), '待删除草稿');
  await fireEvent.press(view.getByLabelText('删除侧问')); expect(view.getByText('删除这条侧问？')).toBeTruthy(); expect(transport.remove).not.toHaveBeenCalled();
  await fireEvent.press(view.getByText('删除侧问'));
  expect(transport.remove).toHaveBeenCalledTimes(1); expect((await readMountedConversations('one')).conversations).toEqual([]); await view.unmount();
});

test('offline user can explicitly delete phone history without claiming or sending a remote deletion', async () => {
  const view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问')); await fireEvent.changeText(view.getByLabelText('侧问问题'), '离线要删除的草稿');
  transport.isCurrent = () => false; await view.rerender(node()); await fireEvent.press(view.getByLabelText('删除侧问'));
  await fireEvent.press(view.getByText('仅删除手机记录'));
  expect(transport.remove).not.toHaveBeenCalled(); expect((await readMountedConversations('one')).conversations).toEqual([]); await view.unmount();
});

test('changing source does not show old private history; returning restores it without sending', async () => {
  const view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问'));
  await fireEvent.changeText(view.getByLabelText('侧问问题'), '来源A的草稿'); await view.rerender(node('two'));
  expect(view.queryByLabelText('侧问问题')).toBeNull(); await view.rerender(node('one'));
  expect(view.getByLabelText('侧问问题').props.value).toBe('来源A的草稿'); expect(transport.ask).not.toHaveBeenCalled(); await view.unmount();
});

test.each(['inactive', 'background'] as const)('queued press cannot send after AppState becomes %s', async state => {
  const view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问')); await fireEvent.changeText(view.getByLabelText('侧问问题'), '问题');
  const send = mockSend!; jest.replaceProperty(AppState, 'currentState', state); await act(() => send()); expect(transport.ask).not.toHaveBeenCalled(); await view.unmount();
});

test('backgrounding while the receipt persists clears only the known undispatched receipt and permits a later explicit send', async () => {
  const view = await render(node()); await fireEvent.press(view.getByLabelText('新建侧问')); await fireEvent.changeText(view.getByLabelText('侧问问题'), '磁盘写入时切后台');
  let release!: () => void, started!: () => void; const begun = new Promise<void>(resolve => { started = resolve; });
  mockPendingWrite = () => { started(); return new Promise<void>(resolve => { release = resolve; }); };
  await fireEvent.press(view.getByLabelText('发送侧问')); await begun;
  jest.replaceProperty(AppState, 'currentState', 'background'); await act(() => release());
  expect(transport.ask).not.toHaveBeenCalled();
  expect((await readMountedConversations('one')).conversations[0].pending).toBeUndefined();
  expect(view.getByLabelText('侧问问题').props.value).toBe('磁盘写入时切后台');
  jest.replaceProperty(AppState, 'currentState', 'active'); await fireEvent.press(view.getByLabelText('发送侧问'));
  expect(transport.ask).toHaveBeenCalledTimes(1); expect(view.getByText('独立回答')).toBeTruthy(); await view.unmount();
});
