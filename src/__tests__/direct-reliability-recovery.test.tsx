import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DirectExperience } from '../remote/DirectExperience';

let mockConnection:any={status:'connected',deviceId:'pc',deviceName:'Computer'},mockGeneration=1;
const mockConnectionListeners=new Set<()=>void>(),mockEventListeners=new Set<(event:any)=>void>();
const mockRequest=jest.fn(),mockSettings=new Map<string,string>();
const mockConsume=jest.fn(async(..._args:unknown[])=>{});
jest.mock('../remote/composer-drafts',()=>({...jest.requireActual('../remote/composer-drafts'),consumeAcceptedComposerDraft:(...args:unknown[])=>mockConsume(...args)}));
let mockConversation:any,mockNewComposer:any;
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,setSetting:async(key:string,value:string)=>{mockSettings.set(key,value);}}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID()}));
jest.mock('../remote/direct-pairing',()=>({getDirectConnectionState:()=>mockConnection,subscribeDirectConnection:(fn:()=>void)=>{mockConnectionListeners.add(fn);return()=>mockConnectionListeners.delete(fn);},directDeliveryScope:()=> 'pairing',directConnectionGeneration:()=>mockGeneration}));
jest.mock('../remote/direct-api',()=>({requestDirect:(...args:unknown[])=>mockRequest(...args),subscribeDirectEvents:(fn:(event:any)=>void)=>{mockEventListeners.add(fn);return()=>mockEventListeners.delete(fn);}}));
jest.mock('../remote/direct-workspace',()=>({createDirectWorkspaceRuntime:()=>({scope:'pairing'})}));
jest.mock('../remote/DirectNewComposer',()=>({DirectNewComposer:(props:any)=>{mockNewComposer=props;return null;}}));
jest.mock('../remote/DirectConversation',()=>({DirectConversation:(props:any)=>{mockConversation=props;const React=require('react'),{Text}=require('react-native');return React.createElement(Text,{testID:'draft'},props.text);}}));
const session={sessionKey:'codex:thread',tool:'codex',client:'Codex CLI',title:'Original',cwd:'C:/project',updatedAt:1,status:'running',controllable:true,controlSurface:'cli'};
const api={name:'API',model:'model',protocol:'responses',configured:true,pending:false,source:'computer',accountId:'api_00112233'};
const base={deviceId:'pc',sessionKey:session.sessionKey,tool:'codex'};
const startOwner=JSON.stringify(['pairing','pc',null,'codex','api_00112233','C:/project','code']);
let hostHistory:any,foreground:(state:string)=>void;
beforeEach(()=>{
  jest.useFakeTimers();jest.clearAllMocks();mockSettings.clear();mockConnectionListeners.clear();mockEventListeners.clear();mockGeneration=1;
  mockConnection={status:'connected',deviceId:'pc',deviceName:'Computer'};mockNewComposer=undefined;mockConversation=undefined;
  Object.defineProperty(AppState,'currentState',{configurable:true,value:'active'});
  jest.spyOn(AppState,'addEventListener').mockImplementation((_event,listener:any)=>{foreground=state=>{Object.defineProperty(AppState,'currentState',{configurable:true,value:state});listener(state);};return {remove:jest.fn()};});
  hostHistory={session,events:[{...base,type:'turn',status:'started',turnId:'turn-1',ts:1},{...base,type:'message',id:'answer',role:'assistant',text:'half',final:false,turnId:'turn-1',ts:2}]};
  mockRequest.mockImplementation(async(command:any)=>{
    if(command.type==='agents.status')return {agents:[{id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,capabilities:{list:true,send:true},api}]};
    if(command.type==='projects.list')return {projects:[{path:'C:/project',name:'Project'}]};
    if(command.type==='sessions.list')return {sessions:[session]};
    if(command.type==='session.open')return hostHistory;
    if(command.type==='session.start')throw Object.assign(new Error('receipt lost after the host accepted'),{code:'timeout'});
    throw new Error(`Unexpected ${command.type}`);
  });
});
afterEach(()=>{jest.restoreAllMocks();jest.useRealTimers();});
async function open(){const view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));await waitFor(()=>expect(mockConversation.canSend).toBe(true));return view;}
function completeHost(){hostHistory={session:{...session,status:'idle',lastTerminalTurnId:'turn-1'},events:[...hostHistory.events,{...base,type:'message',id:'answer',role:'assistant',text:'complete host answer',final:true,turnId:'turn-1',ts:3},{...base,type:'turn',status:'completed',turnId:'turn-1',ts:4}]};}
test('repairs a dropped final output on a still-connected socket without replacing the composer draft',async()=>{
  const view=await open();await act(async()=>mockConversation.onText('next draft'));
  completeHost(); // Neither the final message nor terminal event reaches the live socket.
  await act(async()=>{jest.advanceTimersByTime(15000);});
  await waitFor(()=>expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').text).toBe('complete host answer'));
  expect(mockConversation.text).toBe('next draft');expect(mockConversation.session.status).toBe('idle');
  expect(mockRequest.mock.calls.some(([command])=>['session.send','session.start'].includes(command.type))).toBe(false);await view.unmount();
});
test('returning to the foreground repairs lost events and keeps already loaded history',async()=>{
  const view=await open();completeHost();
  await act(async()=>{foreground('background');foreground('active');});
  await waitFor(()=>expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').final).toBe(true));
  expect(mockConversation.timeline.items.some((item:any)=>item.kind==='turn'&&item.status==='started')).toBe(true);await view.unmount();
});
test('reconnecting the same pairing restores the selected conversation and unsent input',async()=>{
  const view=await open();await act(async()=>mockConversation.onText('retained draft'));
  await act(async()=>{mockConnection={...mockConnection,status:'closed'};mockGeneration++;mockConnectionListeners.forEach(fn=>fn());});
  completeHost();
  await act(async()=>{mockConnection={...mockConnection,status:'connected'};mockGeneration++;mockConnectionListeners.forEach(fn=>fn());});
  await waitFor(()=>expect(view.queryByTestId('draft')).not.toBeNull());
  await waitFor(()=>expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').final).toBe(true));
  expect(mockConversation.text).toBe('retained draft');await view.unmount();
});
test('a lost start receipt survives remount and blocks a second operation ID for the same project draft',async()=>{
  let view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'新建 Code 对话'}));
  await waitFor(()=>expect(mockNewComposer).toBeDefined());
  await act(async()=>{await mockNewComposer.onSend('create original task',{owner:startOwner,attachments:['att_00112233445566778899aabbccddeeff']});});
  await view.unmount();mockNewComposer=undefined;
  view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'新建 Code 对话'}));await waitFor(()=>expect(mockNewComposer).toBeDefined());
  await act(async()=>{await mockNewComposer.onSend('create original task',{owner:startOwner,attachments:['att_00112233445566778899aabbccddeeff']});});
  expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.start')).toHaveLength(1);
  expect(mockNewComposer.uncertain).toBe(true);await view.unmount();
});
test('only the exact original start echo unlocks creation and consumes its original draft revision',async()=>{
  const view=await render(<DirectExperience/>);await fireEvent.press(await view.findByRole('button',{name:'新建 Code 对话'}));
  await waitFor(()=>expect(mockNewComposer.uncertain).toBe(false));
  const draftReceipt={revision:3,identity:'12345678-1234-4123-8123-123456789abc'};
  await act(async()=>{await mockNewComposer.onSend('original prompt',{owner:startOwner,draftReceipt});});
  const command=mockRequest.mock.calls.find(([value])=>value.type==='session.start')![0];
  expect(command).not.toHaveProperty('draftReceipt');
  hostHistory={session,events:[{...base,type:'message',id:'input',role:'user',text:'original prompt',final:true,clientId:'different-operation',ts:1}]};
  await fireEvent.press(await view.findByRole('button',{name:'核对新建结果'}));
  expect(mockConsume).not.toHaveBeenCalled();expect(mockSettings.get('direct_pending_operations_v1')).toContain(command.operationId);
  hostHistory.events[0].clientId=command.operationId;
  await fireEvent.press(await view.findByRole('button',{name:'核对新建结果'}));
  await waitFor(()=>expect(view.queryByTestId('draft')).not.toBeNull());
  expect(mockConsume).toHaveBeenCalledWith(expect.stringContaining('direct-composer:'),'pairing',3,draftReceipt.identity);
  expect(mockSettings.get('direct_pending_operations_v1')).toBe('{}');
  expect(mockRequest.mock.calls.filter(([value])=>value.type==='session.start')).toHaveLength(1);await view.unmount();
});
test('history recovery replays newer live events buffered while its snapshot is in flight',async()=>{
  const view=await open();let finish!:(value:unknown)=>void;
  const previous=mockRequest.getMockImplementation()!;
  mockRequest.mockImplementation((command:any,...args:any[])=>command.type==='session.open'?new Promise(resolve=>{finish=resolve;}):previous(command,...args));
  await act(async()=>{jest.advanceTimersByTime(15000);});
  await act(async()=>{mockEventListeners.forEach(listener=>listener({event:'message',data:{...base,type:'message',id:'answer',role:'assistant',text:'newer streamed final',final:true,turnId:'turn-1',ts:10}}));});
  await act(async()=>{finish(hostHistory);});
  await waitFor(()=>expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').text).toBe('newer streamed final'));
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').final).toBe(true);await view.unmount();
});
test('a rejected history read retains the partial text and retries only a read on the next interval',async()=>{
  const view=await open(),previous=mockRequest.getMockImplementation()!;let failed=false;
  mockRequest.mockImplementation((command:any,...args:any[])=>{if(command.type==='session.open'&&!failed){failed=true;return Promise.reject(new Error('temporary link failure'));}return previous(command,...args);});
  await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').text).toBe('half');
  expect(mockConversation.timeline.error).toBeUndefined();
  const reads=mockRequest.mock.calls.filter(([command])=>command.type==='session.open').length;
  completeHost();await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.open')).toHaveLength(reads);
  await act(async()=>{jest.advanceTimersByTime(15000);});
  await waitFor(()=>expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').text).toBe('complete host answer'));
  expect(mockRequest.mock.calls.some(([command])=>['session.send','session.start'].includes(command.type))).toBe(false);await view.unmount();
});
test('an unchanged idle reply needs three successful reads and a full minute before marking incomplete',async()=>{
  hostHistory={session:{...session,status:'idle',lastTerminalTurnId:'turn-1'},events:[...hostHistory.events,{...base,type:'reasoning',id:'reason',text:'partial reasoning',final:false,turnId:'turn-1',ts:3},{...base,type:'turn',status:'completed',turnId:'turn-1',ts:4}]};
  const view=await open();
  for(let i=0;i<3;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).not.toBe('incomplete');
  for(let i=0;i<2;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer')).toMatchObject({text:'half',final:false,streamState:'incomplete'});
  const reads=mockRequest.mock.calls.filter(([command])=>command.type==='session.open').length;
  await act(async()=>{jest.advanceTimersByTime(60000);});
  expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.open')).toHaveLength(reads);await view.unmount();
});
test('successful snapshots during a quiet running task never mark the partial output incomplete',async()=>{
  const view=await open();for(let i=0;i<4;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  const reply=mockConversation.timeline.items.find((item:any)=>item.id==='answer');expect(reply.final).toBe(false);expect(reply.streamState).not.toBe('incomplete');
  expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.open')).toHaveLength(5);await view.unmount();
});
async function exhaustIdle(){
  hostHistory={session:{...session,status:'idle',lastTerminalTurnId:'turn-1'},events:[...hostHistory.events,{...base,type:'turn',status:'completed',turnId:'turn-1',ts:4}]};
  const view=await open();for(let i=0;i<5;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer')).toMatchObject({final:false,streamState:'incomplete'});return view;
}
test('a longer late live partial restarts recovery and its final host snapshot replaces the incomplete warning',async()=>{
  const view=await exhaustIdle();
  await act(async()=>{mockEventListeners.forEach(listener=>listener({event:'message',data:{...base,type:'message',id:'answer',role:'assistant',text:'half plus late output',final:false,turnId:'turn-1',ts:8}}));});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').text).toBe('half plus late output');
  completeHost();await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer')).toMatchObject({text:'complete host answer',final:true});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).toBeUndefined();await view.unmount();
});
test('foreground recovery remains available after automatic idle repair is exhausted',async()=>{
  const view=await exhaustIdle();completeHost();await act(async()=>{foreground('background');foreground('active');});
  await waitFor(()=>expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').final).toBe(true));await view.unmount();
});
test('leaving and reopening a conversation creates a fresh idle-repair budget',async()=>{
  const view=await exhaustIdle();await act(async()=>mockConversation.onBack());await fireEvent.press(await view.findByRole('button',{name:'打开对话 Original'}));
  await waitFor(()=>expect(mockConversation.canSend).toBe(true));await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).not.toBe('incomplete');await view.unmount();
});

test('rapid foreground changes cannot consume the quiet grace period',async()=>{
  hostHistory={...hostHistory,session:{...session,status:'idle'}};
  const view=await open();
  for(let i=0;i<5;i++)await act(async()=>{foreground('background');foreground('active');});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).not.toBe('incomplete');
  expect(mockRequest.mock.calls.some(([command])=>['session.send','session.start'].includes(command.type))).toBe(false);await view.unmount();
});

test('background time is quiet and returning starts a fresh successful-read grace period',async()=>{
  hostHistory={...hostHistory,session:{...session,status:'idle'}};
  const view=await open();
  for(let i=0;i<3;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  await act(async()=>{foreground('background');});
  const reads=mockRequest.mock.calls.filter(([command])=>command.type==='session.open').length;
  await act(async()=>{jest.advanceTimersByTime(10*60_000);});
  expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.open')).toHaveLength(reads);
  await act(async()=>{foreground('active');});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).not.toBe('incomplete');
  for(let i=0;i<3;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).not.toBe('incomplete');
  await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).toBe('incomplete');await view.unmount();
});

test('reconnect revision cannot issue a history recovery while backgrounded',async()=>{
  const view=await open();await act(async()=>{foreground('background');});
  Object.defineProperty(AppState,'currentState',{configurable:true,value:'background'});
  const reads=mockRequest.mock.calls.filter(([command])=>command.type==='session.open').length;
  await act(async()=>{mockConnection={...mockConnection,status:'closed'};mockGeneration++;mockConnectionListeners.forEach(fn=>fn());});
  await act(async()=>{mockConnection={...mockConnection,status:'connected'};mockGeneration++;mockConnectionListeners.forEach(fn=>fn());});
  await waitFor(()=>expect(view.queryByTestId('draft')).not.toBeNull());
  expect(mockRequest.mock.calls.filter(([command])=>command.type==='session.open')).toHaveLength(reads);
  completeHost();Object.defineProperty(AppState,'currentState',{configurable:true,value:'active'});
  await act(async()=>{foreground('active');});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').final).toBe(true);await view.unmount();
});

test('a failed snapshot starts a new stable confirmation window after the connection recovers',async()=>{
  hostHistory={...hostHistory,session:{...session,status:'idle'}};
  const view=await open(),previous=mockRequest.getMockImplementation()!;
  for(let i=0;i<3;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  let fail=true;mockRequest.mockImplementation((command:any,...args:any[])=>command.type==='session.open'&&fail?Promise.reject(new Error('short interruption')):previous(command,...args));
  await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.error).toBeUndefined();fail=false;
  await act(async()=>{jest.advanceTimersByTime(30000);});
  for(let i=0;i<3;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).not.toBe('incomplete');
  await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).toBe('incomplete');await view.unmount();
});

test('a new partial fragment gets a new stable confirmation window',async()=>{
  hostHistory={...hostHistory,session:{...session,status:'idle'}};
  const view=await open();for(let i=0;i<4;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  hostHistory={...hostHistory,events:[...hostHistory.events,{...base,type:'message',id:'answer',role:'assistant',text:'half plus new fragment',final:false,turnId:'turn-1',ts:10}]};
  await act(async()=>{jest.advanceTimersByTime(15000);});
  for(let i=0;i<3;i++)await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer')).toMatchObject({text:'half plus new fragment',final:false});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').streamState).not.toBe('incomplete');
  completeHost();await act(async()=>{jest.advanceTimersByTime(15000);});
  expect(mockConversation.timeline.items.find((item:any)=>item.id==='answer').final).toBe(true);await view.unmount();
});
