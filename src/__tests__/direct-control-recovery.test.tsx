import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';

const mockMessages=new Set<(frame:unknown)=>void>(),mockConnections=new Set<()=>void>();
const mockSettings=new Map<string,string>(),mockSend=jest.fn();
let mockConnection:any={status:'connected',deviceId:'pc',deviceName:'Computer'},mockGeneration=1,mockConversation:any;
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,setSetting:async(key:string,value:string)=>{mockSettings.set(key,value);}}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_algorithm:string,value:string)=>require('node:crypto').createHash('sha256').update(value).digest('hex')}));
jest.mock('../remote/direct-pairing',()=>({
  getDirectConnectionState:()=>mockConnection,directDeliveryScope:()=> 'pairing',directConnectionGeneration:()=>mockGeneration,
  subscribeDirectConnection:(listener:()=>void)=>{mockConnections.add(listener);return()=>mockConnections.delete(listener);},
  subscribeDirectMessages:(listener:(frame:unknown)=>void)=>{mockMessages.add(listener);return()=>mockMessages.delete(listener);},
  sendDirectPayload:(frame:unknown)=>mockSend(frame),
}));
jest.mock('../remote/direct-workspace',()=>({createDirectWorkspaceRuntime:()=>({scope:'pairing'})}));
jest.mock('../remote/DirectNewComposer',()=>({DirectNewComposer:()=>null}));
jest.mock('../remote/DirectConversation',()=>({DirectConversation:(props:any)=>{mockConversation=props;return null;}}));

const { cancelDirectRequests }=require('../remote/direct-api') as typeof import('../remote/direct-api');
const { DirectExperience }=require('../remote/DirectExperience') as typeof import('../remote/DirectExperience');

const session={sessionKey:'codex:thread',tool:'codex',client:'Codex CLI',title:'Original',cwd:'C:/project',updatedAt:1,status:'running',activeTurnId:'turn-1',controllable:true,controlSurface:'cli'};
const api={name:'API',model:'model',protocol:'responses',configured:true,pending:false,source:'computer',accountId:'api_00112233'};
const base={deviceId:'pc',sessionKey:session.sessionKey,tool:'codex'};
let hostHistory:any,capabilities:any,hostApi:any,interrupt:'timeout'|'requested'|'reject'|'wrong'|'stopped';
const deliver=(frame:unknown)=>mockMessages.forEach(listener=>listener(frame));
const commands=(type:string)=>mockSend.mock.calls.map(([frame])=>frame.command).filter(command=>command.type===type);
beforeEach(()=>{
  cancelDirectRequests();jest.useFakeTimers();jest.clearAllMocks();mockSettings.clear();mockGeneration=1;
  mockConnection={status:'connected',deviceId:'pc',deviceName:'Computer'};mockConversation=undefined;interrupt='timeout';
  Object.defineProperty(AppState,'currentState',{configurable:true,value:'active'});
  capabilities={list:true,read:true,send:true,interrupt:true,preciseInterrupt:true,approval:true,questions:true};hostApi=api;
  hostHistory={session,events:[{...base,type:'turn',status:'started',turnId:'turn-1',ts:1}]};
  // Exercise the production command allowlist, JSON snapshot, request IDs,
  // response parser and timeout. The host fixture rejects every unknown call.
  mockSend.mockImplementation((frame:any)=>{
    expect(frame.type).toBe('command');expect(frame.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const command=frame.command;let result:unknown,error:string|undefined;
    switch(command.type){
      case 'agents.status':result={agents:[{id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,capabilities,api:hostApi}]};break;
      case 'projects.list':result={projects:[{path:'C:/project',name:'Project'}]};break;
      case 'sessions.list':expect(command).toMatchObject({tool:'codex',controlSurface:'cli'});result={sessions:[session]};break;
      case 'session.open':expect(command).toMatchObject({sessionKey:session.sessionKey,controlSurface:'cli'});result=hostHistory;break;
      case 'session.interrupt':
        expect(Object.keys(command).sort()).toEqual(['controlSurface','expectedTurnId','operationId','sessionKey','type']);
        expect(command).toMatchObject({sessionKey:session.sessionKey,controlSurface:'cli',expectedTurnId:'turn-1'});
        expect(command.operationId).toMatch(/^[0-9a-f-]{36}$/);
        if(interrupt==='timeout')return;
        if(interrupt==='reject')error='turn_control_stale: target no longer active';
        else result={turnId:interrupt==='wrong'?'other-turn':'turn-1',status:interrupt==='stopped'?'stopped':'requested'};
        break;
      case 'approval.respond':
        expect(command).toMatchObject({sessionKey:session.sessionKey,controlSurface:'cli',accountId:api.accountId,approvalId:'approval-1'});
        expect(capabilities.approval).toBe(true);if(command.answers)expect(capabilities.questions).toBe(true);result={};break;
      default:throw new Error(`Unexpected host command ${command.type}`);
    }
    void Promise.resolve().then(()=>deliver(error?{type:'response',requestId:frame.requestId,error}:{type:'response',requestId:frame.requestId,result}));
  });
});
afterEach(()=>{cancelDirectRequests();jest.useRealTimers();});
async function open(){const view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));await waitFor(()=>expect(mockConversation.canSend).toBe(true));return view;}
async function stop(){await act(async()=>{mockConversation.onStop();});}
function terminal(turnId='turn-1',parentId?:string){return {...base,type:'turn',status:'interrupted',turnId,ts:5,...(parentId?{parentId}:{})};}

