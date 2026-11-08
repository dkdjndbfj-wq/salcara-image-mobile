import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { closeWorkspacePage, type WorkspacePage } from '../remote/WorkspaceTabs';
import { workspaceBrowserTarget } from '../remote/RemoteBrowserPage';
import { RemoteDemoWorkspace } from '../remote/RemoteDemoWorkspace';
import { matchingBrowserTab } from '../remote/workspace-browser';
import type {SessionInfo} from '../remote/client';

jest.setTimeout(20_000);

// These tests exercise the wide split workspace. The mobile suite separately
// covers full-page tools, returned drafts and Android Back at 390/844 px.
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native'), replacement = Object.create(actual);
  Object.defineProperty(replacement,'useWindowDimensions',{enumerable:true,value:()=>({width:1280,height:900,scale:1,fontScale:1})});
  return replacement;
});

test.each(['code','work'] as const)('the %s composer offers independent planning without a space switch',async workspaceMode=>{
  const view=await render(<RemoteDemoWorkspace workspaceMode={workspaceMode}/>);
  expect(view.queryByLabelText('选择执行模式')).toBeNull();
  expect(view.queryByRole('tab',{name:'Code'})).toBeNull();expect(view.queryByRole('tab',{name:'Work'})).toBeNull();
  await fireEvent.press(view.getByLabelText('打开工具菜单'));
  await fireEvent.press(view.getByLabelText('开启计划模式'));
  expect(view.getByLabelText('关闭演示计划模式')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开工具菜单'));
  expect(view.getByLabelText('关闭计划模式').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('关闭计划模式'));
  expect(view.queryByLabelText('关闭演示计划模式')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开工具菜单'));
  expect(view.getByLabelText('开启计划模式').props.accessibilityState.selected).toBe(false);
  await view.unmount();
});

jest.mock('../components/ui', () => ({ ...jest.requireActual('../components/ui'), useReducedMotion: () => true }));
jest.mock('../remote/RemoteDemoBrowser', () => {
  const React = require('react'), { TextInput } = require('react-native');
  return { RemoteDemoBrowser: ({ uri }: { uri: string }) => {
    const [value, setValue] = React.useState('');
    return React.createElement(TextInput, { accessibilityLabel: `网页内容 ${uri}`, value, onChangeText: setValue });
  } };
});

test('closing an active tab chooses its neighbour and returns to a new page when the last tab closes', () => {
  const pages:WorkspacePage[] = [{id:'agents',kind:'agents',title:'子智能体'},{id:'tools',kind:'tools',title:'执行记录'}];
  expect(closeWorkspacePage(pages, 'agents', 'agents').activeId).toBe('tools');
  expect(closeWorkspacePage([pages[0]], pages[0].id, pages[0].id)).toEqual({ pages: [{ id: 'newtab', kind: 'newtab', title: '新标签页' }], activeId: 'newtab' });
});

test('browser tabs accept only validated HTTP addresses without credentials', () => {
  expect(workspaceBrowserTarget('example.com')).toEqual({ kind: 'web', url: 'https://example.com/' });
  expect(workspaceBrowserTarget('http://192.168.1.10:3000')).toEqual({ kind: 'local-service', url: 'http://192.168.1.10:3000/' });
  for (const value of ['javascript:alert(1)', 'file:///private/keys', 'https://user:password@example.com', '']) expect(workspaceBrowserTarget(value)).toBeUndefined();
});

test('distinct desktop page identities remain separate even when they have the same URL', () => {
  const target = { kind: 'web' as const, url: 'https://example.com/' };
  const pages = [{ id: 'first', pageId: 'desktop-1', url: target.url }, { id: 'second', pageId: 'desktop-2', url: target.url }];
  expect(matchingBrowserTab(pages, { target, pageId: 'desktop-3' })).toBeUndefined();
  expect(matchingBrowserTab(pages, { target: { ...target, url: 'https://example.com/next' }, pageId: 'desktop-2' })?.id).toBe('second');
  expect(matchingBrowserTab([{ id: 'user-page', url: target.url }], { target, pageId: 'desktop-3' })?.id).toBe('user-page');
});

test('demo thread navigation preserves each draft and updates the title', async () => {
  const view = await render(<RemoteDemoWorkspace sessionTitle="最初的任务" />);
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'), '最初任务未发送的草稿');
  await fireEvent.press(view.getByLabelText('打开会话侧栏'));
  await fireEvent.press(view.getByLabelText('切换任务 整理工作区工具标签'));
  expect(view.getByLabelText('编程对话输入框').props.value).toBe('');
  expect(view.getByText('整理工作区工具标签')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开会话侧栏'));
  await fireEvent.press(view.getByLabelText('切换任务 最初的任务'));
  expect(view.getByLabelText('编程对话输入框').props.value).toBe('最初任务未发送的草稿');
});

test('real session identities isolate same-title project drafts and exclude another Agent or mode', async () => {
  const sessions:SessionInfo[] = [
    {sessionKey:'codex:a',title:'同名任务',cwd:'D:/Projects/a',tool:'codex',client:'Codex App',workspaceMode:'code',updatedAt:1,status:'idle',controllable:true},
    {sessionKey:'codex:b',title:'同名任务',cwd:'D:/Projects/b',tool:'codex',client:'Codex App',workspaceMode:'code',updatedAt:2,status:'running',controllable:true},
    {sessionKey:'codex:work',title:'Work 专属',cwd:'D:/Projects/a',tool:'codex',client:'Codex App',workspaceMode:'work',updatedAt:3,status:'idle',controllable:true},
    {sessionKey:'claude:a',title:'Claude 专属',cwd:'D:/Projects/a',tool:'claude',client:'Claude Code',workspaceMode:'code',updatedAt:4,status:'idle',controllable:true},
  ];
  const view=await render(<RemoteDemoWorkspace agentId="codex" sessionKey="codex:b" sessions={sessions}/>);
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'),'B 的草稿');
  await fireEvent.press(view.getByLabelText('打开会话侧栏'));
  expect(view.queryByLabelText('切换任务 Work 专属')).toBeNull();
  expect(view.queryByLabelText('切换任务 Claude 专属')).toBeNull();
  expect(within(view.getByTestId('demo-project:project:d:\\projects\\b')).getByLabelText('切换任务 同名任务').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(within(view.getByTestId('demo-project:project:d:\\projects\\a')).getByLabelText('切换任务 同名任务'));
  expect(view.getByLabelText('编程对话输入框').props.value).toBe('');
  await fireEvent.press(view.getByLabelText('打开会话侧栏'));
  await fireEvent.press(within(view.getByTestId('demo-project:project:d:\\projects\\b')).getByLabelText('切换任务 同名任务'));
  expect(view.getByLabelText('编程对话输入框').props.value).toBe('B 的草稿');
  await fireEvent.press(view.getByLabelText('打开会话侧栏'));
  await fireEvent.press(view.getByLabelText('在项目 a 新建任务'));
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'),'A 项目的新会话');
  await fireEvent.press(view.getByLabelText('发送编程消息'));
  await fireEvent.press(view.getByLabelText('打开会话侧栏'));
  expect(within(view.getByTestId('demo-project:project:d:\\projects\\a')).getByLabelText('切换任务 A 项目的新会话').props.accessibilityState.selected).toBe(true);
  expect(within(view.getByTestId('demo-project:project:d:\\projects\\b')).queryByLabelText('切换任务 A 项目的新会话')).toBeNull();
  await view.unmount();
});

test('each demo side chat owns its draft and a closed tab can be opened again', async () => {
  const view = await render(<RemoteDemoWorkspace />);
  await fireEvent.press(view.getByLabelText('打开侧边聊天标签'));
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '第一张侧边页');
  await fireEvent.press(view.getByLabelText('添加工具标签'));
  await fireEvent.press(view.getByLabelText('打开侧边聊天标签'));
  expect(view.getByLabelText('临时侧边聊天输入').props.value).toBe('');
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '第二张侧边页');
  await fireEvent.press(view.getAllByRole('tab', { name: '侧边聊天' })[0]);
  expect(view.getByLabelText('临时侧边聊天输入').props.value).toBe('第一张侧边页');
  await fireEvent.press(view.getAllByLabelText('关闭侧边聊天')[0]);
  await fireEvent.press(view.getByLabelText('标签页更多'));
  await fireEvent.press(view.getByLabelText('恢复关闭的标签'));
  expect(view.getByLabelText('临时侧边聊天输入').props.value).toBe('第一张侧边页');
});

test('demo uses ordered shared body and expandable execution rows without repeating artifacts on later replies', async () => {
  const view = await render(<RemoteDemoWorkspace agentName="Codex" />);
  expect(view.getByLabelText('模拟电脑已连接')).toBeTruthy();
  expect(view.getByText('示例数据 · Codex')).toBeTruthy();
  expect(view.queryByText('已检查 4 个文件')).toBeNull();
  expect(view.getByText('已在 9 秒 内运行 npm run test -- Login')).toBeTruthy();
  expect(view.getByText('界面检查 · 已完成')).toBeTruthy();
  expect(view.getByText('已查看图片')).toBeTruthy();
  expect(view.getAllByTestId('execution-timeline')).toHaveLength(2);
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expect(view.getByLabelText('撤销本组文件变更').props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('查看命令详情：npm run test -- Login'));
  const output = within(view.getByTestId('command-output-frame'));
  expect(output.getByText(/2 tests passed/)).toBeTruthy();
  expect(output.getByText('退出码 0')).toBeTruthy();
  expect(view.queryByLabelText('在大窗口查看命令：npm run test -- Login')).toBeNull();
  expect(view.queryByLabelText('关闭命令详情')).toBeNull();
  await fireEvent.press(view.getByLabelText('查看命令详情：npm run test -- Login'));
  expect(view.queryByTestId('command-output-frame')).toBeNull();
  await fireEvent.press(view.getByLabelText('界面检查：子任务详情'));
  await fireEvent.press(view.getByLabelText('打开子智能体对话 1'));
  expect(view.getByRole('tab', { name: '子智能体' }).props.accessibilityState.selected).toBe(true);
  const child = within(view.getByTestId('subagent-row:layout'));
  expect(child.getByLabelText('打开界面检查')).toBeTruthy();
  expect(child.getByText(/平板断点与表单可访问性检查已完成/)).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'), '再检查一下');
  await fireEvent.press(view.getByLabelText('发送编程消息'));
  expect(view.getAllByTestId('conversation-changes-card')).toHaveLength(1);
  expect(view.getAllByTestId('conversation-preview-card')).toHaveLength(1);
  expect(view.getAllByLabelText('查看命令详情：npm run test -- Login')).toHaveLength(1);
});

test('shared demo artifact actions use the sidebar and retain the Agent browser page identity', async () => {
  const view = await render(<RemoteDemoWorkspace />);
  expect(view.getByRole('tab', { name: '新标签页' }).props.accessibilityState.selected).toBe(true);
  expect(view.getByRole('tab', { name: 'example.com' }).props.accessibilityState.selected).toBe(false);
  await fireEvent.press(view.getByLabelText('查看修改文件 src/auth/login.css'));
  expect(view.getByRole('tab', { name: 'login.css' }).props.accessibilityState.selected).toBe(true);
  expect(view.getByText('示例变更')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看本组文件变更'));
  expect(view.getByRole('tab', { name: '审查' }).props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('打开网页预览 https://example.com/'));
  expect(view.getAllByRole('tab', { name: 'example.com' })).toHaveLength(1);
  expect(view.getByRole('tab', { name: 'example.com' }).props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('网页预览打开方式'));
  await fireEvent.press(view.getByText('在应用内打开'));
  expect(view.queryByTestId('preview-open-menu')).toBeNull();
  expect(view.getAllByRole('tab', { name: 'example.com' })).toHaveLength(1);
});

test('Work demo has its own document changes and checks', async () => {
  const view = await render(<RemoteDemoWorkspace workspaceMode="work" />);
  expect(view.getByLabelText('查看修改文件 release/checklist.md')).toBeTruthy();
  expect(view.queryByLabelText('查看修改文件 src/auth/login.css')).toBeNull();
  expect(view.getByLabelText('查看命令详情：npm run check:release')).toBeTruthy();
  expect(view.getByText('交付检查 · 已完成')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看本组文件变更'));
  expect(view.getByLabelText('审查文件 release/checklist.md')).toBeTruthy();
  const summary = within(view.getByLabelText('选择审查范围'));
  expect(summary.getByText('+2')).toBeTruthy();
  expect(summary.getByText('-2')).toBeTruthy();
});

test('changing the demo computer retires old drafts and open pages', async () => {
  const view = await render(<RemoteDemoWorkspace computerName="电脑 A" />);
  await fireEvent.changeText(view.getByLabelText('编程对话输入框'), '只属于 A');
  await view.rerender(<RemoteDemoWorkspace computerName="电脑 B" />);
  expect(view.getByLabelText('编程对话输入框').props.value).toBe('');
});

test('demo browser tabs retain each webpage and drafts when switching or folding the workspace', async () => {
  const view = await render(<RemoteDemoWorkspace />);
  await fireEvent.press(view.getByLabelText('添加工具标签'));
  await fireEvent.changeText(view.getByLabelText('新标签页地址或搜索'), 'https://a.example/');
  await fireEvent.press(view.getByLabelText('打开地址或搜索'));
  await fireEvent.changeText(view.getByLabelText('网页内容 https://a.example/'), 'A 页面表单');
  await fireEvent.changeText(view.getByLabelText('浏览器地址'), 'https://a.example/draft');
  await fireEvent.press(view.getByLabelText('添加工具标签'));
  await fireEvent.changeText(view.getByLabelText('新标签页地址或搜索'), 'https://b.example/');
  await fireEvent.press(view.getByLabelText('打开地址或搜索'));
  expect(view.getByRole('tab', { name: 'b.example' }).props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByRole('tab', { name: 'a.example' }));
  expect(view.getByLabelText('网页内容 https://a.example/').props.value).toBe('A 页面表单');
  expect(view.getByLabelText('浏览器地址').props.value).toBe('https://a.example/draft');
  await fireEvent.press(view.getByLabelText('隐藏右侧面板'));
  expect(view.queryByLabelText('浏览器地址')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开工作区面板'));
  expect(view.getByLabelText('网页内容 https://a.example/').props.value).toBe('A 页面表单');
  await fireEvent.press(view.getByLabelText('关闭a.example'));
  expect(view.getByRole('tab', { name: 'b.example' }).props.accessibilityState.selected).toBe(true);
});

test('demo restores browser history after closing the tab and keeps new terminal drafts separate',async()=>{
 const view=await render(<RemoteDemoWorkspace computerName="独立标签测试电脑"/>);
 await fireEvent.changeText(view.getByLabelText('新标签页地址或搜索'),'https://history.example/first');
 await fireEvent.press(view.getByLabelText('打开地址或搜索'));
 await fireEvent.changeText(view.getByLabelText('浏览器地址'),'https://history.example/second');
 await fireEvent.press(view.getByLabelText('打开网址'));
 await fireEvent.press(view.getByLabelText('关闭history.example/second'));
 await fireEvent.press(view.getByLabelText('标签页更多'));
 await fireEvent.press(view.getByLabelText('恢复关闭的标签'));
 await fireEvent.press(view.getByLabelText('网页后退'));
 expect(view.getByLabelText('浏览器地址').props.value).toBe('https://history.example/first');
 await fireEvent.press(view.getByLabelText('添加工具标签'));
 await fireEvent.press(view.getByLabelText('打开终端标签'));
 await fireEvent.changeText(view.getByLabelText('终端命令输入框'),'first draft');
 await fireEvent.press(view.getByLabelText('添加工具标签'));
 await fireEvent.press(view.getByLabelText('打开终端标签'));
 expect(view.getByLabelText('终端命令输入框').props.value).toBe('');
 await fireEvent.press(view.getAllByRole('tab',{name:'终端'})[0]);
 expect(view.getByLabelText('终端命令输入框').props.value).toBe('first draft');
 await view.unmount();
});

test('demo completed Agent browser events synchronize in the background and deduplicate pages', async () => {
  const first = { id: 'agent-open', status: 'done', browser: { action: 'open' as const, url: 'https://a.example/', pageId: 'desktop-tab-1' } };
  const view = await render(<RemoteDemoWorkspace toolActivities={[first]} />);
  expect(view.getByRole('tab', { name: '新标签页' }).props.accessibilityState.selected).toBe(true);
  expect(view.getByRole('tab', { name: 'a.example' }).props.accessibilityState.selected).toBe(false);
  await fireEvent.press(view.getByLabelText('隐藏右侧面板'));
  const second = { id: 'agent-open-2', status: 'done', browser: { action: 'open' as const, url: 'https://b.example/', pageId: 'desktop-tab-2' } };
  await view.rerender(<RemoteDemoWorkspace toolActivities={[first, second]} />);
  expect(view.queryByRole('tab', { name: 'b.example' })).toBeNull();
  expect(view.getByLabelText('打开工作区面板')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开工作区面板'));
  expect(view.getByRole('tab', { name: '新标签页' }).props.accessibilityState.selected).toBe(true);
  expect(view.getByRole('tab', { name: 'b.example' }).props.accessibilityState.selected).toBe(false);
  const navigate = { id: 'agent-nav', status: 'done', browser: { action: 'navigate' as const, url: 'https://a.example/next', pageId: 'desktop-tab-1' } };
  await view.rerender(<RemoteDemoWorkspace toolActivities={[first, second, navigate]} />);
  expect(view.getByRole('tab', { name: 'a.example/next' })).toBeTruthy();
  expect(view.queryByRole('tab', { name: 'a.example' })).toBeNull();
  await fireEvent.press(view.getByLabelText('关闭a.example/next'));
  await view.rerender(<RemoteDemoWorkspace toolActivities={[{ ...first }, { ...second }, { ...navigate }]} />);
  expect(view.queryByRole('tab', { name: 'a.example/next' })).toBeNull();
  expect(view.getAllByRole('tab', { name: 'b.example' })).toHaveLength(1);
  await view.rerender(<RemoteDemoWorkspace toolActivities={[first, second, navigate, { id: 'failed', status: 'failed', browser: { action: 'open', url: 'https://failed.example/' } }, { id: 'running', status: 'running', browser: { action: 'open', url: 'https://running.example/' } }, { id: 'invalid', status: 'done', browser: { action: 'open', url: 'javascript:alert(1)' } }]} />);
  expect(view.queryByRole('tab', { name: 'failed.example' })).toBeNull();
  expect(view.queryByRole('tab', { name: 'running.example' })).toBeNull();
});
