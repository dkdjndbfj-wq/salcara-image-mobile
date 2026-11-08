import { createDirectWorkspaceRuntime } from '../remote/direct-workspace';
import { requestDirect } from '../remote/direct-api';
import { command } from '../remote/client';

jest.mock('expo/fetch', () => ({fetch:jest.fn()}));
jest.mock('../remote/client', () => ({...jest.requireActual('../remote/client'),command:jest.fn()}));
jest.mock('../remote/direct-api', () => ({requestDirect:jest.fn()}));
let mockScope='binding-1',mockGeneration=1,mockConnection:any,mockState:any,mockActive:string|null;
const mockListeners=new Set<()=>void>();
jest.mock('../remote/direct-pairing', () => ({directDeliveryScope:()=>mockScope,directConnectionGeneration:()=>mockGeneration,getDirectConnectionState:()=>mockConnection,
  subscribeDirectConnection:(listener:()=>void)=>{mockListeners.add(listener);return()=>mockListeners.delete(listener);}}));
jest.mock('../remote/store', () => ({timelineKey:(device:string,session:string)=>`${device}|${session}`}));
const request=requestDirect as jest.Mock;
const selection={deviceId:'pc',sessionKey:'codex:test',agentId:'codex',surface:'cli' as const,cwd:'C:/project'};
const revision='a'.repeat(64), terminalId='direct-terminal-001';
const empty={terminalId,cursor:0,startCursor:0,dataBase64:'',truncated:false,exited:false,exitCode:0,nextSequence:1};
const file={path:'index.ts',text:'hi',size:2,modifiedAt:1,revision};
const runtime=()=>createDirectWorkspaceRuntime(()=>mockState,()=>mockActive);
beforeEach(()=>{
  jest.clearAllMocks();mockListeners.clear();mockScope='binding-1';mockGeneration=1;mockActive=selection.sessionKey;mockConnection={status:'connected',deviceId:'pc'};
  mockState={devices:[{deviceId:'pc',online:true,projects:[{path:selection.cwd}],capabilities:['workspace.files.v1','workspace.files.write.v1','workspace.files.manage.v1','workspace.terminal.v1','workspace.preview.v1']}],
    sessions:{pc:{list:[{sessionKey:selection.sessionKey,cwd:selection.cwd,controlSurface:'cli'}]}},timelines:{}};
});
test('files use only authenticated direct transport and preserve revision identity',async()=>{
  const reader=runtime().captureFiles(selection);
  request.mockResolvedValue(file);
  await expect(reader.read('index.ts')).resolves.toEqual(file);
  await reader.write!('index.ts','hi',revision);
  expect(request).toHaveBeenLastCalledWith({type:'workspace.files.write',sessionKey:selection.sessionKey,controlSurface:'cli',expectedCwd:selection.cwd,path:'index.ts',text:'hi',expectedRevision:revision});
  expect(command).not.toHaveBeenCalled();reader.dispose();
});
test.each(['scope','generation','session','capability','surface','project'])('direct handles cannot follow a changed %s',async change=>{
  const reader=runtime().captureFiles(selection);
  if(change==='scope')mockScope='binding-2';if(change==='generation')mockGeneration++;if(change==='session')mockActive='codex:other';
  if(change==='capability')mockState.devices[0].capabilities=[];if(change==='surface')mockState.sessions.pc.list[0].controlSurface='desktop';if(change==='project')mockState.devices[0].projects=[];
  await expect(reader.read('index.ts')).rejects.toMatchObject({code:'workspace_scope_changed'});expect(request).not.toHaveBeenCalled();reader.dispose();
});
test('late file results are rejected after same-computer reconnect',async()=>{
  let resolve!:(value:unknown)=>void;request.mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const reader=runtime().captureFiles(selection),pending=reader.read('index.ts');mockGeneration++;resolve(file);
  await expect(pending).rejects.toMatchObject({code:'workspace_scope_changed'});reader.dispose();
});
test('file management checks capabilities and verifies exact host receipts',async()=>{
  const reader=runtime().captureFiles(selection);request.mockResolvedValue({action:'create',path:'index.ts',file});
  await expect(reader.create!('index.ts','hi')).resolves.toEqual(file);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({type:'workspace.files.mutate',action:'create',path:'index.ts',text:'hi'}));
  request.mockResolvedValue({action:'rename',path:'index.ts',destination:'wrong.ts',file});
  await expect(reader.rename!('index.ts','new.ts',revision)).rejects.toThrow('未确认');reader.dispose();
});
test('terminal input stays ordered and freezes after ambiguous delivery',async()=>{
  request.mockImplementation(async(payload:any)=>payload.type==='workspace.terminal.input'?{terminalId,sequence:payload.sequence}:empty);
  const terminal=runtime().captureTerminal(selection);await terminal.open(80,24);await Promise.all([terminal.input('one\r'),terminal.input('two\r')]);
  expect(request.mock.calls.filter(call=>call[0].type==='workspace.terminal.input').map(call=>call[0].sequence)).toEqual([1,2]);
  request.mockRejectedValueOnce(new Error('delivery unknown'));await expect(terminal.input('three\r')).rejects.toThrow('unknown');
  await expect(terminal.input('four\r')).rejects.toThrow('暂停');expect(request.mock.calls.filter(call=>call[0].type==='workspace.terminal.input')).toHaveLength(3);
  mockGeneration++;terminal.dispose();expect(request.mock.calls.at(-1)[0].type).toBe('workspace.terminal.input');
});
test('preview preserves page identity and never retries ambiguous clicks',async()=>{
  const preview=runtime().capturePreview(selection,jest.fn()),pageId='direct-browser-001';
  request.mockResolvedValue({pageId,url:'http://localhost:8080/',width:800,height:600,nextSequence:1});await preview.open('http://localhost:8080/',800,600);
  request.mockResolvedValue({pageId,sequence:1});await preview.input({action:'click',x:2,y:3});
  request.mockRejectedValueOnce(new Error('lost'));await expect(preview.input({action:'text',text:'hello'})).rejects.toThrow('lost');
  await expect(preview.input({action:'click',x:4,y:5})).rejects.toThrow('未确认');mockGeneration++;preview.dispose();
  expect(command).not.toHaveBeenCalled();
});

