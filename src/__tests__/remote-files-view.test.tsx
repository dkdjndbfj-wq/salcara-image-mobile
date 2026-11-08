import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { RemoteFiles } from '../remote/RemoteFiles';
import { RemoteSidebar } from '../remote/RemoteSidebar';
import type { AgentProfile } from '../remote/client';
import { discardWorkspaceFileDraftsForScope, readWorkspaceFileDraft } from '../remote/workspace-file-drafts';

const mockCapture = jest.fn();
jest.mock('../storage/database', () => ({ getSetting: jest.fn(async () => null), setSetting: jest.fn(async () => undefined) }));
jest.mock('../remote/workspace-files', () => ({ captureWorkspaceFiles: (...args: unknown[]) => mockCapture(...args) }));
const mockState: any = { connection: 'open', connectionId: 'paired', selectedHubUrl: 'https://hub.example.com', devices: [], sessions: {}, timelines: {} };
let mockDraftScope = 'scope-fixture';
jest.mock('../remote/store', () => ({ useRemote: () => mockState, remoteDeliveryScope: () => mockDraftScope, timelineKey: (d: string, s: string) => `${d}|${s}`, loadSessions: async () => undefined, loadNativeSessions: async () => undefined }));
jest.mock('../components/ui', () => ({ useReducedMotion: () => true }));
const agent: AgentProfile = { id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true,
  api: { name: 'fixture', model: '', protocol: 'responses', configured: true, pending: false, source: 'computer' } };
const session = { sessionKey: 'codex:parent', tool: 'codex', title: '主对话', client: 'Codex', cwd: '/fixture', updatedAt: 1, status: 'idle', controllable: true, controlSurface: 'cli' };
const targetScope = { expectedCwd: '/fixture', sessionKey: 'codex:parent', surface: 'cli' as const };
const page = (path = '', nextCursor?: string) => ({ path, entries: [{ name: 'main.ts', path: path ? `${path}/main.ts` : 'main.ts', kind: 'file', size: 5 }], ...(nextCursor ? { nextCursor } : {}), truncated: false });
const file = (path: string, text = 'const value = 1;') => ({ path, text, size: text.length, modifiedAt: 1 });
let mockBackground: (state: string) => void;
beforeEach(() => {
  jest.clearAllMocks();
  mockDraftScope = 'scope-fixture'; discardWorkspaceFileDraftsForScope('scope-fixture'); discardWorkspaceFileDraftsForScope('new-identity');
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockState.devices = [{ deviceId: 'pc', name: 'fixture', online: true, capabilities: ['workspace.files.v1'] }];
  mockState.sessions = { pc: { loaded: true, list: [session] } }; mockState.timelines = {};
  mockCapture.mockImplementation(() => ({ list: jest.fn(async (path: string) => page(path)), read: jest.fn(async (path: string) => file(path)), dispose: jest.fn() }));
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback: any) => { mockBackground = callback; return { remove: jest.fn() }; });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('rename/delete respect drafts in other tabs before issuing computer mutations',async()=>{
 const remove=jest.fn(),rename=jest.fn();mockCapture.mockImplementation(()=>({read:jest.fn(async(path:string)=>({...file(path),revision:'a'.repeat(64)})),list:jest.fn(async()=>page()),manageable:true,writable:true,remove,rename,dispose:jest.fn()}));
 const view=await render(<RemoteFiles deviceId="pc" sessionKey="codex:parent" agentId="codex" surface="cli" target={{...targetScope,path:'main.ts',nonce:1}} canMutatePath={()=>false}/>);
 await fireEvent.press(view.getByLabelText('删除文件'));await fireEvent.press(view.getByLabelText('确认文件操作'));expect(remove).not.toHaveBeenCalled();expect(view.getByText('此文件有未保存草稿，请先保存或丢弃')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('取消文件操作'));await fireEvent.press(view.getByLabelText('重命名文件'));await fireEvent.changeText(view.getByLabelText('文件名'),'next.ts');await fireEvent.press(view.getByLabelText('确认文件操作'));expect(rename).not.toHaveBeenCalled();
});

