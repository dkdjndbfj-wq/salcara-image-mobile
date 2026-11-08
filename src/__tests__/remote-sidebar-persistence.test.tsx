import {openWorkspaceTool} from './fixtures/workspace-navigation';
import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteSidebar } from '../remote/RemoteSidebar';
import type { AgentProfile } from '../remote/client';
import { resetWorkspaceLayoutMemoryForTests } from '../remote/workspace-layout';
import { readWorkspaceFileDraft, resetWorkspaceFileDraftMemoryForTests } from '../remote/workspace-file-drafts';

const mockDisk = new Map<string,string>();
jest.mock('../storage/database', () => ({ getSetting: async (key:string) => mockDisk.get(key) ?? null,
  setSetting: async (key:string,value:string|null) => { if(value===null) mockDisk.delete(key); else mockDisk.set(key,value); } }));

let mockRemote: any;
let mockDialogActions:Array<{label:string;onPress:()=>void}>=[];
const mockCaptureFiles = jest.fn(), mockTerminalMount = jest.fn(), mockTerminalUnmount = jest.fn();
jest.mock('../remote/workspace-files', () => ({ captureWorkspaceFiles: (...args: unknown[]) => mockCaptureFiles(...args) }));
jest.mock('../remote/store', () => ({ useRemote: () => mockRemote, remoteDeliveryScope: () => 'phone-generation-one', timelineKey: (device: string, key: string) => `${device}|${key}`,
  loadSessions: async () => {}, loadNativeSessions: async () => {}, hubSupportsSessionActions: () => false }));
jest.mock('../components/ui', () => {
  const React = require('react'), { View, Text, Pressable } = require('react-native');
  return { useReducedMotion: () => true, dismissKeyboardAndBlur: jest.fn(), showToast: jest.fn(), AppDialog: ({ visible, title, actions }: any) => {if(visible)mockDialogActions=actions;return visible ? React.createElement(View, null,
    React.createElement(Text, null, title), ...actions.map((action: any) => React.createElement(Pressable, { key: action.label, accessibilityLabel: action.label, onPress: action.onPress }, React.createElement(Text, null, action.label)))) : null;} };
});
jest.mock('../remote/RemoteTerminalPage', () => {
  const React = require('react'), { Text } = require('react-native');
  return { RemoteTerminalPage: (props: any) => { React.useEffect(() => { mockTerminalMount(props); return () => mockTerminalUnmount(props); }, []);
    return React.createElement(Text, { testID: 'persistent-terminal' }, props.sessionKey); } };
});
jest.mock('../remote/RemoteBrowserPage', () => ({ RemoteBrowserPage: () => null }));
const agent: AgentProfile = { id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
  api: { name: 'fixture', model: '', protocol: 'responses', configured: true, pending: false, source: 'computer' } };
const props = { visible: true, docked: true, mode: 'tools' as const, deviceId: 'pc', agent, activeSessionKey: 'codex:session', controlSurface: 'cli' as const, onClose: jest.fn(), onOpenSession: jest.fn() };
beforeEach(() => {
  mockDisk.clear(); resetWorkspaceLayoutMemoryForTests(); resetWorkspaceFileDraftMemoryForTests();
  jest.clearAllMocks(); Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockRemote = { connection: 'open', connectionId: 'paired', selectedHubUrl: 'https://relay.example',
    devices: [{ deviceId: 'pc', name: 'Computer', online: true, capabilities: ['workspace.files.v1', 'workspace.files.write.v1', 'workspace.terminal.v1'] }],
    sessions: { pc: { loaded: true, pages: { codex: {} }, list: [{ sessionKey: 'codex:session', tool: 'codex', client: 'Codex', title: 'Task', cwd: '/project', controlSurface: 'cli', status: 'idle', updatedAt: 1 }] } }, timelines: {} };
  mockCaptureFiles.mockImplementation(() => ({ cwd:'/project',writable: true,
    list: jest.fn(async () => ({ path: '', entries: [{ name: 'main.ts', path: 'main.ts', kind: 'file' }], truncated: false })),
    read: jest.fn(async (path: string) => ({ path, text: 'original content', size: 16, modifiedAt: 1, revision: 'a'.repeat(64) })), write: jest.fn(), dispose: jest.fn() }));
});

