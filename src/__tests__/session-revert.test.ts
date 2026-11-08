import {applyEvent,mergeHistory,type Timeline} from '../remote/store';
import {parseHubEvent,type HubEvent} from '../remote/client';
import {isDirectEvent,readDirectHistoryWithRevertGuard} from '../remote/direct-history';
import {latestEditableTurn,parseSessionRevertResult} from '../remote/session-revert';
import type {SentUserMessage} from '../remote/sent-message-revision';
jest.mock('../storage/database',()=>({getSetting:async()=>null,setSetting:async()=>undefined}));
jest.mock('../storage/secure-keys',()=>({getProviderKey:async()=>''}));
const user:SentUserMessage={kind:'message',id:'last-user',turnId:'last',role:'user',text:'task',final:true,ts:3};
const timeline=():Timeline=>({loading:false,snapshotAt:20,session:{sessionKey:'codex:main',tool:'codex',client:'Codex',title:'task',cwd:'/p',updatedAt:10,status:'idle',controllable:true,controlSurface:'cli',latestTurnRevert:true},items:[
 {kind:'message',id:'old-user',turnId:'old',role:'user',text:'earlier',final:true,ts:1},
 {kind:'turn',id:'old-end',turnId:'old',status:'completed',ts:2},user,
 {kind:'tool',id:'changed-file',turnId:'last',tool:'file_change',title:'file.ts',status:'done',ts:4},
 {kind:'message',id:'reply',role:'assistant',text:'answer without native turn marker',final:true,ts:5},
 {kind:'turn',id:'last-end',turnId:'last',status:'completed',ts:6}]});
const reverted:HubEvent={type:'session.reverted',deviceId:'pc',sessionKey:'codex:main',tool:'codex',ts:30,turnId:'last',id:user.id,operationId:'operation',seq:40};
test('only one confirmed latest user in a settled native turn can be edited',()=>{
 expect(latestEditableTurn(timeline(),user)).toBe('last');
 for(const extra of [{cachedAt:1},{loading:true},{error:'offline'},{snapshotAt:undefined}])expect(latestEditableTurn({...timeline(),...extra},user)).toBeUndefined();
 for(const status of ['running','waiting_approval','unknown'] as const)expect(latestEditableTurn({...timeline(),session:{...timeline().session!,status}},user)).toBeUndefined();
 expect(latestEditableTurn(timeline(),{...user,turnId:undefined})).toBeUndefined();
 expect(latestEditableTurn({...timeline(),items:[...timeline().items,{...user,id:'steered'}]}, {...user,id:'steered'})).toBeUndefined();
 expect(latestEditableTurn({...timeline(),session:{...timeline().session!,latestTurnRevert:false}},user)).toBeUndefined();
});
test('revert removes only the selected turn and fences stale history and live fragments',()=>{
 const next=applyEvent(timeline(),reverted);
 expect(next.items.map(item=>item.id)).toEqual(['old-user','old-end']);
 expect(next.revertedItems).toContain('reply');
 const late:HubEvent={...reverted,type:'message',id:'reply',role:'assistant',text:'late',final:true};
 expect(applyEvent(next,late)).toBe(next);
 expect(mergeHistory(next,next.session,[late]).items.map(item=>item.id)).toEqual(['old-user','old-end']);
 expect(mergeHistory(next,next.session,[{...late,id:'new-fragment'}]).items.map(item=>item.id)).toEqual(['old-user','old-end']);
});
test('a newer turn already received is retained while a delayed revert removes its target',()=>{
 const input=timeline();input.items.push({kind:'turn',id:'new-start',turnId:'new',status:'started',ts:31},{...user,id:'new-user',turnId:'new',text:'new task',ts:32});
 expect(applyEvent(input,reverted).items.map(item=>item.id)).toEqual(['old-user','old-end','new-start','new-user']);
});
test('replay is idempotent and unknown unloaded target cannot delete unrelated history',()=>{
 const next=applyEvent(timeline(),reverted);expect(applyEvent(next,reverted).items).toEqual(next.items);
 expect(applyEvent(timeline(),{...reverted,turnId:'absent',id:'absent-user'}).items).toEqual(timeline().items);
});
test('Hub and Direct both validate authoritative reverted event identities',()=>{
 expect(parseHubEvent(reverted)).toEqual(reverted);expect(isDirectEvent(reverted,'pc','codex:main')).toBe(true);
 expect(()=>parseHubEvent({...reverted,id:''})).toThrow();expect(isDirectEvent({...reverted,id:''},'pc','codex:main')).toBe(false);
 expect(()=>parseHubEvent({...reverted,parentId:'child'})).toThrow();
});
test('revert acknowledgements bind all operation identities and never turn unknown into completed',()=>{
 const request={sessionKey:'codex:main',expectedTurnId:'last',expectedMessageId:'last-user',operationId:'operation'};
 const raw={status:'completed',sessionKey:request.sessionKey,turnId:'last',messageId:'last-user',operationId:'operation'};
 expect(parseSessionRevertResult(raw,request).status).toBe('completed');
 expect(parseSessionRevertResult({...raw,status:'unconfirmed'},request).status).toBe('unconfirmed');
 for(const key of ['sessionKey','turnId','messageId','operationId','status'])expect(()=>parseSessionRevertResult({...raw,[key]:'wrong'},request)).toThrow();
});

