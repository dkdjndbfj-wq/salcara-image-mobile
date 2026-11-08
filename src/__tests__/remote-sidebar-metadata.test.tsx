import {openWorkspaceTool} from './fixtures/workspace-navigation';
import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent, act } from '@testing-library/react-native';
import type { AgentProfile, SessionInfo } from '../remote/client';
import { RemoteSidebar } from '../remote/RemoteSidebar';
import { resetWorkspaceLayoutMemoryForTests } from '../remote/workspace-layout';
const mockLayoutDisk = new Map<string,string>();
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockLayoutDisk.get(key)??null,setSetting:async(key:string,value:string)=>{mockLayoutDisk.set(key,value);}}));

// Preserve JS handlers in the synthetic native host so a callback captured
// before a visibility/scope change can be tested without invoking new props.
jest.mock('react-native', () => {
  const React = require('react'); const actual = jest.requireActual('react-native'); const replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, style, ...props }: Record<string, any>) =>
    React.createElement(actual.View, { ...props, accessible: props.accessible ?? true, accessibilityState: { ...props.accessibilityState, ...(props.disabled !== undefined ? { disabled: props.disabled } : {}) }, style: typeof style === 'function' ? style({ pressed: false }) : style }, typeof children === 'function' ? children({ pressed: false }) : children) });
  return replacement;
});

const mockRemote: any = { devices: [], sessions: {}, timelines: {}, connection: 'open' };
const mockLoadNative = jest.fn(async (..._args: unknown[]) => undefined);
const mockLoadHistory = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock('../remote/store', () => ({ useRemote: () => mockRemote, getRemoteState:()=>mockRemote, remoteDeliveryScope:()=> 'fixture-pairing', watchCredentials:()=>undefined, onRemoteChange:()=>()=>{}, timelineKey: (device: string, key: string) => `${device}|${key}`,
  loadSessions: async () => undefined, loadMoreSessions: async () => undefined, loadNativeSessions: (...args: unknown[]) => mockLoadNative(...args),
  loadClaudeDesktopHistory: (...args: unknown[]) => mockLoadHistory(...args) }));
jest.mock('../components/ui', () => ({ useReducedMotion: () => true, dismissKeyboardAndBlur: jest.fn() }));
jest.mock('../remote/RemoteDemoBrowser', () => {
  const React = require('react'), { TextInput } = require('react-native');
  return { RemoteDemoBrowser: ({ uri }: { uri: string }) => {
    const [value, setValue] = React.useState('');
    return React.createElement(TextInput, { accessibilityLabel: `网页内容 ${uri}`, value, onChangeText: setValue });
  } };
});
jest.mock('../remote/RemoteComputerPreview', () => {
  const React = require('react'), { View } = require('react-native');
  return { RemoteComputerPreview: (props: Record<string, unknown>) => React.createElement(View, { ...props, testID: 'fixture-computer-preview' }) };
});
jest.mock('../remote/SessionQuickActionsSheet', () => {
  const React = require('react'), { View, Text } = require('react-native');
  return { SessionQuickActionsSheet: (props: Record<string, unknown>) => props.visible
    ? React.createElement(View, { testID: 'session-quick-actions', ...props }, React.createElement(Text, null, '會話操作')) : null };
});
const agent: AgentProfile = { id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
  api: { name: 'fixture', model: '', protocol: 'responses', configured: true, pending: false, source: 'computer' } };
const session = (key: string, title: string, surface: 'cli' | 'desktop' = 'cli'): SessionInfo => ({ sessionKey: key, title, tool: 'codex', client: 'Codex', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true, controlSurface: surface });
beforeEach(() => {
  mockLayoutDisk.clear();resetWorkspaceLayoutMemoryForTests();
  mockRemote.devices = [{ deviceId: 'pc', online: true, name: 'fixture' }];
  mockRemote.sessions = { pc: { loaded: true, list: [session('codex:parent', '主对话')], pages: {} } };
  mockRemote.timelines = {}; mockRemote.approvals = {}; mockLoadNative.mockClear(); mockLoadHistory.mockClear();
});
afterEach(() => jest.useRealTimers());

test.each([false, true])('navigation omits search and a redundant tab while keeping create and session switching: docked=%s', async docked => {
  mockRemote.sessions.pc.list.push(session('codex:next', '另一个对话'));
  const create = jest.fn(), open = jest.fn();
  const view = await render(<RemoteSidebar docked={docked} visible deviceId="pc" agent={agent} activeSessionKey="codex:parent" onClose={jest.fn()} onOpenSession={open} onNew={create} />);
  expect(view.getByTestId('remote-sidebar-sessions')).toBeTruthy();
  expect(view.queryByLabelText('搜索侧边栏会话')).toBeNull();
  expect(view.queryByPlaceholderText('搜索对话')).toBeNull();
  expect(view.queryByRole('tab', { name: '侧边栏对话' })).toBeNull();
  expect(view.getByLabelText('主对话').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('另一个对话'));
  expect(open).toHaveBeenCalledWith('codex:next');
  await fireEvent.press(view.getByLabelText('新建 Code 对话'));
  expect(create).toHaveBeenCalledWith('code');
  await view.unmount();
});

