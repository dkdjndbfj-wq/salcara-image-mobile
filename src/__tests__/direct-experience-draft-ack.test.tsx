import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DirectExperience } from '../remote/DirectExperience';

const mockConnection={status:'connected',deviceId:'pc',deviceName:'Computer'};
const mockRequest=jest.fn();let mockConversation:any;
const mockSettings=new Map<string,string>();
let mockPendingWriteGate:((key:string,value:string)=>Promise<void>)|undefined;
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,setSetting:async(key:string,value:string)=>{mockSettings.set(key,value);await mockPendingWriteGate?.(key,value);}}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID()}));
jest.mock('../remote/direct-pairing',()=>({getDirectConnectionState:()=>mockConnection,subscribeDirectConnection:()=>()=>{},directDeliveryScope:()=> 'pairing',directConnectionGeneration:()=>1}));
jest.mock('../remote/direct-api',()=>({requestDirect:(...args:unknown[])=>mockRequest(...args),subscribeDirectEvents:()=>()=>{}}));
jest.mock('../remote/direct-workspace',()=>({createDirectWorkspaceRuntime:()=>({scope:'pairing'})}));
jest.mock('../remote/DirectNewComposer',()=>({DirectNewComposer:()=>null}));
jest.mock('../remote/DirectConversation',()=>({DirectConversation:(props:any)=>{mockConversation=props;const React=require('react'),{Text}=require('react-native');return React.createElement(Text,{testID:'direct-draft'},props.text);}}));
const session={sessionKey:'codex:thread',tool:'codex',client:'Codex CLI',title:'Original',cwd:'C:/project',updatedAt:1,status:'idle',controllable:true,controlSurface:'cli'};
const api={name:'API',model:'model',protocol:'responses',configured:true,pending:false,source:'computer',accountId:'api_00112233'};
beforeEach(()=>{jest.clearAllMocks();mockSettings.clear();mockPendingWriteGate=undefined;});

test('the accepted Direct transport refresh preserves later composer input instead of clearing it before draft CAS',async()=>{
  let finish!:(value:unknown)=>void;const receipt=new Promise(resolve=>{finish=resolve;});
  mockRequest.mockImplementation(async(command:any)=>{
    if(command.type==='agents.status')return {agents:[{id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,capabilities:{list:true,send:true},api}]};
    if(command.type==='projects.list')return {projects:[{path:'C:/project',name:'Project'}]};
    if(command.type==='sessions.list')return {sessions:[session]};
    if(command.type==='session.open')return {session,events:[]};
    if(command.type==='session.send')return receipt;
    throw new Error(`Unexpected ${command.type}`);
  });
  const view=await render(<DirectExperience/>);
  await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));
  await waitFor(()=>expect(mockConversation.canSend).toBe(true));
  await act(async()=>mockConversation.onText('original prompt'));
  let flight!:Promise<boolean|undefined>;
  await act(async()=>{flight=mockConversation.onSend({owner:JSON.stringify(['pairing','pc','codex:thread','codex','api_00112233','C:/project'])});});
  await act(async()=>mockConversation.onText('next unsent draft'));
  await act(async()=>{finish({via:'background'});await flight;});
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({type:'session.send',text:'original prompt'}),expect.anything());
  expect(view.getByTestId('direct-draft').props.children).toBe('next unsent draft');
  expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.open')).toHaveLength(2);
  await view.unmount();
});

const owner=JSON.stringify(['pairing','pc','codex:thread','codex','api_00112233','C:/project']);
const baseEvent={deviceId:'pc',sessionKey:session.sessionKey,tool:'codex'};
function setupTurns({failed=false,send,continueReply}: {failed?:boolean;send?:(command:any)=>unknown;continueReply?:(command:any)=>unknown}={}) {
  let events:any[]=[{...baseEvent,type:'message',id:'original',role:'user',text:'original task',final:true,turnId:'turn-1',ts:1},
    {...baseEvent,type:'turn',status:'started',turnId:'turn-1',ts:2},
    {...baseEvent,type:'turn',status:failed?'failed':'completed',turnId:'turn-1',ts:3}];
  let activeApi=api;
  mockRequest.mockImplementation(async(command:any)=>{
    if(command.type==='agents.status')return {agents:[{id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,capabilities:{list:true,send:true,continue:true},api:activeApi}]};
    if(command.type==='projects.list')return {projects:[{path:'C:/project',name:'Project'}]};
    if(command.type==='sessions.list')return {sessions:[session]};
    if(command.type==='session.open')return {session:{...session,status:failed?'failed':'idle',lastTerminalTurnId:'turn-1'},events};
    if(command.type==='session.send')return send?.(command)??{via:'background'};
    if(command.type==='session.continue')return continueReply?.(command)??{accepted:true,sessionKey:session.sessionKey,previousTurnId:command.expectedTurnId,operationId:command.operationId};
    throw new Error(`Unexpected ${command.type}`);
  });
  return {events,changeApi:()=>{activeApi={...api,accountId:'api_aabbccdd'};},setEvents:(value:any[])=>{events=value;}};
}
async function openReady(){const view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));await waitFor(()=>expect(mockConversation.canSend).toBe(true));return view;}