test('initial tool tabs create no file reads or terminals before an explicit open', async () => {
  const view = await render(<RemoteSidebar {...props} />);
  expect(mockCaptureFiles).not.toHaveBeenCalled(); expect(mockTerminalMount).not.toHaveBeenCalled();
  await openWorkspaceTool(view, '工具栏文件');
  expect(mockCaptureFiles).toHaveBeenCalledTimes(1); expect(view.getByLabelText('打开文件 main.ts')).toBeTruthy();
  await view.unmount();
});

test('terminal survives background tabs and collapsed sidebar, but closes when its tab is removed', async () => {
  const view = await render(<RemoteSidebar {...props} />);
  await fireEvent.press(view.getByLabelText('添加工具标签')); await fireEvent.press(view.getByLabelText('打开终端标签'));
  expect(mockTerminalMount).toHaveBeenCalledTimes(1);
  await openWorkspaceTool(view, '工具栏改动'); expect(mockTerminalUnmount).not.toHaveBeenCalled();
  await view.rerender(<RemoteSidebar {...props} visible={false} />); expect(mockTerminalUnmount).not.toHaveBeenCalled();
  await view.rerender(<RemoteSidebar {...props} />); await fireEvent.press(view.getByRole('tab', { name: '终端' }));
  expect(mockTerminalMount).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('关闭标签 终端')); expect(mockTerminalUnmount).toHaveBeenCalledTimes(1);
  await view.unmount();
});

test('multiple terminals have independent lifetimes and switching computer retires both', async () => {
  const view = await render(<RemoteSidebar {...props} />);
  for (let i = 0; i < 2; i++) { await fireEvent.press(view.getByLabelText('添加工具标签')); await fireEvent.press(view.getByLabelText('打开终端标签')); }
  expect(mockTerminalMount).toHaveBeenCalledTimes(2);
  await view.rerender(<RemoteSidebar {...props} deviceId="other-computer" />);
  expect(mockTerminalUnmount).toHaveBeenCalledTimes(2); expect(mockTerminalMount).toHaveBeenCalledTimes(2);
  await view.unmount();
});

test('file drafts survive tab switching and require an explicit discard when closing', async () => {
  const view = await render(<RemoteSidebar {...props} />);
  await openWorkspaceTool(view, '工具栏文件'); await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  await fireEvent.press(view.getByLabelText('文件更多'));await fireEvent.press(view.getByLabelText('在新标签页打开文件'));
  await fireEvent.press(view.getByLabelText('编辑文件')); await fireEvent.changeText(view.getByLabelText('文件内容编辑器'), 'unsaved draft');
  await openWorkspaceTool(view, '工具栏改动'); await fireEvent.press(view.getByRole('tab', { name: '工具栏文件 main.ts' }));
  expect(view.getByLabelText('文件内容编辑器').props.value).toBe('unsaved draft');
  await fireEvent.press(view.getByLabelText('关闭标签 main.ts'));
  expect(view.getByText('关闭未保存的文件？')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('保留草稿')); expect(view.getByLabelText('文件内容编辑器').props.value).toBe('unsaved draft');
  await fireEvent.press(view.getByLabelText('关闭标签 main.ts')); await fireEvent.press(view.getByLabelText('丢弃并关闭'));
  expect(view.queryByRole('tab', { name: '工具栏文件 main.ts' })).toBeNull();
  await view.unmount();
});

test('missing terminal capability shows a clear unavailable state without creating a shell', async () => {
  mockRemote.devices[0].capabilities = ['workspace.files.v1'];
  const view = await render(<RemoteSidebar {...props} />);
  await fireEvent.press(view.getByLabelText('添加工具标签')); await fireEvent.press(view.getByLabelText('打开终端标签'));
  expect(mockTerminalMount).not.toHaveBeenCalled(); expect(view.getByText('当前电脑尚未开放交互终端，请更新电脑端并授权项目。')).toBeTruthy();
  await act(async () => {}); await view.unmount();
});