test('system back closes the phone navigation overlay without opening or creating a conversation', async () => {
  const close = jest.fn(), open = jest.fn(), create = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} activeSessionKey="codex:parent" onClose={close} onOpenSession={open} onNew={create} />);
  await fireEvent(view.getByTestId('remote-navigation-panel'), 'requestClose');
  expect(close).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(view.getByLabelText('主对话').props.accessibilityState.selected).toBe(true);
  await view.unmount();
});

test('a row follows live running, approval and completion while its directory is still idle',async()=>{
  const current=mockRemote.sessions.pc.list[0];
  const element=()=><RemoteSidebar docked visible deviceId="pc" agent={agent} activeSessionKey={current.sessionKey} onClose={()=>{}} onOpenSession={()=>{}}/>;
  const view=await render(element());
  expect(view.queryByTestId('sidebar-session-spinner')).toBeNull();
  mockRemote.timelines={'pc|codex:parent':{session:{...current,status:'running',updatedAt:2,activeTurnId:'current-turn'},snapshotAt:3,sessionSeq:5,loading:false,items:[]}};
  await view.rerender(element());
  expect(view.getByTestId('sidebar-session-spinner')).toBeTruthy();
  mockRemote.timelines={'pc|codex:parent':{...mockRemote.timelines['pc|codex:parent'],items:[{kind:'approval',id:'question',state:'pending',ts:3}]}};
  await view.rerender(element());
  expect(view.queryByTestId('sidebar-session-spinner')).toBeNull();expect(view.getByText('待回复')).toBeTruthy();
  mockRemote.timelines={'pc|codex:parent':{...mockRemote.timelines['pc|codex:parent'],items:[{kind:'turn',id:'done',turnId:'current-turn',status:'completed',seq:7,ts:4}]}};
  await view.rerender(element());
  expect(view.queryByTestId('sidebar-session-spinner')).toBeNull();expect(view.queryByText('待回复')).toBeNull();
  await view.unmount();
});

test.each(['code','work'] as const)('%s navigation aggregates child activity without a child directory and clears on completion',async workspaceMode=>{
  const parent={...session('codex:parent','主对话'),workspaceMode};
  const child={...session('codex:child','子任务'),workspaceMode,parentSessionKey:parent.sessionKey,status:'running' as const};
  mockRemote.sessions.pc={...mockRemote.sessions.pc,list:[parent,child]};
  const open=jest.fn();
  const element=()=><RemoteSidebar docked visible deviceId="pc" agent={agent} workspaceMode={workspaceMode} activeSessionKey={parent.sessionKey} onClose={()=>{}} onOpenSession={open}/>;
  const view=await render(element());
  expect(view.getByRole('progressbar',{name:'主对话及其子任务运行中'})).toBeTruthy();
  expect(view.queryByText('子任务')).toBeNull();
  await fireEvent.press(view.getByLabelText('主对话'));expect(open).toHaveBeenCalledWith(parent.sessionKey);
  mockRemote.approvals={child:{deviceId:'pc',sessionKey:child.sessionKey,approvalId:'child',title:'确认',ts:2,tool:'codex'}};
  await view.rerender(element());
  expect(view.queryByRole('progressbar')).toBeNull();expect(view.getByLabelText('主对话及其子任务待回复')).toBeTruthy();
  mockRemote.approvals={};mockRemote.sessions.pc={...mockRemote.sessions.pc,list:[parent,{...child,status:'idle'}]};
  await view.rerender(element());
  expect(view.queryByRole('progressbar')).toBeNull();expect(view.queryByText('待回复')).toBeNull();
  await view.unmount();
});

test.each(['code','work'] as const)('%s navigation keeps projects open and Agent and mode conversations separate',async workspaceMode=>{
 mockRemote.sessions.pc.list=[...Array.from({length:8},(_,i)=>({...session(`codex:p-${i}`,`同项目对话 ${i}`),cwd:'/projects/mobile',workspaceMode,updatedAt:10-i})),
  {...session('codex:web','另一个项目'),cwd:'/projects/web',workspaceMode},
  {...session('codex:foreign','另一个空间'),cwd:'/projects/mobile',workspaceMode:workspaceMode==='code'?'work':'code'},
  {...session('claude:foreign','另一个 Agent'),tool:'claude',client:'Claude Code',cwd:'/projects/mobile',workspaceMode}];
 const open=jest.fn();const view=await render(<RemoteSidebar docked visible deviceId="pc" agent={agent} workspaceMode={workspaceMode} activeSessionKey="codex:p-7" onClose={()=>{}} onOpenSession={open}/>);
 expect(view.getByLabelText('同项目对话 7').props.accessibilityState.selected).toBe(true);
 expect(view.queryByText('另一个空间')).toBeNull();expect(view.queryByText('另一个 Agent')).toBeNull();
 expect(view.queryByLabelText('折叠mobile')).toBeNull();expect(view.queryByLabelText('展开mobile')).toBeNull();expect(view.queryByTestId('sidebar-project-chevron')).toBeNull();
 await fireEvent.press(view.getByLabelText('同项目对话 2'));expect(open).toHaveBeenCalledWith('codex:p-2');
 await view.unmount();
});

