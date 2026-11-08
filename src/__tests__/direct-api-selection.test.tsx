import React, { useRef } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { AgentProfile, RemoteApiOption } from '../remote/client';
import { useDirectApiSelection } from '../remote/useDirectApiSelection';
import { clearDirectApiSelectionScope, verifiedDirectApiStatus } from '../remote/direct-api-selection';

let mockConnection = { status: 'connected', deviceId: 'pc' }, mockGeneration = 1, mockPairing = 'pairing';
const mockSettings = new Map<string, string>(), mockRequest = jest.fn(), mockHubWrite = jest.fn(), mockStatus = jest.fn();
let mockControl: ReturnType<typeof useDirectApiSelection>, mockDialog: any;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('../remote/direct-pairing', () => ({ getDirectConnectionState: () => mockConnection,
  directDeliveryScope: () => mockPairing, directConnectionGeneration: () => mockGeneration }));
jest.mock('../remote/direct-api', () => ({ requestDirect: (...args: unknown[]) => mockRequest(...args) }));
jest.mock('../remote/store', () => ({ setAgentApi: (...args: unknown[]) => mockHubWrite(...args) }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../remote/ApiPicker', () => ({ ApiChoiceMenu: (props: any) => {
  const React = require('react'), { Pressable, Text, View } = require('react-native');
  if (!props.visible) return null;
  return React.createElement(View, null, props.error ? React.createElement(Text, null, props.error) : null,
    ...[{ id: '', name: props.defaultApiName || '默认 API' }, ...props.apis].map((api: any) => React.createElement(Pressable, { key: api.id,
      accessibilityRole: 'radio', accessibilityLabel: api.name, disabled: Boolean(props.blocked || props.pending !== undefined),
      onPress: () => props.onSelect(api.id) }, React.createElement(Text, null, api.name))),
    props.onVerify ? React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: '核对 API 状态',
      disabled: props.verificationDisabled, onPress: props.onVerify }, React.createElement(Text, null, '核对')) : null);
} }));
jest.mock('../components/ui', () => ({ AppDialog: (props: any) => {
  mockDialog = props;
  const React = require('react'), { Pressable, Text, View } = require('react-native');
  return props.visible ? React.createElement(View, null, ...props.actions.map((action: any) => React.createElement(Pressable,
    { key: action.label, accessibilityRole: 'button', accessibilityLabel: action.label, disabled: action.disabled, onPress: action.onPress },
    React.createElement(Text, null, action.label)))) : null;
} }));

const apis: RemoteApiOption[] = [{ id: 'api_00112233', name: '备用 API', models: ['model-b'] }];
const profile: AgentProfile = { id: 'deepseek-harness', name: 'DeepSeek Harness', tool: 'deepseek-harness', available: true,
  execution: { tool: 'deepseek-harness', controlSurface: 'cli' }, capabilities: { list: true, read: true, send: true, modelOverride: true,
    interrupt: false, approval: false, questions: false, subagents: false, attachments: false, imageInput: false, imageOutput: false },
  remoteSendSupported: true, conversationApiSwitch: true,
  api: { name: '电脑 API', model: 'model-a', protocol: 'chat', configured: true, pending: false, source: 'computer' } };
const changed = { ...profile, api: { ...profile.api, name: '备用 API', model: 'model-b', source: 'phone' as const, accountId: apis[0].id } };
const status = (agent: AgentProfile = changed) => ({ agents: [agent], apis });
function Harness({ agent = profile, sessionKey, blocked = '' }: { agent?: AgentProfile; sessionKey?: string; blocked?: string }) {
  const lock = useRef(false);
  mockControl = useDirectApiSelection({ pairing: mockPairing, generation: mockGeneration, deviceId: mockConnection.deviceId,
    connected: mockConnection.status === 'connected', profile: agent, agents: [agent], apis, sessionKey, blocked, lock, onStatus: mockStatus });
  return mockControl.control;
}
async function choose(view: Awaited<ReturnType<typeof render>>, label = '备用 API') {
  await waitFor(() => expect(mockControl.locked).toBe(false));
  await fireEvent.press(view.getByRole('button', { name: '选择直连 API' }));
  await fireEvent.press(view.getByRole('radio', { name: label }));
}
beforeEach(() => {
  jest.clearAllMocks(); mockSettings.clear(); mockConnection = { status: 'connected', deviceId: 'pc' }; mockGeneration = 1; mockPairing = 'pairing';
  mockRequest.mockReset().mockImplementation(async (command: any) => command.type === 'agents.status' ? status() : { accepted: true });
});

test('opening, choosing and cancelling never sends a mutation', async () => {
  const view = await render(<Harness/>); await choose(view);
  const previousConfirm = mockDialog.actions[1].onPress;
  expect(mockRequest).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: '取消' }));
  await act(async () => previousConfirm());
  expect(mockRequest).not.toHaveBeenCalled(); expect(mockSettings.size).toBe(0); await view.unmount();
});