test('discarding a file-browser preview tab deletes its actual persisted draft',async()=>{
  const view=await render(<RemoteSidebar {...props}/>);
  await openWorkspaceTool(view,'工具栏文件');await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  await fireEvent.press(view.getByLabelText('编辑文件'));await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'browser preview draft');
  const identity={scope:'phone-generation-one',deviceId:'pc',agentId:'codex',sessionKey:'codex:session',surface:'cli' as const,cwd:'/project',path:'main.ts'};
  expect(readWorkspaceFileDraft(identity)?.text).toBe('browser preview draft');
  await fireEvent.press(view.getByLabelText('关闭标签 文件'));expect(view.getByText('关闭未保存的文件？')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('丢弃并关闭'));expect(readWorkspaceFileDraft(identity)).toBeUndefined();
  await openWorkspaceTool(view,'工具栏文件');await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  expect(view.queryByLabelText('文件内容编辑器')).toBeNull();expect(view.getByText('original content')).toBeTruthy();
  await view.unmount();
});

test('an old browser-preview discard callback cannot delete a draft after the computer source changes',async()=>{
  const view=await render(<RemoteSidebar {...props}/>);
  await openWorkspaceTool(view,'工具栏文件');await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  await fireEvent.press(view.getByLabelText('编辑文件'));await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'old computer draft');
  await fireEvent.press(view.getByLabelText('关闭标签 文件'));
  const staleDiscard=mockDialogActions.find(action=>action.label==='丢弃并关闭')!.onPress;
  await view.rerender(<RemoteSidebar {...props} deviceId="other-computer"/>);
  await act(async()=>staleDiscard());
  expect(readWorkspaceFileDraft({scope:'phone-generation-one',deviceId:'pc',agentId:'codex',sessionKey:'codex:session',surface:'cli',cwd:'/project',path:'main.ts'})?.text).toBe('old computer draft');
  await view.unmount();
});

test('discarding an older hidden preview preserves the newer draft owned by an independent file tab',async()=>{
  const view=await render(<RemoteSidebar {...props}/>);
  await openWorkspaceTool(view,'工具栏文件');await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  await fireEvent.press(view.getByLabelText('编辑文件'));await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'older preview draft');
  await fireEvent.press(view.getByLabelText('文件更多'));await fireEvent.press(view.getByLabelText('在新标签页打开文件'));
  await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'newer independent draft');
  await fireEvent.press(view.getByLabelText('关闭标签 文件'));await fireEvent.press(view.getByLabelText('丢弃并关闭'));
  const identity={scope:'phone-generation-one',deviceId:'pc',agentId:'codex',sessionKey:'codex:session',surface:'cli' as const,cwd:'/project',path:'main.ts'};
  expect(readWorkspaceFileDraft(identity)?.text).toBe('newer independent draft');
  expect(view.getByLabelText('文件内容编辑器').props.value).toBe('newer independent draft');
  await fireEvent.press(view.getByLabelText('关闭标签 main.ts'));await fireEvent.press(view.getByLabelText('丢弃并关闭'));
  expect(readWorkspaceFileDraft(identity)).toBeUndefined();
  await view.unmount();
});

test('returning from a preview and discarding the shared draft cannot revive it in a hidden file tab',async()=>{
  const view=await render(<RemoteSidebar {...props}/>);
  await openWorkspaceTool(view,'工具栏文件');await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  await fireEvent.press(view.getByLabelText('编辑文件'));await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'draft A');
  await fireEvent.press(view.getByLabelText('文件更多'));await fireEvent.press(view.getByLabelText('在新标签页打开文件'));
  await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'draft B');
  await fireEvent.press(view.getByRole('tab',{name:'工具栏文件'}));
  expect(view.getByLabelText('文件内容编辑器').props.value).toBe('draft B');
  await fireEvent.press(view.getByLabelText('返回文件目录'));await fireEvent.press(view.getByText('放弃修改'));
  await fireEvent.press(view.getByRole('tab',{name:'工具栏文件 main.ts'}));
  expect(view.queryByLabelText('文件内容编辑器')).toBeNull();expect(view.getByText('original content')).toBeTruthy();
  await view.unmount();
});