test('navigation displays different project groups together without collapse controls',async()=>{
 mockRemote.sessions.pc.list=[{...session('codex:mobile','手机项目对话'),cwd:'/projects/mobile'}, {...session('codex:web','网页项目对话'),cwd:'/projects/web'}];
 const view=await render(<RemoteSidebar docked visible deviceId="pc" agent={agent} onClose={()=>{}} onOpenSession={()=>{}}/>);
 expect(view.getByLabelText('项目 mobile')).toBeTruthy();expect(view.getByLabelText('项目 web')).toBeTruthy();
 expect(view.getByLabelText('手机项目对话')).toBeTruthy();expect(view.getByLabelText('网页项目对话')).toBeTruthy();
 expect(view.queryByTestId('sidebar-project-chevron')).toBeNull();
 await view.unmount();
});

test('child row preserves observed nickname/role and uses the bundled official Codex icon', async () => {
  mockRemote.timelines['pc|codex:child'] = { session: { ...session('codex:child', '子智能体'), agentNickname: 'Atlas', agentRole: 'explorer' } };
  const open = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} activeSessionKey="codex:parent" childSessionKeys={['codex:child']} onClose={jest.fn()} onOpenSession={open} onNew={jest.fn()} />);
  expect(view.getByText('Atlas')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('侧边栏子智能体'));
  expect(view.getByText('Atlas')).toBeTruthy(); expect(view.getByText('explorer')).toBeTruthy();
  expect(view.getAllByTestId('agent-brand-codex').length).toBeGreaterThan(0);
  await fireEvent.press(view.getByLabelText('打开Atlas')); expect(open).toHaveBeenCalledWith('codex:child');
});

test('docked tablet inner page cannot switch the home-selected workspace mode', async () => {
  const switchSpace = jest.fn(), switchMode = jest.fn(), create = jest.fn();
  const view = await render(<RemoteSidebar docked visible deviceId="pc" agent={agent} activeSpace="remote"
    onSwitchSpace={switchSpace} onWorkspaceModeChange={switchMode} onClose={jest.fn()} onOpenSession={jest.fn()} onNew={create} />);
  expect(view.queryByLabelText('编程')).toBeNull();
  expect(view.queryByLabelText('助手')).toBeNull();
  expect(view.queryByLabelText('聊天')).toBeNull();
  expect(switchSpace).not.toHaveBeenCalled();
  expect(view.queryByLabelText('侧边栏 Work')).toBeNull();
  expect(view.queryByLabelText('侧边栏 Code')).toBeNull();
  expect(switchMode).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('新建 Code 对话'));
  expect(create).toHaveBeenCalledWith('code');
});

test('docked tablet work area keeps all HTML tool tabs reachable', async () => {
  const view = await render(<RemoteSidebar docked mode="tools" visible deviceId="pc" agent={agent}
    activeSessionKey="codex:parent" onClose={jest.fn()} onOpenSession={jest.fn()} />);
  for (const label of ['工具栏改动', '工具栏子智能体', '工具栏调用', '工具栏文件', '工具栏预览']) {
    expect(view.queryByLabelText(label)).toBeNull();
  }
  await openWorkspaceTool(view, '工具栏预览');
  expect(view.getByTestId('remote-tool-preview-empty')).toBeTruthy();
});

test('conversation drawer follows its entry mode without an in-thread mode switch', async () => {
  mockRemote.sessions.pc.list = [
    { ...session('codex:code', '代码项目'), workspaceMode: 'code', cwd: '/fixture/code' },
    { ...session('codex:work', '工作项目'), workspaceMode: 'work', cwd: '' },
  ];
  const create = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} activeSessionKey="codex:code" onClose={jest.fn()} onOpenSession={jest.fn()} onNew={create} />);
  expect(view.getByText('代码项目')).toBeTruthy(); expect(view.queryByText('工作项目')).toBeNull();
  expect(view.queryByLabelText('侧边栏 Work')).toBeNull();
  await view.rerender(<RemoteSidebar visible workspaceMode="work" deviceId="pc" agent={agent} activeSessionKey="codex:work" onClose={jest.fn()} onOpenSession={jest.fn()} onNew={create} />);
  expect(view.getByText('工作项目')).toBeTruthy(); expect(view.queryByText('代码项目')).toBeNull();
  expect(view.getByLabelText('新建 Work 对话')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('新建 Work 对话'));
  expect(create).toHaveBeenCalledWith('work');
});

test('an unrelated cached native directory never replaces a CLI conversation sidebar', async () => {
  mockRemote.sessions.pc.native = { loaded: true, list: [session('codex:native', '桌面对话', 'desktop')] };
  const live = { ...agent, desktopLive: { expiresAt: Date.now() + 100_000, sessionKeys: ['codex:native'], capabilities: { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false } } };
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={live} activeSessionKey="codex:parent" onClose={jest.fn()} onOpenSession={jest.fn()} onNew={jest.fn()} />);
  expect(view.getByText('主对话')).toBeTruthy(); expect(view.queryByText('桌面对话')).toBeNull();
});

test('native child links outside the exact host lease remain disabled instead of switching executor', async () => {
  mockRemote.sessions.pc.native = { loaded: true, list: [session('codex:parent', '主对话', 'desktop')] };
  const live = { ...agent, desktopLive: { expiresAt: Date.now() + 100_000, sessionKeys: ['codex:parent'], capabilities: { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false } } };
  const open = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={live} activeSessionKey="codex:parent" childSessionKeys={['codex:child']} onClose={jest.fn()} onOpenSession={open} onNew={jest.fn()} />);
  await fireEvent.press(view.getByLabelText('侧边栏子智能体'));
  expect(view.getByLabelText('打开子智能体').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('打开子智能体')); expect(open).not.toHaveBeenCalled();
});