test.each([['permission_denied','not-sent'],['timeout','unknown'],['protocol','unknown']])('send outcome for %s is %s and never claims acceptance',async(code,outcome)=>{
 setupTurns({send:()=>{throw Object.assign(new Error(code),{code});}});
 const view=await openReady(),observe=jest.fn();
 await act(async()=>{expect(await mockConversation.onSend({owner,inputText:'Revised task'},observe)).toBe(false);});
 expect(observe).toHaveBeenLastCalledWith(outcome);await view.unmount();
});

test('system Back returns to the Direct directory and preserves the selected conversation draft',async()=>{
  setupTurns();
  const back:{current:(()=>boolean)|null}={current:null};
  const register=(handler:(()=>boolean)|null)=>{back.current=handler;};
  const view=await render(<DirectExperience onRegisterBack={register}/>);
  expect(back.current?.()).toBe(false);
  await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));
  await waitFor(()=>expect(mockConversation.canSend).toBe(true));
  await act(async()=>mockConversation.onText('返回后仍保留的草稿'));
  await act(async()=>{expect(back.current?.()).toBe(true);});
  expect(await view.findByRole('button',{name:'打开对话 Original'})).toBeTruthy();
  expect(back.current?.()).toBe(false);
  await fireEvent.press(view.getByRole('button',{name:'打开对话 Original'}));
  await waitFor(()=>expect(mockConversation.text).toBe('返回后仍保留的草稿'));
  expect(mockRequest.mock.calls.some(([command])=>['session.interrupt','session.send'].includes(command.type))).toBe(false);
  const stale=back.current;
  await view.unmount();
  expect(back.current).toBeNull();expect(stale?.()).toBe(false);
});

test('system Back closes new Direct conversation before leaving its directory',async()=>{
  setupTurns();const back:{current:(()=>boolean)|null}={current:null};
  const view=await render(<DirectExperience onRegisterBack={handler=>{back.current=handler;}}/>);
  await fireEvent.press(await view.findByRole('button', {name:'新建 Code 对话'}));
  expect(view.getByText('新建直连会话')).toBeTruthy();
  await act(async()=>{expect(back.current?.()).toBe(true);});
  expect(view.queryByText('新建直连会话')).toBeNull();
  expect(await view.findByRole('button',{name:'打开对话 Original'})).toBeTruthy();
  expect(back.current?.()).toBe(false);
  await view.unmount();
});

test('Continue carries the exact terminal and options, verifies the receipt, and preserves the independent draft',async()=>{
  setupTurns();const view=await openReady();await act(async()=>mockConversation.onText('unrelated next draft'));
  await act(async()=>{expect(await mockConversation.onContinue({owner,collaborationMode:'plan',model:'model-b',effort:'high',permissionMode:'ask'})).toBe(true);});
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({type:'session.continue',expectedTurnId:'turn-1',operationId:expect.any(String),text:'继续处理这个任务中尚未完成的工作。',collaborationMode:'plan',model:'model-b',effort:'high',permissionMode:'ask',accountId:'api_00112233'}),expect.anything());
  expect(mockConversation.text).toBe('unrelated next draft');expect(mockSettings.get('direct_pending_operations_v1')).toBe('{}');await view.unmount();
});

