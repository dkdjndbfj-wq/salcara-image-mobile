import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { AgentProfile, SessionInfo } from '../remote/client';
import { RemoteSidebar } from '../remote/RemoteSidebar';

let mockRemote: any;
const mockListeners = new Set<() => void>();
const mockLoadSessions = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadMore = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadNative = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadHistory = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('../remote/store', () => ({
  useRemote: () => require('react').useSyncExternalStore((listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); }, () => mockRemote),
  remoteDeliveryScope: () => 'synthetic-credential-scope', timelineKey: (device: string, key: string) => `${device}|${key}`,
  loadSessions: (...args: unknown[]) => mockLoadSessions(...args), loadMoreSessions: (...args: unknown[]) => mockLoadMore(...args),
  loadNativeSessions: (...args: unknown[]) => mockLoadNative(...args), loadClaudeDesktopHistory: (...args: unknown[]) => mockLoadHistory(...args),
}));
jest.mock('../components/ui', () => ({ useReducedMotion: () => true }));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native'), React = require('react');
  const replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, style, ...props }: Record<string, any>) =>
    React.createElement(actual.View, { ...props, accessible: true, accessibilityState: { ...props.accessibilityState, disabled: Boolean(props.disabled) },
      style: typeof style === 'function' ? style({ pressed: false }) : style }, typeof children === 'function' ? children({ pressed: false }) : children) });
  return replacement;
});

type Surface = 'cli' | 'desktop' | 'read-only';
const key = 'codex:0199aaa1-1234-4678-9abc-000000000111';
const baseAgent: AgentProfile = { id: 'codex', tool: 'codex', name: 'Codex', available: true, remoteSendSupported: true,
  api: { name: 'fixture', model: '', protocol: 'responses', configured: true, pending: false, source: 'computer' } };
let surface: Surface, agent: AgentProfile;
const row = (): SessionInfo => ({ sessionKey: surface === 'read-only' ? 'claude-desktop:fixture' : key, tool: surface === 'read-only' ? 'claude' : 'codex',
  title: 'Original', client: surface === 'read-only' ? 'Claude Desktop' : 'Codex', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: surface !== 'read-only',
  controlSurface: surface, ...(surface === 'read-only' ? { sessionScope: 'desktop-chat' as const } : {}) });
function publish(patch: Record<string, unknown>) { mockRemote = { ...mockRemote, ...patch }; mockListeners.forEach(listener => listener()); }
function directory(value: Record<string, unknown>) {
  const entry = mockRemote.sessions.pc;
  if (surface === 'desktop') publish({ sessions: { pc: { ...entry, native: value } } });
  else if (surface === 'read-only') publish({ sessions: { pc: { ...entry, readOnly: { 'desktop-chat': { ...value, identity: 'history-fixture' } } } } });
  else publish({ sessions: { pc: { ...entry, ...value, pages: value.loaded === false ? {} : { codex: { loading: value.loading, error: value.error, errorPage: value.errorPage, nextCursor: value.nextCursor } } } } });
}
function choose(next: Surface) {
  surface = next;
  agent = next === 'desktop' ? { ...baseAgent, desktopLive: { expiresAt: Date.now() + 60_000, sessionKeys: [key], capabilities: {
    list: true, read: true, send: false, interrupt: false, approval: false, attachments: false, modelOverride: false } } }
    : next === 'read-only' ? { ...baseAgent, id: 'claude-desktop', tool: 'claude', name: 'Claude Desktop', desktopHistory: {
      available: true, readOnly: true, identity: 'history-fixture', scopes: ['desktop-chat'] } } : { ...baseAgent };
  directory({ list: next === 'read-only' ? [row()] : [], loaded: true, loading: false });
}
const loader = () => surface === 'desktop' ? mockLoadNative : surface === 'read-only' ? mockLoadHistory : mockLoadSessions;
const props = () => ({ visible: true, deviceId: 'pc', agent, controlSurface: surface, workspaceMode: surface === 'read-only' ? 'work' as const : 'code' as const,
  activeSessionKey: row().sessionKey, onClose: jest.fn(), onOpenSession: jest.fn() });