test('native list permission alone cannot authorize reading a conversation', async () => {
  mockRemote.sessions.pc.native = { loaded: true, list: [session('codex:parent', '主对话', 'desktop')] };
  const live = { ...agent, desktopLive: { expiresAt: Date.now() + 100_000, sessionKeys: ['codex:parent'], capabilities: { list: true, read: false, send: false, interrupt: false, approval: false, attachments: false, modelOverride: false } } };
  const open = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={live} activeSessionKey="codex:parent" onClose={jest.fn()} onOpenSession={open} onNew={jest.fn()} />);
  expect(view.getByLabelText('主对话').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('主对话')); expect(open).not.toHaveBeenCalled();
});

test('native child labels never come from a stale CLI entry with the same key', async () => {
  mockRemote.sessions.pc.list.push({ ...session('codex:child', '旧 CLI 标题'), agentRole: 'old-role' });
  mockRemote.sessions.pc.native = { loaded: true, list: [session('codex:parent', '主对话', 'desktop'), { ...session('codex:child', 'native child', 'desktop'), agentNickname: 'Atlas', agentRole: 'explorer' }] };
  const live = { ...agent, desktopLive: { expiresAt: Date.now() + 100_000, sessionKeys: ['codex:parent', 'codex:child'], capabilities: { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false } } };
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={live} activeSessionKey="codex:parent" childSessionKeys={['codex:child']} onClose={jest.fn()} onOpenSession={jest.fn()} onNew={jest.fn()} />);
  expect(view.getByText('Atlas')).toBeTruthy(); expect(view.queryByText('旧 CLI 标题')).toBeNull(); expect(view.queryByText('old-role')).toBeNull();
});

test('an explicit native surface cannot downgrade after the lease disappears or a stale CLI timeline collides', async () => {
  mockRemote.timelines['pc|codex:parent'] = { session: session('codex:parent', 'CLI duplicate') };
  mockRemote.sessions.pc.native = { loaded: true, list: [session('codex:parent', 'native conversation', 'desktop')] };
  const open = jest.fn(), create = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} controlSurface="desktop" activeSessionKey="codex:parent" onClose={jest.fn()} onOpenSession={open} onNew={create} />);
  expect(view.getByText('native conversation')).toBeTruthy(); expect(view.queryByText('CLI duplicate')).toBeNull();
  expect(view.queryByLabelText('新对话')).toBeNull();
  await fireEvent.press(view.getByLabelText('native conversation')); expect(open).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});

test('lease expiry while the drawer remains open disables read, and a captured tap cannot bypass it', async () => {
  jest.useFakeTimers();
  mockRemote.sessions.pc.native = { loaded: true, list: [session('codex:parent', 'native conversation', 'desktop')] };
  const live = { ...agent, desktopLive: { expiresAt: Date.now() + 100, sessionKeys: ['codex:parent'], capabilities: { list: true, read: true, send: true, interrupt: false, approval: false, attachments: false, modelOverride: false } } };
  const open = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={live} controlSurface="desktop" activeSessionKey="codex:parent" onClose={jest.fn()} onOpenSession={open} onNew={jest.fn()} />);
  // Move wall time without firing React's expiry timer: the row is still
  // enabled in the old render, so only the handler's fresh check protects it.
  jest.setSystemTime(Date.now() + 110);
  await fireEvent.press(view.getByLabelText('native conversation'));
  expect(open).not.toHaveBeenCalled();
  await act(async () => { jest.advanceTimersByTime(110); });
  expect(view.getByLabelText('native conversation').props.accessibilityState.disabled).toBe(true); expect(open).not.toHaveBeenCalled();
});

test('CLI new conversation opens the editor callback but never dispatches a task from the drawer', async () => {
  const close = jest.fn(), create = jest.fn(), open = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} controlSurface="cli" activeSessionKey="codex:parent" onClose={close} onOpenSession={open} onNew={create} />);
  await fireEvent.press(view.getByLabelText('新建 Code 对话'));
  expect(create).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled();
});

