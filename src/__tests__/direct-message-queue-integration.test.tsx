import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { useDirectMessageQueue } from '../remote/useDirectMessageQueue';
import type { DirectDraftInput } from '../remote/direct-composer-drafts';
import type { Timeline } from '../remote/store';

const mockSettings=new Map<string,string>(),mockFiles=new Map<string,string>(),mockRequest=jest.fn();
const mockSet=jest.fn(async(key:string,value:string)=>{mockSettings.set(key,value);});
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,setSetting:(key:string,value:string)=>mockSet(key,value)}));
jest.mock('../remote/direct-api',()=>({requestDirect:(...args:unknown[])=>mockRequest(...args)}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_:string,text:string)=>require('node:crypto').createHash('sha256').update(text).digest('hex')}));
jest.mock('expo-file-system/legacy',()=>({documentDirectory:'file://queue-integration/',EncodingType:{Base64:'base64'},getInfoAsync:async(uri:string)=>({exists:mockFiles.has(uri),isDirectory:false}),readAsStringAsync:async(uri:string)=>mockFiles.get(uri)??'',writeAsStringAsync:async(uri:string,data:string)=>{mockFiles.set(uri,data);},makeDirectoryAsync:async()=>{},deleteAsync:async(uri:string)=>{mockFiles.delete(uri);}}));
const input:DirectDraftInput={text:'next task',options:{},model:'',effort:'',permission:'',images:[]};
const session:any={sessionKey:'codex:s',cwd:'C:/project',tool:'codex',status:'idle',controllable:true,controlSurface:'cli'};
const profile:any={id:'codex',tool:'codex',api:{accountId:'api_00112233',model:'model-a'},capabilities:{send:true,modelOverride:true,imageInput:true,features:true,permissionModes:['ask','auto_review'],contextReferences:true}};
let current=true,queue:ReturnType<typeof useDirectMessageQueue>;
const services:any={scope:'pairing/pc/session/api',isCurrent:()=>current,guard:()=>{if(!current)throw new Error('scope changed');},
  models:jest.fn(async()=>({models:['model-a'],modelCapabilities:{'model-a':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['high']}}})),
  features:jest.fn(async()=>({collaborationModes:['default','plan'],skills:[],skillsSupported:true})),uploadImages:jest.fn(async()=>['att_uploaded'])};
const refresh=jest.fn();
function timeline(id='turn-1',status='running',terminal='completed'):Timeline {
  const old:any={kind:'turn',id:`terminal-${id}`,turnId:id,status:terminal,ts:1};
  return {items:status==='running'?[old,{kind:'turn',id:'start',turnId:'active',status:'started',ts:2}]:[old],loading:false,snapshotAt:1,session:{...session,status,...(status==='running'?{activeTurnId:'active'}:{})}};
}
function Harness({page=timeline(),mode='code',canSend=true}:{page?:Timeline;mode?:'code'|'work';canSend?:boolean}) {
  queue=useDirectMessageQueue({pairing:'direct:integration',deviceId:'pc',workspaceMode:mode,services,profile,session:page.session!,timeline:page,canSend,sending:false,uncertain:false,autoAll:false,onRefresh:refresh});return null;
}
beforeEach(()=>{jest.clearAllMocks();current=true;mockSettings.clear();mockFiles.clear();mockSet.mockImplementation(async(key,value)=>{mockSettings.set(key,value);});mockRequest.mockResolvedValue({via:'background'});});
const loaded=()=>waitFor(()=>expect(queue.ready).toBe(true));

test('running drafts drain one at a time only after a new verified terminal and include all selected inputs',async()=>{
  const view=await render(<Harness/>);await loaded();
  await act(async()=>{await queue.enqueue({...input,model:'model-a',effort:'high',permission:'ask',options:{collaborationMode:'plan'}});await queue.enqueue({...input,text:'second'});});
  expect(mockRequest).not.toHaveBeenCalled();
  await view.rerender(<Harness page={timeline('active','idle')}/>);
  await waitFor(()=>expect(mockRequest).toHaveBeenCalledTimes(1));
  await waitFor(()=>expect(queue.entries).toHaveLength(1));
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({type:'session.send',text:'next task',model:'model-a',effort:'high',permissionMode:'ask',collaborationMode:'plan',accountId:'api_00112233',operationId:expect.any(String)}),expect.anything());
  await act(async()=>{await queue.reload();});expect(mockRequest).toHaveBeenCalledTimes(1);
  await view.rerender(<Harness page={timeline('next-terminal','idle')}/>);
  await waitFor(()=>expect(mockRequest).toHaveBeenCalledTimes(2));await waitFor(()=>expect(queue.entries).toHaveLength(0));await view.unmount();
});