test('a failed turn retries its original exact user text and context without consuming the current draft',async()=>{
  const history=setupTurns({failed:true});
  history.events[0].skills=[{name:'review',path:'C:/skills/review/SKILL.md'}];
  history.events[0].contextReferences=[{kind:'message',sessionKey:session.sessionKey,messageId:'context',label:'Context',text:'exact context',startOffset:0,endOffset:13,capturedAt:1}];
  const view=await openReady();await act(async()=>mockConversation.onText('do not replace this draft'));
  await act(async()=>mockConversation.onRetry());
  await waitFor(()=>expect(mockRequest.mock.calls.some(([command])=>command.type==='session.continue')).toBe(true));
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({type:'session.continue',text:'original task',expectedTurnId:'turn-1',skills:history.events[0].skills,contextReferences:history.events[0].contextReferences}),expect.anything());
  expect(mockConversation.text).toBe('do not replace this draft');await view.unmount();
});

test('an ambiguous Continue reply stays blocked across refresh and reentry until its exact own operation echo appears',async()=>{
  const history=setupTurns({continueReply:command=>({accepted:true,sessionKey:session.sessionKey,previousTurnId:'wrong-turn',operationId:command.operationId})});
  let view=await openReady();await act(async()=>{expect(await mockConversation.onContinue({owner})).toBe(false);});
  expect(mockConversation.uncertain).toBe(true);
  const operation=mockRequest.mock.calls.find(([command])=>command.type==='session.continue')![0].operationId;
  await act(async()=>mockConversation.onRefresh());await waitFor(()=>expect(mockConversation.loading).toBe(false));expect(mockConversation.canSend).toBe(false);
  await view.unmount();view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));
  await waitFor(()=>expect(mockConversation.uncertain).toBe(true));expect(mockConversation.canSend).toBe(false);
  history.events.push({...baseEvent,type:'message',id:'accepted',role:'user',text:'continue',clientId:operation,final:true,turnId:'turn-2',ts:4});
  await act(async()=>mockConversation.onRefresh());await waitFor(()=>expect(mockConversation.canSend).toBe(true));
  expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.continue')).toHaveLength(1);await view.unmount();
});

test('an old API Continue callback cannot dispatch after refresh switches the computer API',async()=>{
  const history=setupTurns(),view=await openReady(),oldContinue=mockConversation.onContinue;
  history.changeApi();await act(async()=>mockConversation.onRefresh());await waitFor(()=>expect(mockConversation.loading).toBe(false));
  await act(async()=>{expect(await oldContinue({owner})).toBe(false);});
  expect(mockRequest.mock.calls.some(([command])=>command.type==='session.continue')).toBe(false);await view.unmount();
});

test('normal send timeout is durable and a plain history refresh does not enable a duplicate send',async()=>{
  setupTurns({send:()=>{throw Object.assign(new Error('Timeout'),{code:'timeout'});}});
  const view=await openReady();await act(async()=>mockConversation.onText('original task'));
  await act(async()=>mockConversation.onSend({owner}));expect(mockConversation.uncertain).toBe(true);
  await act(async()=>mockConversation.onRefresh());await waitFor(()=>expect(mockConversation.loading).toBe(false));
  await act(async()=>mockConversation.onSend({owner}));expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.send')).toHaveLength(1);await view.unmount();
});

test('explicit computer verification clears only the pending marker and leaves the draft without resending',async()=>{
  setupTurns({send:()=>{throw Object.assign(new Error('Timeout'),{code:'timeout'});}});
  const view=await openReady();await act(async()=>mockConversation.onText('keep this original draft'));
  await act(async()=>mockConversation.onSend({owner}));expect(mockConversation.uncertain).toBe(true);
  await act(async()=>{expect(await mockConversation.onRecoverDelivery()).toBe(true);});
  expect(mockConversation.canSend).toBe(true);expect(mockConversation.text).toBe('keep this original draft');
  expect(mockSettings.get('direct_pending_operations_v1')).toBe('{}');expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.send')).toHaveLength(1);await view.unmount();
});