test('saving from another file tab retires an older hidden in-memory draft without a false conflict',async()=>{
  let current={path:'main.ts',text:'original content',size:16,modifiedAt:1,revision:'a'.repeat(64)};
  mockCaptureFiles.mockImplementation(()=>({cwd:'/project',writable:true,list:jest.fn(async()=>({path:'',entries:[{name:'main.ts',path:'main.ts',kind:'file'}],truncated:false})),read:jest.fn(async()=>current),write:jest.fn(async(_path:string,text:string)=>{current={...current,text,size:text.length,revision:'b'.repeat(64)};return current;}),dispose:jest.fn()}));
  const view=await render(<RemoteSidebar {...props}/>);
  await openWorkspaceTool(view,'工具栏文件');await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  await fireEvent.press(view.getByLabelText('编辑文件'));await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'older hidden draft');
  await fireEvent.press(view.getByLabelText('文件更多'));await fireEvent.press(view.getByLabelText('在新标签页打开文件'));
  await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'saved current content');await fireEvent.press(view.getByLabelText('保存到电脑'));
  await fireEvent.press(view.getByRole('tab',{name:'工具栏文件'}));
  expect(view.queryByLabelText('文件内容编辑器')).toBeNull();expect(view.getByText('saved current content')).toBeTruthy();
  expect(view.queryByLabelText('合并最新文件版本')).toBeNull();
  await fireEvent.press(view.getByLabelText('关闭标签 文件'));expect(view.queryByText('关闭未保存的文件？')).toBeNull();
  await view.unmount();
});

test('computer use opens a background tab without taking focus and closing it never stops work',async()=>{
  const onStop=jest.fn();
  const activity={kind:'tool' as const,id:'computer-step',turnId:'live-turn',tool:'mcp' as const,title:'actual computer action',status:'running' as const,ts:10,computer:{version:1 as const,surface:'computer' as const,action:'script' as const,provider:'cua_repl'}};
  mockRemote.sessions.pc.list[0].status='running';
  mockRemote.sessions.pc.list[0].activeTurnId='live-turn';
  const view=await render(<RemoteSidebar {...props} toolActivities={[activity]} onComputerUseStop={onStop}/>);
  expect(view.getByRole('tab',{name:'新标签页'})).toBeSelected();
  expect(view.getByRole('tab',{name:'电脑操作'})).not.toBeSelected();
  await fireEvent.press(view.getByRole('tab',{name:'电脑操作'}));expect(view.getByText('AI 正在操作')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭标签 电脑操作'));expect(onStop).not.toHaveBeenCalled();
  await view.rerender(<RemoteSidebar {...props} toolActivities={[activity]} onComputerUseStop={onStop}/>);
  expect(view.queryByRole('tab',{name:'电脑操作'})).toBeNull();
  await view.rerender(<RemoteSidebar {...props} toolActivities={[activity,{...activity,id:'next-step'}]} onComputerUseStop={onStop}/>);
  expect(view.getByRole('tab',{name:'电脑操作'})).not.toBeSelected();
  await fireEvent.press(view.getByRole('tab',{name:'电脑操作'}));await fireEvent.press(view.getByLabelText('停止AI当前回合'));
  expect(onStop).toHaveBeenCalledTimes(1);await view.unmount();
});

test('old or cached computer calls cannot reopen a background tab during another turn',async()=>{
 const activity={kind:'tool' as const,id:'old-call',turnId:'old-turn',tool:'mcp' as const,title:'old computer action',status:'running' as const,ts:10,computer:{version:1 as const,surface:'computer' as const,action:'script' as const,provider:'cua_repl'}};
 const session={...mockRemote.sessions.pc.list[0],status:'running',activeTurnId:'new-turn'};
 mockRemote.timelines['pc|codex:session']={session,items:[],loading:false,cachedAt:100};
 const view=await render(<RemoteSidebar {...props} toolActivities={[activity]}/>);
 expect(view.queryByRole('tab',{name:'电脑操作'})).toBeNull();
 mockRemote.timelines['pc|codex:session']={session,items:[],loading:false};
 await view.rerender(<RemoteSidebar {...props} toolActivities={[activity]}/>);
 expect(view.queryByRole('tab',{name:'电脑操作'})).toBeNull();
 await view.rerender(<RemoteSidebar {...props} toolActivities={[activity,{...activity,id:'new-call',turnId:'new-turn'}]}/>);
 expect(view.getByRole('tab',{name:'电脑操作'})).not.toBeSelected();await view.unmount();
});