test('first-turn project files use Direct and reject a removed project before returning late bytes',async()=>{
  mockActive=null;mockState.devices[0].capabilities.push('workspace.project.files.v1');
  const reader=runtime().captureProjectFiles!({deviceId:'pc',tool:'codex',cwd:'C:/project'});request.mockResolvedValue(file);
  await reader.read('index.ts');expect(request).toHaveBeenLastCalledWith({type:'workspace.project.files.read',tool:'codex',cwd:'C:/project',expectedCwd:'C:/project',controlSurface:'cli',path:'index.ts'});
  let resolve!:(value:any)=>void;request.mockImplementation(()=>new Promise(done=>{resolve=done;}));const pending=reader.read('index.ts');mockState.devices[0].projects=[];resolve(file);
  await expect(pending).rejects.toThrow('已变化');expect(command).not.toHaveBeenCalled();reader.dispose();
});

test('Direct review requires the independent capability and preserves exact hunk authorization fields',async()=>{
  mockState.devices[0].capabilities.push('workspace.git.v1');
  const git=runtime().captureGit!(selection),state={revision,branch:'main',head:'a'.repeat(40),upstream:'',files:[],branches:['main'],worktrees:[],githubCLI:false};
  request.mockResolvedValue(state);await git.status();expect(request).toHaveBeenCalledTimes(1);
  await expect(git.review({reviewScope:'unstaged'})).rejects.toThrow('尚未开放统一审查');expect(request).toHaveBeenCalledTimes(1);
  mockState.devices[0].capabilities.push('workspace.git.review.v1');
  const review={scope:'unstaged',ref:'',base:'',state,files:[],commits:[]};request.mockResolvedValue(review);
  await expect(git.review({reviewScope:'unstaged'})).resolves.toEqual(review);
  // Allow the Bridge's 90-second Git operation budget plus response transit time.
  expect(request).toHaveBeenLastCalledWith({type:'workspace.git.read',sessionKey:selection.sessionKey,controlSurface:'cli',expectedCwd:selection.cwd,action:'review',reviewScope:'unstaged'},{timeoutMs:100_000});
  request.mockResolvedValue({action:'review-apply',state});await git.mutate('review-apply',revision,{reviewScope:'staged',path:'main.ts',patchRevision:'b'.repeat(64),hunk:'c'.repeat(64),operation:'unstage'});
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({type:'workspace.git.mutate',action:'review-apply',reviewScope:'staged',expectedRevision:revision,patchRevision:'b'.repeat(64),hunk:'c'.repeat(64),operation:'unstage'}),{timeoutMs:100_000});
  mockState.devices[0].capabilities=mockState.devices[0].capabilities.filter((value:string)=>value!=='workspace.git.review.v1');
  await expect(git.mutate('review-apply',revision,{reviewScope:'unstaged',operation:'discard'})).rejects.toThrow('尚未开放统一审查');expect(command).not.toHaveBeenCalled();git.dispose();
});
