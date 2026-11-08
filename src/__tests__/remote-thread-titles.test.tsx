import React from 'react';
import { Text, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { cleanThreadTitle, renameThread, resetThreadTitlesForTests, retireThreadTitleScope, threadTitle, useThreadTitles } from '../remote/thread-titles';
import { RemoteWorkspace } from '../remote/RemoteWorkspace';
import { RemoteSidebar } from '../remote/RemoteSidebar';
import type { AgentProfile, SessionInfo } from '../remote/client';

const setting = 'remote_thread_titles_v2';
const scopeA = 'station-a|credential:fixture-a', scopeB = 'station-b|credential:fixture-b';
let mockScope = scopeA;
let mockRemote: any;
const mockSettings = new Map<string, string>();
const mockRetired = new Set<string>();
const mockGet = jest.fn(async (key: string): Promise<string | null> => mockSettings.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); });
jest.mock('../storage/database', () => ({ getSetting: (key: string) => mockGet(key), setSetting: (key: string, value: string) => mockSet(key, value) }));
jest.mock('../remote/delivery', () => ({ retiredDeliveryScopes: async () => [...mockRetired] }));
jest.mock('../remote/store', () => ({
  useRemote: () => mockRemote, remoteDeliveryScope: () => mockScope,
  timelineKey: (device: string, key: string) => device + '|' + key,
  loadSessions: async () => undefined, loadMoreSessions: async () => undefined,
  loadNativeSessions: async () => undefined, loadClaudeDesktopHistory: async () => undefined, selectSessionDirectory: () => undefined,
}));
jest.mock('../remote/useDemandSync', () => ({ useDemandSync: () => undefined }));
jest.mock('../components/ui', () => ({ ...jest.requireActual('../components/ui'), useReducedMotion: () => true }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('react-native', () => {
  const React = require('react'), actual = jest.requireActual('react-native');
  const replacement = Object.create(actual);
  const resolve = (value: unknown) => typeof value === 'function' ? React.createElement(value) : value;
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, style, ...props }: Record<string, any>) =>
    React.createElement(actual.View, { ...props, accessible: true, style: typeof style === 'function' ? style({ pressed: false }) : style }, children) });
  Object.defineProperty(replacement, 'SectionList', { enumerable: true, value: ({ sections, renderItem, renderSectionHeader, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }: Record<string, any>) =>
    React.createElement(actual.View, props, resolve(ListHeaderComponent),
      ...sections.flatMap((section: any) => [React.createElement(actual.View, { key: section.key + '-header' }, renderSectionHeader?.({ section })),
        ...section.data.map((item: SessionInfo, index: number) => React.createElement(actual.View, { key: section.key + item.sessionKey }, renderItem({ item, index, section })))]),
      sections.some((section: any) => section.data.length) ? null : resolve(ListEmptyComponent), resolve(ListFooterComponent)) });
  return replacement;
});