test('opening a conversation drawer does not read project files until its file tab is chosen', async () => {
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} controlSurface="cli" activeSessionKey="codex:parent" onClose={jest.fn()} onOpenSession={jest.fn()} />);
  expect(mockCapture).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('侧边栏文件')); expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText('打开文件 main.ts')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('侧边栏对话')); expect(view.queryByTestId('remote-files')).toBeNull(); expect(mockCapture.mock.results[0].value.dispose).toHaveBeenCalled();
});

test('legacy capabilities and Claude readonly history do not expose a file control', async () => {
  mockState.devices[0].capabilities = [];
  const props = { visible: true, deviceId: 'pc', agent, activeSessionKey: 'codex:parent', onClose: jest.fn(), onOpenSession: jest.fn() };
  const view = await render(<RemoteSidebar {...props} />); expect(view.queryByLabelText('侧边栏文件')).toBeNull(); expect(mockCapture).not.toHaveBeenCalled();
  mockState.devices[0].capabilities = ['workspace.files.v1'];
  await view.rerender(<RemoteSidebar {...props} controlSurface="read-only" />); expect(view.queryByLabelText('侧边栏文件')).toBeNull();
});

test('a file hyperlink opens one exact read without scanning the directory and refresh preserves the selected file', async () => {
  const view = await render(<RemoteFiles deviceId="pc" sessionKey="codex:parent" agentId="codex" surface="cli" target={{ ...targetScope, path: 'src/main.ts', line: 1, nonce: 1 }} />);
  const reader = mockCapture.mock.results[0].value;
  expect(mockCapture).toHaveBeenCalledWith({ deviceId: 'pc', sessionKey: 'codex:parent', agentId: 'codex', surface: 'cli', expectedCwd: '/fixture', expectedSessionKey: 'codex:parent', expectedSurface: 'cli' }, expect.any(Function));
  expect(reader.list).not.toHaveBeenCalled(); expect(reader.read).toHaveBeenCalledWith('src/main.ts'); expect(view.getByText('const value = 1;')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('文件更多'));
  await fireEvent.press(view.getByLabelText('刷新文件'));
  const next = mockCapture.mock.results[1].value; expect(reader.dispose).toHaveBeenCalled(); expect(next.read).toHaveBeenCalledWith('src/main.ts'); expect(next.list).not.toHaveBeenCalled();
});

test('manual pagination merges names once and does not prefetch the next directory page', async () => {
  const list = jest.fn().mockResolvedValueOnce(page('', 'next')).mockResolvedValueOnce({ path: '', entries: [...page().entries, { name: 'second.ts', path: 'second.ts', kind: 'file', size: 2 }], truncated: false });
  mockCapture.mockImplementation(() => ({ list, read: jest.fn(), dispose: jest.fn() }));
  const view = await render(<RemoteFiles deviceId="pc" sessionKey="codex:parent" agentId="codex" surface="cli" />);
  expect(list).toHaveBeenCalledTimes(1); await fireEvent.press(view.getByLabelText('更多文件'));
  expect(list).toHaveBeenLastCalledWith('', 'next'); expect(view.getAllByLabelText('打开文件 main.ts')).toHaveLength(1); expect(view.getByLabelText('打开文件 second.ts')).toBeTruthy();
});

test('a late read from the previous file target cannot replace the new target', async () => {
  let finish!: (value: unknown) => void;
  mockCapture.mockImplementationOnce(() => ({ read: jest.fn(() => new Promise(resolve => { finish = resolve; })), list: jest.fn(), dispose: jest.fn() }));
  const props = { deviceId: 'pc', sessionKey: 'codex:parent', agentId: 'codex' as const, surface: 'cli' as const };
  const view = await render(<RemoteFiles {...props} target={{ ...targetScope, path: 'old.ts', nonce: 1 }} />);
  await view.rerender(<RemoteFiles {...props} target={{ ...targetScope, path: 'new.ts', nonce: 2 }} />);
  await act(async () => finish(file('old.ts', 'private old buffer')));
  expect(view.queryByText('private old buffer')).toBeNull(); expect(view.getByText('new.ts')).toBeTruthy(); expect(view.getByText('const value = 1;')).toBeTruthy();
});

