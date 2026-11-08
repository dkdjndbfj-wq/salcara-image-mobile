import {recoverHistoryInput,requireHistoryCapabilities} from '../remote/history-input';
import {promptHistory} from '../remote/prompt-history';
import {mergeSentEditRecovery} from '../remote/sent-edit-recovery';
import {joinPastedText,splitPastedText} from '../remote/pasted-text';
import type {TimelineItem} from '../remote/store';
const mockRead=jest.fn();jest.mock('../remote/drafts',()=>({readRemoteRetryImages:(...args:unknown[])=>mockRead(...args)}));
const image={uri:'file:///original.png',base64:'eA==',mime:'image/png' as const,width:20,height:30};
const reference={kind:'file' as const,projectPath:'/project',path:'main.ts',label:'main.ts',text:'original source',capturedAt:1,startLine:1,endLine:1};
const message=(extra:object={}):Extract<TimelineItem,{kind:'message'}>=>({kind:'message',id:'old',role:'user',text:'Original request',final:true,ts:1,attachments:[{id:'att_original',mime:'image/png',width:20,height:30,size:1,sha256:'a'.repeat(64)}],skills:[{name:'review',path:'/skills/review'}],contextReferences:[reference],...extra});
beforeEach(()=>{mockRead.mockReset().mockResolvedValue([image]);});
test('unsupported historical references fail before an incompatible draft can be installed',()=>{
 const entry=promptHistory([message({skills:undefined})])[0];expect(()=>requireHistoryCapabilities(entry)).toThrow('不支持原消息中的引用');
});
test('history restores original images, skills and references together without mutating the source',async()=>{
 const input=message(),before=JSON.stringify(input),entry=promptHistory([input])[0],load=jest.fn(async()=>image.uri);
 const result=await recoverHistoryInput(entry,load,()=>true);
 expect(result).toEqual({text:input.text,images:[image],features:{skills:input.skills,contextReferences:[reference]}});expect(JSON.stringify(input)).toBe(before);expect(load).toHaveBeenCalledTimes(1);
});
test('image-only and reference-only history remain usable and identical text with different context is distinct',()=>{
 const list=promptHistory([message({id:'first',text:''}),message({id:'ref',text:'',attachments:undefined,skills:undefined}),message({id:'same-a'}),message({id:'same-b',contextReferences:[{...reference,text:'changed'}]})]);
 expect(list.map(item=>item.id)).toEqual(['same-b','same-a','ref','first']);
});
test.each(['missing','partial','cancel'] as const)('a %s original never results in partial restoration',async kind=>{
 let current=true;const load=jest.fn(async()=>{if(kind==='cancel')current=false;return kind==='missing'?null:image.uri;});if(kind==='partial')mockRead.mockResolvedValue([]);
 await expect(recoverHistoryInput(promptHistory([message()])[0],load,()=>current)).rejects.toThrow();
 if(kind==='missing'||kind==='cancel')expect(mockRead).not.toHaveBeenCalled();
});
test('legacy images without original references are rejected before touching the draft',async()=>{
 const load=jest.fn();await expect(recoverHistoryInput(promptHistory([message({attachments:undefined,images:[image.uri]})])[0],load,()=>true)).rejects.toThrow('引用不完整');expect(load).not.toHaveBeenCalled();
});
test('merging complete history keeps exact text attachment bytes and independent names',()=>{
 const body='  source\r\n🙂\n ',current={text:joinPastedText('Current draft',[{name:'main.ts',text:body}]),images:[],features:{}},incoming={text:joinPastedText('Old prompt',[{name:'main.ts',text:'older source'}]),images:[image],features:{contextReferences:[reference]}};
 const merged=mergeSentEditRecovery(current,incoming);expect(splitPastedText(merged.text)).toEqual({prompt:'Current draft\n\nOld prompt',attachments:[{name:'main.ts',text:body},{name:'main.ts (2)',text:'older source'}]});expect(merged.images).toEqual([image]);expect(merged.features.contextReferences).toEqual([reference]);
 expect(()=>mergeSentEditRecovery({...current,text:joinPastedText('',Array.from({length:8},(_,i)=>({name:`${i}.ts`,text:'x'})))},incoming)).toThrow('8 个文本附件');
});