const surfaces: Surface[] = ['cli', 'desktop', 'read-only'];
beforeEach(() => {
  jest.clearAllMocks(); mockListeners.clear();
  mockLoadSessions.mockResolvedValue(undefined); mockLoadMore.mockResolvedValue(undefined); mockLoadNative.mockResolvedValue(undefined); mockLoadHistory.mockResolvedValue(undefined);
  mockRemote = { connection: 'open', connectionId: 'paired', selectedHubUrl: 'https://hub.fixture/salcara-hub/v1', connectionError: undefined,
    connections: [{ id: 'paired', deviceId: 'pc', hubUrl: 'https://hub.fixture/salcara-hub/v1' }], devices: [{ deviceId: 'pc', name: 'fixture', online: true }],
    sessions: { pc: { list: [], loaded: true, loading: false } }, timelines: {} };
  choose('cli');
});
afterEach(() => { jest.useRealTimers(); });

test.each(surfaces)('%s first read failure offers one explicit retry, not an empty directory or automatic loop', async (mode) => {
  choose(mode); directory({ list: [], loaded: false, loading: false });
  // The read-only surface still obtains its category from exact session metadata.
  if (mode === 'read-only') mockRemote.timelines[`pc|${row().sessionKey}`] = { session: row() };
  const read = loader();
  read.mockImplementationOnce(async () => {
    directory({ list: [], loaded: true, loading: false, error: 'synthetic 500/timeout', errorPage: 'head' });
    publish({ connection: 'error', connectionError: 'synthetic 500/timeout' });
  }).mockImplementationOnce(async () => {
    directory({ list: [], loaded: true, loading: false }); publish({ connection: 'open', connectionError: undefined });
  });
  const view = await render(<RemoteSidebar {...props()} />);
  expect(read).toHaveBeenCalledTimes(1); expect(view.queryByText('还没有对话')).toBeNull(); expect(view.getByText('没有读到对话')).toBeTruthy();
  await act(async () => { await Promise.resolve(); }); expect(read).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('重试'));
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith(...(mode === 'cli' ? ['pc', 'codex', { preservePages: true }]
    : mode === 'desktop' ? ['pc', false, { preservePages: true }] : ['pc', 'desktop-chat', false, { preservePages: true }]));
  expect(view.getByText('还没有对话')).toBeTruthy(); expect(view.queryByLabelText('重试')).toBeNull();
});

test.each(surfaces)('%s head-refresh failure with an older cursor retries the head and preserves the old frontier', async (mode) => {
  choose(mode); directory({ list: [row()], loaded: true, loading: false, error: 'synthetic head failure', errorPage: 'head', nextCursor: 'older' });
  const view = await render(<RemoteSidebar {...props()} />);
  await fireEvent.press(view.getByLabelText('重试'));
  expect(loader()).toHaveBeenLastCalledWith(...(mode === 'cli' ? ['pc', 'codex', { preservePages: true }]
    : mode === 'desktop' ? ['pc', false, { preservePages: true }] : ['pc', 'desktop-chat', false, { preservePages: true }]));
  expect(mockLoadMore).not.toHaveBeenCalled(); expect(view.getByText('Original')).toBeTruthy();
});

test.each(surfaces)('%s more-page failure retries only the original continuation', async (mode) => {
  choose(mode); directory({ list: [row()], loaded: true, loading: false, error: 'synthetic next failure', errorPage: 'more', nextCursor: 'older' });
  const view = await render(<RemoteSidebar {...props()} />);
  await fireEvent.press(view.getByLabelText('重试更多对话'));
  if (mode === 'cli') { expect(mockLoadMore).toHaveBeenCalledWith('pc', 'codex'); expect(mockLoadSessions).not.toHaveBeenCalled(); }
  else expect(loader()).toHaveBeenCalledWith(...(mode === 'desktop' ? ['pc', true] : ['pc', 'desktop-chat', true]));
});

test('a successful empty directory has no error or retry action', async () => {
  const view = await render(<RemoteSidebar {...props()} />);
  expect(view.getByText('还没有对话')).toBeTruthy(); expect(view.queryByText('没有读到对话')).toBeNull(); expect(view.queryByLabelText('重试')).toBeNull();
});

test('another Agent loaded on this computer does not satisfy the selected Agent directory', async () => {
  mockRemote.sessions.pc = { loaded: true, loading: false, list: [{ ...row(), sessionKey: 'claude:other', tool: 'claude' }], pages: { claude: { loading: false } } };
  const original = props(), view = await render(<RemoteSidebar {...original} />);
  expect(mockLoadSessions).toHaveBeenCalledTimes(1); expect(mockLoadSessions).toHaveBeenCalledWith('pc', 'codex');
  // A synthetic adapter that never publishes a page cannot create an effect loop.
  await view.rerender(<RemoteSidebar {...original} childSessionKeys={['codex:child']} />);
  expect(mockLoadSessions).toHaveBeenCalledTimes(1);
});