test('Claude Desktop readonly sidebar preserves Chat/Cowork separation and never replaces it with Code', async () => {
  const readonlyAgent: AgentProfile = { ...agent, id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', remoteSendSupported: false,
    desktopHistory: { available: true, readOnly: true, identity: 'identity-fixture', scopes: ['desktop-chat', 'desktop-cowork'] } };
  const readonly = (key: string, title: string, scope: 'desktop-chat' | 'desktop-cowork'): SessionInfo => ({ ...session(key, title), tool: 'claude', client: 'Claude Desktop', controllable: false, controlSurface: 'read-only', sessionScope: scope });
  mockRemote.sessions.pc.list = [{ ...session('claude:code', 'Code conversation'), tool: 'claude', client: 'Claude Desktop' }];
  mockRemote.sessions.pc.readOnly = {
    'desktop-chat': { identity: 'identity-fixture', loaded: true, list: [readonly('claude-desktop:chat', 'Native Chat', 'desktop-chat')], nextCursor: 'next-chat' },
    'desktop-cowork': { identity: 'identity-fixture', loaded: true, list: [readonly('claude-desktop:cowork', 'Native Cowork', 'desktop-cowork')] },
  };
  const open = jest.fn();
  const view = await render(<RemoteSidebar visible workspaceMode="work" deviceId="pc" agent={readonlyAgent} controlSurface="read-only" activeSessionKey="claude-desktop:chat" onClose={jest.fn()} onOpenSession={open} onNew={jest.fn()} />);
  expect(view.getByText('Native Chat')).toBeTruthy(); expect(view.queryByText('Native Cowork')).toBeNull(); expect(view.queryByText('Code conversation')).toBeNull();
  expect(view.queryByLabelText('新对话')).toBeNull();
  await fireEvent.press(view.getByLabelText('Native Chat')); expect(open).toHaveBeenCalledWith('claude-desktop:chat');
  await fireEvent.press(view.getByLabelText('加载更多对话')); expect(mockLoadHistory).toHaveBeenCalledWith('pc', 'desktop-chat', true);
});

test('Claude Desktop account identity rotation does not reveal the previous account directory', async () => {
  const readonlyAgent: AgentProfile = { ...agent, id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude',
    desktopHistory: { available: true, readOnly: true, identity: 'new-identity', scopes: ['desktop-chat'] } };
  mockRemote.sessions.pc.readOnly = { 'desktop-chat': { identity: 'old-identity', loaded: true, list: [{ ...session('claude-desktop:chat', 'Private old chat'), tool: 'claude', client: 'Claude Desktop', controllable: false, controlSurface: 'read-only', sessionScope: 'desktop-chat' }] } };
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={readonlyAgent} controlSurface="read-only" activeSessionKey="claude-desktop:chat" onClose={jest.fn()} onOpenSession={jest.fn()} />);
  expect(view.queryByText('Private old chat')).toBeNull(); expect(mockLoadHistory).toHaveBeenCalledWith('pc', 'desktop-chat');
});

test('a captured sidebar action is inert after hiding or changing the paired computer', async () => {
  const create = jest.fn(), open = jest.fn();
  const props = { visible: true, deviceId: 'pc', agent, controlSurface: 'cli' as const, activeSessionKey: 'codex:parent', onClose: jest.fn(), onOpenSession: open, onNew: create };
  const view = await render(<RemoteSidebar {...props} />);
  const previousOpen = view.getByLabelText('主对话').props.onPress;
  const previousNew = view.getByLabelText('新建 Code 对话').props.onPress;
  await view.rerender(<RemoteSidebar {...props} visible={false} deviceId="new-pc" />);
  await act(async () => { previousOpen(); previousNew(); });
  expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});

test('a conversation with no working folder appears under temporary tasks in the sidebar', async () => {
  mockRemote.sessions.pc.list = [{ ...session('codex:project', '项目对话'), workspaceMode: 'code' }, { ...session('codex:temporary', '临时对话'), cwd: '', workspaceMode: 'work' }];
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} onClose={jest.fn()} onOpenSession={jest.fn()} />);
  expect(view.getByText('项目对话')).toBeTruthy();
  expect(view.queryByText('临时对话')).toBeNull();
  await view.rerender(<RemoteSidebar visible workspaceMode="work" deviceId="pc" agent={agent} onClose={jest.fn()} onOpenSession={jest.fn()} />);
  expect(view.getByText('临时任务')).toBeTruthy();
  expect(view.getByText('临时对话')).toBeTruthy();
});

test('sidebar shows more conversations without a project collapse control and long press opens the row menu', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => session(`codex:project-${index}`, `项目会话 ${index}`));
  mockRemote.sessions.pc.list = rows;
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} onClose={jest.fn()} onOpenSession={jest.fn()} />);
  expect(view.queryByText('项目会话 7')).toBeNull();
  await fireEvent.press(view.getByLabelText('显示全部 fixture 的对话'));
  expect(view.getByText('项目会话 7')).toBeTruthy();
  expect(view.queryByLabelText('折叠fixture')).toBeNull();
  expect(view.queryByLabelText('展开fixture')).toBeNull();
  expect(view.getByText('项目会话 0')).toBeTruthy();
  await fireEvent(view.getByLabelText('项目会话 0'), 'longPress');
  expect(view.getByTestId('session-quick-actions').props).toMatchObject({ deviceId: 'pc', session: rows[0] });
});

