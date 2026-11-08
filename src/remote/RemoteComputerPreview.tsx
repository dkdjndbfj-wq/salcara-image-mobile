import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, Pressable, ScrollView, Text, TextInput, View} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {useDesk} from '../theme';
import {captureComputerPreview, type ComputerPreview, type PreviewFrame, type PreviewInput} from './workspace-preview';
import type {TerminalSelection} from './workspace-terminal';
import {RemotePreviewCanvas} from './RemotePreviewCanvas';
import {BrowserAnnotations} from './BrowserAnnotations';
import {useWorkspaceRuntime} from './WorkspaceRuntimeContext';
import {decodePreviewBytes, encodePreviewBytes, pickPreviewUpload, savePreviewDownload} from './preview-transfer';
import {BrowserElementEditor} from './BrowserElementEditor';
import {PreviewLogPanel} from './PreviewLogPanel';

export function RemoteComputerPreview({selection, url, active, revision, onNavigate, initialScroll, onScrollChange,annotating=false,onAnnotationDone,onCompose}: {
 annotating?:boolean;onAnnotationDone?:()=>void;onCompose?:(text:string)=>boolean|void;
 selection:TerminalSelection;url:string;active:boolean;revision:number;onNavigate:(url:string)=>void;
 initialScroll?:{x:number;y:number};onScrollChange?:(scroll:{x:number;y:number;url?:string})=>void;
}) {
 const dk=useDesk(), runtime=useWorkspaceRuntime(), runtimeRef=useRef(runtime);runtimeRef.current=runtime;
 const [frame,setFrame]=useState<PreviewFrame|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[text,setText]=useState('');
 const [width,setWidth]=useState(360),[height,setHeight]=useState(640),[ready,setReady]=useState(false);
 const [controls,setControls]=useState(false);
 const [elementPicking,setElementPicking]=useState(false),[elementError,setElementError]=useState('');
 const [selectionMode,setSelectionMode]=useState(false),[notice,setNotice]=useState(''),[transfer,setTransfer]=useState(''),[prompt,setPrompt]=useState(''),[inspecting,setInspecting]=useState(false);
 const controller=useRef<ComputerPreview|null>(null),epoch=useRef(0),currentActive=useRef(active),navigated=useRef(onNavigate),scrollChanged=useRef(onScrollChange);
 const restoreScroll=useRef(initialScroll);restoreScroll.current=initialScroll;
 currentActive.current=active;navigated.current=onNavigate;scrollChanged.current=onScrollChange;
 const latestURL=useRef(url);latestURL.current=url;
 const initialURL=useRef(url);
 const applyFrame=(value:PreviewFrame)=>{setFrame(old=>({...value,imageBase64:value.imageBase64??(old?.pageId===value.pageId&&old?.documentId===value.documentId&&old?.url===value.url&&old?.width===value.width&&old?.height===value.height&&old?.scrollX===value.scrollX&&old?.scrollY===value.scrollY&&old?.nextSequence===value.nextSequence?old?.imageBase64:undefined)}));setReady(true);navigated.current(value.url);if(value.scrollX!==undefined&&value.scrollY!==undefined)scrollChanged.current?.({x:value.scrollX,y:value.scrollY,url:value.url});};
 const renderedScope=JSON.stringify([runtime?.scope,selection.deviceId,selection.sessionKey,selection.agentId,selection.surface,selection.cwd]);
 const currentScope=useRef(renderedScope);currentScope.current=renderedScope;
 const domInput=async(input:PreviewInput)=>{
  const client=controller.current,owner=epoch.current;
  const valid=()=>Boolean(client&&controller.current===client&&owner===epoch.current&&currentActive.current&&currentScope.current===renderedScope&&latestURL.current===url);
  if(!valid()||!ready||error)throw new Error('页面或连接已变化，请重新选择元素');
  setElementError('');await client!.input(input);
  if(!valid())throw new Error('页面或连接已变化，操作结果未确认');
  const value=await client!.frame(true);
  if(!valid())throw new Error('页面或连接已变化，操作结果未确认');
  applyFrame(value);if(input.action==='element-pick')setElementPicking(false);return value;
 };
 const captureAnnotationFrame=async()=>{
  const client=controller.current,owner=epoch.current;
  const valid=()=>Boolean(client&&controller.current===client&&owner===epoch.current&&currentActive.current&&currentScope.current===renderedScope&&latestURL.current===url);
  if(!valid()||!ready||error)throw new Error('网页或连接已变化，请重新读取截图');
  const value=await client!.frame(true);
  if(!valid())throw new Error('网页或对话已变化，旧截图未用于当前批注');
  applyFrame(value);return value;
 };
 const send=(input:PreviewInput)=>{if(!active||error||!ready)return;const owner=epoch.current;void controller.current?.input(input).catch(e=>{if(owner===epoch.current)setError(e.message);});};
 useEffect(()=>{
  const owner=++epoch.current;let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
  setError('');setReady(false);setFrame(null);setNotice('');setTransfer('');setSelectionMode(false);setInspecting(false);setElementPicking(false);setElementError('');initialURL.current=latestURL.current;
  const factory=runtimeRef.current?.capturePreview??captureComputerPreview;
  const client=factory(selection,()=>{if(owner===epoch.current)setError('连接已变化，请重新连接网页预览');});controller.current=client;
  const apply=(value:PreviewFrame)=>{if(!stopped&&owner===epoch.current)applyFrame(value);};
  const poll=async()=>{if(stopped)return;try{if(AppState.currentState==='active'||!AppState.currentState)apply(await client.frame(currentActive.current));}
    catch(e){if(!stopped){setError(e instanceof Error?e.message:'网页预览已断开');return;}}
    if(!stopped)timer=setTimeout(poll,currentActive.current?900:20000);};
  const savedScroll=restoreScroll.current;
  void client.open(initialURL.current,640,640).then(async value=>{
    if(stopped||owner!==epoch.current)return;
    if(savedScroll&&Number.isFinite(savedScroll.x)&&Number.isFinite(savedScroll.y)&&(savedScroll.x||savedScroll.y)) {
      await client.input({action:'scrollTo',x:Math.max(0,Math.min(10000000,savedScroll.x)),y:Math.max(0,Math.min(10000000,savedScroll.y))});
      if(stopped)return;value=await client.frame(true);
    }
    apply(value);if(!stopped)timer=setTimeout(poll,700);
  }).catch(e=>{if(!stopped)setError(e.message);});
  return()=>{stopped=true;epoch.current++;if(timer)clearTimeout(timer);client.dispose();if(controller.current===client)controller.current=null;};
 },[runtime?.scope,selection.deviceId,selection.sessionKey,selection.agentId,selection.surface,selection.cwd,retry]);
 useEffect(()=>{if(ready&&url!==initialURL.current){initialURL.current=url;const owner=epoch.current;void controller.current?.input({action:'navigate',url}).catch(e=>{if(owner===epoch.current)setError(e.message);});}},[url,ready]);
 useEffect(()=>{if(active&&ready&&!error){const owner=epoch.current;void controller.current?.frame(true).then(value=>{if(owner===epoch.current)applyFrame(value);}).catch(e=>{if(owner===epoch.current)setError(e.message);});}},[active,ready]);
 useEffect(()=>{setPrompt(frame?.dialog?.defaultPrompt??'');},[frame?.dialog?.id]);
 useEffect(()=>{setElementPicking(false);setElementError('');},[active,url,frame?.documentId,annotating]);
 useEffect(()=>{
  if(!active||!ready||error)return;const owner=epoch.current;
  const timer=setTimeout(()=>{void controller.current?.input({action:'resize',width:Math.max(320,Math.min(1440,Math.floor(width))),height:Math.max(240,Math.min(1200,Math.floor(height-150)))}).catch(e=>{if(owner===epoch.current)setError(e.message);});},200);
  return()=>clearTimeout(timer);
 },[active,ready,width,height]);
 const lastRevision=useRef(revision);
 useEffect(()=>{if(revision!==lastRevision.current){lastRevision.current=revision;send({action:'reload'});}},[revision]);
 const copySelection=async()=>{
  const client=controller.current,owner=epoch.current;if(!client||!active||!ready||error)return;
  try {const current=await client.frame(false);if(owner!==epoch.current||!currentActive.current)return;if(!current.selectionText){setNotice('请先拖动选择网页文字');return;}await Clipboard.setStringAsync(current.selectionText);if(owner===epoch.current)setNotice('已复制选中文字');}
  catch(e){if(owner===epoch.current)setNotice(e instanceof Error?e.message:'复制失败');}
 };
 const upload=async()=>{
  const client=controller.current,owner=epoch.current,chooser=frame?.chooser;if(!client||!chooser||transfer||!active)return;
  setTransfer('选择上传文件');setNotice('');let submitted=false;
  try {const file=await pickPreviewUpload();if(!file||owner!==epoch.current)return;
   const uploadId=`upload_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;
   for(let offset=0;offset<file.bytes.length||offset===0;offset+=12288) {
    if(owner!==epoch.current)return;const chunk=file.bytes.slice(offset,offset+12288),final=offset+chunk.length===file.bytes.length;
    setTransfer(`上传 ${Math.round((offset+chunk.length)/Math.max(1,file.bytes.length)*100)}%`);
    submitted=true;await client.input({action:'upload',chooserId:chooser.id,uploadId,name:file.name,total:file.bytes.length,offset,dataBase64:encodePreviewBytes(chunk),final});
    if(final)break;
   }
   if(owner===epoch.current){const updated=await client.frame(true);if(owner===epoch.current){applyFrame(updated);setNotice('文件已上传到网页');}}
  }catch(e){if(owner===epoch.current){const message=e instanceof Error?e.message:'上传失败';setNotice(message);if(submitted)setError(message);}}
  finally{if(owner===epoch.current)setTransfer('');}
 };
 const download=async(id:string)=>{
  const client=controller.current,owner=epoch.current;if(!client?.download||transfer||!active)return;setTransfer('正在读取下载文件');setNotice('');
  try{let offset=0,bytes:Uint8Array|undefined,name='';
   for(let count=0;count<258;count++) {const part=await client.download(id,offset);if(owner!==epoch.current)return;
    if(!bytes){bytes=new Uint8Array(part.total);name=part.name;}if(part.total!==bytes.length||part.name!==name)throw new Error('下载文件已变化，请重试');
    const chunk=decodePreviewBytes(part.dataBase64);bytes.set(chunk,offset);offset+=chunk.length;
    setTransfer(`下载 ${Math.round(offset/Math.max(1,bytes.length)*100)}%`);
    if(part.done){await savePreviewDownload(name,bytes);if(owner===epoch.current)setNotice('已打开保存下载文件');return;}
   }throw new Error('下载文件不完整');
  }catch(e){if(owner===epoch.current)setNotice(e instanceof Error?e.message:'下载失败');}
  finally{if(owner===epoch.current)setTransfer('');}
 };
 const button=(label:string,action:()=>void,disabled=false)=><Pressable key={label} accessibilityRole="button" accessibilityLabel={`网页${label}`} disabled={!active||!ready||Boolean(error)||disabled} onPress={action} style={{paddingHorizontal:9,paddingVertical:7,borderWidth:1,borderColor:dk.line,borderRadius:6,opacity:disabled?0.4:1}}><Text style={{color:dk.text2,fontSize:12}}>{label}</Text></Pressable>;
 return <View testID="computer-preview" style={{flex:1,minHeight:0}} onLayout={event=>{const layout=event.nativeEvent.layout;if(layout.width>0&&layout.height>0){setWidth(layout.width);setHeight(layout.height);}}}>
  <Text style={{color:dk.muted,fontSize:11,paddingHorizontal:12,paddingBottom:8}}>电脑网页 · {error?'连接中断':ready?'已连接':'正在连接'}</Text>
  {error?<View style={{padding:14,gap:12}}><Text accessibilityRole="alert" style={{color:dk.bad,fontSize:12}}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="重新连接网页预览" onPress={()=>setRetry(v=>v+1)}><Text style={{color:dk.accentText}}>重新连接</Text></Pressable></View>:null}
  {frame?.dialog?<View accessibilityLabel="网页对话框" style={{padding:14,gap:12,borderWidth:1,borderColor:dk.line,borderRadius:8,margin:8}}><Text style={{color:dk.text}}>{frame.dialog.message}</Text>
   {frame.dialog.type==='prompt'?<TextInput accessibilityLabel="网页对话框输入" value={prompt} onChangeText={setPrompt} maxLength={2048} style={{color:dk.text,borderWidth:1,borderColor:dk.line,padding:8}}/>:null}
   <View style={{flexDirection:'row',gap:8}}>{frame.dialog.type!=='alert'?button('取消对话框',()=>send({action:'dialog',dialogId:frame.dialog!.id,accept:false})):null}{button('确认对话框',()=>send({action:'dialog',dialogId:frame.dialog!.id,accept:true,...(frame.dialog!.type==='prompt'?{prompt}:{})}))}</View></View>:null}
  <ScrollView scrollEnabled={!selectionMode&&!annotating&&!elementPicking} style={{flex:1}} contentContainerStyle={{flexGrow:1}}>{frame?<BrowserAnnotations scopeKey={`${renderedScope}|${url}|${revision}`} frame={frame} onCaptureFrame={captureAnnotationFrame} onLocate={async point=>{await domInput({action:'scrollTo',x:point.x,y:point.y});}} url={frame.url} enabled={annotating&&active&&ready&&!error&&url===frame.url} onDone={()=>onAnnotationDone?.()} onCompose={onCompose} viewport={{width:frame.width,height:frame.height}} scroll={{x:frame.scrollX??0,y:frame.scrollY??0}}>{frame.imageBase64?<RemotePreviewCanvas frame={frame} width={width} disabled={!active||Boolean(error)||Boolean(frame.dialog)} selectionMode={selectionMode} elementPicking={elementPicking} onInput={input=>{if(input.action==='element-pick'){void domInput(input).catch(reason=>{if(currentScope.current===renderedScope&&currentActive.current)setElementError(reason instanceof Error?reason.message:'无法选择元素');});}else send(input);}} onCopySelection={copySelection}/>:<Text style={{padding:20,color:dk.muted,fontSize:12}}>网页截图尚未读取，可重试截图后继续批注。</Text>}</BrowserAnnotations>:!error?<ActivityIndicator style={{margin:36}} color={dk.muted}/>:null}</ScrollView>
  {elementError?<Text accessibilityRole="alert" style={{color:dk.bad,paddingHorizontal:12,fontSize:12}}>{elementError}</Text>:null}
  {frame?.domSupported||controls?<ScrollView style={{maxHeight:Math.max(160,height*0.6),flexGrow:0,flexShrink:1}} keyboardShouldPersistTaps="handled"><BrowserElementEditor scopeKey={`${renderedScope}|${url}|${revision}`} frame={frame} onCaptureFrame={captureAnnotationFrame} active={active&&ready&&!error&&!annotating&&!frame?.dialog&&url===frame?.url} picking={elementPicking} onPickingChange={value=>{setElementPicking(value);if(value)setSelectionMode(false);}} onInput={domInput} onCompose={onCompose}/></ScrollView>:null}
  {inspecting?<View style={{maxHeight:220,padding:12,borderTopWidth:1,borderColor:dk.line}}><Text style={{color:dk.text,fontSize:12,marginBottom:6}}>网页结构</Text><ScrollView><Text selectable style={{color:dk.text2,fontFamily:'monospace',fontSize:11}}>{frame?.inspection||'正在读取网页结构…'}</Text></ScrollView></View>:null}
  <PreviewLogPanel scopeKey={`${renderedScope}|${frame?.pageId??''}|${frame?.documentId??''}|${url}|${revision}`} entries={frame?.url===url?frame?.logs??[]:[]} origin={frame?.url??url} supported={frame?.logsSupported===true} unavailableReason="当前电脑端未开放网页日志，请更新电脑端后重新连接预览" active={active&&ready&&!error&&frame?.url===url} onCompose={onCompose?text=>{if(!currentActive.current||currentScope.current!==renderedScope||latestURL.current!==url)return false;return onCompose(text);}:undefined}/>
  <Pressable accessibilityRole="button" accessibilityLabel={controls?'收起网页操作':'展开网页操作'} onPress={()=>setControls(value=>!value)} style={{padding:9,alignSelf:'flex-end'}}><Text style={{fontSize:11,color:dk.muted}}>{controls?'收起操作':'网页操作'}</Text></Pressable>
  <View style={{padding:10,gap:8,borderTopWidth:1,borderTopColor:dk.line,display:controls||frame?.chooser||frame?.downloads?.length?'flex':'none'}}>
   {notice||transfer?<Text accessibilityLiveRegion="polite" style={{color:dk.muted,fontSize:11}}>{transfer||notice}</Text>:null}
   {frame?.chooser?<View style={{flexDirection:'row',gap:8,alignItems:'center'}}><Text style={{color:dk.text2,fontSize:12,flex:1}}>网页请求上传文件</Text>{button('选择文件',()=>void upload(),Boolean(transfer))}</View>:null}
   {frame?.downloads?.map(item=><View key={item.id} style={{flexDirection:'row',gap:8,alignItems:'center'}}><Text numberOfLines={1} style={{color:dk.text2,fontSize:12,flex:1}}>{item.name} · {item.state==='completed'?'已下载':item.state==='canceled'?'已取消':'下载中'}</Text>{item.state==='completed'?button(`保存 ${item.name}`,()=>void download(item.id),Boolean(transfer)):null}</View>)}
   <View style={{flexDirection:'row',gap:7}}><TextInput accessibilityLabel="网页输入内容" placeholder="点击网页字段后输入" placeholderTextColor={dk.muted} value={text} onChangeText={setText} maxLength={4096}
    onSubmitEditing={()=>{if(text){send({action:'text',text});setText('');}}} style={{flex:1,minWidth:0,color:dk.text,padding:8,borderWidth:1,borderColor:dk.line,borderRadius:8}}/>
    <Pressable accessibilityRole="button" accessibilityLabel="输入到电脑网页" disabled={!active||!text||Boolean(error)||!ready} onPress={()=>{send({action:'text',text});setText('');}} style={{padding:9}}><Text style={{color:dk.text}}>输入</Text></Pressable></View>
   <View style={{flexDirection:'row',flexWrap:'wrap',gap:6}}>{button('回车',()=>send({action:'key',key:'Enter'}))}{button('Tab',()=>send({action:'key',key:'Tab'}))}{button('退格',()=>send({action:'key',key:'Backspace'}))}{button('向上滚动',()=>send({action:'scroll',deltaY:-380}))}{button('向下滚动',()=>send({action:'scroll',deltaY:380}))}{button(selectionMode?'结束选择':'选择文字',()=>setSelectionMode(v=>!v))}{button('复制选中',()=>void copySelection())}{button('检查网页',()=>{if(!inspecting)send({action:'inspect'});setInspecting(v=>!v);})}</View>
  </View>
 </View>;
}