test('backgrounding clears the text and disposes the reader; foreground does not silently resume a read', async () => {
  const view = await render(<RemoteFiles deviceId="pc" sessionKey="codex:parent" agentId="codex" surface="cli" target={{ ...targetScope, path: 'main.ts', nonce: 1 }} />);
  const reader = mockCapture.mock.results[0].value; expect(view.getByText('const value = 1;')).toBeTruthy();
  await act(async () => mockBackground('background'));
  expect(view.queryByText('const value = 1;')).toBeNull(); expect(reader.dispose).toHaveBeenCalled();
  await act(async () => mockBackground('active')); expect(mockCapture).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('重试文件读取')); expect(mockCapture).toHaveBeenCalledTimes(2);
});

test('native file views disappear when the exact lease expires, without CLI fallback', async () => {
  jest.useFakeTimers();
  const live = { ...agent, desktopLive: { expiresAt: Date.now() + 100, sessionKeys: ['codex:parent'], capabilities: { list: true, read: true, send: false, interrupt: false, approval: false, attachments: false, modelOverride: false } } };
  mockState.sessions.pc.native = { loaded: true, list: [{ ...session, controlSurface: 'desktop' }] };
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={live} controlSurface="desktop" activeSessionKey="codex:parent" fileTarget={{ ...targetScope, surface: 'desktop', path: 'main.ts', nonce: 1 }} onClose={jest.fn()} onOpenSession={jest.fn()} />);
  expect(view.getByTestId('remote-files')).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(110));
  expect(view.queryByTestId('remote-files')).toBeNull(); expect(view.queryByLabelText('侧边栏文件')).toBeNull(); expect(mockCapture.mock.results[0].value.dispose).toHaveBeenCalled();
});

test('a referenced Codex task absent from the latest directory appears neutrally, without gaining native read permission', async () => {
  const open = jest.fn();
  const view = await render(<RemoteSidebar visible deviceId="pc" agent={agent} controlSurface="cli" activeSessionKey="codex:parent" focusSessionKey="codex:older" onClose={jest.fn()} onOpenSession={open} />);
  await fireEvent.press(view.getByRole('button', { name: '关联任务' })); expect(open).toHaveBeenCalledWith('codex:older'); expect(mockCapture).not.toHaveBeenCalled();
});

test('editing saves the complete draft with its original revision and reports only the confirmed save', async () => {
  const initial = { ...file('main.ts', 'first\n'), revision: 'a'.repeat(64) };
  const write = jest.fn(async (_path: string, text: string) => ({ ...initial, text, revision: 'b'.repeat(64) }));
  mockCapture.mockImplementation(() => ({ writable: true, read: jest.fn(async () => initial), write, dispose: jest.fn() }));
  const onSaved = jest.fn(), onDirtyChange = jest.fn();
  const view = await render(<RemoteFiles deviceId="pc" sessionKey="codex:parent" agentId="codex" surface="cli" target={{ ...targetScope, path: 'main.ts', nonce: 1 }} onSaved={onSaved} onDirtyChange={onDirtyChange} />);
  await fireEvent.press(view.getByLabelText('编辑文件'));
  await fireEvent.changeText(view.getByLabelText('文件内容编辑器'), 'second\n');
  expect(onDirtyChange).toHaveBeenLastCalledWith(true,{path:'main.ts',cwd:'/fixture'});
  await fireEvent.press(view.getByLabelText('保存到电脑'));
  expect(write).toHaveBeenCalledWith('main.ts', 'second\n', initial.revision);
  expect(view.getByText('已保存到电脑')).toBeTruthy(); expect(onSaved).toHaveBeenCalledWith({ before: initial, after: { ...initial, text: 'second\n', revision: 'b'.repeat(64) } });
  expect(onDirtyChange).toHaveBeenLastCalledWith(false,{path:'main.ts',cwd:'/fixture'});
});

