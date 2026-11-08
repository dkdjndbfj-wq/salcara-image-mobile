import {parseHubEvent} from '../remote/client';
import {applyEvent,EMPTY_TIMELINE} from '../remote/store';
import {liveComputerActivityIds,parseComputerActivity} from '../remote/computer-activity';
import type {TimelineItem} from '../remote/store';
import {executionLabel} from '../remote/execution-presentation';
jest.mock('../storage/database',()=>({getSetting:async()=>null,setSetting:async()=>undefined}));
jest.mock('../storage/secure-keys',()=>({getProviderKey:async()=>null}));
const computer={version:1,surface:'computer',action:'script',provider:'cua_repl'};
const event=(extra:Record<string,unknown>={})=>({type:'tool',deviceId:'pc',sessionKey:'codex:a',tool:'codex',ts:10,id:'actual-call',kind:'mcp',title:'调用 cua_repl.js',status:'running',...extra});
test.each(['running','done','failed','interrupted'])('computer metadata and actual state survive parsing and reduction: %s',status=>{
 const parsed=parseHubEvent(event({status,computer}));expect(parsed).toMatchObject({computer,status});
 const item=applyEvent(EMPTY_TIMELINE,parsed!).items[0];expect(item).toMatchObject({computer,status});
 if(item.kind==='tool')expect(executionLabel(item)).toContain(status==='failed'?'失败':status==='interrupted'?'已中断':status==='running'?'正在执行':'已完成');
});
test.each([null,{}, {...computer,version:2},{...computer,provider:'untrusted'},{...computer,surface:'browser'},{...computer,action:'execute-shell'}])('invalid metadata does not make ordinary calls computer activity',value=>{
 expect(parseComputerActivity(value)).toBeUndefined();expect(parseHubEvent(event({computer:value}))).not.toHaveProperty('computer');
});
test('text claiming computer use does not become computer activity',()=>{expect(parseHubEvent(event({title:'Computer Use',output:'taking screenshot and clicking'}))).not.toHaveProperty('computer');});
test('image receipts remain tied to the actual call and survive terminal update',()=>{
 const attachments=[{id:`att_${'a'.repeat(32)}`,mime:'image/png'}];
 const started=applyEvent(EMPTY_TIMELINE,parseHubEvent(event({computer}))!);
 const done=applyEvent(started,parseHubEvent(event({computer,status:'done',attachments}))!);
 expect(done.items).toHaveLength(1);expect(done.items[0]).toMatchObject({computer,attachments,status:'done'});
});

const call=(id:string,turnId?:string,parentId?:string):Extract<TimelineItem,{kind:'tool'}>=>({kind:'tool',id,turnId,parentId,tool:'mcp',title:'computer',status:'running',ts:10,computer:{version:1,surface:'computer',action:'script',provider:'cua_repl'}});
const boundary=(turnId:string,status:'started'|'completed',ts:number,parentId?:string):TimelineItem=>({kind:'turn',id:`${turnId}:${status}`,turnId,parentId,status,ts});
test('a new turn cannot revive an old unfinished computer call, even with a late session snapshot',()=>{
 const ids=liveComputerActivityIds([call('old','turn-1'),call('current','turn-2'),call('unscoped')],[boundary('turn-1','started',1),boundary('turn-1','completed',2),boundary('turn-2','started',3)],{status:'running',activeTurnId:'turn-1'});
 expect([...ids]).toEqual(['current']);
});
test('a terminal boundary vetoes a stale running session and tool',()=>{
 const ids=liveComputerActivityIds([call('old','turn-1')],[boundary('turn-1','started',1),boundary('turn-1','completed',2)],{status:'running',activeTurnId:'turn-1'});
 expect(ids.size).toBe(0);
});
test('a new session turn arriving before its start event does not revive an unfinished old call',()=>{
 const ids=liveComputerActivityIds([call('old','turn-1')],[boundary('turn-1','started',1)],{status:'running',activeTurnId:'turn-2'});
 expect(ids.size).toBe(0);
});
test('mixed legacy timestamps and new sequence cursors use established timeline order',()=>{
 const ids=liveComputerActivityIds([call('new','turn-2')],[boundary('turn-1','completed',1700000000000),{...boundary('turn-2','started',1700000000001),seq:42}],{status:'running',activeTurnId:'turn-2'});
 expect([...ids]).toEqual(['new']);
});
test('child operation needs its own active turn rather than inheriting parent activity',()=>{
 const tools=[call('parent','turn-1'),call('child','turn-1','child-call')];
 expect([...liveComputerActivityIds(tools,[],{status:'running',activeTurnId:'turn-1'})]).toEqual(['parent']);
 expect([...liveComputerActivityIds(tools,[boundary('turn-1','started',1,'child-call')],{status:'waiting_approval',activeTurnId:'turn-1'})]).toEqual(['parent','child']);
 expect(liveComputerActivityIds(tools,[boundary('turn-1','started',1)],{status:'idle'}).size).toBe(0);
});
