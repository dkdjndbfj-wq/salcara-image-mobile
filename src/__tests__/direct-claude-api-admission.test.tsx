import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DirectExperience } from '../remote/DirectExperience';
import { parseAgentStatus } from '../remote/projection';

const mockConnection = { status: 'connected', deviceId: 'pc', deviceName: 'Computer' };
const mockRequest = jest.fn(), mockOpenApi = jest.fn(), mockSettings = new Map<string, string>();
let mockConversation: any, mockComposer: any, mockApiSelection: any;
let mockPendingWrite: (() => Promise<void>) | undefined;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value); if (key === 'direct_pending_operations_v1') await mockPendingWrite?.(); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('../remote/direct-pairing', () => ({ getDirectConnectionState: () => mockConnection, subscribeDirectConnection: () => () => {},
  directDeliveryScope: () => 'pairing', directConnectionGeneration: () => 1 }));
jest.mock('../remote/direct-api', () => ({ requestDirect: (...args: unknown[]) => mockRequest(...args), subscribeDirectEvents: () => () => {} }));
jest.mock('../remote/direct-workspace', () => ({ createDirectWorkspaceRuntime: () => ({ scope: 'pairing' }) }));
jest.mock('../remote/useDirectApiSelection', () => ({ useDirectApiSelection: (options: any) => {
  mockApiSelection = options; return { busy: false, locked: false, control: null, open: mockOpenApi };
} }));
jest.mock('../remote/DirectConversation', () => ({ DirectConversation: (props: any) => {
  mockConversation = props; const { View, Text } = require('react-native');
  return <View>{props.apiControl}<Text testID="existing-draft">{props.text}</Text></View>;
} }));
jest.mock('../remote/direct-session-services', () => ({ captureDirectProjectServices: () => ({ scope: 'new-project', isCurrent: () => true }) }));
jest.mock('../remote/ConversationDropZone', () => ({ ConversationDropZone: (props: any) => props.children }));
jest.mock('../remote/DirectComposer', () => ({ DirectComposer: (props: any) => {
  mockComposer = props; const { TextInput, Pressable, Text, View } = require('react-native');
  return <View><TextInput accessibilityLabel="新任务草稿" value={props.text} onChangeText={props.onText}/>
    <Pressable accessibilityRole="button" accessibilityLabel="发送新任务" disabled={!props.canSend || props.uncertain || props.sending}
      onPress={() => props.onSend({ owner: JSON.stringify(['pairing', 'pc', null, props.profile.id, props.profile.api.accountId ?? '', props.session.cwd, 'code']) })}><Text>发送</Text></Pressable></View>;
} }));

const session = { sessionKey: 'claude:thread', tool: 'claude', client: 'Claude Code', title: 'Claude task', cwd: 'C:/project', updatedAt: 1,
  status: 'idle', controllable: true, controlSurface: 'cli', sessionScope: 'code' };
const readyApi = { name: 'Claude API', model: 'claude-fixture', protocol: 'anthropic', configured: true, pending: false, source: 'computer', accountId: 'api_00112233' };
let currentApi: Record<string, unknown>, currentId: 'claude' | 'claude-desktop';
function status() { return { agents: [{ id: currentId, tool: 'claude', available: true, remoteSendSupported: true,
  execution: { tool: 'claude', controlSurface: 'cli', ...(currentId === 'claude-desktop' ? { entrypoint: 'claude-desktop' } : {}) },
  capabilities: { list: true, read: true, send: true }, conversationApiSwitch: true, api: currentApi }] }; }
const writes = () => mockRequest.mock.calls.filter(([command]) => ['session.send', 'session.start', 'session.continue'].includes(command.type));
beforeEach(() => {
  jest.clearAllMocks(); mockSettings.clear(); mockPendingWrite = undefined; mockConversation = undefined; mockComposer = undefined;
  currentApi = readyApi; currentId = 'claude';
  mockRequest.mockImplementation(async (command: any) => {
    if (command.type === 'agents.status') return status();
    if (command.type === 'projects.list') return { projects: [{ path: 'C:/project', name: 'Project' }] };
    if (command.type === 'sessions.list') return { sessions: [{ ...session, client: currentId === 'claude' ? 'Claude Code' : 'Claude Desktop' }] };
    if (command.type === 'session.open') return { session, events: [] };
    if (command.type === 'session.send') return { via: 'background' };
    throw new Error(`Unexpected ${command.type}`);
  });
});
async function updateApi(api: Record<string, unknown>) {
  currentApi = api;
  await act(async () => mockApiSelection.onStatus(parseAgentStatus(status())));
}
async function openConversation() {
  const view = await render(<DirectExperience/>);
  await fireEvent.press(await view.findByRole('button', { name: '打开对话 Claude task' }));
  await waitFor(() => expect(mockConversation.loading).toBe(false));
  return view;
}

