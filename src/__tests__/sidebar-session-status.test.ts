import type {SessionInfo,SessionStatus} from '../remote/client';
import {sidebarSessionStatus} from '../remote/sidebar-session-status';
import type {Timeline,TimelineItem} from '../remote/store';

const row:SessionInfo={sessionKey:'codex:task',tool:'codex',client:'Codex',title:'Task',cwd:'/project',workspaceMode:'code',
  status:'idle',updatedAt:100,controllable:true,controlSurface:'cli'};
const snapshot=(session:Partial<SessionInfo>={},extra:Partial<Timeline>={}):Timeline=>({items:[],loading:false,snapshotAt:1000,
  session:{...row,...session},...extra});
const turn=(id:string,status:'started'|'completed'|'failed'|'interrupted',extra:Partial<Extract<TimelineItem,{kind:'turn'}>>={}):TimelineItem=>
  ({kind:'turn',id:`${id}:${status}`,turnId:id,status,ts:101,...extra});

test('a loaded live session updates a stale directory row even during a history refresh',()=>{
  expect(sidebarSessionStatus(row,snapshot({status:'running',updatedAt:101},{loading:true}))).toBe('running');
  expect(sidebarSessionStatus(row,snapshot({status:'running'}))).toBe('running');
  expect(row.status).toBe('idle');
});

test.each(['idle','failed','waiting_approval','unknown'] as SessionStatus[])('a newer live %s state stops the directory running indicator',status=>{
  expect(sidebarSessionStatus({...row,status:'running'},snapshot({status,updatedAt:101}))).toBe(status);
});

test.each([
  ['missing timeline',undefined],
  ['missing snapshot',snapshot({status:'running'},{snapshotAt:undefined})],
  ['cached snapshot',snapshot({status:'running'},{cachedAt:900})],
  ['failed snapshot',snapshot({status:'running'},{error:'offline'})],
  ['older session',snapshot({status:'running',updatedAt:99})],
  ['different session',snapshot({status:'running',sessionKey:'codex:another'})],
  ['different tool',snapshot({status:'running',tool:'claude'})],
  ['different surface',snapshot({status:'running',controlSurface:'desktop'})],
  ['different workspace',snapshot({status:'running',workspaceMode:'work'})],
] as const)('%s cannot replace the directory status',(_reason,timeline)=>{
  expect(sidebarSessionStatus(row,timeline)).toBe('idle');
});

test('legacy CLI surfaces match but read-only Chat and Cowork scopes remain separate',()=>{
  expect(sidebarSessionStatus({...row,controlSurface:undefined},snapshot({status:'running'}))).toBe('running');
  const readonly={...row,controlSurface:'read-only' as const,sessionScope:'desktop-chat' as const};
  expect(sidebarSessionStatus(readonly,snapshot({...readonly,status:'running',sessionScope:'desktop-cowork'}))).toBe('idle');
});

test('pending confirmation is static and an expired or resolved request cannot create it',()=>{
  const approval:TimelineItem={kind:'approval',id:'question',approval:'question',title:'Confirm',state:'pending',ts:101,expiresAt:Date.now()+60_000};
  expect(sidebarSessionStatus(row,snapshot({status:'running'},{items:[approval]}))).toBe('waiting_approval');
  expect(sidebarSessionStatus(row,snapshot({status:'running'},{items:[{...approval,expiresAt:1}]}))).toBe('running');
  expect(sidebarSessionStatus(row,snapshot({status:'running'},{items:[{...approval,state:'allow'}]}))).toBe('running');
});

test.each(['completed','interrupted','failed'] as const)('a matching %s root boundary stops stale running without a Direct session cursor',status=>{
  const timeline=snapshot({status:'running',activeTurnId:'current'},{items:[turn('current','started',{ts:90}),turn('current',status,{ts:99})]});
  expect(sidebarSessionStatus(row,timeline)).toBe(status==='failed'?'failed':'idle');
});

test('a late old terminal and a child terminal cannot stop a different current run',()=>{
  const timeline=snapshot({status:'running',activeTurnId:'new'},{items:[turn('old','started',{ts:80}),turn('new','started',{ts:99}),
    turn('old','completed',{ts:105}),turn('new','completed',{ts:106,parentId:'child'})]});
  expect(sidebarSessionStatus(row,timeline)).toBe('running');
});

test.each([
  ['tool', {kind:'tool',id:'old-tool',tool:'command',title:'Old command',status:'running',ts:80}],
  ['partial output', {kind:'message',id:'old-output',role:'assistant',text:'Old partial',final:false,ts:80}],
  ['old start', turn('old','started',{ts:99})],
] as const)('historical %s does not promote an idle snapshot to running',(_kind,item)=>{
  expect(sidebarSessionStatus(row,snapshot({}, {items:[item as TimelineItem]}))).toBe('idle');
});

test.each([
  ['newer sequence',11,10,99,'running'],
  ['older sequence despite later timestamp',9,10,101,'idle'],
  ['Direct newer timestamp',undefined,undefined,101,'running'],
  ['Direct equal timestamp',undefined,undefined,100,'idle'],
] as const)('%s only promotes an explicitly newer root start',(_kind,seq,sessionSeq,ts,status)=>{
  expect(sidebarSessionStatus(row,snapshot({}, {sessionSeq,items:[turn('new','started',{seq,ts})]}))).toBe(status);
});

test('a new run already terminated in the same snapshot is not revived by its start',()=>{
  expect(sidebarSessionStatus(row,snapshot({activeTurnId:'old'}, {sessionSeq:10,items:[turn('new','started',{seq:11}),turn('new','failed',{seq:12})]}))).toBe('failed');
});

test('an unidentified terminal stops running only with newer ordering evidence',()=>{
  const running=snapshot({status:'running'}, {sessionSeq:10,items:[turn('old','completed',{seq:9,ts:101})]});
  expect(sidebarSessionStatus(row,running)).toBe('running');
  expect(sidebarSessionStatus(row,{...running,items:[turn('new','completed',{seq:11})]})).toBe('idle');
});
