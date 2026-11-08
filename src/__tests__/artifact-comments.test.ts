import {artifactCommentsInput,parseElementSelection,type ArtifactComment,type ArtifactElementSelection} from '../remote/artifact-annotations';
import {loadArtifactComments,parseCommentRecord,saveArtifactComments,type ArtifactCommentRecord} from '../remote/artifact-comment-store';
import {getSetting,setSetting} from '../storage/database';
const mockSettings=new Map<string,string>();
jest.mock('../storage/database',()=>({getSetting:jest.fn(async(key:string)=>mockSettings.get(key)??null),setSetting:jest.fn(async(key:string,value:string|null)=>{if(value===null)mockSettings.delete(key);else mockSettings.set(key,value);})}));
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=';
const selection:ArtifactElementSelection={kind:'element',quote:'标题',selector:'#title',group:'顶部',outerHTML:'<h1 id="title">标题</h1>',computed:{'font-size':'24px'},rect:{x:40,y:50,width:160,height:30},viewport:{width:800,height:600},screenshot:{base64:png,width:1,height:1}};
const note:ArtifactComment={id:'note-1',number:1,selection,comment:'标题缩小'};
const record=(comment:string):ArtifactCommentRecord=>({notes:[{...note,comment}],nextNumber:2});

test('batch input carries actual screenshots with exact grouped location JSON and stable comment numbers',()=>{
 const notes=[{...note,number:3},{...note,id:'note-2',number:8,selection:{...selection,group:'底部',selector:'#footer'}},{...note,id:'note-3',number:12,selection:{...selection,selector:'#subtitle',screenshot:undefined,kind:undefined}}];
 const input=artifactCommentsInput('原消息：source-message\n版本：source-revision',notes);
 expect(input.images).toHaveLength(2);expect(input.images[0]).toMatchObject({mime:'image/png',base64:png,width:1,height:1});expect(input.text).toContain('版本：source-revision');expect(input.text).toContain('批注 3：标题缩小\n附图 1：批注 3');expect(input.text).toContain('批注 8：标题缩小\n附图 2：批注 8');expect(input.text).toContain('批注 12：标题缩小');expect(input.text).toContain('位置分组：顶部');expect(input.text).toContain('位置分组：底部');
 const locations=input.text.split('\n').filter(line=>line.startsWith('页面定位数据：')).map(line=>JSON.parse(line.slice('页面定位数据：'.length)));
 expect(locations[0]).toMatchObject({selector:'#title',rect:selection.rect,viewport:selection.viewport,computed:selection.computed,outerHTML:selection.outerHTML});expect(locations.every(location=>!('screenshot' in location))).toBe(true);expect(input.text).not.toContain(png);
});

test('element/region capture errors stop image submission while plain text comments remain supported',()=>{
 expect(()=>artifactCommentsInput('origin',[{...note,selection:{...selection,screenshot:undefined,captureError:'截图超出范围'}}])).toThrow('截图超出范围');
 expect(()=>artifactCommentsInput('origin',[{...note,selection:{...selection,kind:'region',screenshot:undefined,captureError:undefined}}])).toThrow('局部截图尚未生成');
 const text=artifactCommentsInput('origin',[{...note,selection:{quote:'原文',page:3,sheet:'预算',cellRange:'A1:B2'}}]);expect(text.images).toEqual([]);expect(text.text).toContain('"cellRange":"A1:B2"');
 expect(()=>artifactCommentsInput('origin',[])).toThrow('1–4');expect(()=>artifactCommentsInput('origin',Array.from({length:5},(_,i)=>({...note,id:`note-${i}`})))).toThrow('1–4');
});

test('invalid screenshot bytes, oversized metadata and malformed geometry cannot become stored visual selections',()=>{
 expect(parseElementSelection(selection)).toEqual(selection);
 expect(parseElementSelection({...selection,screenshot:{base64:'not-a-png',width:1,height:1}})).toBeUndefined();expect(parseElementSelection({...selection,screenshot:{base64:png,width:1601,height:1}})).toBeUndefined();expect(parseElementSelection({...selection,rect:{x:0,y:0,width:NaN,height:10}})).toBeUndefined();expect(parseElementSelection({...selection,computed:{color:42}})).toBeUndefined();expect(parseElementSelection({...selection,outerHTML:'x'.repeat(12001)})).toBeUndefined();expect(parseElementSelection({...selection,cellRange:'<script>'})).toBeUndefined();
});

test('full computer/project/conversation and artifact revision scopes stay independent on reload',async()=>{
 const first=JSON.stringify(['pc-a/agent/api/project/work/thread','artifact','v1']),otherPc=JSON.stringify(['pc-b/agent/api/project/work/thread','artifact','v1']),otherRevision=JSON.stringify(['pc-a/agent/api/project/work/thread','artifact','v2']);
 await saveArtifactComments(first,{...record('只修改旧页面'),draft:{selection,comment:'尚未保存的编辑',editingId:note.id}});
 expect(await loadArtifactComments(first)).toEqual({...record('只修改旧页面'),draft:{selection,comment:'尚未保存的编辑',editingId:note.id}});expect((await loadArtifactComments(otherPc)).notes).toEqual([]);expect((await loadArtifactComments(otherRevision)).notes).toEqual([]);
});

test('a failed save keeps the latest record in memory and the next successful write repairs storage',async()=>{
 const scope='store-failure';await saveArtifactComments(scope,record('旧内容'));jest.mocked(setSetting).mockRejectedValueOnce(new Error('disk busy'));
 await expect(saveArtifactComments(scope,record('保留新批注'))).rejects.toThrow('disk busy');expect((await loadArtifactComments(scope)).notes[0].comment).toBe('保留新批注');await saveArtifactComments(scope,record('保留新批注'));expect(JSON.parse(mockSettings.get(`remote.artifact.comments.v1:${scope}`)!).notes[0].comment).toBe('保留新批注');
});

test('a delayed stale read cannot replace a newer completed save for the same artifact',async()=>{
 const scope='late-store-read';await saveArtifactComments(scope,record('旧内容'));let finish!:(raw:string)=>void;
 jest.mocked(getSetting).mockImplementationOnce(()=>new Promise<string>(resolve=>{finish=resolve;}));const reading=loadArtifactComments(scope);
 await saveArtifactComments(scope,record('新内容'));finish(JSON.stringify(record('旧内容')));
 expect((await reading).notes[0].comment).toBe('新内容');
});

test('persisted duplicate identities or pin numbers are rejected instead of opening an ambiguous editor',()=>{
 expect(()=>parseCommentRecord(JSON.stringify({notes:[note,{...note,number:2}],nextNumber:3}))).toThrow();
 expect(()=>parseCommentRecord(JSON.stringify({notes:[note,{...note,id:'another'}],nextNumber:3}))).toThrow();
 expect(parseCommentRecord(JSON.stringify({notes:[{...note,number:9}],nextNumber:1})).nextNumber).toBe(10);
});