const key = (scope = scopeA, device = 'pc', session = 'codex:one') => JSON.stringify([scope, device, session]);
const session: SessionInfo = { sessionKey: 'codex:one', title: '电脑原名', tool: 'codex', client: 'Codex', cwd: '/project-demo', model: 'model-fixture', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' };
const agent: AgentProfile = { id: 'codex', tool: 'codex', name: 'Codex', available: true, remoteSendSupported: true,
  api: { name: 'fixture', model: '', source: 'computer', configured: true, pending: false, protocol: 'responses' } };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function Name({ device = 'pc', capture }: { device?: string; capture?: (lookup: ReturnType<typeof useThreadTitles>) => void }) {
  const lookup = useThreadTitles();
  capture?.(lookup);
  return <Text testID="name">{lookup(device, 'codex:one', '电脑原名')}</Text>;
}
beforeEach(() => {
  resetThreadTitlesForTests(); mockSettings.clear(); mockRetired.clear(); mockScope = scopeA;
  mockGet.mockReset().mockImplementation(async name => mockSettings.get(name) ?? null);
  mockSet.mockReset().mockImplementation(async (name, value) => { mockSettings.set(name, value); });
  mockRemote = { phase: 'ready', connectionId: 'station-a', selectedHubUrl: 'https://station-a.example', connection: 'open', connections: [], serviceId: null,
    devices: [{ deviceId: 'pc', name: '工作电脑', online: true, tools: [], projects: [] }],
    sessions: { pc: { list: [session], loaded: true, loading: false, pages: { codex: { loaded: true, loading: false } } } }, agents: {}, timelines: {}, approvals: {} };
});

test('exact station, pairing credential, computer and session names stay isolated across restoration', async () => {
  await renameThread('pc', 'codex:one', '站点 A');
  await renameThread('pc-other', 'codex:one', '另一电脑');
  mockScope = scopeB; await renameThread('pc', 'codex:one', '站点 B');
  expect(threadTitle('pc', 'codex:one', '原名')).toBe('站点 B');
  mockScope = scopeA;
  expect(threadTitle('pc', 'codex:one', '原名')).toBe('站点 A');
  expect(threadTitle('pc-other', 'codex:one', '原名')).toBe('另一电脑');
  expect(threadTitle('pc', 'codex:other', '原名')).toBe('原名');
  mockScope = 'station-a|credential:replacement';
  expect(threadTitle('pc', 'codex:one', '原名')).toBe('原名');
  resetThreadTitlesForTests(); mockScope = scopeA;
  const view = await render(<Name />);
  expect(view.getByTestId('name').props.children).toBe('站点 A');
});

test('unscoped legacy names are retained on disk but never attributed to a new pairing', async () => {
  mockSettings.set('remote_thread_titles_v1', JSON.stringify({ 'pc|codex:one': '无法证明归属的旧名' }));
  const view = await render(<Name />);
  expect(view.getByTestId('name').props.children).toBe('电脑原名');
  await act(() => renameThread('pc', 'codex:one', '当前配对'));
  expect(mockSettings.get('remote_thread_titles_v1')).toContain('无法证明归属');
  expect(JSON.parse(mockSettings.get(setting)!)).toEqual({ [key()]: '当前配对' });
});

test.each(['', '最新别名'])('an edit made during initial hydration wins over the saved alias: %j', async replacement => {
  const pending = deferred<string | null>();
  mockGet.mockReturnValueOnce(pending.promise);
  const view = await render(<Name />);
  const editing = renameThread('pc', 'codex:one', replacement);
  await act(async () => { pending.resolve(JSON.stringify({ [key()]: '旧别名' })); await editing; });
  expect(view.getByTestId('name').props.children).toBe(replacement || '电脑原名');
  expect(JSON.parse(mockSettings.get(setting)!)).toEqual(replacement ? { [key()]: replacement } : {});
});

test('scope changes during hydration reject the old edit without writing to either pairing', async () => {
  const pending = deferred<string | null>();
  mockGet.mockReturnValueOnce(pending.promise);
  const view = await render(<Name />);
  const editing = renameThread('pc', 'codex:one', '旧弹窗修改', scopeA).catch(error => error);
  await Promise.resolve(); // The original-scope writer is now waiting for hydration.
  mockScope = scopeB;
  await act(async () => { pending.resolve(JSON.stringify({ [key()]: '站点 A' })); await editing; });
  expect(await editing).toBeInstanceOf(Error);
  expect(mockSet).not.toHaveBeenCalled();
  await view.rerender(<Name />);
  expect(view.getByTestId('name').props.children).toBe('电脑原名');
  await expect(renameThread('pc', 'codex:one', '旧回调', scopeA)).rejects.toThrow('连接已改变');
});

test('retirement during a delayed read cannot revive its aliases or erase another pairing', async () => {
  const pending = deferred<string | null>();
  mockGet.mockReturnValueOnce(pending.promise);
  const view = await render(<Name />);
  let removing!: Promise<void>;
  await act(async () => { mockRetired.add(scopeA); removing = retireThreadTitleScope(scopeA); });
  await act(async () => { pending.resolve(JSON.stringify({ [key()]: '旧绑定', [key(scopeB)]: '另一站点' })); await removing; });
  expect(view.getByTestId('name').props.children).toBe('电脑原名');
  expect(JSON.parse(mockSettings.get(setting)!)).toEqual({ [key(scopeB)]: '另一站点' });
  await expect(renameThread('pc', 'codex:one', '不可复活', scopeA)).rejects.toThrow('连接已改变');
});

test('retirement during an in-flight save hides the old name immediately and finishes exact cleanup', async () => {
  await renameThread('pc', 'codex:one', '已存别名');
  mockScope = scopeB; await renameThread('pc', 'codex:one', '保留 B'); mockScope = scopeA;
  const view = await render(<Name />);
  const entered = deferred<void>(), pending = deferred<void>();
  mockSet.mockImplementationOnce(async (name, value) => { entered.resolve(); await pending.promise; mockSettings.set(name, value); });
  const saving = renameThread('pc', 'codex:one', '晚到写入');
  await entered.promise;
  let removing!: Promise<void>;
  await act(async () => { mockRetired.add(scopeA); removing = retireThreadTitleScope(scopeA); });
  expect(view.getByTestId('name').props.children).toBe('电脑原名');
  await act(async () => { pending.resolve(); await saving; await removing; });
  expect(JSON.parse(mockSettings.get(setting)!)).toEqual({ [key(scopeB)]: '保留 B' });
  expect(view.getByTestId('name').props.children).toBe('电脑原名');
});

test('committed retirement fences also hide an old alias after restarting before cleanup finished', async () => {
  mockSettings.set(setting, JSON.stringify({ [key()]: '已经撤销', [key(scopeB)]: 'B' }));
  mockRetired.add(scopeA);
  const view = await render(<Name />);
  expect(view.getByTestId('name').props.children).toBe('电脑原名');
  mockScope = scopeB; await view.rerender(<Name />);
  expect(view.getByTestId('name').props.children).toBe('B');
});

test('failed reads and writes preserve the last committed names and allow a later retry', async () => {
  const original = JSON.stringify({ [key()]: '已保存' });
  mockSettings.set(setting, original);
  mockGet.mockRejectedValueOnce(new Error('synthetic read failure'));
  await expect(renameThread('pc', 'codex:one', '未读取时覆盖')).rejects.toThrow('read failure');
  expect(mockSet).not.toHaveBeenCalled(); expect(mockSettings.get(setting)).toBe(original);
  mockSet.mockRejectedValueOnce(new Error('synthetic write failure'));
  await expect(renameThread('pc', 'codex:one', '失败写入')).rejects.toThrow('write failure');
  expect(threadTitle('pc', 'codex:one', '原名')).toBe('已保存');
  await renameThread('pc', 'codex:one', '成功重试');
  expect(threadTitle('pc', 'codex:one', '原名')).toBe('成功重试');
});

test('corrupt storage and a connection without a pairing never overwrite existing names', async () => {
  mockSettings.set(setting, '{broken');
  await expect(renameThread('pc', 'codex:one', '改名')).rejects.toThrow();
  expect(mockSet).not.toHaveBeenCalled(); expect(mockSettings.get(setting)).toBe('{broken');
  mockScope = 'station-a';
  await expect(renameThread('pc', 'codex:one', '改名')).rejects.toThrow('连接已改变');
});

test('the lookup stays stable on unrelated renders and follows only the scoped committed title', async () => {
  const lookups: ReturnType<typeof useThreadTitles>[] = [];
  const view = await render(<Name capture={lookup => lookups.push(lookup)} />);
  const last = lookups.at(-1);
  await view.rerender(<Name capture={lookup => lookups.push(lookup)} />);
  expect(lookups.at(-1)).toBe(last);
  await act(() => renameThread('pc', 'codex:one', '简洁名称'));
  expect(lookups.at(-1)).not.toBe(last);
  expect(cleanThreadTitle('  名称\n  测试\u0000  ')).toBe('名称 测试');
});

test('workspace search and unfiltered sidebar labels update together without changing the native session title', async () => {
  const close = jest.fn(), open = jest.fn();
  const view = await render(<View>
    <RemoteWorkspace visible deviceId="pc" agent={agent} onOpen={open} onNew={jest.fn()} onSettings={jest.fn()} />
    <RemoteSidebar visible deviceId="pc" agent={agent} activeSessionKey="codex:one" onClose={close} onOpenSession={open} />
  </View>);
  const search = view.getByLabelText('搜索对话');
  expect(view.getAllByPlaceholderText('搜索对话')).toHaveLength(1);
  expect(view.queryByLabelText('搜索侧边栏会话')).toBeNull();
  await fireEvent.changeText(search, '我的新名称');
  expect(view.getByLabelText('电脑原名')).toBeTruthy();
  expect(view.queryByLabelText('我的新名称')).toBeNull();
  await act(() => renameThread('pc', 'codex:one', '我的新名称'));
  expect(view.getAllByLabelText('我的新名称')).toHaveLength(2);
  expect(session.title).toBe('电脑原名');
  await fireEvent.press(view.getAllByLabelText('我的新名称')[1]);
  expect(open).toHaveBeenCalledWith('codex:one');
  await act(() => renameThread('pc', 'codex:one', ''));
  expect(view.queryByLabelText('我的新名称')).toBeNull();
  await fireEvent.changeText(search, 'project-demo');
  expect(view.getAllByLabelText('电脑原名')).toHaveLength(2);
  await fireEvent.changeText(search, 'model-fixture');
  expect(view.getAllByLabelText('电脑原名')).toHaveLength(2);
});

test('sidebar parent and child navigation use local names while preserving executor and role metadata', async () => {
  await renameThread('pc', 'codex:one', '主任务别名');
  await renameThread('pc', 'codex:child', '子任务别名');
  mockRemote.timelines['pc|codex:child'] = { session: { ...session, sessionKey: 'codex:child', title: '子智能体', agentNickname: 'Atlas', agentRole: 'explorer' } };
  const open = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} activeSessionKey="codex:one" childSessionKeys={['codex:child']} onClose={jest.fn()} onOpenSession={open} />);
  await fireEvent.press(view.getByLabelText('侧边栏对话'));
  expect(view.getByLabelText('主任务别名')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('侧边栏子智能体'));
  expect(view.getByLabelText('打开子任务别名')).toBeTruthy();
  expect(view.getByText('explorer')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开子任务别名'));
  expect(open).toHaveBeenCalledWith('codex:child');
});

