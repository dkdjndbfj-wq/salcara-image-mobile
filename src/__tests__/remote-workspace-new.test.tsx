import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteWorkspace } from '../remote/RemoteWorkspace';
import type { AgentProfile, SessionInfo } from '../remote/client';
import type { RemoteState } from '../remote/store';

let mockRemote: RemoteState;
const mockLoadSessions = jest.fn<Promise<void>, [string, string?, { preservePages?: boolean }?]>(async () => undefined);
const mockLoadMore = jest.fn<Promise<void>, [string, string]>(async () => undefined);
const mockLoadNative = jest.fn<Promise<void>, [string, boolean?, { preservePages?: boolean }?]>(async () => undefined);
const mockLoadHistory = jest.fn<Promise<void>, [string, string, boolean?, { preservePages?: boolean }?]>(async () => undefined);
const mockDemandSync = jest.fn();
jest.mock('../remote/store', () => ({ useRemote: () => mockRemote, loadClaudeDesktopHistory: (id: string, scope: string, more?: boolean, options?: { preservePages?: boolean }) => options ? mockLoadHistory(id, scope, more, options) : mockLoadHistory(id, scope, more), loadSessions: (id: string, agentId?: string, options?: { preservePages?: boolean }) => options ? mockLoadSessions(id, agentId, options) : mockLoadSessions(id, agentId), loadMoreSessions: (id: string, agentId: string) => mockLoadMore(id, agentId), loadNativeSessions: (id: string, more?: boolean, options?: { preservePages?: boolean }) => options ? mockLoadNative(id, more, options) : more ? mockLoadNative(id, more) : mockLoadNative(id), selectSessionDirectory: (id: string, surface: 'desktop' | 'all') => { mockRemote.sessions[id].directorySurface = surface; } }));
jest.mock('../remote/useDemandSync', () => ({ useDemandSync: (...args: unknown[]) => mockDemandSync(...args) }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../remote/parts', () => {
  const actual = jest.requireActual('../remote/parts'); const React = require('react'); const { View } = require('react-native');
  return { ...actual, ToolBadge: (props: Record<string, unknown>) => React.createElement(View, { testID: 'workspace-agent-brand', ...props }) };
});
jest.mock('../remote/ProgrammingUi', () => {
  const React = require('react'); const { Text, View, Pressable } = require('react-native');
  const actual = jest.requireActual('../remote/ProgrammingUi');
  return { ...actual,
    ProgrammingHeading: ({ title, subtitle }: { title: string; subtitle?: string }) => React.createElement(View, null, React.createElement(Text, null, title), subtitle ? React.createElement(Text, null, subtitle) : null),
    ProgrammingAction: ({ label, disabled, onPress, ...props }: Record<string, unknown>) => React.createElement(Pressable, { accessibilityRole: 'button', accessibilityLabel: label, accessibilityState: { disabled }, disabled, onPress, ...props }, React.createElement(Text, null, label)),
  };
});
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native'); const React = require('react');
  const resolve = (component: unknown) => typeof component === 'function' ? React.createElement(component) : component;
  const replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, ...props }: Record<string, any>) => React.createElement(actual.View, props, children) });
  Object.defineProperty(replacement, 'SectionList', { enumerable: true, value: ({ sections, renderItem, renderSectionHeader, renderSectionFooter, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }: Record<string, any>) => React.createElement(actual.View, { ...props, sections },
      resolve(ListHeaderComponent), !sections.some((section: { data: unknown[] }) => section.data.length) ? resolve(ListEmptyComponent) : null,
      ...sections.flatMap((section: any) => [
        React.createElement(actual.View, { key: `${section.key}-header`, testID: `workspace-project-${section.key}` }, renderSectionHeader?.({ section })),
        ...section.data.map((item: SessionInfo, index: number) => React.createElement(actual.View, { key: item.sessionKey }, renderItem({ item, index, section }))),
        React.createElement(actual.View, { key: `${section.key}-footer` }, renderSectionFooter?.({ section })),
      ]), resolve(ListFooterComponent)) });
  return replacement;
});