test('a conflict preserves the draft, shows the latest computer text, and never forces an overwrite', async () => {
  const initial = { ...file('main.ts', 'first\n'), revision: 'a'.repeat(64) }, latest = { ...file('main.ts', 'computer edit\n'), revision: 'c'.repeat(64) };
  const write = jest.fn().mockRejectedValue(new Error('workspace_file_conflict: 电脑上的文件已变化'));
  mockCapture.mockImplementation(() => ({ writable: true, read: jest.fn().mockResolvedValueOnce(initial).mockResolvedValue(latest), write, dispose: jest.fn() }));
  const view = await render(<RemoteFiles deviceId="pc" sessionKey="codex:parent" agentId="codex" surface="cli" target={{ ...targetScope, path: 'main.ts', nonce: 1 }} />);
  await fireEvent.press(view.getByLabelText('编辑文件')); await fireEvent.changeText(view.getByLabelText('文件内容编辑器'), 'my draft\n');
  await fireEvent.press(view.getByLabelText('保存到电脑'));
  expect(view.getByLabelText('文件内容编辑器').props.value).toBe('my draft\n'); expect(view.getByText('computer edit\n')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('保存到电脑')); expect(write).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('放弃草稿使用电脑版本')); expect(view.getByText('放弃此文件尚未保存的修改？')).toBeTruthy();
});

test('hidden file tabs retain dirty drafts but cannot save, and compare a new revision when shown', async () => {
  const initial = { ...file('main.ts', 'first\n'), revision: 'a'.repeat(64) }, latest = { ...file('main.ts', 'later\n'), revision: 'b'.repeat(64) };
  const write = jest.fn();
  mockCapture.mockImplementationOnce(() => ({ writable: true, read: jest.fn(async () => initial), write, dispose: jest.fn() }))
    .mockImplementation(() => ({ writable: true, read: jest.fn(async () => latest), write, dispose: jest.fn() }));
  const props = { deviceId: 'pc', sessionKey: 'codex:parent', agentId: 'codex' as const, surface: 'cli' as const, target: { ...targetScope, path: 'main.ts', nonce: 1 } };
  const view = await render(<RemoteFiles {...props} />);
  await fireEvent.press(view.getByLabelText('编辑文件')); await fireEvent.changeText(view.getByLabelText('文件内容编辑器'), 'draft\n');
  await view.rerender(<RemoteFiles {...props} visible={false} />);
  await fireEvent.press(view.getByLabelText('保存到电脑')); expect(write).not.toHaveBeenCalled();
  expect(view.getByLabelText('文件内容编辑器').props.value).toBe('draft\n');
  await view.rerender(<RemoteFiles {...props} visible />);
  expect(view.getByLabelText('文件内容编辑器').props.value).toBe('draft\n'); expect(view.getByText('later\n')).toBeTruthy();
});

test('unmounting or switching computers keeps drafts scoped and restores them after a fresh authorized read', async () => {
  const initial = { ...file('main.ts', 'first\n'), revision: 'a'.repeat(64) };
  mockCapture.mockImplementation(() => ({ writable: true, read: jest.fn(async () => initial), write: jest.fn(), dispose: jest.fn() }));
  const props = { deviceId: 'pc', sessionKey: 'codex:parent', agentId: 'codex' as const, surface: 'cli' as const, target: { ...targetScope, path: 'main.ts', nonce: 1 } };
  let view = await render(<RemoteFiles {...props} />);
  await fireEvent.press(view.getByLabelText('编辑文件')); await fireEvent.changeText(view.getByLabelText('文件内容编辑器'), 'retained draft\n');
  await view.unmount();
  view = await render(<RemoteFiles {...props} deviceId="other-pc" />);
  expect(view.queryByLabelText('文件内容编辑器')).toBeNull(); expect(view.queryByText('retained draft\n')).toBeNull();
  await view.rerender(<RemoteFiles {...props} />);
  expect(view.getByLabelText('文件内容编辑器').props.value).toBe('retained draft\n');
  expect(view.getByText('已恢复此会话的未保存草稿')).toBeTruthy();
});

