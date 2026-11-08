import React,{useEffect,useRef,useState} from 'react';
import {Image,Pressable,StyleSheet,Text,TextInput,View} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {useDesk} from '../theme';
import type {PreviewFrame} from './workspace-preview';
import type {RemoteImage} from './attachment-chunks';
import {useArtifactImageAppender} from './ArtifactAnnotationContext';
import {cropBrowserAnnotation,type BrowserAnnotationFrame,type BrowserAnnotationRect as Box} from './browser-annotation-image';
import {sameBrowserCapture} from './browser-annotation-image-shared';

export function browserAnnotationText(url:string,box:Box,viewport:{width:number;height:number},comment:string,scroll?:{x:number;y:number}){
 return `网页批注\n地址：${url}\n视口：${Math.round(viewport.width)} × ${Math.round(viewport.height)}\n选区（视口像素）：x=${Math.round(box.x)}, y=${Math.round(box.y)}, width=${Math.round(box.width)}, height=${Math.round(box.height)}${scroll?`\n页面滚动：x=${Math.round(scroll.x)}, y=${Math.round(scroll.y)}`:''}\n意见：${comment.trim()}`;
}
type Props={url:string;enabled:boolean;onDone:()=>void;onCompose?:(text:string)=>boolean|void;viewport?:{width:number;height:number};scroll?:{x:number;y:number};children:React.ReactNode;
 scopeKey?:string;frame?:PreviewFrame|null;onCaptureFrame?:()=>Promise<PreviewFrame>;onLocate?:(scroll:{x:number;y:number})=>Promise<void>|void};
