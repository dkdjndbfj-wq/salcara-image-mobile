import { parseHubEvent, sessionEventsPage, setHubFetch, type HubEvent } from '../remote/client';
import { isDirectEvent, normalizeDirectEvent } from '../remote/direct-history';
import { applyEvent, EMPTY_TIMELINE, mergeHistory } from '../remote/store';
import type { SessionInfo } from '../remote/client';

const base = { deviceId:'pc', sessionKey:'hermes:fixture', tool:'hermes', ts:1, seq:1 };
const approvalId = 'hermes:fixture:prompt-1';
const samples = [
  {type:'tool',id:'tool-1',kind:'other',title:'Read file',status:'completed',output:'result',outputFinal:true},
  {type:'notice',level:'warning',text:'Check the computer'},
  {type:'notice',text:'Progress'},
  {type:'notice',level:'',text:'Progress'},
  {type:'approval.resolved',approvalId},
  {type:'approval.resolved',approvalId,decision:'allow'},
  {type:'approval.resolved',approvalId,decision:'unknown',by:'unknown'},
  {type:'approval.resolved',approvalId,decision:'',by:''},
];
afterEach(()=>setHubFetch(null));
test.each(samples)('old Hermes event is consumable through both transports: %j',sample=>{
  const wire={...base,...sample};
  const hub=parseHubEvent(wire)!;
  expect(hub).toBeDefined();expect(isDirectEvent(wire,'pc',base.sessionKey)).toBe(true);
  expect(normalizeDirectEvent(wire as HubEvent,'pc')).toEqual(hub);
  const timeline=applyEvent(EMPTY_TIMELINE,hub);
  expect(timeline.items).toHaveLength(1);
  if(sample.type==='tool')expect(timeline.items[0]).toMatchObject({status:'done',output:'result'});
  if(sample.type==='approval.resolved')expect(timeline.items[0]).toMatchObject({state:sample.decision==='allow'?'allow':'resolved'});
});
test('unknown settlement closes an approval without inventing a grant and later known receipt enriches it',()=>{
  let timeline=applyEvent(EMPTY_TIMELINE,{...base,type:'approval.request',approvalId,kind:'tool',title:'Approve'});
  timeline=applyEvent(timeline,parseHubEvent({...base,seq:2,type:'approval.resolved',approvalId})!);
  expect(timeline.items[0]).toMatchObject({state:'resolved',by:undefined});
  timeline=applyEvent(timeline,{...base,seq:3,type:'approval.resolved',approvalId,decision:'deny',by:'phone'});
  timeline=applyEvent(timeline,parseHubEvent({...base,seq:4,type:'approval.resolved',approvalId})!);
  expect(timeline.items[0]).toMatchObject({state:'deny',by:'phone'});
  timeline=applyEvent(timeline,{...base,seq:5,type:'approval.request',approvalId,kind:'tool',title:'Old replay'});
  expect(timeline.items[0]).toMatchObject({state:'deny',by:'phone'});
});
test('raw old snapshot tool state is normalized without changing turn completed',()=>{
  const tool={...base,...samples[0]} as HubEvent;
  expect(applyEvent(EMPTY_TIMELINE,tool).items[0]).toMatchObject({status:'done'});
  expect(parseHubEvent({...base,type:'turn',status:'completed'})).toMatchObject({status:'completed'});
});
test.each([
  {tool:'claude',sessionKey:'claude:fixture'}, {sessionKey:'hermes:other'},
  {approvalId:'hermes:other:prompt-1'}, {decision:null}, {by:null}, {approvalId:'hermes:fixture:'},
])('compatibility never repairs another identity or malformed field: %j',change=>{
  const wire={...base,type:'approval.resolved',approvalId,...change};
  expect(()=>parseHubEvent(wire)).toThrow();
  expect(isDirectEvent(wire,'pc',String(wire.sessionKey))).toBe(false);
});
test('future values are skipped and field limits still apply',()=>{
  expect(parseHubEvent({...base,type:'notice',level:'future',text:'Future'})).toBeUndefined();
  expect(()=>parseHubEvent({...base,type:'notice',text:7})).toThrow();
  expect(()=>parseHubEvent({...base,type:'approval.resolved',approvalId:'hermes:fixture:'+ 'x'.repeat(513)})).toThrow();
});
test('persisted legacy rows no longer pin the event page before a valid reply',async()=>{
  const lastSeq=samples.length+1;
  const events=[...samples.map((row,index)=>({...base,...row,seq:index+1})),{...base,seq:lastSeq,type:'message',id:'reply',role:'assistant',text:'Finished',final:true}];
  setHubFetch((async()=>({ok:true,status:200,text:async()=>JSON.stringify({events,nextSeq:lastSeq,lastSeq,hasMore:false})})) as any);
  const page=await sessionEventsPage({url:'https://fixture.invalid',deviceId:'pc'},'pc',base.sessionKey,0);
  expect(page.nextSeq).toBe(lastSeq);expect(page.events).toHaveLength(lastSeq);expect(page.events.at(-1)).toMatchObject({text:'Finished'});
});

