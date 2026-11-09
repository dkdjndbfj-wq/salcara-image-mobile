import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { AgentProfile, SessionInfo, WorkspaceMode } from '../remote/client';
import { DirectProjectDirectory } from '../remote/DirectProjectDirectory';

// Keep the original JS callback available for source-switch race coverage.
jest.mock('react-native', () => {
  const React = require('react'), actual = jest.requireActual('react-native'), replacement = Object.create(actual);
  Object.defineProperty(replacement, 'Pressable', { enumerable: true, value: ({ children, style, ...props }: Record<string, any>) =>
    React.createElement(actual.View, { ...props, accessible: true, style: typeof style === 'function' ? style({ pressed: false }) : style }, children) });
  return replacement;
});

const agent: AgentProfile = { id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
  api: { name: 'API', model: 'model', protocol: 'responses', configured: true, pending: false, source: 'computer' } };
function session(id: string, cwd: string, workspaceMode: WorkspaceMode = 'code', updatedAt = 1): SessionInfo {
  return { sessionKey: `codex:${id}`, title: id, cwd, workspaceMode, updatedAt, tool: 'codex', client: 'Codex CLI', status: 'idle', controllable: true, controlSurface: 'cli' };
}
const rows = [session('first', '/projects/alpha', 'code', 3), session('second', '/projects/alpha', 'code', 2), session('third', '/projects/beta')];

test('opening and closing a project never selects its first conversation; only a conversation click opens it', async () => {
  const open = jest.fn();
  const view = await render(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={rows} onOpen={open}/>);
  expect(view.getByRole('button', { name: '折叠 alpha 对话' }).props.accessibilityState.expanded).toBe(true);
  expect(view.getByRole('button', { name: '打开对话 first' })).toBeTruthy();
  expect(view.getByRole('button', { name: '打开对话 second' })).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: '折叠 alpha 对话' }));
  expect(view.queryByRole('button', { name: '打开对话 first' })).toBeNull();
  expect(view.getByRole('button', { name: '打开对话 third' })).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: '展开 alpha 对话' }));
  expect(open).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: '打开对话 second' }));
  expect(open).toHaveBeenCalledWith(rows[1]); expect(open).toHaveBeenCalledTimes(1);
});