test('restored drafts retain their base revision and require conflict resolution before saving a changed computer file', async () => {
  const initial = { ...file('main.ts', 'first\n'), revision: 'a'.repeat(64) }, latest = { ...file('main.ts', 'computer edit\n'), revision: 'b'.repeat(64) }, write = jest.fn();
  mockCapture.mockImplementationOnce(() => ({ writable: true, read: jest.fn(async () => initial), write, dispose: jest.fn() }))
    .mockImplementation(() => ({ writable: true, read: jest.fn(async () => latest), write, dispose: jest.fn() }));
  const props = { deviceId: 'pc', sessionKey: 'codex:parent', agentId: 'codex' as const, surface: 'cli' as const, target: { ...targetScope, path: 'main.ts', nonce: 1 } };
  const first = await render(<RemoteFiles {...props} />);
  await fireEvent.press(first.getByLabelText('编辑文件')); await fireEvent.changeText(first.getByLabelText('文件内容编辑器'), 'retained draft\n'); await first.unmount();
  const restored = await render(<RemoteFiles {...props} />);
  expect(restored.getByLabelText('文件内容编辑器').props.value).toBe('retained draft\n'); expect(restored.getByText('computer edit\n')).toBeTruthy();
  await fireEvent.press(restored.getByLabelText('保存到电脑')); expect(write).not.toHaveBeenCalled();
  const key = { scope: 'scope-fixture', deviceId: 'pc', agentId: 'codex', sessionKey: 'codex:parent', surface: 'cli' as const, cwd: '/fixture', path: 'main.ts' };
  expect(readWorkspaceFileDraft(key)?.base.revision).toBe(initial.revision);
});

test('a new credential identity cannot restore a previous identity draft, and an unreadable file does not expose cached text', async () => {
  const initial = { ...file('main.ts', 'first\n'), revision: 'a'.repeat(64) };
  mockCapture.mockImplementation(() => ({ writable: true, read: jest.fn(async () => initial), write: jest.fn(), dispose: jest.fn() }));
  const props = { deviceId: 'pc', sessionKey: 'codex:parent', agentId: 'codex' as const, surface: 'cli' as const, target: { ...targetScope, path: 'main.ts', nonce: 1 } };
  const first = await render(<RemoteFiles {...props} />);
  await fireEvent.press(first.getByLabelText('编辑文件')); await fireEvent.changeText(first.getByLabelText('文件内容编辑器'), 'identity private draft'); await first.unmount();
  mockDraftScope = 'new-identity';
  const replacement = await render(<RemoteFiles {...props} />); expect(replacement.queryByLabelText('文件内容编辑器')).toBeNull(); await replacement.unmount();
  mockDraftScope = 'scope-fixture';
  mockCapture.mockImplementation(() => ({ writable: true, read: jest.fn().mockRejectedValue(new Error('authorization revoked')), dispose: jest.fn() }));
  const denied = await render(<RemoteFiles {...props} />);
  expect(denied.queryByLabelText('文件内容编辑器')).toBeNull(); expect(denied.queryByText('identity private draft')).toBeNull();
});

const directory=(path:string,entries:Array<{name:string;path:string;kind:'directory'|'file'}>,nextCursor?:string)=>({path,entries,truncated:false,...(nextCursor?{nextCursor}:{})});
const folder=(name:string,path=name)=>({name,path,kind:'directory' as const});
const entry=(name:string,path=name)=>({name,path,kind:'file' as const});
const browserProps={deviceId:'pc',sessionKey:'codex:parent',agentId:'codex' as const,surface:'cli' as const};

