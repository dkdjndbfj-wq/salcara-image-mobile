import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DirectExperience } from '../remote/DirectExperience';

let mockConnection = { status: 'connected', deviceId: 'pc', deviceName: 'Computer' }, mockGeneration = 1;
const mockConnectionListeners = new Set<() => void>(), mockSettings = new Map<string, string>(), mockRequest = jest.fn();
let mockConversation: any, mockMenu: any, mockDialog: any;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('../remote/direct-pairing', () => ({ getDirectConnectionState: () => mockConnection,
  subscribeDirectConnection: (fn: () => void) => { mockConnectionListeners.add(fn); return () => mockConnectionListeners.delete(fn); },
  directDeliveryScope: () => 'pairing', directConnectionGeneration: () => mockGeneration }));
jest.mock('../remote/direct-api', () => ({ requestDirect: (...args: unknown[]) => mockRequest(...args), subscribeDirectEvents: () => () => {} }));
jest.mock('../remote/direct-workspace', () => ({ createDirectWorkspaceRuntime: () => ({ scope: 'pairing' }) }));
jest.mock('../remote/DirectNewComposer', () => ({ DirectNewComposer: () => null }));
jest.mock('../remote/DirectComputerManagement', () => ({ DirectComputerManagement: () => null }));
jest.mock('../remote/DirectConversation', () => ({ DirectConversation: (props: any) => {
  mockConversation = props;
  const React = require('react'), { View, Text, Pressable } = require('react-native');
  return <View>{props.apiControl}<Text testID="draft">{props.text}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="从失败消息检查 API" onPress={props.onResolveApi}/></View>;
} }));
jest.mock('../remote/ApiPicker', () => ({ ApiChoiceMenu: (props: any) => {
  mockMenu = props;
  const React = require('react'), { View, Text, Pressable } = require('react-native');
  return props.visible ? <View>{props.blocked ? <Text>{props.blocked}</Text> : null}
    {props.apis.map((api: any) => <Pressable key={api.id} accessibilityRole="radio" accessibilityLabel={api.name}
      disabled={Boolean(props.blocked || props.pending !== undefined)} onPress={() => props.onSelect(api.id)}/>)}
    {props.onVerify ? <Pressable accessibilityRole="button" accessibilityLabel="核对 API 状态" disabled={props.verificationDisabled} onPress={props.onVerify}/> : null}
  </View> : null;
} }));
jest.mock('../components/ui', () => ({ AppDialog: (props: any) => {
  mockDialog = props;
  const React = require('react'), { View, Pressable } = require('react-native');
  return props.visible ? <View>{props.actions.map((action: any) => <Pressable key={action.label} accessibilityRole="button"
    accessibilityLabel={action.label} disabled={action.disabled} onPress={action.onPress}/>)}</View> : null;
} }));

const session = { sessionKey: 'codex:failed', tool: 'codex', client: 'Codex CLI', title: 'Failed task', cwd: 'C:/project', updatedAt: 1,
  status: 'failed', controllable: true, controlSurface: 'cli' };
const originalApi = { name: 'Current API', model: 'model-a', protocol: 'responses', configured: true, pending: false, source: 'computer', accountId: 'api_00112233' };
const apis = [{ id: 'api_11223344', name: 'Backup API', models: ['model-b'] }];
let currentApi = originalApi, currentSession = session;
function status() { return { agents: [{ id: 'codex', tool: 'codex', name: 'Codex', available: true, remoteSendSupported: true,
  conversationApiSwitch: true, capabilities: { list: true, read: true, send: true }, api: currentApi }], apis }; }
beforeEach(() => {
  jest.clearAllMocks(); mockSettings.clear(); mockConnectionListeners.clear(); mockGeneration = 1;
  mockConnection = { status: 'connected', deviceId: 'pc', deviceName: 'Computer' };
  currentApi = originalApi; currentSession = session; mockConversation = undefined;
  mockRequest.mockReset().mockImplementation(async (command: any) => {
    if (command.type === 'agents.status') return status();
    if (command.type === 'projects.list') return { projects: [{ path: 'C:/project', name: 'Project' }] };
    if (command.type === 'sessions.list') return { sessions: [currentSession] };
    if (command.type === 'session.open') return { session: { ...currentSession, sessionKey: command.sessionKey }, events: [] };
    if (command.type === 'agents.api.set') { currentApi = { ...originalApi, source: 'phone', accountId: apis[0].id, name: apis[0].name, model: 'model-b' }; return { accepted: true }; }
    throw new Error(`Unexpected ${command.type}`);
  });
});
async function open() {
  const view = await render(<DirectExperience/>);
  await fireEvent.press(await view.findByRole('button', { name: '打开对话 Failed task' }));
  await waitFor(() => expect(mockConversation.canSend).toBe(true));
  return view;
}
const switches = () => mockRequest.mock.calls.filter(([command]) => command.type === 'agents.api.set');
const sends = () => mockRequest.mock.calls.filter(([command]) => ['session.send', 'session.start', 'session.continue'].includes(command.type));

