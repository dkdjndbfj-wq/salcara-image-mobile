import React from 'react';
import {act,fireEvent,render} from '@testing-library/react-native';
import {RemoteGitPage} from '../remote/RemoteGitPage';
import {createWorkspaceGit,type GitState} from '../remote/workspace-git';

jest.mock('../remote/store',()=>({}));
jest.mock('../remote/WorkspaceRuntimeContext',()=>({useWorkspaceRuntime:()=>null}));
const mockDialogActions = new Map<string, () => void>();
jest.mock('../components/ui', () => {
  const actual = jest.requireActual('../components/ui'), React = require('react');
  return { ...actual, AppDialog: (props: any) => {
    if (props.visible) for (const action of props.actions ?? []) if (action.onPress) mockDialogActions.set(action.label, action.onPress);
    return React.createElement(actual.AppDialog, props);
  } };
});

test('a partially staged file exposes both reviewed versions without changing the index',async()=>{
  const state:GitState={revision:'a'.repeat(64),head:'b'.repeat(40),branch:'main',upstream:'',branches:['main'],worktrees:[],githubCLI:false,files:[{path:'main.ts',index:'M',worktree:'M'}]};
  const send=jest.fn(async(_type:string,input:Record<string,string>)=>input.action==='status'?state:{path:input.path,revision:state.revision,diff:input.action==='staged-diff'?'+ staged version':'+ working version'});
  const view=await render(<RemoteGitPage active selection={{deviceId:'pc',agentId:'codex',sessionKey:'codex:one',surface:'cli',cwd:'/project'}} factory={()=>createWorkspaceGit(send,()=>{},()=>{})}/>);
  await fireEvent.press(view.getByLabelText('查看 Git 差异 main.ts'));
  expect(view.getByText('+ working version')).toBeTruthy();
  expect(view.getByText('未暂存 · 尚未加入下次提交')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看已暂存差异'));
  expect(view.getByText('+ staged version')).toBeTruthy();
  expect(view.getByText('已暂存 · 将包含在下次提交中')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看未暂存差异'));
  expect(view.getByText('+ working version')).toBeTruthy();
  expect(send.mock.calls.map(call=>call[1].action)).toEqual(['status','diff','staged-diff','diff']);
  expect(send.mock.calls.every(call=>call[0]==='workspace.git.read')).toBe(true);
  await view.unmount();
});

test('a project change retires its commit confirmation and cannot replay it into the new project', async () => {
  const state: GitState = { revision: 'a'.repeat(64), head: 'b'.repeat(40), branch: 'main', upstream: '', branches: ['main'], worktrees: [], githubCLI: false,
    files: [{ path: 'main.ts', index: 'M', worktree: ' ' }] };
  const send = jest.fn(async (_type: string, input: Record<string, string>) => input.action === 'status' ? state : { action: input.action, state });
  const selection = { deviceId: 'pc', agentId: 'codex', sessionKey: 'codex:one', surface: 'cli' as const, cwd: '/project' };
  const factory = () => createWorkspaceGit(send, () => {}, () => {});
  const view = await render(<RemoteGitPage active selection={selection} factory={factory} />);
  await fireEvent.changeText(view.getByLabelText('提交说明'), 'Original project commit');
  await fireEvent.press(view.getByLabelText('提交 1 个已暂存文件'));
  const oldConfirm = mockDialogActions.get('确认')!;
  await view.rerender(<RemoteGitPage active selection={{ ...selection, sessionKey: 'codex:two', cwd: '/other-project' }} factory={factory} />);
  expect(view.queryByText('提交暂存改动？')).toBeNull();
  expect(view.getByLabelText('提交说明').props.value).toBe('');
  await act(async () => { oldConfirm(); });
  expect(send.mock.calls.filter(call => call[0] === 'workspace.git.mutate')).toHaveLength(0);
  await fireEvent.changeText(view.getByLabelText('提交说明'), 'New project commit');
  await fireEvent.press(view.getByLabelText('提交 1 个已暂存文件'));
  await fireEvent.press(view.getByRole('button', { name: '确认' }));
  expect(send).toHaveBeenLastCalledWith('workspace.git.mutate', { action: 'commit', expectedRevision: state.revision, message: 'New project commit' });
  await view.unmount();
});