test('Work has the same project tree while agent, mode and archived records remain isolated', async () => {
  const open = jest.fn(), mixed = [...rows, session('work-one', '/work/notes', 'work'), session('work-two', '/work/notes', 'work'),
    { ...session('different-agent', '/projects/other'), tool: 'claude', sessionKey: 'claude:different-agent', client: 'Claude Code' },
    { ...session('archived', '/projects/archive'), archived: true }];
  const view = await render(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={mixed} onOpen={open}/>);
  expect(view.queryByText('work-one')).toBeNull(); expect(view.queryByText('different-agent')).toBeNull(); expect(view.queryByText('archived')).toBeNull();
  await view.rerender(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="work" sessions={mixed} onOpen={open}/>);
  expect(view.getByRole('button', { name: '折叠 notes 对话' })).toBeTruthy();
  expect(view.getByText('work-one')).toBeTruthy(); expect(view.getByText('work-two')).toBeTruthy(); expect(view.queryByText('first')).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

test('a computer switch resets folders and invalidates stale session handlers, including a return to the first computer', async () => {
  const open = jest.fn();
  const view = await render(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={rows} onOpen={open}/>);
  const stale = view.getByRole('button', { name: '打开对话 first' }).props.onPress;
  await fireEvent.press(view.getByRole('button', { name: '折叠 alpha 对话' }));
  await view.rerender(<DirectProjectDirectory scopeKey="computer-b" agent={agent} workspaceMode="code" sessions={[session('b-only', '/projects/alpha')]} onOpen={open}/>);
  expect(view.getByRole('button', { name: '折叠 alpha 对话' })).toBeTruthy(); expect(view.queryByText('first')).toBeNull();
  await act(async () => stale()); expect(open).not.toHaveBeenCalled();
  await view.rerender(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={rows} onOpen={open}/>);
  expect(view.getByRole('button', { name: '打开对话 first' })).toBeTruthy();
});

test('pagination preserves the current folder state and adds actual sessions without fabricating projects', async () => {
  const open = jest.fn();
  const view = await render(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={rows} onOpen={open}/>);
  await fireEvent.press(view.getByRole('button', { name: '折叠 alpha 对话' }));
  await view.rerender(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={[...rows, session('older', '/projects/alpha')]} onOpen={open}/>);
  expect(view.getByRole('button', { name: '展开 alpha 对话' })).toBeTruthy(); expect(view.queryByText('older')).toBeNull();
  await fireEvent.press(view.getByRole('button', { name: '展开 alpha 对话' })); expect(view.getByText('older')).toBeTruthy();
  await view.rerender(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={[]} onOpen={open}/>);
  expect(view.queryAllByRole('button')).toHaveLength(0); expect(open).not.toHaveBeenCalled();
});

test('same-named projects show their actual paths and Windows path casing is normalized', async () => {
  const actual = [session('one', 'C:\\Work\\App', 'code', 3), session('two', 'c:\\work\\app\\', 'code', 2), session('three', 'D:\\Other\\App')];
  const view = await render(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={actual} onOpen={jest.fn()}/>);
  expect(view.getAllByRole('button', { name: '折叠 App 对话' })).toHaveLength(2);
  expect(view.getByText('C:\\Work\\App')).toBeTruthy(); expect(view.getByText('D:\\Other\\App')).toBeTruthy();
  expect(view.getByText('two')).toBeTruthy();
});

test('disabled directory entries do not open conversations while a source is loading', async () => {
  const open = jest.fn();
  const view = await render(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode="code" sessions={rows} onOpen={open} disabled/>);
  await fireEvent.press(view.getByRole('button', { name: '打开对话 first' }));
  await fireEvent.press(view.getByRole('button', { name: '折叠 alpha 对话' }));
  expect(view.getByRole('button', { name: '打开对话 first' })).toBeTruthy(); expect(open).not.toHaveBeenCalled();
});

test.each(['code', 'work'] as const)('%s lists only parent conversations and does not expose a separate child directory', async workspaceMode => {
  const parent = session('parent', '/project/main', workspaceMode);
  const child = { ...session('child', '/project/child-only', workspaceMode), parentSessionKey: parent.sessionKey };
  const view = await render(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode={workspaceMode} sessions={[parent, child]} onOpen={jest.fn()}/>);
  expect(view.getByRole('button', { name: '打开对话 parent' })).toBeTruthy();
  expect(view.queryByText('child')).toBeNull(); expect(view.queryByText('child-only')).toBeNull();
  expect(view.queryByLabelText('子智能体')).toBeNull();
});

test.each(['code', 'work'] as const)('%s keeps child activity on the parent row and clears it after completion', async workspaceMode => {
  const parent = session('parent', '/project/main', workspaceMode);
  const child = { ...session('child', '/project/child-only', workspaceMode), parentSessionKey: parent.sessionKey, status: 'running' as const };
  const open = jest.fn();
  const view = await render(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode={workspaceMode} sessions={[parent, child]} onOpen={open}/>);
  expect(view.getByRole('progressbar', { name: 'parent及其子任务运行中' })).toBeTruthy();
  expect(view.queryByText('child')).toBeNull();
  await fireEvent.press(view.getByRole('button', { name: '打开对话 parent' }));
  expect(open).toHaveBeenCalledWith(parent);
  await view.rerender(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode={workspaceMode} sessions={[parent, { ...child, status: 'waiting_approval' }]} onOpen={open}/>);
  expect(view.queryByRole('progressbar')).toBeNull(); expect(view.getByLabelText('parent及其子任务待回复')).toBeTruthy();
  await view.rerender(<DirectProjectDirectory scopeKey="computer-a" agent={agent} workspaceMode={workspaceMode} sessions={[parent, { ...child, status: 'idle' }]} onOpen={open}/>);
  expect(view.queryByRole('progressbar')).toBeNull(); expect(view.queryByText('待回复')).toBeNull();
});
test('new project conversation keeps the exact path and rejects handlers from a previous visit', async () => {
  const onNew=jest.fn(),open=jest.fn();
  const sessions=[session('one','C:/one/shop'),session('two','D:/two/shop')];
  const p={scopeKey:'computer-a',agent,workspaceMode:'code' as const,sessions,onOpen:open,onNew};
  const view=await render(<DirectProjectDirectory {...p}/>);
  const buttons=view.getAllByRole('button',{name:'在 shop 中新建 Code 对话'});
  const stale=buttons[0].props.onPress;
  await fireEvent.press(buttons[1]);expect(onNew).toHaveBeenCalledWith('D:/two/shop');onNew.mockClear();
  await view.rerender(<DirectProjectDirectory {...p} scopeKey="computer-b"/>);
  await view.rerender(<DirectProjectDirectory {...p}/>);
  await act(async()=>stale());expect(onNew).not.toHaveBeenCalled();expect(open).not.toHaveBeenCalled();
  await view.unmount();
});


test('projectless sessions share a readable group without exposing managed directory names',()=>{
 const {groupSessionsByProject}=require('../remote/projection');
 const groups=groupSessionsByProject([{sessionKey:'codex:a',cwd:'C:/managed/a',projectless:true,updatedAt:1},{sessionKey:'codex:b',cwd:'C:/managed/b',projectless:true,updatedAt:2},{sessionKey:'codex:c',cwd:'C:/real',updatedAt:3}]);
 const standalone=groups.find((group:any)=>group.projectless);expect(standalone).toMatchObject({name:'不关联文件夹',path:'',projectless:true});expect(standalone.sessions).toHaveLength(2);
});