interface Note {id:string;number:number;box:Box;viewport:{width:number;height:number};scroll?:{x:number;y:number};comment:string;frame?:BrowserAnnotationFrame;image?:RemoteImage;error?:string}
/** A navigation/source change invalidates old drafts and all late crop callbacks. */
export function BrowserAnnotations(props:Props){return <AnnotationPage key={JSON.stringify([props.scopeKey,props.url,props.frame?.pageId,props.frame?.documentId])} {...props}/>;}
function AnnotationPage({url,enabled,onDone,onCompose,viewport,scroll,children,frame,onCaptureFrame,onLocate}:Props){
 const d=useDesk(),appendImages=useArtifactImageAppender(),remote=frame!==undefined;
 const [size,setSize]=useState({width:1,height:1}),[box,setBox]=useState<Box|null>(null),[comment,setComment]=useState(''),[notice,setNotice]=useState('');
 const [notes,setNotes]=useState<Note[]>([]),[editing,setEditing]=useState<string>(),[selected,setSelected]=useState<string>(),[busy,setBusy]=useState(false),[sent,setSent]=useState<string[]>([]);
 const start=useRef<{x:number;y:number}|null>(null),sequence=useRef(0),alive=useRef(true),active=useRef(enabled),locked=useRef(false),notesRef=useRef(notes);
 active.current=enabled;notesRef.current=notes;
 const current=()=>alive.current&&active.current;
 const draftSource=useRef<{frame?:BrowserAnnotationFrame;viewport:{width:number;height:number};scroll?:{x:number;y:number}}|undefined>(undefined);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const put=(next:Note[])=>{notesRef.current=next;setNotes(next);};
 const clear=()=>{setBox(null);setComment('');setEditing(undefined);draftSource.current=undefined;};
 const point=(event:any)=>({x:Math.max(0,Math.min(size.width,event.nativeEvent.locationX)),y:Math.max(0,Math.min(size.height,event.nativeEvent.locationY))});
 const region=(end:{x:number;y:number})=>{const p=start.current;if(!p)return;const x=Math.max(0,Math.min(p.x,end.x,size.width-4)),y=Math.max(0,Math.min(p.y,end.y,size.height-4));setBox({x,y,width:Math.min(size.width-x,Math.max(4,Math.abs(p.x-end.x))),height:Math.min(size.height-y,Math.max(4,Math.abs(p.y-end.y)))});};
 const draftNote=():Note|undefined=>{
  if(!box||!comment.trim())return;
  const source=draftSource.current??{frame:frame??undefined,viewport:viewport??size,scroll},target=source.viewport;
  const existing=notesRef.current.find(note=>note.id===editing),number=existing?.number??sequence.current+1;
  return {id:existing?.id??`region-${number}`,number,box:{x:box.x*target.width/size.width,y:box.y*target.height/size.height,width:box.width*target.width/size.width,height:box.height*target.height/size.height},viewport:{...target},scroll:source.scroll?{...source.scroll}:undefined,comment:comment.trim(),frame:source.frame?{...source.frame}:undefined};
 };
 const capture=async(note:Note,refresh=false):Promise<Note>=>{
  if(!remote)return note;
  try {
   let source=note.frame;
   if(refresh||!source?.imageBase64){
    if(!onCaptureFrame)throw new Error('电脑网页截图尚未读取，批注已保留，请重试截图');
    const next=await onCaptureFrame();if(!current())return note;
    if(source&&!sameBrowserCapture(source,next)||next.url!==url)throw new Error('网页位置已变化，请先定位原批注，再重试截图');
    source={...next};
   }
   if(!source)throw new Error('电脑网页截图尚未读取，批注已保留');
   const image=await cropBrowserAnnotation(source,note.box,current);
   return {...note,frame:source,image,error:undefined};
  }catch(error){return {...note,image:undefined,error:error instanceof Error?error.message:'截图失败，批注已保留，请重试'};}
 };
 const stash=async():Promise<Note|undefined>=>{
  const note=draftNote();if(!note)return;
  if(!notesRef.current.some(item=>item.id===note.id)&&notesRef.current.length>=4)throw new Error('每次最多添加 4 条批注，请先将当前批注加入对话');
  sequence.current=Math.max(sequence.current,note.number);
  put(notesRef.current.some(item=>item.id===note.id)?notesRef.current.map(item=>item.id===note.id?note:item):[...notesRef.current,note]);
  clear();
  const result=await capture(note);if(!alive.current)return;
  put(notesRef.current.map(item=>item.id===note.id?result:item));setSelected(note.id);return result;
 };
 const add=async()=>{
  if(!current()||locked.current)return;locked.current=true;setBusy(true);setNotice('');
  try{const note=await stash();if(current()&&note)setNotice(note.error??`已保存批注 ${note.number}，可继续选择其他区域`);}catch(error){if(current())setNotice(error instanceof Error?error.message:'批注暂未保存');}
  finally{locked.current=false;if(alive.current)setBusy(false);}
 };
 const noteText=(note:Note)=>`批注 ${note.number}\n${browserAnnotationText(url,note.box,note.viewport,note.comment,note.scroll)}${note.frame?.documentId?`\n页面标识：${note.frame.documentId}`:''}`;
 const submit=async(copy=false)=>{
  if(!current()||locked.current)return;
  if(copy){const draft=draftNote(),all=draft?[...notesRef.current.filter(note=>note.id!==draft.id),draft]:notesRef.current;if(!all.length)return;try{await Clipboard.setStringAsync(all.map(noteText).join('\n\n'));if(current())setNotice('批注已复制');}catch{if(current())setNotice('复制失败，请重试');}return;}
  locked.current=true;setBusy(true);setNotice('');
  try {
   const draft=draftNote();if(draft)await stash();if(!current())return;
   const submitted=notesRef.current;if(!submitted.length)return;
   const text=submitted.map((note,index)=>`${noteText(note)}${remote?`\n附图 ${index+1}：批注 ${note.number} 的页面局部截图`:'\n截图：当前网页仅支持坐标文字批注，未附图片'}`).join('\n\n');
   if(text.length>36000)throw new Error('批注较长，请分批添加到对话');
   let accepted:boolean|void;
   if(remote){
    if(!appendImages)throw new Error('当前对话暂不支持附图批注，请稍后重试或复制说明');
    const missing=submitted.find(note=>!note.image);if(missing)throw new Error(missing.error??`批注 ${missing.number} 的截图尚未生成，请重试截图`);
    accepted=await appendImages(text,submitted.map(note=>note.image!));
   }else{if(!onCompose)return;accepted=onCompose(text);}
   if(!current())return;
   if(accepted===false)throw new Error('当前对话暂不能接收批注，请稍后重试或复制保存');
   const ids=new Set(submitted.map(note=>note.id));put(notesRef.current.filter(note=>!ids.has(note.id)));setSent(old=>[...old,text].slice(-30));clear();setSelected(undefined);
   setNotice(remote?'截图与批注已加入对话草稿，尚未发送':'坐标文字批注已加入对话草稿，尚未发送');onDone();
  }catch(error){if(current())setNotice(error instanceof Error?error.message:'批注尚未加入对话，请重试');}
  finally{locked.current=false;if(alive.current)setBusy(false);}
 };
 const locate=async(note:Note,edit=false)=>{
  if(!current()||locked.current)return;setSelected(note.id);setNotice('');
  if(edit){setEditing(note.id);setComment(note.comment);setBox({x:note.box.x*size.width/note.viewport.width,y:note.box.y*size.height/note.viewport.height,width:note.box.width*size.width/note.viewport.width,height:note.box.height*size.height/note.viewport.height});draftSource.current={frame:note.frame,viewport:note.viewport,scroll:note.scroll};}
  try{if(note.scroll)await onLocate?.(note.scroll);if(current()&&note.viewport.width!==(viewport??size).width)setNotice('网页尺寸已变化，批注仍保留原始截图与位置，请核对后修改');}catch(error){if(current())setNotice(error instanceof Error?error.message:'暂时无法定位批注');}
 };
 const retry=async(note:Note)=>{
  if(!current()||locked.current)return;locked.current=true;setBusy(true);setNotice('');
  try{const result=await capture(note,Boolean(onCaptureFrame));if(current()){put(notesRef.current.map(item=>item.id===note.id?result:item));setNotice(result.error??`批注 ${note.number} 的截图已更新`);}}
  finally{locked.current=false;if(alive.current)setBusy(false);}
 };
 const action=(label:string,fn:()=>void,disabled=false)=><Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled||busy} style={{paddingVertical:7,opacity:(disabled||busy)?0.35:1}} onPress={fn}><Text style={{fontSize:12,color:d.text}}>{label}</Text></Pressable>;
 const pending=Boolean(box&&comment.trim()),canSubmit=(notes.length>0||pending)&&(remote?Boolean(appendImages):Boolean(onCompose));
 return <View style={{flex:1,minHeight:0}}>
  <View testID="browser-annotation-viewport" style={[{flex:1,minHeight:0,position:'relative'},viewport?{flex:undefined,width:'100%',aspectRatio:viewport.width/viewport.height}:undefined]} onLayout={event=>{const {width,height}=event.nativeEvent.layout;if(width>0&&height>0)setSize({width,height});}}>
   {children}
   {enabled?<View accessibilityLabel="拖动选择网页批注区域" style={[StyleSheet.absoluteFill,{zIndex:20,cursor:'crosshair'} as any]}
    onStartShouldSetResponder={()=>!busy&&(!remote||Boolean(frame?.imageBase64))} onMoveShouldSetResponder={()=>!busy&&(!remote||Boolean(frame?.imageBase64))}
    onResponderGrant={event=>{if(locked.current||remote&&!frame?.imageBase64)return;draftSource.current={frame:frame?{...frame}:undefined,viewport:{...(viewport??size)},scroll:scroll?{...scroll}:undefined};start.current=point(event);setSelected(undefined);region(start.current);}}
    onResponderMove={event=>{if(!locked.current)region(point(event));}} onResponderRelease={event=>{if(!locked.current)region(point(event));start.current=null;}} onResponderTerminate={()=>{start.current=null;}}>
    {box?<View pointerEvents="none" style={{position:'absolute',left:box.x,top:box.y,width:box.width,height:box.height,borderWidth:1.5,borderColor:d.text,backgroundColor:'rgba(128,128,128,0.13)'}}/>:null}
    {notes.map(note=>{
     const target=viewport??size;if(note.viewport.width!==target.width||note.viewport.height!==target.height)return null;
     const x=(note.box.x+(note.scroll?.x??0)-(scroll?.x??0))*size.width/target.width,y=(note.box.y+(note.scroll?.y??0)-(scroll?.y??0))*size.height/target.height;
     if(x<0||y<0||x>size.width||y>size.height)return null;
     return <Pressable key={note.id} accessibilityRole="button" accessibilityLabel={`网页批注标记 ${note.number}`} onPress={()=>void locate(note)} disabled={busy} style={{position:'absolute',left:Math.min(size.width-26,x),top:Math.min(size.height-26,y),width:26,height:26,borderRadius:13,borderWidth:1,borderColor:d.line,backgroundColor:selected===note.id?d.text:d.surface,alignItems:'center',justifyContent:'center'}}><Text style={{fontSize:11,color:selected===note.id?d.surface:d.text}}>{note.number}</Text></Pressable>;
    })}
   </View>:null}
  </View>
  {enabled?<View style={{padding:12,gap:8,borderTopWidth:StyleSheet.hairlineWidth,borderColor:d.line,backgroundColor:d.surface}}>
   <Text style={{color:d.muted,fontSize:12}}>{editing?'编辑已有批注':box?'已选择区域，描述你希望如何修改':'拖动选择区域，保存后可继续批注其他位置'}{!remote?' · 坐标文字模式（不含截图）':''}</Text>
   {remote&&!frame?.imageBase64&&onCaptureFrame?action('重新读取网页截图',()=>{void onCaptureFrame().catch(error=>{if(current())setNotice(error instanceof Error?error.message:'截图尚未读取，请重试');});}):null}
   <TextInput accessibilityLabel="网页批注意见" multiline value={comment} editable={!busy} maxLength={4000} onChangeText={setComment} placeholder="描述这处需要修改的内容…" placeholderTextColor={d.muted} style={{color:d.text,fontSize:13,minHeight:55}}/>
   <View style={{flexDirection:'row',flexWrap:'wrap',columnGap:16}}>{action(editing?'保存网页批注修改':'保存网页批注',()=>void add(),!pending)}{action('将网页批注加入对话',()=>void submit(),!canSubmit)}{action('复制网页批注',()=>void submit(true),!notes.length&&!pending)}{action('取消网页批注',onDone)}</View>
   {notes.map(note=><View key={note.id} testID={`browser-note:${note.number}`} style={{padding:10,gap:5,borderWidth:1,borderColor:selected===note.id?d.text:d.line,borderRadius:8}}>
    <View style={{flexDirection:'row',gap:10,alignItems:'center'}}>{note.image?<Image accessibilityLabel={`批注 ${note.number} 的局部截图`} source={{uri:note.image.uri}} resizeMode="contain" style={{width:64,height:46,backgroundColor:d.surface2}}/>:null}<Text style={{flex:1,fontSize:12,lineHeight:18,color:d.text}}>{note.number}. {note.comment}</Text></View>
    {note.error?<Text accessibilityRole="alert" style={{color:d.muted,fontSize:11}}>{note.error}</Text>:null}
    <View style={{flexDirection:'row',flexWrap:'wrap',columnGap:14}}>{action(`定位网页批注 ${note.number}`,()=>void locate(note))}{action(`编辑网页批注 ${note.number}`,()=>void locate(note,true))}{action(`删除网页批注 ${note.number}`,()=>{put(notesRef.current.filter(item=>item.id!==note.id));if(editing===note.id)clear();})}{remote&&!note.image?action(`重试网页截图 ${note.number}`,()=>void retry(note)):null}</View>
   </View>)}
  </View>:null}
  {notice?<Text accessibilityLiveRegion="polite" style={{fontSize:11,color:d.muted,padding:8}}>{notice}</Text>:null}
  {!enabled&&sent.length?<Pressable accessibilityRole="button" accessibilityLabel="复制当前网页全部批注" onPress={()=>void Clipboard.setStringAsync(sent.join('\n\n'))} style={{padding:8}}><Text style={{fontSize:11,color:d.muted}}>{sent.length} 次已添加批注 · 复制文字</Text></Pressable>:null}
 </View>;
}