function profile(id: AgentProfile['id'] = 'codex'): AgentProfile {
  return { id, name: id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : 'Claude Desktop', tool: id === 'codex' ? 'codex' : 'claude', available: true, remoteSendSupported: true,
    api: { name: '电脑主力', model: '', source: 'computer', configured: true, pending: false, protocol: 'responses' } };
}
function session(key: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { sessionKey: key, tool: 'codex', client: 'Codex App', title: key, cwd: 'C:\\code\\shop', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli', ...extra };
}
function ready(list: SessionInfo[] = []): RemoteState {
  return { phase: 'ready', connectionId: 'paired', selectedHubUrl: 'https://station.example/salcara-hub/v1', connection: 'open', serviceId: null, connections: [], probes: {}, signingIn: null, devicesLoaded: true,
    devices: [{ deviceId: 'pc-1', name: '工作电脑', online: true, os: 'windows', lastSeen: 1, tools: [], projects: [] }],
    agents: {}, sessions: { 'pc-1': { list, loading: false, loaded: true } }, timelines: {}, approvals: {}, focus: null };
}
type Props = React.ComponentProps<typeof RemoteWorkspace>;
async function mount(extra: Partial<Props> = {}) {
  const props: Props = { visible: true, deviceId: 'pc-1', agent: profile(), onOpen: jest.fn(), onNew: jest.fn(), onSettings: jest.fn(), ...extra };
  const view = await render(<RemoteWorkspace {...props} />);
  return { view, props };
}
beforeEach(() => { jest.clearAllMocks(); mockLoadSessions.mockImplementation(async () => undefined); mockLoadNative.mockImplementation(async () => undefined); mockLoadHistory.mockImplementation(async () => undefined); mockRemote = ready(); });

test('authorized native directory preserves pinned order and keeps all history explicitly selectable', async () => {
  const keys = ['codex:0199aaa1-1234-4678-9abc-000000000001', 'codex:0199aaa1-1234-4678-9abc-000000000002'];
  mockRemote = ready([session('codex:history-only', { title: '全部历史' })]);
  mockRemote.sessions['pc-1'].native = { list: [session(keys[0], { title: '旧置顶', controlSurface: 'desktop', updatedAt: 1, pinnedIndex: 1, sidebarIndex: 1 }), session(keys[1], { title: '新最近', controlSurface: 'desktop', updatedAt: 100, sidebarIndex: 2 })], loaded: true, loading: false };
  const agent = { ...profile(), desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: keys, capabilities: { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false } } };
  const { view } = await mount({ agent });
  expect(mockLoadNative).toHaveBeenCalledWith('pc-1'); expect(mockLoadSessions).not.toHaveBeenCalled();
  expect(view.getByTestId('remote-workspace-list').props.sections.map((item: { name: string }) => item.name)).toEqual(['置顶', '最近']);
  expect(view.queryByText('全部历史')).toBeNull(); expect(view.queryByLabelText('新对话')).toBeNull();
  await fireEvent.press(view.getByLabelText('全部对话'));
  expect(view.getByText('全部历史')).toBeTruthy(); expect(mockLoadSessions).toHaveBeenCalledWith('pc-1', 'codex');
  await fireEvent.press(view.getByLabelText('桌面对话'));
  expect(view.getByText('旧置顶')).toBeTruthy();
});

test('native lease expiry keeps the selected directory and disables opening without CLI fallback', async () => {
  const key = 'codex:0199aaa1-1234-4678-9abc-000000000001';
  mockRemote = ready([session('codex:history-only')]);
  mockRemote.sessions['pc-1'].native = { list: [session(key, { title: '桌面任务', controlSurface: 'desktop', sidebarIndex: 1 })], loading: false, loaded: true };
  const agent = { ...profile(), desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: [key], capabilities: { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false } } };
  const { view, props } = await mount({ agent });
  await view.rerender(<RemoteWorkspace {...props} agent={{ ...agent, desktopLive: { ...agent.desktopLive, expiresAt: Date.now() - 1 } }} />);
  expect(view.getByText('桌面连接已断开')).toBeTruthy(); expect(view.getByText('桌面任务')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('桌面任务')); expect(props.onOpen).not.toHaveBeenCalled();
  await act(async () => view.getByTestId('remote-workspace-list').props.onRefresh());
  expect(mockLoadSessions).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('全部对话')); expect(mockLoadSessions).toHaveBeenCalledWith('pc-1', 'codex');
});

