import {ArtifactAnnotationProvider} from './ArtifactAnnotationContext';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {ActivityIndicator,Pressable,ScrollView,StyleSheet,Text,View} from 'react-native';
import {Icon} from '../components/Icon';
import {Sheet,showToast} from '../components/ui';
import {useDesk} from '../theme';
import {ArtifactViewer} from '../components/ArtifactViewer';
import type {ArtifactAnnotation} from './artifact-viewer-types';
import {ConversationImageCanvas,type CanvasSessionState} from './ConversationImageCanvas';
import {ImageViewer} from './thread-extras';
import {conversationImages,type CanvasImage} from './conversation-images';
import {prepareCanvasImageInput} from './canvas-image-input';
import type {ImageAnnotationAppender} from './image-annotation-draft';
import type {TimelineItem} from './store';
import type {AttachmentRef} from './client';
import {captureConversationArtifacts,type ArtifactDescriptor,type ArtifactPayload} from './conversation-artifacts';
import type {WorkspaceFileSelection,WorkspaceRuntime} from './WorkspaceRuntimeContext';

export const isConversationArtifactPath=(path:string)=>/\.(?:pdf|docx|xlsx|pptx|html?|svg|png|jpe?g|webp|gif|md|txt|json)$/i.test(path);
export function artifactAnnotationPrompt(note:ArtifactAnnotation):string {
  const location=[note.page?`第 ${note.page} 页`:'',note.sheet?`工作表：${note.sheet}`:'',note.cellRange?`单元格：${note.cellRange}`:''].filter(Boolean).join(' · ');
  return `请根据以下产物批注修改原文件：\n文件：${note.path}\n版本：${note.revision}${location?`\n位置：${location}`:''}${note.quote?`\n引用内容：\n${note.quote}`:''}\n\n修改要求：${note.comment}`;
}
interface Options {scopeKey:string;generationKey?:string;active:boolean;items:readonly TimelineItem[];selection?:WorkspaceFileSelection;runtime?:WorkspaceRuntime;available:boolean;writable:boolean;requestAttachment:(ref:AttachmentRef)=>void;onCompose:(text:string)=>boolean;onComposeImages?:ImageAnnotationAppender;isCurrent:()=>boolean}
export function useConversationOutputs(options:Options) {
  const [open,setOpen]=useState<{scope:string;owner?:string;kind:'library'|'image'|'file';path?:string;imageId?:string}>();
  const images=useMemo(()=>conversationImages(options.items),[options.items]);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const latest=useRef(options);latest.current=options;
  const opened=useRef(open);opened.current=open;
  const same=()=>alive.current&&latest.current.scopeKey===options.scopeKey&&latest.current.generationKey===options.generationKey&&latest.current.active&&options.isCurrent();
  const openLibrary=()=>{if(same())setOpen({scope:options.scopeKey,owner:options.generationKey,kind:'library'});};
  const openImage=(uri:string)=>{const image=images.find(image=>image.uri===uri);if(!image||!same())return false;setOpen({scope:options.scopeKey,owner:options.generationKey,kind:'image',imageId:image.id});return true;};
  const openFile=(path:string)=>{if(!options.available||!isConversationArtifactPath(path)||!same())return false;setOpen({scope:options.scopeKey,owner:options.generationKey,kind:'file',path});return true;};
  const close=()=>{if(same()&&opened.current===open)setOpen(undefined);};
  // Entry points belong to actual message content, never a permanent canvas button.
  const button=null;
  const panel=open&&open.scope===options.scopeKey&&open.owner===options.generationKey&&options.active
    ?<OutputLibrary key={JSON.stringify([options.scopeKey,open.owner,open.kind,open.path,open.imageId])} {...options} isCurrent={same} initial={open} images={images} onClose={close}/>:null;
  return {button,panel,openFile,openImage,openLibrary};
}
function OutputLibrary({scopeKey,selection,runtime,available,writable,images,initial,requestAttachment,onCompose,onComposeImages,isCurrent,onClose}:Options&{images:CanvasImage[];initial:{kind:'library'|'image'|'file';path?:string;imageId?:string};onClose:()=>void}) {
  const d=useDesk(),[artifacts,setArtifacts]=useState<ArtifactDescriptor[]>([]),[cursor,setCursor]=useState<string>(),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [mode,setMode]=useState<'library'|'image'|'canvas'|'file'>(initial.kind),[selected,setSelected]=useState<ArtifactDescriptor>(),[fileImages,setFileImages]=useState<Record<string,string>>({}),[dirty,setDirty]=useState(false);
  const imageId=initial.imageId;
  const [imageView,setImageView]=useState<import('../components/ImagePreview').ImageViewState>();
  const canvasSession=useRef<CanvasSessionState|undefined>(undefined);
  const [canvasSubmitting,setCanvasSubmitting]=useState(false);
  const controller=useMemo(()=>new AbortController(),[]),generation=useRef(0),cache=useRef(new Map<string,ArtifactPayload>());
  const current=()=>!controller.signal.aborted&&isCurrent();
  const service=useMemo(()=>available&&selection?(runtime?.captureArtifacts?runtime.captureArtifacts(selection):runtime?undefined:captureConversationArtifacts(selection)):undefined,[]);
  useEffect(()=>()=>{controller.abort();service?.dispose();},[service,controller]);
  const requests=useRef<Promise<unknown>>(Promise.resolve()),imageController=useRef<AbortController|undefined>(undefined);
  useEffect(()=>()=>imageController.current?.abort(),[]);
  const serialize=<T,>(run:()=>Promise<T>):Promise<T>=>{const next=requests.current.catch(()=>{}).then(()=>{guard();return run();});requests.current=next;return next;};
  const guard=()=>{if(!current())throw new Error('电脑或会话已切换，请重新打开产物');};
  const load=async(artifact:ArtifactDescriptor,signal:AbortSignal)=>{guard();if(!service)throw new Error('当前电脑尚未开放产物读取');const value=await serialize(()=>service.read(artifact.path,signal));guard();return value;};
  const refresh=async(more=false)=>{if(!service)return;const id=++generation.current;setLoading(true);setError('');try{const page=await serialize(()=>service.list(more?cursor:undefined,controller.signal));guard();if(id!==generation.current)return;setArtifacts(old=>more?[...old,...page.artifacts.filter(item=>!old.some(a=>a.path===item.path))]:page.artifacts);setCursor(page.nextCursor);}catch(e){if(current()&&id===generation.current)setError(e instanceof Error?e.message:'产物读取失败');}finally{if(current()&&id===generation.current)setLoading(false);}};
  const openPath=async(path:string)=>{if(!service)return;setLoading(true);setError('');try{const value=await serialize(()=>service.read(path,controller.signal));guard();cache.current.set(path,value);setSelected(value.artifact);setMode('file');}catch(e){if(current())setError(e instanceof Error?e.message:'文件读取失败');}finally{if(current())setLoading(false);}};
  useEffect(()=>{if(initial.path)void openPath(initial.path);else void refresh();},[]);
  const allImages=useMemo(()=>[...images,...artifacts.filter(a=>a.kind==='image').map(a=>({id:`file:${a.id}:${a.revision}`,messageId:'',name:a.name,path:a.path,revision:a.revision,uri:fileImages[JSON.stringify([a.path,a.revision])],role:'assistant' as const}))],[images,artifacts,fileImages]);
  const compose=(text:string)=>{if(!current())return false;if(!onCompose(text)){showToast('当前对话草稿尚未就绪，请稍后重试','alert');return false;}return true;};
  const composeImages=async(text:string,sources:CanvasImage[])=>{
    guard();if(!onComposeImages)throw new Error('当前对话尚未开放图片输入，批注已保留');
    const attached=await prepareCanvasImageInput(sources,{isCurrent:current,signal:controller.signal});guard();
    return onComposeImages(text,attached);
  };
  const readImage=async(image:CanvasImage)=>{if(image.ref){requestAttachment(image.ref);return;}if(!service||!image.path)return;imageController.current?.abort();const reading=new AbortController();imageController.current=reading;try{const value=await serialize(()=>service.read(image.path!,reading.signal));guard();if(reading.signal.aborted)return;if(value.encoding!=='base64'||value.artifact.kind!=='image'||value.artifact.revision!==image.revision)throw new Error('图片版本已变化，请刷新产物');setFileImages(old=>({...old,[JSON.stringify([image.path,image.revision])]:`data:${value.artifact.mime};base64,${value.content}`}));}catch(e){if(current()&&!reading.signal.aborted)showToast(e instanceof Error?e.message:'图片读取失败','alert');}};
  const page=(content:React.ReactNode,close=onClose)=><Sheet visible presentation="page" hideHeader scroll={false} dismissible={!dirty&&!canvasSubmitting} onClose={close}>{content}</Sheet>;
  const originalImage=allImages.find(image=>image.id===imageId);
  const backToImage=()=>{if(current()&&!canvasSubmitting)setMode('image');};
  if(mode==='image')return originalImage?.uri?<ImageViewer uri={originalImage.uri} initialView={imageView} onClose={onClose} onOpenCanvas={view=>{if(current()){setImageView(view);setMode('canvas');}}}/>
    :page(<View style={{padding:24,gap:16}}><Text style={{color:d.muted}}>原图片暂时无法读取，请返回对话重新打开。</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭图片预览" onPress={onClose}><Text style={{color:d.text}}>返回聊天</Text></Pressable></View>);
  if(mode==='canvas')return page(<ConversationImageCanvas scopeKey={scopeKey} sessionStateRef={canvasSession} images={allImages} onRequest={requestAttachment} onLoadImage={readImage} onCompose={composeImages} onSubmittingChange={setCanvasSubmitting} onSubmitted={onClose} onClose={backToImage}/>,backToImage);
  if(mode==='file'&&selected)return page(<ArtifactAnnotationProvider value={onComposeImages?async(text,images)=>{guard();return onComposeImages(text,images);}:undefined}><ArtifactViewer onComposeComments={compose} key={selected.path} artifact={selected} scopeKey={scopeKey} onDirtyChange={setDirty}
    load={async(artifact,signal)=>{const cached=cache.current.get(artifact.path);if(cached){guard();cache.current.delete(artifact.path);return cached;}return load(artifact,signal);}}
    save={writable&&service?async(artifact,content,revision,signal)=>{guard();const value=await serialize(()=>service.save(artifact.path,content,revision,signal));guard();setArtifacts(old=>old.map(item=>item.path===value.artifact.path?value.artifact:item));return value;}:undefined}
    onAnnotate={note=>{if(compose(artifactAnnotationPrompt(note)))onClose();}} onClose={()=>{setSelected(undefined);setMode('library');void refresh();}}/></ArtifactAnnotationProvider>);
  return page(<View testID="conversation-output-library" style={{flex:1,backgroundColor:d.surface}}><View style={[s.header,{borderColor:d.line}]}><Text style={{flex:1,fontSize:16,fontWeight:'600',color:d.text}}>对话产物</Text><Pressable accessibilityRole="button" accessibilityLabel="刷新产物" disabled={loading||!service} onPress={()=>void refresh()} style={s.iconButton}><Icon name="regenerate" size={18} color={d.muted} accent={d.muted}/></Pressable><Pressable accessibilityRole="button" accessibilityLabel="关闭产物" onPress={onClose} style={s.iconButton}><Icon name="close" size={18} color={d.muted} accent={d.muted}/></Pressable></View>
    <ScrollView contentContainerStyle={{padding:24,gap:18}}>
      <Text style={{fontSize:13,color:d.muted}}>此会话生成或引用的文件</Text>
      {!service?<Text style={{color:d.muted}}>电脑端尚未提供产物读取能力，更新并重新连接后即可使用。</Text>:null}
      {loading?<ActivityIndicator color={d.muted}/>:null}
      {error?<View style={{gap:10}}><Text accessibilityRole="alert" style={{color:d.text2}}>{error}</Text><Pressable accessibilityRole="button" onPress={()=>initial.path?void openPath(initial.path):void refresh()}><Text style={{color:d.text}}>重新读取</Text></Pressable></View>:null}
      {!loading&&!error&&service&&!artifacts.length?<Text style={{color:d.muted}}>暂无文件。对话中的 PDF、文档、表格、幻灯片和网页产物会出现在这里。</Text>:null}
      <View style={s.grid}>{artifacts.map(artifact=><Pressable key={artifact.id} accessibilityRole="button" accessibilityLabel={`打开产物 ${artifact.name}`} disabled={loading} onPress={()=>{setSelected(artifact);setMode('file');}} style={[s.card,{borderColor:d.line,backgroundColor:d.surface}]}><Icon name="file" size={24} color={d.muted}/><Text numberOfLines={2} style={{fontWeight:'500',fontSize:14,color:d.text}}>{artifact.name}</Text><Text numberOfLines={1} style={{fontSize:12,color:d.muted}}>{artifact.kind.toUpperCase()} · {Math.max(1,Math.round(artifact.size/1024))} KB</Text></Pressable>)}</View>
      {cursor?<Pressable accessibilityRole="button" disabled={loading} onPress={()=>void refresh(true)} style={s.button}><Text style={{color:d.text}}>加载更多产物</Text></Pressable>:null}
    </ScrollView></View>);
}
const s=StyleSheet.create({header:{paddingHorizontal:20,paddingVertical:12,borderBottomWidth:1,flexDirection:'row',alignItems:'center',gap:8},iconButton:{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center'},button:{padding:10},grid:{flexDirection:'row',flexWrap:'wrap',gap:14},card:{padding:18,gap:16,minWidth:150,maxWidth:260,flexGrow:1,flexBasis:180,borderWidth:1,borderRadius:14}});
