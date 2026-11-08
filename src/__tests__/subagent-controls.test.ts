import { captureDirectSubagents, captureHubSubagents, subagentControlReason, type SubagentSelection, type SubagentSnapshot } from '../remote/subagent-controls';
import { requestDirect } from '../remote/direct-api';
import { continueSession, interruptSession, openSession } from '../remote/store';

jest.mock('expo-crypto',()=>({randomUUID:()=> '11111111-2222-4333-8444-555555555555'}));
jest.mock('../remote/direct-api',()=>({requestDirect:jest.fn()}));
let mockScope='binding',mockGeneration=1,mockState:any,mockConnection:any,mockCredentials:any;
jest.mock('../remote/direct-pairing',()=>({directDeliveryScope:()=>mockScope,directConnectionGeneration:()=>mockGeneration,getDirectConnectionState:()=>mockConnection}));
jest.mock('../remote/store',()=>({EMPTY_TIMELINE:{items:[],loading:false},getRemoteState:()=>mockState,watchCredentials:()=>mockCredentials,remoteDeliveryScope:()=>mockScope,
  timelineKey:(device:string,key:string)=>`${device}|${key}`,openSession:jest.fn(),interruptSession:jest.fn(),continueSession:jest.fn()}));
jest.mock('../remote/direct-history',()=>({parseDirectHistoryPage:(raw:any,_device:string,expected:any)=>{if(raw.session.sessionKey!==expected.sessionKey)throw new Error('wrong session');return raw;},
  mergeDirectHistoryPage:(_timeline:any,page:any)=>({items:page.events,session:page.session,loading:false})}));
const selection:SubagentSelection={deviceId:'pc',parentSessionKey:'codex:parent',surface:'cli',children:['codex:child'],agent:{id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,api:{accountId:'account-a'} as any,capabilities:{interrupt:true,preciseInterrupt:true,continue:true} as any}};
const child={sessionKey:'codex:child',tool:'codex',client:'Codex',cwd:'C:/project',title:'Review',updatedAt:1,status:'running',activeTurnId:'turn-1',controllable:true,controlSurface:'cli',parentSessionKey:'codex:parent'} as const;
const snapshot=():SubagentSnapshot=>({session:{...child},timeline:{items:[],session:{...child},loading:false,snapshotAt:1} as any});
const request=requestDirect as jest.Mock;
beforeEach(()=>{jest.clearAllMocks();mockScope='binding';mockGeneration=1;mockConnection={status:'connected',deviceId:'pc'};mockCredentials={url:'https://example.test',pairToken:'binding-a'};
  mockState={connection:'open',devices:[{deviceId:'pc',online:true}],agents:{pc:{list:[selection.agent]}},timelines:{['pc|codex:child']:snapshot().timeline}};
});
test.each(['desktop','read-only'] as const)('never substitutes CLI control for a %s child',async surface=>{
  const selected={...selection,surface};expect(subagentControlReason(selected,snapshot(),'stop')).toContain('桌面宿主');
  await expect(captureDirectSubagents(selected,()=>true).stop(snapshot())).rejects.toThrow('桌面宿主');expect(request).not.toHaveBeenCalled();
});
test('parent-child identity is required and conflicting host metadata wins',async()=>{
  const value=snapshot();value.session.parentSessionKey='codex:another';
  expect(subagentControlReason(selection,value,'stop')).toContain('关系');
  await expect(captureDirectSubagents(selection,()=>true).stop(value)).rejects.toThrow('不属于');expect(request).not.toHaveBeenCalled();
});
test('direct child stop uses that child and exact turn, checks host receipt',async()=>{
  const transport=captureDirectSubagents(selection,()=>true);request.mockResolvedValue({turnId:'turn-1',status:'requested'});
  await expect(transport.stop(snapshot())).resolves.toBe('requested');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({type:'session.interrupt',sessionKey:'codex:child',expectedTurnId:'turn-1',controlSurface:'cli'}));
  request.mockResolvedValue({turnId:'turn-2',status:'stopped'});await expect(transport.stop(snapshot())).rejects.toThrow('未确认');
});
test('direct child continuation is a new turn in the same real child, never creation',async()=>{
  const value=snapshot();value.session={...value.session,status:'failed',activeTurnId:undefined,lastTerminalTurnId:'finished-1'};value.timeline.session=value.session;
  request.mockResolvedValue({accepted:true,sessionKey:'codex:child',previousTurnId:'finished-1',operationId:'11111111-2222-4333-8444-555555555555'});await captureDirectSubagents(selection,()=>true).continue(value);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({type:'session.continue',sessionKey:'codex:child',expectedTurnId:'finished-1',accountId:'account-a'}),{timeoutMs:100000});
  expect(request.mock.calls.some(call=>call[0].type==='session.start')).toBe(false);
});
test.each([
  {accepted:false}, {sessionKey:'codex:other'}, {previousTurnId:'other-turn'}, {operationId:'other-operation'},
])('direct continuation rejects a mismatched receipt without replay: %s',async mismatch=>{
  const value=snapshot();value.session={...value.session,status:'failed',activeTurnId:undefined,lastTerminalTurnId:'finished-1'};value.timeline.session=value.session;
  request.mockResolvedValue({accepted:true,sessionKey:'codex:child',previousTurnId:'finished-1',operationId:'11111111-2222-4333-8444-555555555555',...mismatch});
  await expect(captureDirectSubagents(selection,()=>true).continue(value)).rejects.toThrow('未确认');expect(request).toHaveBeenCalledTimes(1);
});
test('direct late reads and actions after reconnect cannot update or stop a replacement',async()=>{
  const transport=captureDirectSubagents(selection,()=>true);let resolve!:(value:any)=>void;request.mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const reading=transport.read('codex:child');mockGeneration++;resolve({session:child,events:[]});await expect(reading).rejects.toThrow('已变化');
  await expect(transport.stop(snapshot())).rejects.toThrow('已变化');expect(request).toHaveBeenCalledTimes(1);
});
test('hub child stop refuses an updated turn before dispatch',async()=>{
  const transport=captureHubSubagents(selection),value=snapshot();mockState.timelines['pc|codex:child'].session.activeTurnId='turn-2';
  await expect(transport.stop(value)).rejects.toThrow('轮次已变化');expect(interruptSession).not.toHaveBeenCalled();
});
test('hub child continuation guards API account and binding',async()=>{
  const transport=captureHubSubagents(selection);mockCredentials={...mockCredentials,pairToken:'replacement'};
  await expect(transport.read('codex:child')).rejects.toThrow('已变化');expect(openSession).not.toHaveBeenCalled();expect(continueSession).not.toHaveBeenCalled();
});
test('missing capability or controllability produces a reason without guessing support',()=>{
  expect(subagentControlReason({...selection,agent:{...selection.agent,capabilities:undefined}},snapshot(),'stop')).toContain('不支持');
  const value=snapshot();value.session.controllable=false;expect(subagentControlReason(selection,value,'continue')).toContain('只支持查看');
});
