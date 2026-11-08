import {bytesToHex} from '@noble/hashes/utils.js';
import {sha256} from '@noble/hashes/sha2.js';
import {CANVAS_LIMITS,CANVAS_STORE_KEY,boundedCanvasSession,freshCanvasRecord,loadCanvasRecord,recordCanvasNotes,redoCanvasNotes,retireCanvasNotes,saveCanvasRecord,undoCanvasNotes,type CanvasRecord} from '../remote/canvas-session';
import type {ImageNote} from '../remote/conversation-images';
import {setSetting} from '../storage/database';
const mockSettings=new Map<string,string>();
jest.mock('../storage/database',()=>({getSetting:jest.fn(async(key:string)=>mockSettings.get(key)??null),setSetting:jest.fn(async(key:string,value:string|null)=>{if(value===null)mockSettings.delete(key);else mockSettings.set(key,value);})}));
const key=(id:string,revision='v1')=>JSON.stringify([id,revision]);
const note:ImageNote={id:'note-a',imageId:'image-a',imageRevision:'v1',comment:'修改标题',region:{x:.1,y:.2,width:.3,height:.4}};

test('history keeps IDs, numbers and image revisions stable, limits depth and clears redo on a new action',()=>{
 let record=recordCanvasNotes(freshCanvasRecord('history'),[note]);
 const original=record.notes[0];expect(original.number).toBe(1);
 for(let i=0;i<40;i++)record=recordCanvasNotes(record,[{...record.notes[0],comment:`修改 ${i}`}]);
 expect(record.history.past).toHaveLength(CANVAS_LIMITS.historySteps);const edited=record.notes[0];record=undoCanvasNotes(record);expect(record.notes[0]).toMatchObject({id:original.id,number:1,imageId:'image-a',imageRevision:'v1'});
 expect(redoCanvasNotes(record).notes[0]).toEqual(edited);record=recordCanvasNotes(record,[{...record.notes[0],comment:'新方向'}]);expect(record.history.future).toEqual([]);
 record=recordCanvasNotes(record,[]);record=recordCanvasNotes(record,[{...note,id:'note-b'}]);expect(record.notes[0].number).toBe(2);expect(record.history.nextNumber).toBe(3);
});

test('retirement strips successful submissions from all historical snapshots but retains unrelated work',()=>{
 const other={...note,id:'note-b',imageId:'image-b',imageRevision:'v7',comment:'另一张图'};
 let record=recordCanvasNotes(freshCanvasRecord('retire'),[note,other]);record=recordCanvasNotes(record,record.notes.map(n=>({...n,comment:`更新 ${n.comment}`})));record=undoCanvasNotes(record);
 record.session.drafts={'edit:note-a':{comment:'已提交备注的旧编辑草稿'},[key('image-b','v7')]:{comment:'尚未添加的新草稿'}};
 const retired=retireCanvasNotes(record,new Set(['note-a']));
 expect([...retired.notes,...retired.history.past.flat(),...retired.history.future.flat()].every(n=>n.id!=='note-a')).toBe(true);
 expect(retired.notes[0]).toMatchObject({id:'note-b',number:2,imageRevision:'v7'});expect(retired.session.drafts['edit:note-a']).toBeUndefined();expect(retired.session.drafts[key('image-b','v7')].comment).toBe('尚未添加的新草稿');
});

test('untrusted persisted sessions are validated and bounded without loading image bytes',()=>{
 const drafts=Object.fromEntries(Array.from({length:100},(_,i)=>[key(`image-${i}`),{comment:'文字'.repeat(2000),region:{x:.1,y:.1,width:.5,height:.5}}]));
 const views=Object.fromEntries(Array.from({length:100},(_,i)=>[key(`image-${i}`),{zoom:2,x:5,y:-5}]));
 const session=boundedCanvasSession('scope',{scopeKey:'different',focusedKey:key('image-99'),selected:[key('image-99'),key('image-99'),'invalid'],drafts:{...drafts,invalid:{comment:'bad'},[key('bad')]:{comment:'bad region',region:{x:-1,y:0,width:1,height:1}}},views:{...views,[key('unsafe')]:{zoom:Infinity,x:0,y:0}},selectedOnly:true});
 expect(session.scopeKey).toBe('scope');expect(session.selected).toEqual([key('image-99')]);expect(Object.keys(session.drafts).length).toBeLessThanOrEqual(CANVAS_LIMITS.drafts);expect(new TextEncoder().encode(JSON.stringify(session.drafts)).length).toBeLessThanOrEqual(CANVAS_LIMITS.draftBytes);expect(session.drafts[key('image-99')]).toBeTruthy();expect(session.drafts[key('bad')]).toBeUndefined();expect(session.views[key('unsafe')]).toBeUndefined();expect(Object.keys(session.views).length).toBeLessThanOrEqual(CANVAS_LIMITS.views);
});