test('switching computers keeps project groups and colliding session handles scoped to that computer', async () => {
  const key = 'codex:same-handle';
  mockRemote.devices.push({ deviceId: 'pc-2', online: true, name: '家用电脑' });
  mockRemote.sessions['pc-2'] = { loaded: true, list: [{ ...session(key, '家用机对话'), cwd: 'D:\\home\\repo' }], pages: {} } as any;
  mockRemote.sessions.pc.list = [{ ...session(key, '工作机对话'), cwd: 'C:\\work\\repo' }];
  const open = jest.fn();
  const makeProps = (deviceId: string) => ({ visible: true, deviceId, agent, activeSessionKey: key, onClose: jest.fn(), onNew: jest.fn(), onOpenSession: (sessionKey: string) => open(deviceId, sessionKey) });
  const view = await render(<RemoteSidebar {...makeProps('pc')} />);

  expect(view.getByText('工作机对话')).toBeTruthy();
  expect(view.getByLabelText('项目 repo').props.accessibilityHint).toBe('C:\\work\\repo');
  expect(view.queryByText('家用机对话')).toBeNull();
  const staleWorkComputerRow = view.getByLabelText('工作机对话').props.onPress;

  await view.rerender(<RemoteSidebar {...makeProps('pc-2')} />);
  await act(async () => { staleWorkComputerRow(); });
  expect(open).not.toHaveBeenCalled();
  expect(view.getByText('家用机对话')).toBeTruthy();
  expect(view.getByLabelText('项目 repo').props.accessibilityHint).toBe('D:\\home\\repo');
  expect(view.queryByText('工作机对话')).toBeNull();
  await fireEvent.press(view.getByLabelText('家用机对话'));
  expect(open).toHaveBeenCalledWith('pc-2', key);
});