test('returning from a thread after lease expiry retains the prior native directory selection', async () => {
  mockRemote = ready([session('codex:history-only', { title: '不自动切换到历史' })]);
  mockRemote.sessions['pc-1'].directorySurface = 'desktop';
  mockRemote.sessions['pc-1'].native = { list: [], loading: false, loaded: true };
  const { view } = await mount();
  expect(view.getByText('桌面连接已断开')).toBeTruthy(); expect(view.queryByText('不自动切换到历史')).toBeNull();
  expect(mockLoadSessions).not.toHaveBeenCalled();
});

test('groups the original sessions by project with the most recent project first', async () => {
  mockRemote = ready([session('codex:old', { cwd: 'C:\\code\\shop', updatedAt: 1 }), session('codex:new', { cwd: 'C:\\code\\api', updatedAt: 3 })]);
  const { view } = await mount();
  expect(view.getByText('Codex')).toBeTruthy(); expect(view.getByText('工作电脑')).toBeTruthy();
  const sections = view.getByTestId('remote-workspace-list').props.sections;
  expect(sections.map((item: { name: string }) => item.name)).toEqual(['api', 'shop']);
  expect(sections.flatMap((item: { data: SessionInfo[] }) => item.data.map(row => row.sessionKey))).toEqual(['codex:new', 'codex:old']);
  expect(mockLoadSessions).toHaveBeenCalledWith('pc-1', 'codex');
});

test('Claude native Chat/Cowork stay separate from Code and readonly directories do not offer a new task', async () => {
  const identity = 'c'.repeat(64), localKey = 'claude-desktop:local_0199aaa1-1234-4678-9abc-000000000001';
  mockRemote = ready([session('claude:code-fixture', { tool: 'claude', client: 'Claude Desktop', title: 'Code task' })]);
  mockRemote.sessions['pc-1'].readOnly = {
    'desktop-chat': { identity, loaded: true, loading: false, list: [session(localKey, { tool: 'claude', client: 'Claude Desktop', title: 'Native Chat', controlSurface: 'read-only', controllable: false, sessionScope: 'desktop-chat' })] },
    'desktop-cowork': { identity, loaded: true, loading: false, list: [] },
  };
  const agent = { ...profile('claude-desktop'), desktopHistory: { available: true as const, readOnly: true as const, identity, scopes: ['desktop-chat', 'desktop-cowork'] as const } };
  const { view, props } = await mount({ agent: { ...agent, desktopHistory: { ...agent.desktopHistory, scopes: [...agent.desktopHistory.scopes] } } });
  expect(view.getByText('Native Chat')).toBeTruthy(); expect(view.queryByText('Code task')).toBeNull();
  expect(view.queryByLabelText('新对话')).toBeNull(); expect(view.queryByLabelText('更换 Agent / API')).toBeNull();
  expect(mockLoadHistory).toHaveBeenCalledWith('pc-1', 'desktop-chat', false); expect(mockLoadSessions).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('Native Chat')); expect(props.onOpen).toHaveBeenCalledWith(localKey);
  await fireEvent.press(view.getByLabelText('Cowork对话')); expect(mockLoadHistory).toHaveBeenCalledWith('pc-1', 'desktop-cowork', false);
  await fireEvent.press(view.getByLabelText('Code对话')); expect(view.getByText('Code task')).toBeTruthy(); expect(view.getByLabelText('新对话')).toBeTruthy();
  expect(mockLoadSessions).toHaveBeenCalledWith('pc-1', 'claude-desktop');
});

test.each(['codex', 'claude', 'claude-desktop'] as const)('filters the directory for the selected %s Agent', async id => {
  mockRemote = ready([session('codex:app'), session('codex:cli', { client: 'Codex CLI' }), session('claude:code', { tool: 'claude', client: 'Claude Code' }), session('claude:desktop', { tool: 'claude', client: 'Claude Desktop' })]);
  const { view } = await mount({ agent: profile(id) });
  const sections = view.getByTestId('remote-workspace-list').props.sections;
  expect(sections.flatMap((item: { data: SessionInfo[] }) => item.data.map(row => row.sessionKey))).toEqual(id === 'codex' ? ['codex:app', 'codex:cli'] : [id === 'claude' ? 'claude:code' : 'claude:desktop']);
});