test('a fresh runtime reloads the complete durable record without in-memory session references',async()=>{
 let record=recordCanvasNotes(freshCanvasRecord('restart-computer/agent/api/project/work/session'),[note]);
 record=undoCanvasNotes(record);record.session={scopeKey:record.scopeKey,initialized:true,focused:'image-a',focusedKey:key('image-a'),selected:[key('image-a')],drafts:{[key('image-a')]:{comment:'重启继续',region:note.region}},views:{[key('image-a')]:{zoom:2,x:30,y:-20}},selectedOnly:true};
 await saveCanvasRecord(record);
 let restarted!:typeof import('../remote/canvas-session');jest.isolateModules(()=>{restarted=require('../remote/canvas-session');});
 const loaded=await restarted.loadCanvasRecord(record.scopeKey);expect(loaded.session).toEqual(record.session);expect(loaded.history.future).toEqual(record.history.future);expect(loaded.notes).toEqual([]);
 expect((await restarted.loadCanvasRecord('restart-computer/agent/api/project/code/session')).session.drafts).toEqual({});
});

test('a newer queued session write wins over a delayed older write',async()=>{
 const implementation=jest.mocked(setSetting).getMockImplementation()!;
 let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),begun=new Promise<void>(resolve=>{started=resolve;});
 jest.mocked(setSetting).mockImplementationOnce(async(k,value)=>{started();await gate;await implementation(k,value);});
 const first=freshCanvasRecord('queued-record');first.session.drafts={[key('image')]:{comment:'旧文字'}};
 const saving=saveCanvasRecord(first);await begun;
 const second={...first,session:{...first.session,drafts:{[key('image')]:{comment:'新文字'}}}};const latest=saveCanvasRecord(second);release();await Promise.all([saving,latest]);
 expect((await loadCanvasRecord('queued-record')).session.drafts[key('image')].comment).toBe('新文字');
});

test('bounded storage evicts least-recent scopes and cannot resurrect their legacy annotations',async()=>{
 const legacyScope='legacy-evicted',hash=bytesToHex(sha256(new TextEncoder().encode(legacyScope))),legacyKey=`remote_image_canvas_v1_${hash}`;
 mockSettings.set(legacyKey,JSON.stringify([note]));const legacy=await loadCanvasRecord(legacyScope);expect(legacy.notes).toEqual([note]);await saveCanvasRecord(legacy);expect(mockSettings.has(legacyKey)).toBe(false);
 for(let i=0;i<CANVAS_LIMITS.scopes+2;i++)await saveCanvasRecord(freshCanvasRecord(`recent-scope-${i}`));
 const raw=mockSettings.get(CANVAS_STORE_KEY)!,stored=JSON.parse(raw) as {records:CanvasRecord[]};expect(stored.records.length).toBeLessThanOrEqual(CANVAS_LIMITS.scopes);expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(CANVAS_LIMITS.storeBytes);
 expect((await loadCanvasRecord(legacyScope)).notes).toEqual([]);expect(stored.records.some(record=>record.scopeKey===`recent-scope-${CANVAS_LIMITS.scopes+1}`)).toBe(true);
});

test('history size is bounded even for long comments and a failed write stays retryable',async()=>{
 let record=freshCanvasRecord('large-history');for(let i=0;i<30;i++)record=recordCanvasNotes(record,Array.from({length:20},(_,j)=>({...note,id:`note-${j}`,comment:`${i}-${j} ${'文'.repeat(3900)}`})));
 expect(new TextEncoder().encode(JSON.stringify([record.history.past,record.history.future])).length).toBeLessThanOrEqual(CANVAS_LIMITS.historyBytes);
 jest.mocked(setSetting).mockRejectedValueOnce(new Error('disk full'));await expect(saveCanvasRecord(record)).rejects.toThrow('disk full');expect((await loadCanvasRecord(record.scopeKey)).notes).toEqual(record.notes);
 await saveCanvasRecord(record);expect((await loadCanvasRecord(record.scopeKey)).notes).toEqual(record.notes);
});