test('rapid repeated retry taps share one request even before loading rerenders', async () => {
  directory({ list: [], loaded: true, loading: false, error: 'synthetic failure', errorPage: 'head' });
  let finish!: () => void; mockLoadSessions.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(undefined); }));
  const view = await render(<RemoteSidebar {...props()} />), retry = view.getByLabelText('重试').props.onPress;
  await act(async () => { retry(); retry(); }); expect(mockLoadSessions).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
});

test('a silent preserved-head retry cannot flash a successful empty state while its read is pending', async () => {
  directory({ list: [], loaded: true, loading: false, error: 'synthetic failure', errorPage: 'head' });
  let finish!: () => void;
  mockLoadSessions.mockImplementationOnce(() => {
    directory({ list: [], loaded: true, loading: false });
    return new Promise(resolve => { finish = () => resolve(undefined); });
  });
  const view = await render(<RemoteSidebar {...props()} />);
  await fireEvent.press(view.getByLabelText('重试'));
  expect(view.queryByText('还没有对话')).toBeNull();
  expect(view.getByLabelText('加载更多对话').props.accessibilityState.disabled).toBe(true);
  await act(async () => finish());
  expect(view.getByText('还没有对话')).toBeTruthy(); expect(view.queryByLabelText('加载更多对话')).toBeNull();
});

test.each(['hidden', 'station', 'capability'] as const)('a queued retry callback cannot dispatch after its %s owner changes', async (change) => {
  directory({ list: [], loaded: true, loading: false, error: 'synthetic failure', errorPage: 'head' });
  const original = props(), view = await render(<RemoteSidebar {...original} />), retry = view.getByLabelText('重试').props.onPress;
  if (change === 'station') await act(async () => publish({ connectionId: 'new-pair', selectedHubUrl: 'https://other.fixture/salcara-hub/v1' }));
  else await view.rerender(<RemoteSidebar {...original} {...(change === 'hidden' ? { visible: false } : { agent: { ...agent, available: false } })} />);
  await act(async () => retry()); expect(mockLoadSessions).not.toHaveBeenCalled();
});

test('native expiry between rendering and tapping cannot dispatch or fall back to CLI', async () => {
  jest.useFakeTimers(); choose('desktop'); agent.desktopLive!.expiresAt = Date.now() + 1;
  directory({ list: [], loaded: true, loading: false, error: 'synthetic failure', errorPage: 'head' });
  const view = await render(<RemoteSidebar {...props()} />), retry = view.getByLabelText('重试').props.onPress;
  await act(async () => jest.advanceTimersByTime(2)); await act(async () => retry());
  expect(mockLoadNative).not.toHaveBeenCalled(); expect(mockLoadSessions).not.toHaveBeenCalled();
});

test.each(['offline', 'deleted-device', 'unpaired', 'wrong-saved-device'] as const)('an error retry cannot dispatch for an %s computer', async (change) => {
  directory({ list: [], loaded: true, loading: false, error: 'synthetic failure', errorPage: 'head' });
  mockRemote.connection = 'error'; mockRemote.connectionError = 'synthetic disconnect';
  if (change === 'offline') mockRemote.devices[0].online = false;
  else if (change === 'deleted-device') mockRemote.devices = [];
  else if (change === 'unpaired') mockRemote.connections = [];
  else mockRemote.connections[0].deviceId = 'other-pc';
  const view = await render(<RemoteSidebar {...props()} />);
  await act(async () => view.getByLabelText('重试').props.onPress()); expect(mockLoadSessions).not.toHaveBeenCalled();
});

test.each(['identity', 'availability'] as const)('read-only history %s changes invalidate a captured retry', async (change) => {
  choose('read-only'); directory({ list: [row()], loaded: true, loading: false, error: 'synthetic failure', errorPage: 'head' });
  const original = props(), view = await render(<RemoteSidebar {...original} />), retry = view.getByLabelText('重试').props.onPress;
  await view.rerender(<RemoteSidebar {...original} agent={{ ...agent, desktopHistory: change === 'identity' ? { ...agent.desktopHistory!, identity: 'new-history' } : undefined }} />);
  // A new identity may initiate its own fresh authorized directory read.
  // The captured old retry must not add another request to either surface.
  const currentReads = mockLoadHistory.mock.calls.length;
  await act(async () => retry()); expect(mockLoadHistory).toHaveBeenCalledTimes(currentReads); expect(mockLoadSessions).not.toHaveBeenCalled();
});