test('child sessions stay in the source directory but are not duplicated in the main task list', async () => {
  mockRemote = ready([session('codex:parent'), session('codex:child', { parentSessionKey: 'codex:parent', title: '子任务内部过程' })]);
  const { view } = await mount();
  expect(view.getByText('codex:parent')).toBeTruthy();
  expect(view.queryByText('子任务内部过程')).toBeNull();
  expect(mockRemote.sessions['pc-1'].list).toHaveLength(2);
});

test.each(['修复订单', 'api', 'fixture-model'])('search matches titles, project paths and models (%s)', async query => {
  mockRemote = ready([session('codex:one', { title: '修复订单', cwd: 'C:\\code\\api', model: 'fixture-model' }), session('codex:two', { title: '无关任务' })]);
  const { view } = await mount();
  await fireEvent.changeText(view.getByLabelText('搜索对话'), query);
  expect(view.getByText('修复订单')).toBeTruthy(); expect(view.queryByText('无关任务')).toBeNull();
  await fireEvent.press(view.getByLabelText('清除搜索')); expect(view.getByText('无关任务')).toBeTruthy();
});

test('project expansion reveals older sessions and collapses back to six', async () => {
  mockRemote = ready(Array.from({ length: 8 }, (_, index) => session(`codex:${index}`, { updatedAt: 8 - index })));
  const { view } = await mount();
  expect(view.queryByText('codex:6')).toBeNull();
  await fireEvent.press(view.getByLabelText('显示全部 shop 的对话'));
  expect(view.getByText('codex:7')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('收起 shop 的对话'));
  expect(view.queryByText('codex:7')).toBeNull();
});

test('opening an existing row preserves its exact key and stays separate from new and settings actions', async () => {
  const key = 'codex:11111111-2222-3333-4444-555555555555';
  mockRemote = ready([session(key, { title: '旧会话' })]);
  const { view, props } = await mount();
  await fireEvent.press(view.getByLabelText('旧会话'));
  expect(props.onOpen).toHaveBeenCalledWith(key); expect(props.onNew).not.toHaveBeenCalled(); expect(props.onSettings).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('新对话')); expect(props.onNew).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('更换 Agent / API')); expect(props.onSettings).toHaveBeenCalledTimes(1);
  expect(view.getByText('电脑主力')).toBeTruthy();
});

test('pending, running and failed tasks have compact statuses and official badge props', async () => {
  mockRemote = ready([session('codex:pending'), session('codex:run', { status: 'running' }), session('codex:failed', { status: 'failed' })]);
  mockRemote.approvals = { pending: { approvalId: 'pending', deviceId: 'pc-1', sessionKey: 'codex:pending', tool: 'codex', title: '确认操作', ts: 1 } };
  const { view } = await mount();
  expect(view.getByText('待回复')).toBeTruthy(); expect(view.getByText('运行中')).toBeTruthy(); expect(view.getByText('失败')).toBeTruthy();
  expect(view.getAllByTestId('workspace-agent-brand').every(item => item.props.size === 34 && item.props.tool === 'codex')).toBe(true);
});

test('a valid desktop lease is labeled only on its exact session, never as a global execution guarantee', async () => {
  const key = 'codex:11111111-2222-3333-4444-555555555555';
  mockRemote = ready([session(key), session('codex:other')]);
  const agent = { ...profile(), desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: [key] } };
  const { view } = await mount({ agent });
  expect(view.getAllByText('桌面授权中')).toHaveLength(1);
  expect(view.queryByText('消息会直接在电脑窗口里执行')).toBeNull();
  await view.rerender(<RemoteWorkspace visible deviceId="pc-1" agent={{ ...agent, desktopLive: { ...agent.desktopLive, expiresAt: Date.now() - 1 } }} onOpen={jest.fn()} onNew={jest.fn()} onSettings={jest.fn()} />);
  expect(view.queryByText('桌面授权中')).toBeNull();
});

test('hidden workspace and stale refresh callbacks do not read the computer', async () => {
  const { view, props } = await mount({ visible: false });
  await act(async () => view.getByTestId('remote-workspace-list').props.onRefresh());
  expect(mockLoadSessions).not.toHaveBeenCalled();
  expect(mockDemandSync).toHaveBeenLastCalledWith(false, false, expect.any(Function));
  await view.rerender(<RemoteWorkspace {...props} visible />); expect(mockLoadSessions).toHaveBeenCalledTimes(1);
  const oldRefresh = view.getByTestId('remote-workspace-list').props.onRefresh;
  await view.rerender(<RemoteWorkspace {...props} visible={false} />);
  await act(async () => oldRefresh()); expect(mockLoadSessions).toHaveBeenCalledTimes(1);
});