test('tool pages close independently and can be reopened from a new tab', async () => {
  const view = await render(<RemoteSidebar docked mode="tools" visible deviceId="pc" agent={agent}
    activeSessionKey="codex:parent" onClose={jest.fn()} onOpenSession={jest.fn()} sideChat={<Text>独立聊天内容</Text>} />);
  await openWorkspaceTool(view,'工具栏子智能体');
  await fireEvent.press(view.getByLabelText('关闭标签 子智能体'));
  expect(view.queryByLabelText('工具栏子智能体')).toBeNull();
  await fireEvent.press(view.getByLabelText('添加工具标签'));
  await fireEvent.press(view.getByLabelText('新标签页更多'));
  await fireEvent.press(view.getByLabelText('打开子智能体标签'));
  expect(view.getByLabelText('工具栏子智能体').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('添加工具标签'));
  await fireEvent.press(view.getByLabelText('打开侧边聊天标签'));
  expect(view.getByTestId('remote-side-chat-tab')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭标签 侧边聊天'));
  expect(view.queryByTestId('remote-side-chat-tab')).toBeNull();
});

test('file change tabs use filenames and are cleared when the computer changes', async () => {
  const base = { docked: true, mode: 'tools' as const, visible: true, agent, activeSessionKey: 'codex:parent', onClose: jest.fn(), onOpenSession: jest.fn() };
  const first = { id: 'a', path: 'src/App.tsx', add: 1, del: 0, diff: '+ first', status: 'done' as const };
  const second = { id: 'b', path: 'src/Login.tsx', add: 2, del: 0, diff: '+ second', status: 'done' as const };
  const view = await render(<RemoteSidebar {...base} deviceId="pc" diffTarget={first} diffOpenNonce={1} />);
  expect(view.getByLabelText('工具栏文件 App.tsx').props.accessibilityState.selected).toBe(true);
  await view.rerender(<RemoteSidebar {...base} deviceId="pc" diffTarget={second} diffOpenNonce={2} />);
  expect(view.getByLabelText('工具栏文件 App.tsx')).toBeTruthy();
  expect(view.getByLabelText('工具栏文件 Login.tsx').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('工具栏文件 App.tsx'));
  expect(view.getByText('+ first')).toBeTruthy();
  await view.rerender(<RemoteSidebar {...base} deviceId="other-computer" />);
  expect(view.queryByLabelText('工具栏文件 App.tsx')).toBeNull();
  expect(view.queryByLabelText('工具栏文件 Login.tsx')).toBeNull();
});

test('Agent browser events add independent background tabs, retain page state, and do not reopen dismissed events', async () => {
  const base = { docked: true, mode: 'tools' as const, visible: true, deviceId: 'pc', agent, activeSessionKey: 'codex:parent', onClose: jest.fn(), onOpenSession: jest.fn() };
  const event = (id: string, url: string, pageId: string) => ({ kind: 'tool' as const, id, tool: 'mcp' as const, title: 'browser_navigate', status: 'done' as const, ts: 1, browser: { action: 'open' as const, url, pageId } });
  const first = event('open-a', 'https://a.example/', 'page-a');
  const second = event('open-b', 'https://b.example/', 'page-b');
  const view = await render(<RemoteSidebar {...base} toolActivities={[first]} />);
  expect(view.getByRole('tab',{name:'新标签页'}).props.accessibilityState.selected).toBe(true);
  expect(view.getByRole('tab', { name: '网页 a.example' }).props.accessibilityState.selected).toBe(false);
  expect(view.queryByLabelText('网页内容 https://a.example/')).toBeNull();
  await fireEvent.press(view.getByRole('tab', { name: '网页 a.example' }));
  await fireEvent.changeText(view.getByLabelText('网页内容 https://a.example/'), 'A 的表单内容');
  await view.rerender(<RemoteSidebar {...base} toolActivities={[first, second]} />);
  expect(view.getByRole('tab', { name: '网页 a.example' }).props.accessibilityState.selected).toBe(true);
  expect(view.getByRole('tab', { name: '网页 b.example' }).props.accessibilityState.selected).toBe(false);
  await fireEvent.press(view.getByRole('tab', { name: '网页 b.example' }));
  await fireEvent.changeText(view.getByLabelText('浏览器地址'), 'https://b.example/not-submitted');
  await fireEvent.press(view.getByRole('tab', { name: '网页 a.example' }));
  expect(view.getByLabelText('网页内容 https://a.example/').props.value).toBe('A 的表单内容');
  await fireEvent.press(view.getByRole('tab', { name: '网页 b.example' }));
  expect(view.getByLabelText('浏览器地址').props.value).toBe('https://b.example/not-submitted');
  await fireEvent.press(view.getByLabelText('关闭标签 b.example'));
  await view.rerender(<RemoteSidebar {...base} toolActivities={[{ ...first }, { ...second }]} />);
  expect(view.queryByRole('tab', { name: '网页 b.example' })).toBeNull();
  expect(view.getAllByRole('tab', { name: '网页 a.example' })).toHaveLength(1);
  await view.rerender(<RemoteSidebar {...base} visible={false} toolActivities={[first, second, event('navigate-a', 'https://a.example/next', 'page-a')]} />);
  expect(view.queryByTestId('remote-sidebar')).toBeNull();
  await view.rerender(<RemoteSidebar {...base} toolActivities={[first, second, event('navigate-a', 'https://a.example/next', 'page-a')]} />);
  expect(view.getByRole('tab', { name: '网页 a.example/next' })).toBeTruthy();
  expect(view.queryByRole('tab', { name: '网页 a.example' })).toBeNull();
});

test('user link opens focus their tab; new links retain existing pages and repeated clicks reuse them', async () => {
  const base = { mode: 'tools' as const, visible: true, deviceId: 'pc', agent, activeSessionKey: 'codex:parent', onClose: jest.fn(), onOpenSession: jest.fn() };
  const view = await render(<RemoteSidebar {...base} previewTarget={{ kind: 'web', url: 'https://a.example/' }} previewOpenNonce={1} />);
  await view.rerender(<RemoteSidebar {...base} previewTarget={{ kind: 'web', url: 'https://b.example/' }} previewOpenNonce={2} />);
  expect(view.getByRole('tab', { name: '网页 b.example' }).props.accessibilityState.selected).toBe(true);
  expect(view.getByRole('tab', { name: '网页 a.example' })).toBeTruthy();
  await openWorkspaceTool(view, '工具栏改动');
  await view.rerender(<RemoteSidebar {...base} previewTarget={{ kind: 'web', url: 'https://b.example/' }} previewOpenNonce={3} />);
  expect(view.getByRole('tab', { name: '网页 b.example' }).props.accessibilityState.selected).toBe(true);
  expect(view.getAllByRole('tab', { name: '网页 b.example' })).toHaveLength(1);
  await fireEvent.changeText(view.getByLabelText('浏览器地址'), 'https://b.example/next');
  await fireEvent.press(view.getByLabelText('打开网址'));
  expect(view.getByLabelText('浏览器地址').props.value).toBe('https://b.example/next');
  await fireEvent.press(view.getByLabelText('网页后退'));
  expect(view.getByLabelText('浏览器地址').props.value).toBe('https://b.example/');
  await fireEvent.press(view.getByLabelText('网页更多操作'));
  await fireEvent.press(view.getByLabelText('网页前进'));
  expect(view.getByLabelText('浏览器地址').props.value).toBe('https://b.example/next');
});

test('two desktop pages at the same URL remain independent when one navigates', async () => {
  const base = { docked: true, mode: 'tools' as const, visible: true, deviceId: 'pc', agent, activeSessionKey: 'codex:parent', onClose: jest.fn(), onOpenSession: jest.fn() };
  const first = { kind: 'tool' as const, id: 'open-1', tool: 'mcp' as const, title: 'browser_navigate', status: 'done' as const, ts: 1, browser: { action: 'open' as const, url: 'https://same.example/', pageId: 'page-1' } };
  const second = { ...first, id: 'open-2', browser: { ...first.browser, pageId: 'page-2' } };
  const view = await render(<RemoteSidebar {...base} toolActivities={[first, second]} />);
  expect(view.getAllByRole('tab', { name: '网页 same.example' })).toHaveLength(2);
  await fireEvent.press(view.getAllByRole('tab', { name: '网页 same.example' })[0]);
  await fireEvent.changeText(view.getByLabelText('网页内容 https://same.example/'), 'first page');
  const navigate = { ...second, id: 'navigate-2', browser: { ...second.browser, action: 'navigate' as const, url: 'https://same.example/next' } };
  await view.rerender(<RemoteSidebar {...base} toolActivities={[first, second, navigate]} />);
  expect(view.getByRole('tab', { name: '网页 same.example' }).props.accessibilityState.selected).toBe(true);
  expect(view.getByLabelText('网页内容 https://same.example/').props.value).toBe('first page');
  expect(view.getByRole('tab', { name: '网页 same.example/next' }).props.accessibilityState.selected).toBe(false);
});

test.each(['agent-page', 'user-url'] as const)('reopening a browser by %s retains history and scroll after a cold layout restore', async source => {
  const base = { docked: true, mode: 'tools' as const, visible: true, deviceId: 'pc', agent, activeSessionKey: 'codex:parent', onClose: jest.fn(), onOpenSession: jest.fn() };
  const firstUrl = 'http://localhost:3000/one', secondUrl = 'http://localhost:3000/two';
  const first = { kind: 'tool' as const, id: 'browser-open', tool: 'mcp' as const, title: 'browser_navigate', status: 'done' as const, ts: 1, browser: { action: 'open' as const, url: firstUrl, pageId: 'desktop-page' } };
  const view = await render(<RemoteSidebar {...base} toolActivities={[first]} />);
  await fireEvent.press(view.getByRole('tab', { name: '网页 localhost/one' }));
  await fireEvent.changeText(view.getByLabelText('浏览器地址'), secondUrl);
  await fireEvent.press(view.getByLabelText('打开网址'));
  const savedScroll = { x: 14, y: 620, url: secondUrl };
  await fireEvent(view.getByTestId('fixture-computer-preview'), 'scrollChange', savedScroll);
  await openWorkspaceTool(view, '工具栏改动');
  if (source === 'agent-page') {
    const repeated = { ...first, id: 'browser-reopened', browser: { ...first.browser, url: secondUrl } };
    await view.rerender(<RemoteSidebar {...base} toolActivities={[first, repeated]} />);
    expect(view.getByLabelText('工具栏改动').props.accessibilityState.selected).toBe(true);
    await fireEvent.press(view.getByRole('tab', { name: '网页 localhost/two' }));
  } else {
    await view.rerender(<RemoteSidebar {...base} toolActivities={[first]} previewTarget={{ kind: 'local-service', url: secondUrl }} previewOpenNonce={1} />);
  }
  expect(view.getAllByRole('tab', { name: '网页 localhost/two' })).toHaveLength(1);
  await view.unmount();
  // Evict the module cache as an app restart would, while retaining the actual
  // layout writes produced by the sidebar and browser navigation callbacks.
  resetWorkspaceLayoutMemoryForTests();
  const restored = await render(<RemoteSidebar {...base} />);
  expect(restored.getByLabelText('浏览器地址').props.value).toBe(secondUrl);
  expect(restored.getByTestId('fixture-computer-preview').props.initialScroll).toEqual(savedScroll);
  await fireEvent.press(restored.getByLabelText('网页后退'));
  expect(restored.getByLabelText('浏览器地址').props.value).toBe(firstUrl);
  await fireEvent.press(restored.getByLabelText('网页更多操作'));
  await fireEvent.press(restored.getByLabelText('网页前进'));
  expect(restored.getByLabelText('浏览器地址').props.value).toBe(secondUrl);
  await restored.unmount();
});

test('browser pages with different desktop identities never inherit each other’s persisted history or scroll at the same URL', async () => {
  const base = { docked: true, mode: 'tools' as const, visible: true, deviceId: 'pc', agent, activeSessionKey: 'codex:parent', onClose: jest.fn(), onOpenSession: jest.fn() };
  const firstUrl = 'http://localhost:3000/one', sharedUrl = 'http://localhost:3000/shared';
  const first = { kind: 'tool' as const, id: 'browser-one', tool: 'mcp' as const, title: 'browser_navigate', status: 'done' as const, ts: 1, browser: { action: 'open' as const, url: firstUrl, pageId: 'page-one' } };
  const second = { ...first, id: 'browser-two', browser: { ...first.browser, url: sharedUrl, pageId: 'page-two' } };
  const view = await render(<RemoteSidebar {...base} toolActivities={[first]} />);
  await fireEvent.press(view.getByRole('tab', { name: '网页 localhost/one' }));
  await fireEvent.changeText(view.getByLabelText('浏览器地址'), sharedUrl);
  await fireEvent.press(view.getByLabelText('打开网址'));
  const firstScroll = { x: 2, y: 320, url: sharedUrl }, secondScroll = { x: 8, y: 840, url: sharedUrl };
  await fireEvent(view.getByTestId('fixture-computer-preview'), 'scrollChange', firstScroll);
  await view.rerender(<RemoteSidebar {...base} toolActivities={[first, second]} />);
  await fireEvent.press(view.getAllByRole('tab', { name: '网页 localhost/shared' })[1]);
  expect(view.getByTestId('fixture-computer-preview').props.initialScroll).toBeUndefined();
  expect(view.getByLabelText('网页后退').props.accessibilityState.disabled).toBe(true);
  await fireEvent(view.getByTestId('fixture-computer-preview'), 'scrollChange', secondScroll);
  const repeated = { ...first, id: 'browser-one-again', browser: { ...first.browser, url: sharedUrl } };
  await view.rerender(<RemoteSidebar {...base} toolActivities={[first, second, repeated]} />);
  await view.unmount();
  resetWorkspaceLayoutMemoryForTests();
  const restored = await render(<RemoteSidebar {...base} />);
  expect(restored.getAllByRole('tab', { name: '网页 localhost/shared' })).toHaveLength(2);
  expect(restored.getByTestId('fixture-computer-preview').props.initialScroll).toEqual(secondScroll);
  expect(restored.getByLabelText('网页后退').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(restored.getAllByRole('tab', { name: '网页 localhost/shared' })[0]);
  expect(restored.getByTestId('fixture-computer-preview').props.initialScroll).toEqual(firstScroll);
  await fireEvent.press(restored.getByLabelText('网页后退'));
  expect(restored.getByLabelText('浏览器地址').props.value).toBe(firstUrl);
  await restored.unmount();
});