test.each([
  { ...readyApi, source: 'tool' }, { ...readyApi, configured: false },
  { ...readyApi, pending: true }, { ...readyApi, accountId: '' },
])('Claude API must be confirmed before Direct sending: %j', async api => {
  currentApi = api; const view = await openConversation();
  expect(mockConversation.canSend).toBe(false);
  await act(async () => mockConversation.onText('preserve this draft'));
  await act(async () => mockConversation.onSend({ owner: 'stale' }));
  expect(writes()).toHaveLength(0); expect(mockConversation.text).toBe('preserve this draft');
  await fireEvent.press(view.getByRole('button', { name: '选择并确认 Claude API' }));
  expect(mockOpenApi).toHaveBeenCalledTimes(1);
  await updateApi(readyApi);
  await waitFor(() => expect(mockConversation.canSend).toBe(true));
  expect(mockConversation.text).toBe('preserve this draft'); expect(writes()).toHaveLength(0);
  await view.unmount();
});

test('Claude Desktop Code also requires a confirmed API and cannot create native Desktop sessions', async () => {
  currentId = 'claude-desktop'; currentApi = { ...readyApi, source: 'tool' };
  const view = await openConversation(); expect(mockConversation.canSend).toBe(false);
  await updateApi(readyApi); await waitFor(() => expect(mockConversation.canSend).toBe(true));
  await act(async () => mockConversation.onNew()); expect(mockComposer).toBeUndefined(); expect(writes()).toHaveLength(0);
  await view.unmount();
});

test('new Claude tasks open API selection first, and a later API revocation preserves the new draft', async () => {
  currentApi = { ...readyApi, source: 'tool' };
  const view = await render(<DirectExperience/>);
  await fireEvent.press(await view.findByRole('button', {name:'新建 Code 对话'}));
  expect(mockOpenApi).toHaveBeenCalledTimes(1); expect(view.queryByText('新建直连会话')).toBeNull();
  await updateApi(readyApi); await fireEvent.press(view.getByRole('button', {name:'新建 Code 对话'}));
  await waitFor(() => expect(mockComposer.uncertain).toBe(false));
  expect(mockComposer.canSend).toBe(true);
  await fireEvent.changeText(view.getByLabelText('新任务草稿'), 'new task draft');
  const retainedSend = mockComposer.onSend;
  await updateApi({ ...readyApi, pending: true });
  expect(mockComposer.canSend).toBe(false); expect(mockComposer.text).toBe('new task draft');
  await act(async () => retainedSend({ owner: JSON.stringify(['pairing', 'pc', null, 'claude', readyApi.accountId, 'C:/project', 'code']) }));
  expect(writes()).toHaveLength(0); expect(view.getByText('请先选择并确认 Claude API，草稿已保留')).toBeTruthy();
  await updateApi(readyApi); expect(mockComposer.canSend).toBe(true); expect(mockComposer.text).toBe('new task draft');
  await view.unmount();
});

test('API revocation while persisting a new task cannot dispatch the queued callback', async () => {
  const view = await render(<DirectExperience/>); await fireEvent.press(await view.findByRole('button', {name:'新建 Code 对话'}));
  await waitFor(() => expect(mockComposer.uncertain).toBe(false));
  await fireEvent.changeText(view.getByLabelText('新任务草稿'), 'still unsent');
  let release!: () => void, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  mockPendingWrite = () => { mockPendingWrite = undefined; entered(); return new Promise<void>(resolve => { release = resolve; }); };
  let flight!: Promise<boolean | undefined>;
  await act(async () => { flight = mockComposer.onSend({ owner: JSON.stringify(['pairing', 'pc', null, 'claude', readyApi.accountId, 'C:/project', 'code']) }); });
  await started; await updateApi({ ...readyApi, configured: false });
  await act(async () => { release(); expect(await flight).toBe(false); });
  expect(writes()).toHaveLength(0); expect(mockComposer.text).toBe('still unsent');
  await view.unmount();
});