test('unmounted workspace ignores its former refresh and demand callbacks', async () => {
  const { view } = await mount();
  const refresh = view.getByTestId('remote-workspace-list').props.onRefresh;
  const demand = mockDemandSync.mock.calls.at(-1)?.[2] as () => Promise<void>;
  await view.unmount(); mockLoadSessions.mockClear();
  await act(async () => { refresh(); await demand(); });
  expect(mockLoadSessions).not.toHaveBeenCalled();
});

test('offline workspace retains cached sessions without reads or new-task submission', async () => {
  mockRemote = ready([session('codex:cached', { title: '已保存的任务' })]); mockRemote.devices[0].online = false;
  const { view, props } = await mount();
  expect(view.getByText('电脑离线')).toBeTruthy(); expect(view.getByText('已保存的任务')).toBeTruthy();
  await act(async () => view.getByTestId('remote-workspace-list').props.onRefresh());
  await fireEvent.press(view.getByLabelText('新对话'));
  expect(mockLoadSessions).not.toHaveBeenCalled(); expect(props.onNew).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('已保存的任务')); expect(props.onOpen).toHaveBeenCalledWith('codex:cached');
});

test('simultaneous entry, pull and demand refresh share one in-flight request', async () => {
  let resolve: () => void = () => undefined;
  mockLoadSessions.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  const { view } = await mount();
  const demand = mockDemandSync.mock.calls.at(-1)?.[2] as () => Promise<void>;
  await act(async () => { view.getByTestId('remote-workspace-list').props.onRefresh(); void demand(); });
  expect(mockLoadSessions).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  await act(async () => view.getByTestId('remote-workspace-list').props.onRefresh());
  expect(mockLoadSessions).toHaveBeenCalledTimes(2);
  await act(async () => resolve());
});

test('a running task keeps demand updates active even when search hides it', async () => {
  mockRemote = ready([session('codex:run', { status: 'running', title: '后台任务' }), session('codex:idle', { title: '搜索目标' })]);
  const { view } = await mount();
  await fireEvent.changeText(view.getByLabelText('搜索对话'), '搜索目标');
  expect(mockDemandSync).toHaveBeenLastCalledWith(true, true, expect.any(Function));
  expect(view.queryByText('后台任务')).toBeNull();
  const demand = mockDemandSync.mock.calls.at(-1)?.[2] as () => Promise<void>;
  await act(async () => demand());
  expect(mockLoadSessions).toHaveBeenLastCalledWith('pc-1', 'codex', { preservePages: true });
  await act(async () => view.getByTestId('remote-workspace-list').props.onRefresh());
  expect(mockLoadSessions).toHaveBeenLastCalledWith('pc-1', 'codex');
});

test.each(['native', 'readonly'] as const)('a foreground more-page click is not swallowed by a %s background refresh', async surface => {
  const nativeKey = 'codex:0199aaa1-1234-4678-9abc-000000000001', identity = 'c'.repeat(64);
  const row = surface === 'native' ? session(nativeKey, { controlSurface: 'desktop', sidebarIndex: 1, status: 'running' })
    : session('claude-desktop:local_0199aaa1-1234-4678-9abc-000000000001', { tool: 'claude', client: 'Claude Desktop', sessionScope: 'desktop-chat', controlSurface: 'read-only', controllable: false });
  mockRemote = ready();
  const agent: AgentProfile = surface === 'native' ? { ...profile(), desktopLive: { expiresAt: Date.now() + 60000, sessionKeys: [nativeKey], capabilities: { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false } } }
    : { ...profile('claude-desktop'), desktopHistory: { available: true, readOnly: true, identity, scopes: ['desktop-chat'] } };
  if (surface === 'native') mockRemote.sessions['pc-1'].native = { list: [row], loaded: true, loading: false, nextCursor: 'older' };
  else mockRemote.sessions['pc-1'].readOnly = { 'desktop-chat': { list: [row], loaded: true, loading: false, nextCursor: 'older', identity } };
  const { view } = await mount({ agent });
  let release!: () => void, background!: Promise<void>;
  if (surface === 'native') mockLoadNative.mockImplementation((_id, _more, options) => options?.preservePages ? new Promise(resolve => { release = resolve; }) : Promise.resolve());
  else mockLoadHistory.mockImplementation((_id, _scope, _more, options) => options?.preservePages ? new Promise(resolve => { release = resolve; }) : Promise.resolve());
  const demand = mockDemandSync.mock.calls.at(-1)?.[2] as () => Promise<void>;
  await act(async () => { background = demand(); await Promise.resolve(); });
  await fireEvent.press(view.getByLabelText('更多对话'));
  if (surface === 'native') {
    expect(mockLoadNative).toHaveBeenCalledWith('pc-1', false, { preservePages: true });
    expect(mockLoadNative).toHaveBeenLastCalledWith('pc-1', true);
  } else {
    expect(mockLoadHistory).toHaveBeenCalledWith('pc-1', 'desktop-chat', false, { preservePages: true });
    expect(mockLoadHistory).toHaveBeenLastCalledWith('pc-1', 'desktop-chat', true);
  }
  await act(async () => { release(); await background; });
  await view.unmount();
});