const session:SessionInfo={sessionKey:base.sessionKey,tool:'hermes',client:'Hermes',title:'Original',cwd:'C:/fixture',status:'idle',controllable:true,updatedAt:1};
const settled=(decision:'allow'|'deny'|'unknown',by:'phone'|'desktop'|'unknown',seq:number):HubEvent=>({...base,type:'approval.resolved',approvalId,decision,by,seq});
test.each([true,false])('snapshot/live merge preserves the known decision in either direction (%s)', knownLive=>{
  const known=settled('deny','phone',2),unknown=settled('unknown','unknown',9);
  const live=applyEvent(EMPTY_TIMELINE,knownLive?known:unknown);
  const merged=mergeHistory(live,session,[knownLive?unknown:known]);
  expect(merged.items[0]).toMatchObject({state:'deny',by:'phone'});
});
test('authoritative unknown settlement replaces local expiry through live and either snapshot merge direction',()=>{
  const expired=applyEvent(EMPTY_TIMELINE,{...base,seq:9,type:'approval.request',approvalId,kind:'question',title:'Expired locally',expiresAt:Date.now()-1});
  expect(expired.items[0]).toMatchObject({state:'deny',by:'timeout'});
  const event=settled('unknown','unknown',10);
  expect(applyEvent(expired,event).items[0]).toMatchObject({state:'resolved',by:undefined});
  expect(mergeHistory(expired,session,[event]).items[0]).toMatchObject({state:'resolved',by:undefined});
  const authoritative=applyEvent(EMPTY_TIMELINE,event);
  expect(mergeHistory(authoritative,session,[{...base,seq:11,type:'approval.request',approvalId,kind:'question',title:'Old expired replay',expiresAt:Date.now()-1}]).items[0]).toMatchObject({state:'resolved',by:undefined});
});
test('a different known decision with unknown provenance never inherits the old actor',()=>{
  let timeline=applyEvent(EMPTY_TIMELINE,settled('deny','phone',2));
  timeline=mergeHistory(timeline,session,[settled('allow','unknown',3)]);
  expect(timeline.items[0]).toMatchObject({state:'allow',by:undefined});
});

const frozen:HubEvent={...base,type:'notice',id:'hermes-frozen-source',level:'warn',noticeKind:'session_source_frozen',errorCode:'session_source_frozen',text:'Original source is frozen'};
test('only a current original-session source notice restricts sending and a fresh read clears it',()=>{
  const reply:HubEvent={...base,type:'message',id:'reply',role:'assistant',text:'Original history',final:true};
  const first=mergeHistory(EMPTY_TIMELINE,session,[reply,frozen]);
  expect(first.sourceFrozen).toBe(true);
  expect(first.items.find(item=>item.kind==='notice')).toMatchObject({noticeKind:'session_source_frozen'});
  const partial=mergeHistory(first,session,[],new Set(),false);
  expect(partial.sourceFrozen).toBe(true);
  const refreshed=mergeHistory(partial,session,[]);
  expect(refreshed.sourceFrozen).toBe(false);
  expect(refreshed.items).toEqual([expect.objectContaining({text:'Original history'})]);
  expect(applyEvent({...EMPTY_TIMELINE,session},frozen).sourceFrozen).toBe(true);
});
test('model or API labels and other-session or child notices do not assert a source restriction',()=>{
  for(const event of [{...frozen,sessionKey:'hermes:other'}, {...frozen,parentId:'child'}, {...frozen,tool:'claude' as const}]){
    expect(mergeHistory(EMPTY_TIMELINE,session,[event]).sourceFrozen).toBe(false);
  }
  expect(mergeHistory(EMPTY_TIMELINE,{...session,model:'different-name'},[]).sourceFrozen).toBe(false);
});