test('direct navigation retains the API catalog and routes dynamically advertised Harness and Hermes profiles',async()=>{
  const extension=(id:string,name:string)=>({id,name,tool:id,available:true,remoteSendSupported:true,conversationApiSwitch:true,
    execution:{tool:id,controlSurface:'cli'},capabilities:{list:true,read:true,send:true,modelOverride:true},api});
  const catalog=[{id:'api_00112233',name:'Shared API',models:['model']}];
  mockRequest.mockImplementation(async(command:any)=>{
    if(command.type==='agents.status')return {agents:[extension('deepseek-harness','DeepSeek Harness'),extension('hermes','Hermes')],apis:catalog};
    if(command.type==='projects.list')return {projects:[{path:'C:/project',name:'Project'}]};
    if(command.type==='sessions.list')return {sessions:[{...session,sessionKey:`${command.tool}:thread`,tool:command.tool,title:command.tool}]};
    if(command.type==='session.open')return {session:{...session,sessionKey:command.sessionKey,tool:'hermes',title:'hermes'},events:[]};
    throw new Error(`Unexpected ${command.type}`);
  });
  const view=await render(<DirectExperience/>);
  await view.findByRole('button',{name:'DeepSeek Harness'});
  await fireEvent.press(view.getByRole('button',{name:'Hermes'}));
  await fireEvent.press(await view.findByRole('button',{name:'打开对话 hermes'}));
  await waitFor(()=>expect(mockConversation.profile.id).toBe('hermes'));
  expect(mockConversation.runtime.remote.agents.pc.apis).toEqual(catalog);
  expect(mockConversation.apiControl).toBeTruthy();
  expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({type:'sessions.list',tool:'hermes',controlSurface:'cli'}));
  await view.unmount();
});

function setupEdit(reply:(command:any)=>any){
 const editable={...session,latestTurnRevert:true};
 const events:any[]=[{...baseEvent,type:'message',id:'edit-user',role:'user',text:'Original edit',final:true,turnId:'edit-turn',ts:1},{...baseEvent,type:'turn',status:'completed',turnId:'edit-turn',ts:2}];
 mockRequest.mockImplementation(async(command:any)=>{
  if(command.type==='agents.status')return {agents:[{id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,capabilities:{list:true,send:true,latestTurnRevert:true},api}]};
  if(command.type==='projects.list')return {projects:[{path:'C:/project',name:'Project'}]};
  if(command.type==='sessions.list')return {sessions:[editable]};
  if(command.type==='session.open')return {session:editable,events};
  if(command.type==='session.revert')return reply(command);
  throw new Error(`Unexpected ${command.type}`);
 });
 return {events};
}
test('latest Direct message revert binds exact IDs, preserves the main draft and does not resend itself',async()=>{
 setupEdit(command=>({status:'completed',sessionKey:command.sessionKey,turnId:command.expectedTurnId,messageId:command.expectedMessageId,operationId:command.operationId}));
 const view=await openReady();await act(async()=>mockConversation.onText('Unsent newer draft'));
 const message=mockConversation.timeline.items.find((item:any)=>item.id==='edit-user');
 await act(async()=>mockConversation.onRevert(message,'b3d117de-91f8-4850-b1a7-425848c809f2'));
 expect(mockRequest).toHaveBeenCalledWith(expect.objectContaining({type:'session.revert',expectedTurnId:'edit-turn',expectedMessageId:'edit-user',accountId:api.accountId}),expect.anything());
 expect(mockConversation.text).toBe('Unsent newer draft');expect(mockConversation.timeline.items.some((item:any)=>item.id==='edit-user')).toBe(false);
 expect(mockConversation.canSend).toBe(true);expect(mockRequest.mock.calls.some(([command])=>command.type==='session.send')).toBe(false);await view.unmount();
});
test('an ambiguous latest Direct revert remains blocked after reopening with its durable operation marker',async()=>{
 setupEdit(command=>({status:'unconfirmed',sessionKey:command.sessionKey,turnId:command.expectedTurnId,messageId:command.expectedMessageId,operationId:command.operationId}));
 let view=await openReady();const message=mockConversation.timeline.items.find((item:any)=>item.id==='edit-user');
 await act(async()=>{await expect(mockConversation.onRevert(message,'b3d117de-91f8-4850-b1a7-425848c809f2')).rejects.toThrow('未确认');});
 expect(mockConversation.canSend).toBe(false);expect(mockSettings.get('direct_pending_operations_v1')).toContain('revert');
 await view.unmount();view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));
 await waitFor(()=>expect(mockConversation.uncertain).toBe(true));expect(mockConversation.canSend).toBe(false);expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.revert')).toHaveLength(1);await view.unmount();
});