test('active child tasks retain foreground demand updates without appearing as separate main tasks', async () => {
  mockRemote = ready([session('codex:parent'), session('codex:child', { parentSessionKey: 'codex:parent', status: 'running' })]);
  const { view } = await mount();
  expect(view.queryByText('codex:child')).toBeNull();
  expect(mockDemandSync).toHaveBeenLastCalledWith(true, true, expect.any(Function));
});

test('station scope changes refresh the directory and clear old search without mutating sessions', async () => {
  mockRemote = ready([session('codex:one'), session('codex:two')]);
  const { view, props } = await mount();
  await fireEvent.changeText(view.getByLabelText('搜索对话'), 'one');
  expect(view.queryByText('codex:two')).toBeNull();
  mockLoadSessions.mockClear(); mockRemote = { ...mockRemote, serviceId: 'another-relay' };
  await view.rerender(<RemoteWorkspace {...props} />);
  expect(view.getByLabelText('搜索对话').props.value).toBe('');
  expect(view.getByText('codex:two')).toBeTruthy();
  expect(mockLoadSessions).toHaveBeenCalledTimes(1);
  expect(mockRemote.sessions['pc-1'].list).toHaveLength(2);
});

test('a shared directory read already marked loading is not duplicated on entry or refresh', async () => {
  mockRemote = ready([session('codex:one')]); mockRemote.sessions['pc-1'].loading = true;
  const { view, props } = await mount();
  await act(async () => view.getByTestId('remote-workspace-list').props.onRefresh());
  expect(mockLoadSessions).not.toHaveBeenCalled();
  mockRemote.sessions['pc-1'].loading = false;
  await view.rerender(<RemoteWorkspace {...props} />);
  expect(mockLoadSessions).toHaveBeenCalledTimes(1);
  expect(mockLoadSessions).toHaveBeenCalledWith('pc-1', 'codex');
  await view.rerender(<RemoteWorkspace {...props} />);
  expect(mockLoadSessions).toHaveBeenCalledTimes(1);
});

test('station connection errors prevent reads even if the cached device still reports online', async () => {
  mockRemote = ready([session('codex:cached')]); mockRemote.connectionError = 'network';
  const { view, props } = await mount();
  await act(async () => view.getByTestId('remote-workspace-list').props.onRefresh());
  expect(mockLoadSessions).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('新对话')); expect(props.onNew).not.toHaveBeenCalled();
});

test('demand sync receives failed reads for its existing retry backoff', async () => {
  mockRemote = ready([session('codex:run', { status: 'running' })]);
  const { view } = await mount();
  mockLoadSessions.mockRejectedValueOnce(new Error('synthetic failure'));
  const demand = mockDemandSync.mock.calls.at(-1)?.[2] as () => Promise<void>;
  await expect(demand()).rejects.toThrow('synthetic failure');
  expect(view.getByText('codex:run')).toBeTruthy();
});

test('loading, empty and no-match states remain concise and distinct', async () => {
  mockRemote = ready(); mockRemote.sessions['pc-1'].loading = true;
  const { view, props } = await mount(); expect(view.getByTestId('remote-workspace-loading')).toBeTruthy();
  mockRemote = ready(); await view.rerender(<RemoteWorkspace {...props} />); expect(view.getByText('还没有对话')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('搜索对话'), '不存在'); expect(view.getByText('没有匹配的对话')).toBeTruthy();
});