test('a failed message opens the existing Direct picker and verified switching preserves input without replaying the task', async () => {
  const view = await open(); await act(async () => mockConversation.onText('next unsent input'));
  mockRequest.mockClear();
  await fireEvent.press(view.getByRole('button', { name: '从失败消息检查 API' }));
  expect(mockRequest).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('radio', { name: 'Backup API' }));
  await fireEvent.press(view.getByRole('button', { name: '确认切换' }));
  await waitFor(() => expect(mockConversation.profile.api.accountId).toBe(apis[0].id));
  expect(mockRequest.mock.calls.map(([command]) => command)).toEqual([
    { type: 'agents.api.set', agent: 'codex', accountId: apis[0].id, sessionKey: session.sessionKey }, { type: 'agents.status' },
  ]);
  expect(mockConversation.text).toBe('next unsent input'); expect(mockMenu.visible).toBe(false); expect(sends()).toHaveLength(0);
  await view.unmount();
});

test('recovery from an old failed message cannot switch an API while the current task is running', async () => {
  currentSession = { ...session, status: 'running' };
  const view = await open(); await fireEvent.press(view.getByRole('button', { name: '从失败消息检查 API' }));
  expect(view.getByText('当前任务仍在运行，请结束后切换 API')).toBeTruthy();
  await fireEvent.press(view.getByRole('radio', { name: 'Backup API' }));
  expect(mockDialog.visible).toBe(false); expect(switches()).toHaveLength(0);
  await view.unmount();
});

test('a timeout remains locked and explicit verification only reads status, never replays the API change or failed task', async () => {
  const normal = mockRequest.getMockImplementation()!;
  mockRequest.mockImplementation((command: any) => command.type === 'agents.api.set'
    ? Promise.reject(Object.assign(new Error('lost reply'), { code: 'timeout' })) : normal(command));
  const view = await open(); await fireEvent.press(view.getByRole('button', { name: '从失败消息检查 API' }));
  await fireEvent.press(view.getByRole('radio', { name: 'Backup API' }));
  await fireEvent.press(view.getByRole('button', { name: '确认切换' }));
  await view.findByRole('button', { name: '核对 API 状态' });
  await waitFor(() => expect(mockConversation.canSend).toBe(false));
  currentApi = { ...originalApi, source: 'phone', accountId: apis[0].id, name: apis[0].name, model: 'model-b' };
  await fireEvent.press(view.getByRole('button', { name: '核对 API 状态' }));
  await waitFor(() => expect(mockConversation.canSend).toBe(true));
  expect(switches()).toHaveLength(1); expect(sends()).toHaveLength(0);
  await view.unmount();
});

test.each(['session', 'api', 'mode', 'device'] as const)('a retained recovery callback cannot open for a newer %s source', async change => {
  const view = await open(), retained = mockConversation.onResolveApi;
  if (change === 'session') {
    await act(async () => mockConversation.onOpenSession('codex:other'));
    await waitFor(() => expect(mockConversation.session.sessionKey).toBe('codex:other'));
  } else if (change === 'api') {
    currentApi = { ...originalApi, model: 'new-computer-model' };
    await act(async () => mockConversation.onRefresh());
    await waitFor(() => expect(mockConversation.profile.api.model).toBe('new-computer-model'));
  } else if (change === 'mode') {
    await view.rerender(<DirectExperience workspaceMode="work"/>);
  } else {
    await act(async () => { mockConnection = { ...mockConnection, deviceId: 'other-pc' }; mockGeneration++; mockConnectionListeners.forEach(listener => listener()); });
  }
  await act(async () => retained());
  expect(mockMenu.visible).toBe(false); expect(switches()).toHaveLength(0); expect(sends()).toHaveLength(0);
  await view.unmount();
});
