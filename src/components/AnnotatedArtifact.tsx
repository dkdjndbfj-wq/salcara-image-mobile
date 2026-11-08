import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Image,Pressable,Text,TextInput,View} from 'react-native';
import {useDesk} from '../theme';
import {InteractiveArtifact} from './InteractiveArtifact';
import type {InteractiveArtifactProps} from '../remote/artifact-viewer-types';
import {artifactCommentsInput,type ArtifactComment,type ArtifactElementSelection} from '../remote/artifact-annotations';
import {loadArtifactComments,saveArtifactComments,type ArtifactCommentRecord} from '../remote/artifact-comment-store';
import {useArtifactImageAppender} from '../remote/ArtifactAnnotationContext';
import {ToolbarButton} from '../remote/WorkbenchToolbar';

/** Content-scoped comments: save pins locally, then explicitly append a reviewed batch. */
export function AnnotatedArtifact(props:InteractiveArtifactProps&{origin:string;onCompose:(text:string)=>boolean|void}) {
  const scope=JSON.stringify([props.scopeKey,props.artifactId,props.revision]);
  return <CommentSession key={scope} {...props} storageScope={scope}/>;
}
function CommentSession({origin,onCompose,storageScope,...props}:InteractiveArtifactProps&{origin:string;onCompose:(text:string)=>boolean|void;storageScope:string}) {
  const d=useDesk(),appendImages=useArtifactImageAppender();
  const [record,setRecord]=useState<ArtifactCommentRecord>({notes:[],nextNumber:1}),[ready,setReady]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0),[focus,setFocus]=useState<{id:string;nonce:number}>();
  const ref=useRef(record),alive=useRef(true),edited=useRef(false),flight=useRef(false),latest=useRef({onCompose,appendImages});ref.current=record;latest.current={onCompose,appendImages};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{let current=true;void loadArtifactComments(storageScope).then(saved=>{if(!current)return;const next={...saved,...(edited.current?{draft:ref.current.draft}:{})};ref.current=next;setRecord(next);setReady(true);setError('');if(edited.current)void saveArtifactComments(storageScope,next).catch(()=>{if(current)setError('批注尚未保存，请重试');});}).catch(()=>{if(current)setError('批注暂时无法读取，请重试');});return()=>{current=false;};},[storageScope,attempt]);
  const persist=(next:ArtifactCommentRecord)=>{ref.current=next;setRecord(next);if(ready)void saveArtifactComments(storageScope,next).catch(reason=>{if(alive.current)setError(reason instanceof Error?reason.message:'批注尚未保存，请重试');});};
  const begin=(selection:ArtifactElementSelection)=>{if(!alive.current||flight.current)return;edited.current=true;persist({...ref.current,draft:{selection,comment:selection.comment??''}});};
  const save=()=>{const current=ref.current,draft=current.draft;if(!alive.current||!ready||flight.current||!draft?.comment.trim())return;if(!draft.editingId&&current.notes.length>=20){setError('最多保留 20 条批注，请先分批加入对话');return;}const existing=current.notes.find(n=>n.id===draft.editingId);const note:ArtifactComment={id:existing?.id??`${Date.now()}-${current.nextNumber}`,number:existing?.number??current.nextNumber,selection:draft.selection,comment:draft.comment.trim()};persist({notes:existing?current.notes.map(n=>n.id===note.id?note:n):[...current.notes,note],nextNumber:existing?current.nextNumber:current.nextNumber+1});setError('');};
  const submit=async()=>{if(!alive.current||!ready||flight.current||!ref.current.notes.length)return;const batch=ref.current.notes.slice(0,4);if(ref.current.draft?.editingId&&batch.some(n=>n.id===ref.current.draft!.editingId)){setError('请先保存或取消当前批注编辑，再加入对话');return;}flight.current=true;setBusy(true);setError('');try{const input=artifactCommentsInput(origin,batch);let accepted:boolean|void;if(input.images.length){if(!latest.current.appendImages)throw Error('当前对话尚未开放图片批注，请连接支持图片的 Agent 后重试');accepted=await latest.current.appendImages(input.text,input.images);}else accepted=latest.current.onCompose(input.text);if(!alive.current)return;if(accepted===false)throw Error('当前对话草稿尚未就绪，批注已保留');const ids=new Set(batch.map(n=>n.id));const next={...ref.current,notes:ref.current.notes.filter(n=>!ids.has(n.id)),draft:ref.current.draft?.editingId&&ids.has(ref.current.draft.editingId)?undefined:ref.current.draft};ref.current=next;setRecord(next);await saveArtifactComments(storageScope,next);}catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'添加失败，批注已保留');}finally{flight.current=false;if(alive.current)setBusy(false);}};
  const pins=useMemo(()=>record.notes.flatMap(note=>note.selection.rect?[{id:note.id,number:note.number,rect:note.selection.rect,selector:note.selection.selector}]:[]),[record.notes]);
  const edit=(note:ArtifactComment)=>{if(!alive.current||flight.current)return;setFocus({id:note.id,nonce:Date.now()});edited.current=true;persist({...ref.current,draft:{selection:note.selection,comment:note.comment,editingId:note.id}});};
  const action=(label:string,fn:()=>void,disabled=false)=><Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={busy||disabled} onPress={fn} style={{minHeight:34,justifyContent:'center',paddingHorizontal:10,borderWidth:1,borderColor:d.line,borderRadius:7,opacity:busy||disabled?0.45:1}}><Text style={{fontSize:12,color:d.text}}>{label}</Text></Pressable>;
  return <View style={{gap:10}}>
    <InteractiveArtifact {...props} onComposeLogs={text=>alive.current&&props.active!==false?latest.current.onCompose(text):false} elementAnnotations onAnnotate={begin} annotationPins={pins} annotationFocus={focus} onAnnotationFocus={id=>{const note=ref.current.notes.find(n=>n.id===id);if(note)edit(note);}}/>
    {record.draft?<View style={{borderWidth:1,borderColor:d.line,borderRadius:10,padding:12,gap:10}}>
      {record.draft.selection.selector?<Text numberOfLines={2} style={{color:d.muted,fontSize:11}}>{record.draft.selection.selector}</Text>:record.draft.selection.quote?<Text numberOfLines={3} style={{color:d.muted,fontSize:12}}>{record.draft.selection.quote}</Text>:null}
      {record.draft.selection.screenshot?<Image accessibilityLabel="批注局部截图" source={{uri:`data:image/png;base64,${record.draft.selection.screenshot.base64}`}} style={{width:Math.min(240,record.draft.selection.screenshot.width),height:Math.min(90,record.draft.selection.screenshot.height),maxWidth:'100%',borderRadius:6}} resizeMode="contain"/>:null}
      {record.draft.selection.captureError?<Text style={{color:d.muted,fontSize:12}}>{record.draft.selection.captureError}</Text>:null}
      <TextInput accessibilityLabel="交互内容修改要求" multiline editable={!busy} value={record.draft.comment} maxLength={4000} placeholder="描述这处需要修改的内容…" placeholderTextColor={d.muted} onChangeText={comment=>{edited.current=true;persist({...ref.current,draft:{...ref.current.draft!,comment}});}} style={{minHeight:60,fontSize:13,color:d.text}}/>
      <View style={{flexDirection:'row',gap:8}}>{action('取消批注编辑',()=>persist({...ref.current,draft:undefined}))}{action('保存界面批注',save,!ready||!record.draft.comment.trim())}</View>
    </View>:null}
    {record.notes.length?<View style={{padding:12,gap:10,borderWidth:1,borderColor:d.line,borderRadius:10}}>
      <Text style={{color:d.muted,fontSize:12}}>{record.notes.length} 条批注 · 加入草稿后由你发送</Text>
      {record.notes.map(note=><View key={note.id} testID={`artifact-comment:${note.number}`} style={{gap:6}}><Text style={{color:d.text,fontSize:13,lineHeight:20}}>{note.number}. {note.comment}</Text><View style={{flexDirection:'row',alignSelf:'flex-end'}}><ToolbarButton icon="target" label={`定位界面批注 ${note.number}`} onPress={()=>setFocus({id:note.id,nonce:Date.now()})} disabled={busy||!note.selection.rect}/><ToolbarButton icon="edit" label={`编辑界面批注 ${note.number}`} disabled={busy} onPress={()=>edit(note)}/><ToolbarButton icon="trash" label={`删除界面批注 ${note.number}`} disabled={busy} onPress={()=>persist({...ref.current,notes:ref.current.notes.filter(n=>n.id!==note.id),draft:ref.current.draft?.editingId===note.id?undefined:ref.current.draft})}/></View></View>)}
      {record.draft?.editingId?<Text style={{color:d.muted,fontSize:12}}>先保存或取消当前批注编辑，再加入对话。</Text>:null}
      {action(record.notes.length>4?'将前 4 条界面批注添加到对话':'将交互内容批注添加到对话',()=>void submit(),!ready||Boolean(record.draft?.editingId&&record.notes.slice(0,4).some(n=>n.id===record.draft?.editingId)))}
    </View>:null}
    {error?<View style={{padding:10,gap:8}}><Text accessibilityRole="alert" style={{color:d.text2,fontSize:12}}>{error}</Text>{action(ready?'重试保存界面批注':'重新读取界面批注',()=>{if(!ready){setAttempt(n=>n+1);return;}void saveArtifactComments(storageScope,ref.current).then(()=>{if(alive.current)setError('');}).catch(()=>{});})}</View>:null}
  </View>;
}