test('failed reads offer retry without exposing raw server error text', async () => {
  mockRemote = ready(); mockRemote.sessions['pc-1'].error = 'opaque backend detail';
  const { view } = await mount();
  expect(view.getByText('没有读到对话')).toBeTruthy(); expect(view.queryByText('opaque backend detail')).toBeNull();
  mockLoadSessions.mockClear(); await fireEvent.press(view.getByLabelText('重试'));
  expect(mockLoadSessions).toHaveBeenCalledWith('pc-1', 'codex');
});

test('an error with cached sessions keeps the list and offers a compact retry', async () => {
  mockRemote = ready([session('codex:cached')]); mockRemote.sessions['pc-1'].error = 'temporary failure';
  const { view } = await mount();
  expect(view.getByText('codex:cached')).toBeTruthy(); expect(view.getByText('没有更新会话')).toBeTruthy();
  mockLoadSessions.mockClear(); await fireEvent.press(view.getByLabelText('重试读取会话')); expect(mockLoadSessions).toHaveBeenCalledTimes(1);
});

test.each(['hidden', 'reopened', 'station', 'agent', 'unmounted'] as const)('queued workspace actions cannot escape their %s generation', async condition => {
  mockRemote = ready([session('codex:old', { title: '旧任务' })]);
  const { view, props } = await mount();
  const open = view.getByLabelText('旧任务').props.onPress;
  const create = view.getByLabelText('新对话').props.onPress;
  const settings = view.getByLabelText('更换 Agent / API').props.onPress;
  const refresh = view.getByTestId('remote-workspace-list').props.onRefresh;
  if (condition === 'hidden' || condition === 'reopened') {
    await view.rerender(<RemoteWorkspace {...props} visible={false} />);
    if (condition === 'reopened') await view.rerender(<RemoteWorkspace {...props} />);
  } else if (condition === 'station') {
    mockRemote = { ...mockRemote, serviceId: 'other-relay' };
    await view.rerender(<RemoteWorkspace {...props} />);
  } else if (condition === 'agent') await view.rerender(<RemoteWorkspace {...props} agent={profile('claude')} />);
  else await view.unmount();
  mockLoadSessions.mockClear();
  await act(async () => { open(); create(); settings(); refresh(); });
  expect(props.onOpen).not.toHaveBeenCalled(); expect(props.onNew).not.toHaveBeenCalled(); expect(props.onSettings).not.toHaveBeenCalled();
  expect(mockLoadSessions).not.toHaveBeenCalled();
});

test('server pagination appends through the scoped reader and keeps cached rows on a page error', async () => {
  mockRemote = ready([session('codex:existing')]);
  mockRemote.sessions['pc-1'].pages = { codex: { nextCursor: 'opaque-next', loading: false } };
  const { view, props } = await mount();
  await fireEvent.press(view.getByLabelText('更多对话'));
  expect(mockLoadMore).toHaveBeenCalledWith('pc-1', 'codex');
  mockRemote.sessions['pc-1'].pages!.codex = { nextCursor: 'opaque-next', loading: false, error: 'raw error' };
  await view.rerender(<RemoteWorkspace {...props} />);
  expect(view.getByText('codex:existing')).toBeTruthy(); expect(view.getByText('没有读到更多对话')).toBeTruthy(); expect(view.queryByText('raw error')).toBeNull();
  await fireEvent.press(view.getByLabelText('重试更多对话')); expect(mockLoadMore).toHaveBeenCalledTimes(2);
});

test('stale and offline pagination never request a next page', async () => {
  mockRemote = ready([session('codex:existing')]);
  mockRemote.sessions['pc-1'].pages = { codex: { nextCursor: 'opaque-next', loading: false } };
  const { view, props } = await mount(); const loadMore = view.getByLabelText('更多对话').props.onPress;
  await view.rerender(<RemoteWorkspace {...props} visible={false} />);
  await view.rerender(<RemoteWorkspace {...props} />);
  await act(async () => loadMore()); expect(mockLoadMore).not.toHaveBeenCalled();
  mockRemote.devices[0].online = false; await view.rerender(<RemoteWorkspace {...props} />);
  await fireEvent.press(view.getByLabelText('更多对话')); expect(mockLoadMore).not.toHaveBeenCalled();
});