test('an unknown delivery persists, never resumes after refresh, and clears only for the exact own operation echo',async()=>{
  mockRequest.mockRejectedValue(Object.assign(new Error('lost reply'),{code:'timeout'}));
  const view=await render(<Harness/>);await loaded();await act(async()=>{await queue.enqueue(input);});
  await view.rerender(<Harness page={timeline('active','idle')}/>);
  await waitFor(()=>expect(queue.entries[0]?.state).toBe('unconfirmed'));
  const operation=queue.entries[0].id;
  await act(async()=>{await queue.reload();});expect(mockRequest).toHaveBeenCalledTimes(1);
  const page=timeline('active','idle');page.items.unshift({kind:'message',id:'echo',role:'user',text:input.text,clientId:'other-operation',final:true,ts:0});
  await view.rerender(<Harness page={page}/>);expect(queue.entries).toHaveLength(1);
  const accepted={...page,items:page.items.map(item=>item.kind==='message'?{...item,clientId:operation}:item)};
  await view.rerender(<Harness page={accepted}/>);await waitFor(()=>expect(queue.entries).toHaveLength(0));expect(mockRequest).toHaveBeenCalledTimes(1);await view.unmount();
});

test('a failed turn pauses the queue and an explicit resume is required to send it',async()=>{
  const view=await render(<Harness/>);await loaded();await act(async()=>{await queue.enqueue(input);});
  await view.rerender(<Harness page={timeline('active','failed','failed')}/>);
  await waitFor(()=>expect(queue.entries[0]?.state).toBe('blocked'));expect(mockRequest).not.toHaveBeenCalled();
  await act(async()=>{await queue.resume(queue.entries[0]);});
  await waitFor(()=>expect(mockRequest).toHaveBeenCalledTimes(1));await waitFor(()=>expect(queue.entries).toHaveLength(0));await view.unmount();
});

test('changing Code/Work while a message is queued does not send it into the new context',async()=>{
  const view=await render(<Harness/>);await loaded();await act(async()=>{await queue.enqueue(input);});
  await view.rerender(<Harness mode="work" page={timeline('active','idle')}/>);await loaded();
  expect(queue.entries).toHaveLength(0);expect(mockRequest).not.toHaveBeenCalled();
  await view.rerender(<Harness mode="code" page={timeline('active','idle')}/>);await loaded();
  await waitFor(()=>expect(mockRequest).toHaveBeenCalledTimes(1));await view.unmount();
});

test('accepted transport followed by failed local consume becomes unconfirmed and never offers a resend',async()=>{
  const view=await render(<Harness/>);await loaded();await act(async()=>{await queue.enqueue(input);});
  let failed=false;
  mockSet.mockImplementation(async(key,value)=>{if(key==='direct_message_queues_v1'&&value==='{}'&&!failed){failed=true;throw new Error('Disk write failed');}mockSettings.set(key,value);});
  await view.rerender(<Harness page={timeline('active','idle')}/>);
  await waitFor(()=>expect(queue.entries[0]?.state).toBe('unconfirmed'));
  await expect(queue.resume(queue.entries[0])).rejects.toThrow('不能重新发送');
  expect(mockRequest).toHaveBeenCalledTimes(1);await view.unmount();
});

test('editing retains selected options and remains paused across the terminal event until explicitly resumed',async()=>{
  const view=await render(<Harness/>);await loaded();
  await act(async()=>{await queue.enqueue({...input,model:'model-a',effort:'high',permission:'ask',options:{collaborationMode:'plan'}});await queue.enqueue({...input,text:'second'});});
  await act(async()=>{await queue.pause();});
  await act(async()=>{await queue.editText(queue.entries[0],'edited next task');});
  expect(queue.entries.map(row=>row.state)).toEqual(['blocked','blocked']);
  await view.rerender(<Harness page={timeline('active','idle')}/>);
  expect(mockRequest).not.toHaveBeenCalled();
  await act(async()=>{await queue.resume(queue.entries[0]);});
  await waitFor(()=>expect(mockRequest).toHaveBeenCalledTimes(1));
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({text:'edited next task',model:'model-a',effort:'high',permissionMode:'ask',collaborationMode:'plan'}),expect.anything());
  await waitFor(()=>expect(queue.entries).toHaveLength(1));
  await view.rerender(<Harness page={timeline('second-completed','idle')}/>);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(queue.entries[0].input.text).toBe('second');expect(queue.entries[0].state).toBe('blocked');
  await view.unmount();
});

test('reordering pauses the whole queue and sends the reordered head only after explicit resume',async()=>{
  const view=await render(<Harness/>);await loaded();
  await act(async()=>{await queue.enqueue(input);await queue.enqueue({...input,text:'second first'});});
  await act(async()=>{await queue.move(queue.entries[1],-1);});
  expect(queue.entries.map(row=>row.input.text)).toEqual(['second first','next task']);
  await view.rerender(<Harness page={timeline('active','idle')}/>);
  expect(mockRequest).not.toHaveBeenCalled();
  await act(async()=>{await queue.resume(queue.entries[0]);});
  await waitFor(()=>expect(mockRequest).toHaveBeenCalledTimes(1));
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({text:'second first'}),expect.anything());
  await waitFor(()=>expect(queue.entries).toHaveLength(1));
  expect(queue.entries[0].state).toBe('blocked');await view.unmount();
});