const wireUser=(id:string,turnId?:string):HubEvent=>({type:'message',deviceId:'pc',sessionKey:'codex:main',tool:'codex',ts:3,id,turnId,role:'user',text:id,final:true});
const untagged=(id:string):HubEvent=>({type:'message',deviceId:'pc',sessionKey:'codex:main',tool:'codex',ts:5,id,role:'assistant',text:id,final:true});
const end=(turnId:string):HubEvent=>({type:'turn',deviceId:'pc',sessionKey:'codex:main',tool:'codex',ts:6,turnId,status:'completed'});
const untaggedTool:HubEvent={type:'tool',deviceId:'pc',sessionKey:'codex:main',tool:'codex',ts:4,id:'unseen-tool',kind:'command',title:'old command',status:'done'};

test('late native page boundaries remove unseen untagged outputs while retaining a newer turn and its outputs',()=>{
 const current=applyEvent(timeline(),reverted);
 const next=mergeHistory(current,current.session,[wireUser('last-user','last'),untaggedTool,untagged('unseen-answer'),end('last'),wireUser('new-user','new'),untagged('new-answer'),end('new')]);
 expect(next.items.map(item=>item.id)).not.toEqual(expect.arrayContaining(['unseen-answer','unseen-tool','last-user']));
 expect(next.items.map(item=>item.id)).toEqual(expect.arrayContaining(['old-user','new-user','new-answer']));
 expect(next.revertedItems).toEqual(expect.arrayContaining(['unseen-answer','unseen-tool']));
 expect(mergeHistory(next,next.session,[untagged('unseen-answer')]).items.some(item=>item.id==='unseen-answer')).toBe(false);
});

test.each([false,true])('page-tail tombstones work before any cache and when the operation was already applied (%s)',seen=>{
 const current=seen?applyEvent(timeline(),reverted):{items:[],loading:false};
 const next=mergeHistory(current,timeline().session,[wireUser('last-user','last'),untagged('never-seen'),untaggedTool,end('last'),reverted]);
 expect(next.items.some(item=>['last-user','never-seen','unseen-tool'].includes(item.id))).toBe(false);
 expect(next.revertedItems).toEqual(expect.arrayContaining(['never-seen','unseen-tool']));
 expect(next.revertOperations).toEqual(['operation']);
});

