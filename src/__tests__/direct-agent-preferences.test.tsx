import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DirectExperience } from '../remote/DirectExperience';
import { readPreferredAgent, rememberPreferredAgent } from '../remote/agent-preferences';

let mockConnection = { status: 'connected', deviceId: 'pc-a', deviceName: 'Same name' };
let mockScope = 'binding-a', mockGeneration = 1;
const mockRequest = jest.fn(), mockSettings = new Map<string, string | null>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { mockSettings.set(key, value); } }));
jest.mock('../remote/direct-pairing', () => ({ getDirectConnectionState: () => mockConnection, subscribeDirectConnection: () => () => {},
  directDeliveryScope: () => mockScope, directConnectionGeneration: () => mockGeneration }));
jest.mock('../remote/direct-api', () => ({ requestDirect: (...args: unknown[]) => mockRequest(...args), subscribeDirectEvents: () => () => {} }));
jest.mock('../remote/direct-workspace', () => ({ createDirectWorkspaceRuntime: () => ({ scope: mockScope }) }));
jest.mock('../remote/DirectNewComposer', () => ({ DirectNewComposer: () => null }));
jest.mock('../remote/DirectConversation', () => ({ DirectConversation: () => null }));
const profiles = ['codex', 'claude'].map(id => ({ id, tool: id, name: `${id} picker`, available: true, remoteSendSupported: true,
  capabilities: { list: true, send: true }, api: { name: 'Computer API', model: 'model', protocol: 'responses', configured: true, pending: false, source: 'computer' } }));
function respond(command: any) {
  if (command.type === 'agents.status') return { agents: profiles };
  if (command.type === 'projects.list') return { projects: [] };
  if (command.type === 'sessions.list') return { sessions: [] };
  throw new Error(`Unexpected ${command.type}`);
}
const scope = () => ({ kind: 'direct' as const, connectionId: mockScope, deviceId: mockConnection.deviceId });
beforeEach(() => {
  mockSettings.clear(); mockGeneration = 1; mockScope = 'binding-a'; mockConnection = { status: 'connected', deviceId: 'pc-a', deviceName: 'Same name' };
  mockRequest.mockReset().mockImplementation(async (command: any) => respond(command));
});
async function selected(view: Awaited<ReturnType<typeof render>>, id: string) {
  await waitFor(() => expect(view.getByRole('button', { name: id === 'claude' ? 'Claude Code' : 'Codex' }).props.accessibilityState.selected).toBe(true));
}

test('explicit Direct Agent selection survives remount without consulting the global preference', async () => {
  mockSettings.set('remote_last_agent_v1', 'claude');
  let view = await render(<DirectExperience/>);
  await selected(view, 'codex');
  await fireEvent.press(view.getByRole('button', { name: 'Claude Code' }));
  await selected(view, 'claude');
  expect(await readPreferredAgent(scope())).toBe('claude');
  await view.unmount();
  view = await render(<DirectExperience/>);
  await selected(view, 'claude');
  await view.unmount();
});

test('same-name computers and a replacement fingerprint cannot inherit the other Direct Agent', async () => {
  const original = scope(); await rememberPreferredAgent(original, 'claude');
  const view = await render(<DirectExperience/>); await selected(view, 'claude');
  mockConnection = { ...mockConnection, deviceId: 'pc-b' }; mockScope = 'binding-b'; mockGeneration++;
  await view.rerender(<DirectExperience/>); await selected(view, 'codex');
  mockConnection = { ...mockConnection, deviceId: 'pc-a' }; mockScope = 'binding-a'; mockGeneration++;
  await view.rerender(<DirectExperience/>); await selected(view, 'claude');
  mockScope = 'replacement-fingerprint-a'; mockGeneration++;
  await view.rerender(<DirectExperience/>); await selected(view, 'codex');
  expect(await readPreferredAgent(original)).toBe('claude'); await view.unmount();
});

test('an unavailable saved Agent is not advertised and no API mutation is sent while restoring', async () => {
  await rememberPreferredAgent(scope(), 'removed-harness');
  const view = await render(<DirectExperience/>); await selected(view, 'codex');
  expect(view.queryByText('removed-harness')).toBeNull();
  expect(mockRequest.mock.calls.every(([command]) => ['agents.status', 'projects.list', 'sessions.list'].includes(command.type))).toBe(true);
  await view.unmount();
});

test('late profile reply from an old binding cannot issue a project request on the replacement binding', async () => {
  let finish!: (value: unknown) => void;
  mockRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = await render(<DirectExperience/>);
  await waitFor(() => expect(finish).toBeDefined());
  // Native state can change before React receives its subscription callback.
  mockScope = 'replacement-fingerprint-a'; mockGeneration++;
  await act(async () => finish({ agents: profiles }));
  expect(mockRequest.mock.calls.map(([command]) => command.type)).toEqual(['agents.status']);
  await view.unmount();
});