test.each(['timeout','requested','wrong'] as const)('%s stop settles only on its own terminal and never marks the message draft uncertain',async reply=>{
  interrupt=reply;const view=await open();await act(async()=>mockConversation.onText('keep my next draft'));await stop();
  if(reply==='timeout')await act(async()=>{jest.advanceTimersByTime(20001);});
  expect(mockConversation.stopPending).toBe(true);expect(mockConversation.uncertain).toBe(false);expect(mockConversation.canSend).toBe(false);
  // Empty durable-message storage, an idle status, an unrelated terminal and
  // a child with the same turn ID must not accidentally settle this stop.
  hostHistory={session:{...session,status:'idle',activeTurnId:undefined},events:[hostHistory.events[0],terminal('other-turn'),terminal('turn-1','child')]};
  hostApi={...api,name:'Refreshed API display name'};
  await act(async()=>{await mockConversation.onRefresh();});
  expect(mockConversation.stopPending).toBe(true);expect(mockConversation.canSend).toBe(false);
  hostHistory={session:{...session,status:'idle',activeTurnId:undefined,lastTerminalTurnId:'turn-1'},events:[hostHistory.events[0],terminal()]};
  await act(async()=>{jest.advanceTimersByTime(15000);});
  await waitFor(()=>expect(mockConversation.stopPending).toBe(false));expect(mockConversation.canSend).toBe(true);
  expect(mockConversation.text).toBe('keep my next draft');expect(commands('session.interrupt')).toHaveLength(1);
  expect(commands('session.send')).toHaveLength(0);expect(mockSettings.get('direct_pending_operations_v1')).toBeUndefined();await view.unmount();
});

test('a definitive host rejection does not leave either a stop or a message delivery lock',async()=>{
  interrupt='reject';const view=await open();await stop();
  await waitFor(()=>expect(mockConversation.sending).toBe(false));expect(mockConversation.stopPending).toBe(false);expect(mockConversation.uncertain).toBe(false);
  expect(mockConversation.canSend).toBe(true);expect(mockConversation.error).toContain('turn_control_stale');await view.unmount();
});

test('a verified stopped receipt settles immediately and preserves the draft',async()=>{
  interrupt='stopped';const view=await open();await act(async()=>mockConversation.onText('draft'));await stop();
  await waitFor(()=>expect(mockConversation.sending).toBe(false));expect(mockConversation.stopPending).toBe(false);expect(mockConversation.uncertain).toBe(false);
  expect(mockConversation.text).toBe('draft');await view.unmount();
});

test('a terminal arriving over the real event parser settles a lost stop response without another interrupt',async()=>{
  const view=await open();await stop();await act(async()=>{jest.advanceTimersByTime(20001);});
  await act(async()=>{deliver({type:'event',event:'turn',data:terminal()});});
  expect(mockConversation.stopPending).toBe(false);expect(mockConversation.uncertain).toBe(false);expect(commands('session.interrupt')).toHaveLength(1);await view.unmount();
});

test('retiring the connection clears its stop state and a late old receipt cannot change the new conversation',async()=>{
  const view=await open();await stop();const oldFrame=mockSend.mock.calls.find(([frame])=>frame.command.type==='session.interrupt')![0];
  await act(async()=>{mockConnection={...mockConnection,status:'closed'};mockGeneration++;mockConnections.forEach(listener=>listener());});
  await act(async()=>{mockConnection={...mockConnection,status:'connected'};mockGeneration++;mockConnections.forEach(listener=>listener());});
  await waitFor(()=>expect(mockConversation.canSend).toBe(true));expect(mockConversation.stopPending).toBe(false);
  await act(async()=>{deliver({type:'response',requestId:oldFrame.requestId,result:{turnId:'turn-1',status:'stopped'}});});
  expect(mockConversation.stopPending).toBe(false);expect(commands('session.interrupt')).toHaveLength(1);await view.unmount();
});

test.each([
  ['tool',false,true,'allow',undefined],['question',true,false,'allow',{answer:['yes']}],['question',true,false,'deny',undefined],
] as const)('blocks %s decision when its published approval/question capability is missing',async(kind,approval,questions,decision,answers)=>{
  capabilities={...capabilities,approval,questions};hostHistory.events.push({...base,type:'approval.request',approvalId:'approval-1',kind,title:'Confirm',ts:2});
  const view=await open();expect(mockConversation.timeline.items.some((item:any)=>item.kind==='approval'&&item.id==='approval-1')).toBe(true);await act(async()=>mockConversation.onRespond('approval-1',decision,answers));
  expect(commands('approval.respond')).toHaveLength(0);expect(mockConversation.error).toContain('不支持手机');await view.unmount();
});

test('supported structured answers preserve exact session and account through the real Direct command schema',async()=>{
  hostHistory.events.push({...base,type:'approval.request',approvalId:'approval-1',kind:'question',title:'Confirm',ts:2});
  const view=await open();await act(async()=>mockConversation.onRespond('approval-1','allow',{answer:['yes']}));
  await waitFor(()=>expect(commands('approval.respond')).toHaveLength(1));expect(commands('approval.respond')[0].answers).toEqual({answer:['yes']});await view.unmount();
});