test('a partial older page with its terminal anchor removes only that proven prefix; an untagged new user is a barrier',()=>{
 const current=applyEvent(timeline(),reverted);
 const prefix=mergeHistory(current,current.session,[untagged('partial-old-answer'),untaggedTool,end('last'),reverted]);
 expect(prefix.items.some(item=>['partial-old-answer','unseen-tool'].includes(item.id))).toBe(false);
 const newer=mergeHistory(current,current.session,[wireUser('last-user','last'),end('last'),wireUser('new-without-turn'),untagged('new-without-turn-answer'),reverted]);
 expect(newer.items.map(item=>item.id)).toEqual(expect.arrayContaining(['new-without-turn','new-without-turn-answer']));
 // Equal clock values alone cannot associate output with a revoked turn.
 expect(mergeHistory(current,current.session,[untagged('unattributed'),reverted]).items.some(item=>item.id==='unattributed')).toBe(true);
});

test('Direct discards a boundary-free late page and rereads the new head once while retaining concurrent new-turn events',async()=>{
 const nextUser=wireUser('concurrent-new-user','new');
 const read=jest.fn(async()=>({session:timeline().session!,events:[untagged('stale-no-boundaries')],nextCursor:'stale-cursor'}));
 read.mockResolvedValueOnce({session:timeline().session!,events:[untagged('stale-no-boundaries')],nextCursor:'stale-cursor'}).mockResolvedValueOnce({session:timeline().session!,events:[untagged('fresh-answer')],nextCursor:'fresh-cursor'});
 const take=jest.fn<HubEvent[],[]>(()=>[]).mockReturnValueOnce([reverted,nextUser]);
 const retained=jest.fn();
 const result=await readDirectHistoryWithRevertGuard(timeline(),read,take,()=>true,retained);
 expect(read.mock.calls).toEqual([[false],[true]]);expect(result?.nextCursor).toBe('fresh-cursor');
 expect(result?.timeline.items.map(item=>item.id)).toEqual(expect.arrayContaining(['old-user','concurrent-new-user','fresh-answer']));
 expect(result?.timeline.items.some(item=>item.id==='stale-no-boundaries')).toBe(false);expect(retained).toHaveBeenCalledTimes(1);
});

test('Direct repeated concurrent reverts stop after one retry and retain the newest live event without accepting stale content',async()=>{
 const read=jest.fn(async()=>({session:timeline().session!,events:[untagged('never-admit')],nextCursor:'stale'}));
 const second={...reverted,id:'second-user',turnId:'second',operationId:'second-revert'};
 const take=jest.fn<HubEvent[],[]>(()=>[]).mockReturnValueOnce([reverted]).mockReturnValueOnce([second,wireUser('third-user','third')]);
 const result=await readDirectHistoryWithRevertGuard(timeline(),read,take,()=>true);
 expect(read).toHaveBeenCalledTimes(2);expect(result?.invalidated).toBe(true);expect(result?.nextCursor).toBeUndefined();
 expect(result?.timeline.items.some(item=>item.id==='never-admit')).toBe(false);expect(result?.timeline.items.some(item=>item.id==='third-user')).toBe(true);
 expect(result?.timeline.error).toContain('请刷新');
});

test('Direct publishes the retained tombstone before retry so a failed retry cannot revive or discard the concurrent turn',async()=>{
 const read=jest.fn(async()=>({session:timeline().session!,events:[untagged('old-page')]})).mockRejectedValueOnce(new Error('connection failed'));
 // Fail the fresh-head read, after the original stale page has been rejected.
 read.mockReset().mockResolvedValueOnce({session:timeline().session!,events:[untagged('old-page')]}).mockRejectedValueOnce(new Error('connection failed'));
 const retain=jest.fn();
 await expect(readDirectHistoryWithRevertGuard(timeline(),read,()=>[reverted,wireUser('new-user','new')],()=>true,retain)).rejects.toThrow('connection failed');
 expect(retain.mock.calls[0][0].revertOperations).toEqual(['operation']);
 expect(retain.mock.calls[0][0].items.map((item:any)=>item.id)).toContain('new-user');
});