test('only the matching confirmed revert receipt unlocks an uncertain operation after reopen without resending',async()=>{
 const history=setupEdit(command=>({status:'unconfirmed',sessionKey:command.sessionKey,turnId:command.expectedTurnId,messageId:command.expectedMessageId,operationId:command.operationId}));
 const operationId='b3d117de-91f8-4850-b1a7-425848c809f2';
 let view=await openReady();const message=mockConversation.timeline.items.find((item:any)=>item.id==='edit-user');
 await act(async()=>{await expect(mockConversation.onRevert(message,operationId)).rejects.toThrow('未确认');});
 await view.unmount();view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));
 await waitFor(()=>expect(mockConversation.uncertain).toBe(true));
 history.events.push({...baseEvent,type:'session.reverted',id:'other-user',turnId:'other-turn',operationId:'81cb3fd6-9bb1-46b8-8d31-3e77ca1bbfe1',ts:3});
 await act(async()=>mockConversation.onRefresh());await waitFor(()=>expect(mockConversation.loading).toBe(false));
 expect(mockConversation.canSend).toBe(false);
 history.events.push({...baseEvent,type:'session.reverted',id:'edit-user',turnId:'edit-turn',operationId,ts:4});
 await act(async()=>mockConversation.onRefresh());await waitFor(()=>expect(mockConversation.canSend).toBe(true));
 expect(mockConversation.timeline.items.some((item:any)=>item.id==='edit-user')).toBe(false);
 expect(mockSettings.get('direct_pending_operations_v1')).toBe('{}');
 expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.revert')).toHaveLength(1);
 expect(mockRequest.mock.calls.some(([command])=>command.type==='session.send')).toBe(false);
 await view.unmount();
});

test.each(['ready','read-only','running','archived','failed-read'] as const)('an immediate pre-render send after revert uses the refreshed admission: %s',async state=>{
 let reverted=false;
 const editable={...session,latestTurnRevert:true};
 const events=[{...baseEvent,type:'message',id:'edit-user',role:'user',text:'Original edit',final:true,turnId:'edit-turn',ts:1},
  {...baseEvent,type:'turn',status:'completed',turnId:'edit-turn',ts:2}];
 mockRequest.mockImplementation(async(command:any)=>{
  if(command.type==='agents.status')return {agents:[{id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,capabilities:{list:true,send:true,steer:true,latestTurnRevert:true},api}]};
  if(command.type==='projects.list')return {projects:[{path:'C:/project',name:'Project'}]};
  if(command.type==='sessions.list')return {sessions:[editable]};
  if(command.type==='session.open'){
   if(reverted&&state==='failed-read')throw new Error('Snapshot failed');
   const changed=state==='read-only'?{controllable:false,controlSurface:'read-only'}:state==='running'?{status:'running',activeTurnId:'next-turn'}:state==='archived'?{archived:true}:{};
   return {session:{...editable,...(reverted?changed:{})},events:reverted?[]:events};
  }
  if(command.type==='session.revert'){reverted=true;return {status:'completed',sessionKey:command.sessionKey,turnId:command.expectedTurnId,messageId:command.expectedMessageId,operationId:command.operationId};}
  if(command.type==='session.send'||command.type==='session.steer')return {via:'background'};
  throw new Error(`Unexpected ${command.type}`);
 });
 const view=await openReady(),captured=mockConversation,message=mockConversation.timeline.items.find((item:any)=>item.id==='edit-user');
 await act(async()=>{
  await captured.onRevert(message,'b3d117de-91f8-4850-b1a7-425848c809f2');
  // Deliberately no act/render boundary between the revert and old callback.
  expect(Boolean(await captured.onSend({owner,inputText:'Revised task'}))).toBe(state==='ready');
 });
 expect(mockRequest.mock.calls.some(([command])=>command.type==='session.send'||command.type==='session.steer')).toBe(state==='ready');
 await view.unmount();
});

test('unmounting during the durable pending write prevents dispatch and clears the definitely unsent marker',async()=>{
 setupTurns();const view=await openReady();
 let finish!:()=>void,started!:()=>void;const writing=new Promise<void>(resolve=>{started=resolve;}),blocked=new Promise<void>(resolve=>{finish=resolve;});
 mockPendingWriteGate=async(key,value)=>{if(key==='direct_pending_operations_v1'&&value.includes('"kind":"send"')){started();await blocked;}};
 let flight!:Promise<boolean|undefined>;
 await act(async()=>{flight=mockConversation.onSend({owner,inputText:'Must remain unsent'});await writing;});
 await view.unmount();
 await act(async()=>{finish();expect(await flight).toBe(false);});
 expect(mockRequest.mock.calls.some(([command])=>command.type==='session.send')).toBe(false);
 expect(mockSettings.get('direct_pending_operations_v1')).toBe('{}');
});