test('the file browser shows the reader project root and expands directories without replacing parents',async()=>{
  const list=jest.fn(async(path:string)=>path?directory(path,[entry('index.ts',`${path}/index.ts`)]):directory('',[folder('src'),entry('README.md')]));
  mockCapture.mockImplementation(()=>({cwd:'/work/actual-project',list,read:jest.fn(),dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  expect(view.getByText('/work/actual-project')).toBeTruthy();expect(view.queryByText('C:')).toBeNull();
  await fireEvent(view.getByTestId('workspace-file-browser'),'layout',{nativeEvent:{layout:{width:733,height:900,x:0,y:0}}});
  expect(view.getByText('从工作区目录树中选择文件')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  expect(view.getByLabelText('打开文件 README.md')).toBeTruthy();expect(view.getByLabelText('打开文件 index.ts')).toBeTruthy();
  expect(list).toHaveBeenLastCalledWith('src',undefined);
  await fireEvent.press(view.getByLabelText('打开目录 src'));expect(view.queryByLabelText('打开文件 index.ts')).toBeNull();
  await fireEvent.press(view.getByLabelText('打开目录 src'));expect(view.getByLabelText('打开文件 index.ts')).toBeTruthy();
  expect(list).toHaveBeenCalledTimes(2);
});

test('each expanded directory owns its cursor and filtering loaded files starts no background scans',async()=>{
  const list=jest.fn(async(path:string,cursor?:string)=>{
    if(!path)return directory('',[folder('src'),entry('README.md')],'root-next');
    return cursor?directory('src',[entry('first.ts','src/first.ts'),entry('second.ts','src/second.ts')]):directory('src',[entry('first.ts','src/first.ts')],'src-next');
  });
  mockCapture.mockImplementation(()=>({cwd:'/fixture',list,read:jest.fn(),dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  await fireEvent.press(view.getByLabelText('更多文件 src'));
  expect(list).toHaveBeenLastCalledWith('src','src-next');expect(view.getAllByLabelText('打开文件 first.ts')).toHaveLength(1);
  expect(view.getByLabelText('更多文件')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('筛选文件'),'second');
  expect(view.queryByLabelText('打开文件 README.md')).toBeNull();expect(view.getByLabelText('打开文件 second.ts')).toBeTruthy();
  expect(list).toHaveBeenCalledTimes(3);
  await fireEvent.press(view.getByLabelText('清除文件筛选'));expect(view.getByLabelText('打开文件 README.md')).toBeTruthy();
});

test('selecting a file previews locally and opens an independent tab only on the explicit menu action',async()=>{
  const read=jest.fn(async(path:string)=>file(path,'preview content')),onOpenFile=jest.fn();
  mockCapture.mockImplementation(()=>({cwd:'/fixture',list:jest.fn(async()=>page()),read,dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps} onOpenFile={onOpenFile}/>);
  await fireEvent.changeText(view.getByLabelText('筛选文件'),'main');
  await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  expect(read).toHaveBeenCalledWith('main.ts');expect(view.getByText('preview content')).toBeTruthy();expect(onOpenFile).not.toHaveBeenCalled();
  expect(view.queryByLabelText('筛选文件')).toBeNull();
  await fireEvent.press(view.getByLabelText('文件更多'));await fireEvent.press(view.getByLabelText('在新标签页打开文件'));
  expect(onOpenFile).toHaveBeenCalledWith('main.ts');
  expect(view.queryByTestId('workspace-file-actions')).toBeNull();
  await fireEvent.press(view.getByLabelText('返回文件目录'));
  expect(view.getByLabelText('筛选文件').props.value).toBe('main');expect(view.getByLabelText('打开文件 main.ts')).toBeTruthy();
});

test('a late directory response cannot populate a different computer project tree',async()=>{
  let release!:(value:unknown)=>void;
  const oldList=jest.fn((path:string)=>path?new Promise(resolve=>{release=resolve;}):Promise.resolve(directory('',[folder('private')])));
  const nextList=jest.fn(async()=>directory('',[entry('public.ts')]));
  mockCapture.mockImplementation((selection:{deviceId:string})=>({cwd:selection.deviceId==='pc'?'/old-project':'/next-project',list:selection.deviceId==='pc'?oldList:nextList,read:jest.fn(),dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent.press(view.getByLabelText('打开目录 private'));
  await view.rerender(<RemoteFiles {...browserProps} deviceId="next-pc"/>);
  await act(async()=>release(directory('private',[entry('secret.ts','private/secret.ts')],'private-next')));
  expect(view.getByText('/next-project')).toBeTruthy();expect(view.getByLabelText('打开文件 public.ts')).toBeTruthy();
  expect(view.queryByLabelText('打开目录 private')).toBeNull();expect(view.queryByLabelText('打开文件 secret.ts')).toBeNull();expect(view.queryByLabelText('更多文件 private')).toBeNull();
});

test('changing credential scope clears expanded caches even when the same device and relative paths return',async()=>{
  const list=jest.fn(async(path:string)=>path?directory(path,[entry(mockDraftScope==='scope-fixture'?'old.ts':'new.ts',`${path}/${mockDraftScope==='scope-fixture'?'old.ts':'new.ts'}`)]):directory('',[folder('src')]));
  mockCapture.mockImplementation(()=>({cwd:'/fixture',list,read:jest.fn(),dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent.press(view.getByLabelText('打开目录 src'));expect(view.getByLabelText('打开文件 old.ts')).toBeTruthy();
  mockDraftScope='new-identity';await view.rerender(<RemoteFiles {...browserProps}/>);
  expect(view.queryByLabelText('打开文件 old.ts')).toBeNull();
  expect(view.getByLabelText('打开目录 src').props.accessibilityState.expanded).toBe(false);
  await fireEvent.press(view.getByLabelText('打开目录 src'));expect(view.getByLabelText('打开文件 new.ts')).toBeTruthy();
});

test('directory expansion waits for the current reader operation before another request can start',async()=>{
  let release!:(value:unknown)=>void;
  const list=jest.fn((path:string)=>!path?Promise.resolve(directory('',[folder('a'),folder('b')])):path==='a'?new Promise(resolve=>{release=resolve;}):Promise.resolve(directory(path,[entry('b.ts','b/b.ts')])));
  mockCapture.mockImplementation(()=>({cwd:'/fixture',list,read:jest.fn(),dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent.press(view.getByLabelText('打开目录 a'));
  expect(view.getByLabelText('打开目录 b')).toBeDisabled();await fireEvent.press(view.getByLabelText('打开目录 b'));expect(list).toHaveBeenCalledTimes(2);
  await act(async()=>release(directory('a',[entry('a.ts','a/a.ts')])));
  await fireEvent.press(view.getByLabelText('打开目录 b'));expect(list).toHaveBeenCalledTimes(3);expect(view.getByLabelText('打开文件 a.ts')).toBeTruthy();expect(view.getByLabelText('打开文件 b.ts')).toBeTruthy();
});

test('losing authorization removes cached directory names while retaining a dirty file draft',async()=>{
  let invalidate!:()=>void;
  mockCapture.mockImplementation((_selection:unknown,callback:()=>void)=>{invalidate=callback;return{cwd:'/fixture',writable:true,list:jest.fn(async()=>page()),read:jest.fn(async(path:string)=>({...file(path),revision:'a'.repeat(64)})),dispose:jest.fn()};});
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent(view.getByTestId('workspace-file-browser'),'layout',{nativeEvent:{layout:{width:733,height:900,x:0,y:0}}});
  await fireEvent.press(view.getByLabelText('打开文件 main.ts'));await fireEvent.press(view.getByLabelText('编辑文件'));await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'private retained draft');
  await act(async()=>invalidate());
  expect(view.queryByLabelText('打开文件 main.ts')).toBeNull();expect(view.getByLabelText('文件内容编辑器').props.value).toBe('private retained draft');expect(view.getByLabelText('保存到电脑')).toBeDisabled();
});

test('choosing another file preserves dirty edits until the discard choice is explicit',async()=>{
  const read=jest.fn(async(path:string)=>({...file(path,path==='a.ts'?'A':'B'),revision:'a'.repeat(64)}));
  mockCapture.mockImplementation(()=>({cwd:'/fixture',writable:true,list:jest.fn(async()=>directory('',[entry('a.ts'),entry('b.ts')])),read,dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent(view.getByTestId('workspace-file-browser'),'layout',{nativeEvent:{layout:{width:733,height:900,x:0,y:0}}});
  await fireEvent.press(view.getByLabelText('打开文件 a.ts'));await fireEvent.press(view.getByLabelText('编辑文件'));await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'A draft');
  await fireEvent.press(view.getByLabelText('打开文件 b.ts'));expect(read).toHaveBeenCalledTimes(1);expect(view.getByLabelText('文件内容编辑器').props.value).toBe('A draft');
  await fireEvent.press(view.getByText('继续编辑'));expect(read).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('打开文件 b.ts'));await fireEvent.press(view.getByText('放弃修改'));expect(read).toHaveBeenLastCalledWith('b.ts');expect(view.getByText('B')).toBeTruthy();
});

test('expanding a directory after a failed file read returns narrow layouts to the actual tree',async()=>{
  mockCapture.mockImplementation(()=>({cwd:'/fixture',list:jest.fn(async(path:string)=>path?directory(path,[entry('index.ts',`${path}/index.ts`)]):directory('',[folder('src'),entry('missing.ts')])),read:jest.fn().mockRejectedValue(new Error('文件已删除')),dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent(view.getByTestId('workspace-file-browser'),'layout',{nativeEvent:{layout:{width:733,height:900,x:0,y:0}}});
  await fireEvent.press(view.getByLabelText('打开文件 missing.ts'));expect(view.getByText('文件已删除')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  await fireEvent(view.getByTestId('workspace-file-browser'),'layout',{nativeEvent:{layout:{width:390,height:844,x:0,y:0}}});
  expect(view.getByLabelText('筛选文件')).toBeTruthy();expect(view.getByLabelText('打开文件 index.ts')).toBeTruthy();expect(view.queryByTestId('workspace-file-preview')).toBeNull();
});

test('a changed reader cwd cannot inherit an old local draft or directory cache for the same relative path',async()=>{
  let cwd='/project-a';
  mockCapture.mockImplementation(()=>({cwd,writable:true,list:jest.fn(async(path:string)=>path?directory(path,[entry('private-a.ts',`${path}/private-a.ts`)]):directory('',[folder('src'),entry('main.ts')])),read:jest.fn(async(path:string)=>({...file(path,cwd==='/project-a'?'project A':'project B'),revision:'a'.repeat(64)})),dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent.press(view.getByLabelText('打开目录 src'));await fireEvent.press(view.getByLabelText('打开文件 main.ts'));
  await fireEvent.press(view.getByLabelText('编辑文件'));await fireEvent.changeText(view.getByLabelText('文件内容编辑器'),'project A draft');
  await view.rerender(<RemoteFiles {...browserProps} visible={false}/>);cwd='/project-b';await view.rerender(<RemoteFiles {...browserProps}/>);
  expect(view.queryByLabelText('文件内容编辑器')).toBeNull();expect(view.getByText('project B')).toBeTruthy();
  await fireEvent(view.getByTestId('workspace-file-browser'),'layout',{nativeEvent:{layout:{width:733,height:900,x:0,y:0}}});
  expect(view.queryByLabelText('打开文件 private-a.ts')).toBeNull();
  expect(readWorkspaceFileDraft({scope:'scope-fixture',deviceId:'pc',agentId:'codex',sessionKey:'codex:parent',surface:'cli',cwd:'/project-a',path:'main.ts'})?.text).toBe('project A draft');
});

test('an interrupted directory read becomes retryable after hiding and showing the file browser',async()=>{
  let release!:(value:unknown)=>void;
  const oldList=jest.fn((path:string)=>path?new Promise(resolve=>{release=resolve;}):Promise.resolve(directory('',[folder('src')])));
  const nextList=jest.fn(async(path:string)=>path?directory(path,[entry('current.ts',`${path}/current.ts`)]):directory('',[folder('src')]));
  mockCapture.mockImplementationOnce(()=>({cwd:'/fixture',list:oldList,read:jest.fn(),dispose:jest.fn()})).mockImplementation(()=>({cwd:'/fixture',list:nextList,read:jest.fn(),dispose:jest.fn()}));
  const view=await render(<RemoteFiles {...browserProps}/>);
  await fireEvent.press(view.getByLabelText('打开目录 src'));
  await view.rerender(<RemoteFiles {...browserProps} visible={false}/>);await view.rerender(<RemoteFiles {...browserProps}/>);
  expect(view.queryByText('正在读取目录…')).toBeNull();expect(view.getByLabelText('读取目录')).toBeTruthy();
  await act(async()=>release(directory('src',[entry('old.ts','src/old.ts')])));
  expect(view.queryByLabelText('打开文件 old.ts')).toBeNull();
  await fireEvent.press(view.getByLabelText('读取目录'));expect(view.getByLabelText('打开文件 current.ts')).toBeTruthy();expect(nextList).toHaveBeenLastCalledWith('src',undefined);
});