test('a renewed same-device pairing clears the workspace query and neither directory reuses its alias', async () => {
  await renameThread('pc', 'codex:one', '站点 A 别名');
  const props = { visible: true, deviceId: 'pc', agent, activeSessionKey: 'codex:one', onClose: jest.fn(), onOpenSession: jest.fn() };
  const directories = <View><RemoteWorkspace visible deviceId="pc" agent={agent} onOpen={jest.fn()} onNew={jest.fn()} onSettings={jest.fn()} /><RemoteSidebar {...props} /></View>;
  const view = await render(directories);
  expect(view.queryByLabelText('搜索侧边栏会话')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('搜索对话'), '站点 A 别名');
  expect(view.getAllByLabelText('站点 A 别名')).toHaveLength(2);
  mockScope = 'station-a|credential:replacement';
  await view.rerender(<View><RemoteWorkspace visible deviceId="pc" agent={agent} onOpen={jest.fn()} onNew={jest.fn()} onSettings={jest.fn()} /><RemoteSidebar {...props} /></View>);
  expect(view.getByLabelText('搜索对话').props.value).toBe('');
  expect(view.queryByLabelText('搜索侧边栏会话')).toBeNull();
  expect(view.queryByLabelText('站点 A 别名')).toBeNull();
  expect(view.getAllByLabelText('电脑原名')).toHaveLength(2);
});