test('a confirmed extension Agent switch uses direct commands and a fresh exact status acknowledgement', async () => {
  const view = await render(<Harness sessionKey="deepseek-harness:thread"/>); await choose(view);
  await fireEvent.press(view.getByRole('button', { name: '确认切换' }));
  await waitFor(() => expect(mockControl.locked).toBe(false));
  expect(mockRequest.mock.calls.map(([command]) => command)).toEqual([
    { type: 'agents.api.set', agent: 'deepseek-harness', accountId: apis[0].id, sessionKey: 'deepseek-harness:thread' }, { type: 'agents.status' },
  ]);
  expect(mockStatus).toHaveBeenCalledWith(expect.objectContaining({ apis, agents: expect.arrayContaining([expect.objectContaining({ id: profile.id, api: changed.api })]) }));
  expect(mockHubWrite).not.toHaveBeenCalled(); expect(mockSettings.get('direct_api_selections_v1')).toBe('{}'); await view.unmount();
});

test('a timeout is durable across remount and read-only verification never resends it', async () => {
  mockRequest.mockImplementation(async (command: any) => {
    if (command.type === 'agents.api.set') throw Object.assign(new Error('Timeout'), { code: 'timeout' });
    return status(profile);
  });
  let view = await render(<Harness/>); await choose(view); await fireEvent.press(view.getByRole('button', { name: '确认切换' }));
  await waitFor(() => expect(mockControl.busy).toBe(false)); expect(mockControl.locked).toBe(true);
  await view.unmount(); view = await render(<Harness/>);
  await waitFor(() => expect(mockControl.locked).toBe(true));
  await fireEvent.press(view.getByRole('button', { name: '选择直连 API' }));
  await fireEvent.press(await view.findByRole('button', { name: '核对 API 状态' }));
  await waitFor(() => expect(mockControl.busy).toBe(false)); expect(mockControl.locked).toBe(true);
  mockRequest.mockImplementation(async () => status());
  await fireEvent.press(view.getByRole('button', { name: '核对 API 状态' }));
  await waitFor(() => expect(mockControl.locked).toBe(false));
  expect(mockRequest.mock.calls.filter(([command]) => command.type === 'agents.api.set')).toHaveLength(1);
  expect(mockStatus).toHaveBeenCalledTimes(1); await view.unmount();
});

test('a definitive computer rejection clears the marker without changing the active API', async () => {
  mockRequest.mockRejectedValue(Object.assign(new Error('任务正在运行'), { code: 'remote' }));
  const view = await render(<Harness/>); await choose(view); await fireEvent.press(view.getByRole('button', { name: '确认切换' }));
  await waitFor(() => expect(mockControl.locked).toBe(false));
  expect(mockStatus).not.toHaveBeenCalled(); expect(mockSettings.get('direct_api_selections_v1')).toBe('{}'); await view.unmount();
});

test('a retained confirmation cannot write after the Agent or its API source changes', async () => {
  const view = await render(<Harness/>); await choose(view);
  const confirm = mockDialog.actions[1].onPress;
  await view.rerender(<Harness agent={changed}/>); await act(async () => confirm());
  expect(mockRequest).not.toHaveBeenCalled(); expect(mockDialog.visible).toBe(false); await view.unmount();
});

test('a late old-device response cannot publish to the new device', async () => {
  let finish!: (value: unknown) => void;
  mockRequest.mockImplementation(async (command: any) => command.type === 'agents.api.set' ? new Promise(resolve => { finish = resolve; }) : status());
  const view = await render(<Harness/>); await choose(view); await fireEvent.press(view.getByRole('button', { name: '确认切换' }));
  await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1)); expect(mockControl.locked).toBe(true);
  mockConnection = { status: 'connected', deviceId: 'other' }; mockGeneration++;
  await view.rerender(<Harness/>); await act(async () => finish({ accepted: true }));
  expect(mockStatus).not.toHaveBeenCalled(); expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockSettings.get('direct_api_selections_v1')).toContain('"deviceId":"pc"'); await view.unmount();
});

test('follow-computer verification requires an explicit computer record, never parser defaults', () => {
  const selection = { id: '11111111-1111-4111-8111-111111111111', agentId: 'codex', accountId: '' };
  expect(verifiedDirectApiStatus({ agents: [] }, selection)).toBeUndefined();
  expect(verifiedDirectApiStatus({ agents: [{ id: 'codex', available: true, api: { pending: false } }] }, selection)).toBeUndefined();
  expect(verifiedDirectApiStatus({ agents: [{ id: 'codex', available: true, api: { source: 'computer', pending: true } }] }, selection)).toBeUndefined();
  expect(verifiedDirectApiStatus({ agents: [{ id: 'codex', available: true, api: { source: 'computer', pending: false } }] }, selection)).toBeDefined();
});

test('corrupt recovery records fail closed and forgetting a pairing clears only its pending switch', async () => {
  mockSettings.set('direct_api_selections_v1', 'corrupt');
  const view = await render(<Harness/>);
  await fireEvent.press(view.getByRole('button', { name: '选择直连 API' }));
  await view.findByRole('button', { name: '核对 API 状态' });
  expect(mockControl.locked).toBe(true); expect(mockRequest).not.toHaveBeenCalled(); await view.unmount();
  mockSettings.clear();
  mockRequest.mockRejectedValue(Object.assign(new Error('Timeout'), { code: 'timeout' }));
  const next = await render(<Harness/>); await choose(next); await fireEvent.press(next.getByRole('button', { name: '确认切换' }));
  await waitFor(() => expect(mockControl.busy).toBe(false)); await next.unmount();
  await clearDirectApiSelectionScope('different'); expect(mockSettings.get('direct_api_selections_v1')).toContain('"agentId":"deepseek-harness"');
  await clearDirectApiSelectionScope('pairing'); expect(mockSettings.get('direct_api_selections_v1')).toBe('{}');
});
