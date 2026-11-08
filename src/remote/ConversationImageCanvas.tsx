import React,{useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {AppState,Image,Pressable,ScrollView,StyleSheet,Text,TextInput,View,useWindowDimensions} from 'react-native';
import {useDesk} from '../theme';
import {ManagedImage} from './ManagedImage';
import {Icon,type IconName} from '../components/Icon';
import {ToolbarButton,ToolbarMenu} from './WorkbenchToolbar';
import type {AttachmentRef} from './client';
import {canvasImageKey,canvasImageRevision,imageNoteMatches,imageNotesPrompt,type CanvasImage,type ImageNote} from './conversation-images';
import {CanvasImageStage,fittedCanvasImageView,type CanvasImageView,type CanvasImageStageHandle,type CanvasZoomAction} from './CanvasImageStage';
import {boundedCanvasSession,canvasNoteNumber,canvasRecordPending,emptyCanvasHistory,freshCanvasRecord,loadCanvasRecord,recordCanvasNotes,redoCanvasNotes,retireCanvasNotes,saveCanvasRecord,undoCanvasNotes,type CanvasDraft as Draft,type CanvasHistory,type CanvasRecord,type CanvasSessionState} from './canvas-session';
export type {CanvasSessionState} from './canvas-session';

interface Props {scopeKey:string;images:CanvasImage[];initialId?:string;onRequest:(ref:AttachmentRef)=>void;onLoadImage?:(image:CanvasImage)=>void;onCompose:(text:string,images:CanvasImage[])=>boolean|Promise<boolean>;onClose:()=>void;onSubmitted?:()=>void;onSubmittingChange?:(submitting:boolean)=>void;closeLabel?:string;sessionStateRef?:React.MutableRefObject<CanvasSessionState|undefined>}
const emptyDraft:Draft={comment:''};
/** A scope change also invalidates any late gesture, storage and compose callback. */
export function ConversationImageCanvas(props:Props) {return <ImageCanvas key={props.scopeKey} {...props}/>;}
function ImageCanvas({scopeKey,images,initialId,onRequest,onLoadImage,onCompose,onClose,onSubmitted,onSubmittingChange,closeLabel='返回图片',sessionStateRef}:Props) {
  const d=useDesk(),window=useWindowDimensions();
  const restored=useRef(sessionStateRef?.current?.scopeKey===scopeKey?sessionStateRef.current:undefined).current;
  const [focused,setFocused]=useState<string|undefined>(()=>restored?restored.focused:initialId),[selected,setSelected]=useState<string[]>(()=>restored?.selected??images.filter(image=>image.id===initialId).map(canvasImageKey));
  const [notes,setNotes]=useState<ImageNote[]>([]),[ready,setReady]=useState(false),[drafts,setDrafts]=useState<Record<string,Draft>>(()=>restored?.drafts??{}),[marking,setMarking]=useState(false);
  const [history,setHistory]=useState<CanvasHistory>(emptyCanvasHistory),recordRef=useRef<CanvasRecord>(freshCanvasRecord(scopeKey)),hydrated=useRef(false);
  const [views,setViews]=useState<Record<string,CanvasImageView>>(()=>restored?.views??{}),[activeNoteId,setActiveNoteId]=useState<string>(),[editingId,setEditingId]=useState<string>();
  const [storageError,setStorageError]=useState(''),[restoreAttempt,setRestoreAttempt]=useState(0),[selectedOnly,setSelectedOnly]=useState(restored?.selectedOnly??false);
  const [sending,setSending]=useState(false),[sendError,setSendError]=useState(''),sendingRef=useRef(false);
  const [menuOpen,setMenuOpen]=useState(false),menuAnchor=useRef<View>(null);
  useLayoutEffect(()=>{onSubmittingChange?.(sending);return()=>{if(sending)onSubmittingChange?.(false);};},[sending,onSubmittingChange]);
  const [containerWidth,setContainerWidth]=useState(window.width),[gridWidth,setGridWidth]=useState(0);
  const notesRef=useRef(notes),alive=useRef(true),saveVersion=useRef(0),idCounter=useRef(0);notesRef.current=notes;
  const scroll=useRef<ScrollView>(null),notePositions=useRef<Record<string,number>>({}),notePanelY=useRef(0);
  const current=images.find(image=>image.id===focused),currentKey=current?canvasImageKey(current):undefined;
  const imageOwner=useMemo(()=>({key:currentKey}),[currentKey]),currentOwner=useRef(imageOwner);currentOwner.current=imageOwner;
  const stage=useRef<CanvasImageStageHandle>(null),zoomAnchor=useRef<View>(null);
  const [zoomMenuOwner,setZoomMenuOwner]=useState<typeof imageOwner>(),[zoomReading,setZoomReading]=useState<{owner:typeof imageOwner;zoom?:number}>();
  const reportZoom=useCallback((zoom:number|undefined)=>{if(currentOwner.current!==imageOwner)return;setZoomReading(old=>old?.owner===imageOwner&&old.zoom===zoom?old:{owner:imageOwner,zoom});},[imageOwner]);
  const setImageView=(value:CanvasImageView)=>{
    if(!alive.current||!hydrated.current||sendingRef.current||!currentKey||currentOwner.current!==imageOwner)return;
    setViews(old=>{const next={...old};delete next[currentKey];next[currentKey]=value;return boundedCanvasSession(scopeKey,{...recordRef.current.session,views:next}).views;});
  };
  const zoomImage=(action:CanvasZoomAction)=>{
    if(!alive.current||!hydrated.current||sendingRef.current||currentOwner.current!==imageOwner||stage.current?.imageKey!==currentKey)return;
    stage.current?.zoom(action);
  };
  const latestImages=useRef(images);latestImages.current=images;
  const selectedImages=images.filter(image=>selected.includes(canvasImageKey(image)));
  const selectionSignature=JSON.stringify(images.map(canvasImageKey));
  const draftKey=editingId?`edit:${editingId}`:currentKey??`batch:${JSON.stringify([...selected].sort())}`;
  const draft=drafts[draftKey]??emptyDraft;
  const updateDraft=(value:Partial<Draft>)=>{if(alive.current&&hydrated.current&&!sendingRef.current)setDrafts(old=>{const next={...old},draft={...(old[draftKey]??emptyDraft),...value};delete next[draftKey];next[draftKey]=draft;return boundedCanvasSession(scopeKey,{...recordRef.current.session,drafts:next}).drafts;});};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{let cancelled=false;setReady(false);void loadCanvasRecord(scopeKey).then(value=>{
    if(cancelled)return;recordRef.current=value;notesRef.current=value.notes;setNotes(value.notes);setHistory(value.history);
    const state=restored??(value.session.initialized?value.session:undefined);
    if(state){const source=latestImages.current;setFocused(state.focusedKey?source.find(image=>canvasImageKey(image)===state.focusedKey)?.id:state.focused);setSelected(state.selected.filter(key=>source.some(image=>canvasImageKey(image)===key)));setDrafts(state.drafts);setViews(state.views);setSelectedOnly(state.selectedOnly);}
    hydrated.current=true;setReady(true);setStorageError(canvasRecordPending(scopeKey)?'画布更改尚未保存到本机，请重试保存。':'');
  }).catch(()=>{if(!cancelled)setStorageError('批注暂时无法读取，请重试。');});return()=>{cancelled=true;};},[scopeKey,restoreAttempt]);
  useLayoutEffect(()=>{
    if(!ready)return;
    const session=boundedCanvasSession(scopeKey,{scopeKey,initialized:true,focused,focusedKey:currentKey,selected,drafts,views,selectedOnly});
    recordRef.current={...recordRef.current,notes,history,session};if(sessionStateRef)sessionStateRef.current=session;
  },[ready,scopeKey,focused,currentKey,selected,drafts,views,selectedOnly,notes,history,sessionStateRef]);
  const write=async(value:CanvasRecord)=>{const version=++saveVersion.current;try{await saveCanvasRecord(value);if(alive.current&&saveVersion.current===version){setStorageError('');setSendError(error=>error.startsWith('图片和批注已加入对话，画布状态尚未保存')?'':error);}}catch(error){if(alive.current&&saveVersion.current===version)setStorageError('画布更改尚未保存到本机，请重试保存。');throw error;}};
  useEffect(()=>{if(!ready)return;const timer=setTimeout(()=>{void write(recordRef.current).catch(()=>{});},120);return()=>clearTimeout(timer);},[ready,focused,currentKey,selected,drafts,views,selectedOnly,notes,history]);
  useEffect(()=>{
    const flush=()=>{if(hydrated.current)void saveCanvasRecord(recordRef.current).catch(()=>{});};
    const subscription=AppState.addEventListener('change',state=>{if(state!=='active')flush();});
    return()=>{subscription.remove();flush();};
  },[scopeKey]);
  useEffect(()=>{
    if(!ready)return;const valid=new Set(images.map(canvasImageKey));setSelected(old=>{const next=old.filter(key=>valid.has(key));return next.length===old.length?old:next;});
    if(focused&&!images.some(image=>image.id===focused)){setFocused(undefined);setEditingId(undefined);}
  },[selectionSignature,ready]);
  useEffect(()=>{setMarking(false);setEditingId(undefined);setActiveNoteId(undefined);if(current&&!current.uri){if(onLoadImage)onLoadImage(current);else if(current.ref)onRequest(current.ref);}},[currentKey]);
  const acceptRecord=(next:CanvasRecord)=>{recordRef.current=next;notesRef.current=next.notes;setNotes(next.notes);setHistory(next.history);};
  const persist=(next:ImageNote[],consumeDraft?:string)=>{if(!alive.current||!ready)return;let record=recordCanvasNotes(recordRef.current,next);if(consumeDraft){const drafts={...record.session.drafts};delete drafts[consumeDraft];record={...record,session:{...record.session,drafts}};}acceptRecord(record);void write(record).catch(()=>{});};
  const travel=(direction:'undo'|'redo')=>{if(!alive.current||!ready||sendingRef.current)return;const next=direction==='undo'?undoCanvasNotes(recordRef.current):redoCanvasNotes(recordRef.current);acceptRecord(next);setEditingId(undefined);setActiveNoteId(undefined);setMarking(false);void write(next).catch(()=>{});};
  const focus=(id?:string)=>{setFocused(id);setMarking(false);setEditingId(undefined);setActiveNoteId(undefined);};
  const clearDraft=()=>setDrafts(old=>{const next={...old};delete next[draftKey];return next;});
  const add=()=>{
    const targets=current?[current]:selectedImages;if(!alive.current||sendingRef.current||!ready||!draft.comment.trim()||!targets.length)return;
    if(editingId){persist(notesRef.current.map(note=>note.id===editingId?{...note,comment:draft.comment.trim(),region:draft.region}:note),draftKey);setEditingId(undefined);}
    else persist([...notesRef.current,...targets.map(image=>({id:`${Date.now()}-${++idCounter.current}`,imageId:image.id,imageRevision:canvasImageRevision(image),comment:draft.comment.trim(),...(current&&draft.region?{region:draft.region}: {})}))].slice(-100),draftKey);
    clearDraft();setMarking(false);
  };
  const send=async()=>{
    if(!alive.current||sendingRef.current||!ready)return;
    const submitted=notesRef.current.filter(note=>images.some(image=>imageNoteMatches(note,image)));
    const prompt=imageNotesPrompt(images,submitted);if(!prompt)return;
    const sourceImages=[...new Map(images.filter(image=>submitted.some(note=>imageNoteMatches(note,image))).map(image=>[canvasImageKey(image),image])).values()];
    sendingRef.current=true;setSending(true);setSendError('');
    try {
      const accepted=await onCompose(prompt,sourceImages);
      if(!alive.current)return;
      if(!accepted){setSendError('图片和批注尚未加入对话，已保留批注，请重试。');return;}
      const submittedIds=new Set(submitted.map(note=>note.id));
      const next=retireCanvasNotes(recordRef.current,submittedIds);acceptRecord(next);setDrafts(next.session.drafts);
      try{await write(next);}catch{if(alive.current)setSendError('图片和批注已加入对话，画布状态尚未保存。请重试保存后再关闭。');return;}
      if(alive.current)(onSubmitted??onClose)();
    }catch(error){if(alive.current)setSendError(error instanceof Error&&error.message?`未能添加到对话：${error.message}`:'图片和批注尚未加入对话，已保留批注，请重试。');}
    finally{sendingRef.current=false;if(alive.current)setSending(false);}
  };
  const locate=(note:ImageNote,edit=false)=>{
    const image=images.find(image=>imageNoteMatches(note,image));if(!image)return;
    setFocused(image.id);setMarking(false);setActiveNoteId(note.id);setEditingId(edit?note.id:undefined);
    setViews(old=>({...old,[canvasImageKey(image)]:fittedCanvasImageView}));
    if(edit)setDrafts(old=>({...old,[`edit:${note.id}`]:old[`edit:${note.id}`]??{comment:note.comment,region:note.region}}));
  };
  const pendingLocate=useRef<{note:ImageNote;edit:boolean}|undefined>(undefined);
  useEffect(()=>{const pending=pendingLocate.current;if(pending&&current&&imageNoteMatches(pending.note,current)){pendingLocate.current=undefined;locate(pending.note,pending.edit);}},[currentKey]);
  const openNote=(note:ImageNote,edit=false)=>{if(sendingRef.current)return;const image=images.find(image=>imageNoteMatches(note,image));if(!image)return;if(image.id!==focused)pendingLocate.current={note,edit};locate(note,edit);scroll.current?.scrollTo({y:0,animated:true});};
  const guarded=(action:()=>void,early=false)=>()=>{if(alive.current&&!sendingRef.current&&(hydrated.current||early))action();};
  const button=(label:string,action:()=>void,disabled=false,active=false,primary=false)=>{const early=label===closeLabel||label==='重新读取批注',blocked=disabled||sending||!ready&&!early;return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled:blocked,selected:active}} disabled={blocked} onPress={guarded(action,early)} style={[s.button,{backgroundColor:primary?d.text:active?d.surface2:'transparent',opacity:blocked?.4:1}]}><Text style={{color:primary?d.surface:d.text,fontSize:13}}>{label}</Text></Pressable>;};
  const iconButton=(label:string,icon:IconName,action:()=>void,disabled=false)=><ToolbarButton icon={icon} label={label} disabled={disabled||sending||!ready&&label!==closeLabel} onPress={guarded(action,label===closeLabel)}/>;
  const menuAction=(label:string,action:()=>void,disabled=false,icon?:IconName)=>({label,icon,disabled:disabled||sending||!ready,onPress:guarded(action)});
  const wide=containerWidth>=900,inlineHistory=containerWidth>=680,shownImages=selectedOnly?selectedImages:images;
  const zoom=zoomReading?.owner===imageOwner?zoomReading.zoom:undefined,zoomMenu=zoomMenuOwner===imageOwner;
  const zoomBlocked=!ready||sending||!current?.uri;
  const currentIndex=images.findIndex(image=>image.id===focused);
  const paged=Boolean(current&&images.length>1),showImageName=containerWidth>=520;
  const pageLabel=`${currentIndex+1}/${images.length}`,pageWidth=Math.max(32,Math.ceil((String(images.length).length*14+4)*window.fontScale+2));
  // Reserve the widest page number before deciding which controls fit; targets stay 44px.
  const navigationWidth=(paged?88:0)+pageWidth+(showImageName?88:0);
  const inlineZoom=containerWidth>=390&&containerWidth>=16+44+navigationWidth+140+44+24+(inlineHistory?96:0);
  const imageTitle=current?`图片画布：${current.name}，第 ${currentIndex+1} 张，共 ${images.length} 张`:'图片画布';
  const availableWidth=gridWidth||Math.max(1,containerWidth-40),columns=Math.max(1,Math.floor((availableWidth+12)/192)),tileWidth=(availableWidth-(columns-1)*12)/columns;
  const currentNotes=notes.map((note,index)=>({note,number:canvasNoteNumber(note,index)})).filter(entry=>current&&imageNoteMatches(entry.note,current));
  const activeNotes=notes.filter(note=>images.some(image=>imageNoteMatches(note,image)));
  return <View testID="conversation-image-canvas" onLayout={event=>{if(event.nativeEvent.layout.width>0)setContainerWidth(event.nativeEvent.layout.width);}} style={{flex:1,minHeight:0,backgroundColor:d.surface}}>
    <View testID="canvas-header-toolbar"><View testID="canvas-image-toolbar" style={[s.bar,s.toolbar,{borderColor:d.line}]}>
      {iconButton(closeLabel,'arrowLeft',onClose)}
      <View testID="canvas-page-controls" style={s.navigation}>
        {paged?iconButton('上一张','chevronLeft',()=>focus(images[Math.max(0,currentIndex-1)]?.id),currentIndex===0):null}
        {current?<>
          {showImageName?<Text testID="canvas-image-title" numberOfLines={1} accessibilityLabel={imageTitle} style={[s.title,{color:d.text,marginRight:8}]}>{current.name}</Text>:null}
          <Text testID={showImageName?undefined:'canvas-image-title'} numberOfLines={1} accessibilityLabel={showImageName?undefined:imageTitle} style={[s.page,{color:d.text,width:pageWidth}]}>{pageLabel}</Text>
        </>:<Text testID="canvas-image-title" numberOfLines={1} accessibilityLabel={imageTitle} style={[s.title,{color:d.text}]}>图片画布</Text>}
        {paged?iconButton('下一张','chevronRight',()=>focus(images[Math.min(images.length-1,currentIndex+1)]?.id),currentIndex===images.length-1):null}
      </View>
      {current?<View testID="canvas-zoom-controls" style={s.controlGroup}>{inlineZoom?iconButton('缩小画布图片','zoomOut',()=>zoomImage('out'),zoomBlocked||zoom===undefined):null}
        <Pressable ref={zoomAnchor} collapsable={false} accessibilityRole="button" accessibilityLabel="画布缩放选项" accessibilityState={{expanded:zoomMenu,disabled:zoomBlocked}} disabled={zoomBlocked} onPress={guarded(()=>{if(currentOwner.current===imageOwner)setZoomMenuOwner(imageOwner);})} style={[s.zoom,{opacity:zoomBlocked?.4:1}]}><Text testID="canvas-zoom-level" style={{color:d.muted,fontSize:12}}>{zoom===undefined?'—':`${Math.round(zoom*100)}%`}</Text><Icon name="chevronDown" size={12} color={d.muted} accent={d.muted}/></Pressable>
        {inlineZoom?iconButton('放大画布图片','zoomIn',()=>zoomImage('in'),zoomBlocked||zoom===undefined):null}</View>:null}
      {inlineHistory?<View style={s.controlGroup}>{iconButton('撤销批注','undo',()=>travel('undo'),!history.past.length)}{iconButton('重做批注','redo',()=>travel('redo'),!history.future.length)}</View>:null}
      <ToolbarButton icon="more" label="画布更多操作" anchorRef={menuAnchor} disabled={sending} selected={menuOpen} onPress={()=>setMenuOpen(true)}/>
    </View></View>
    <ToolbarMenu visible={menuOpen} anchorRef={menuAnchor} onClose={()=>setMenuOpen(false)} label="画布操作" testID="canvas-actions-menu" actions={[
      ...(!inlineHistory?[menuAction('撤销批注',()=>travel('undo'),!history.past.length,'undo'),menuAction('重做批注',()=>travel('redo'),!history.future.length,'redo')]:[]),
      menuAction(focused?'全部图片':'聚焦',()=>focus(focused?undefined:selectedImages[0]?.id??images[0]?.id),!images.length,focused?'imageGrid':'image'),
      menuAction('全选',()=>setSelected(images.map(canvasImageKey)),!images.length||selectedImages.length===images.length,'selectAll'),
      menuAction('清空选择',()=>setSelected([]),!selectedImages.length,'selectionClear'),
      menuAction(selectedOnly?'显示全部':'只看已选',()=>setSelectedOnly(!selectedOnly),false,selectedOnly?'imageGrid':'filter'),
    ]}/>
    <ToolbarMenu visible={Boolean(current)&&zoomMenu} anchorRef={zoomAnchor} onClose={()=>setZoomMenuOwner(undefined)} label="画布缩放" testID="canvas-zoom-menu" actions={[
      ...(!inlineZoom?[menuAction('缩小画布图片',()=>zoomImage('out'),zoomBlocked||zoom===undefined,'zoomOut'),menuAction('放大画布图片',()=>zoomImage('in'),zoomBlocked||zoom===undefined,'zoomIn')]:[]),
      menuAction('适应画布',()=>zoomImage('fit'),zoomBlocked,'fitFrame'),
      menuAction('画布原始尺寸',()=>zoomImage('original'),zoomBlocked,'originalSize'),
    ]}/>
    {!ready?<Text style={{paddingHorizontal:16,paddingVertical:6,color:d.muted,fontSize:11}}>正在恢复画布…</Text>:null}
    <ScrollView ref={scroll} contentContainerStyle={{padding:containerWidth<400?12:20,gap:16}} keyboardShouldPersistTaps="handled">
      <View style={{flexDirection:focused&&wide?'row':'column',gap:20}}><View style={{flex:1,minWidth:0,gap:12}}>
      {current&&currentKey?<>
        <CanvasImageStage key={currentKey} ref={stage} image={current} height={Math.max(240,Math.min(760,window.height-200))} view={views[currentKey]??fittedCanvasImageView} onView={setImageView} onZoomChange={reportZoom} disabled={!ready||sending}
          marking={marking} region={!editingId&&activeNoteId?undefined:draft.region} onRegion={region=>{if(currentOwner.current===imageOwner)updateDraft({region});}} notes={currentNotes} activeNoteId={editingId?undefined:activeNoteId} onLocate={note=>{if(!alive.current||!hydrated.current||sendingRef.current||currentOwner.current!==imageOwner)return;locate(note);scroll.current?.scrollTo({y:Math.max(0,notePanelY.current+(notePositions.current[note.id]??0)),animated:true});}} onRetry={()=>{if(onLoadImage)onLoadImage(current);else if(current.ref)onRequest(current.ref);}}/>
        <View style={[s.row,{flexWrap:'wrap'}]}>{button(marking?'完成框选':'框选区域',()=>{setMarking(!marking);setActiveNoteId(undefined);},!current.uri,marking)}{draft.region?button('清除选区',()=>updateDraft({region:undefined})):null}<Text style={{color:d.muted,fontSize:12,flex:1,minWidth:100}}>{marking?'在图片上拖动框选；完成后填写批注':'拖动平移，双指缩放。批注标记可点按定位。'}</Text></View>
      </>:<>
        <Text style={{color:d.muted,fontSize:12}}>已选择 {selectedImages.length} / {images.length}</Text>
        <View onLayout={event=>{if(event.nativeEvent.layout.width>0)setGridWidth(event.nativeEvent.layout.width);}} style={s.grid}>{shownImages.map(image=>{const key=canvasImageKey(image),checked=selected.includes(key);return <View key={key} style={[s.tile,{borderColor:checked?d.text:d.line,width:tileWidth}]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`查看图片 ${image.name}`} disabled={sending||!ready} onPress={()=>{if(hydrated.current&&!sendingRef.current)focus(image.id);}} style={{aspectRatio:4/3,backgroundColor:d.surface2,alignItems:'center',justifyContent:'center'}}>{image.uri?<ManagedImage uri={image.uri} resizeMode="contain" style={{width:'100%',height:'100%'}}/>:<Text style={{color:d.muted,fontSize:12}}>点按读取图片</Text>}</Pressable>
          <Pressable accessibilityRole="checkbox" accessibilityState={{checked,disabled:sending||!ready}} disabled={sending||!ready} accessibilityLabel={`选择图片 ${image.name}`} onPress={()=>{if(hydrated.current&&!sendingRef.current)setSelected(value=>value.includes(key)?value.filter(id=>id!==key):[...value,key]);}} style={[s.row,{padding:10,minHeight:44}]}><Icon name={checked?'selectAll':'selectionClear'} size={18} color={d.text} accent={d.text}/><Text numberOfLines={1} style={{flex:1,color:d.text,fontSize:13}}>{image.name}</Text></Pressable>
        </View>;})}</View>
        {selectedOnly&&!selectedImages.length?<Text style={{color:d.muted,fontSize:13}}>尚未选择图片，点击“显示全部”后选择。</Text>:null}
      </>}
      {!images.length?<Text style={{color:d.muted,fontSize:13}}>本会话暂时没有图片。生成或发送图片后会自动汇集到这里。</Text>:null}
      </View><View onLayout={event=>{notePanelY.current=event.nativeEvent.layout.y;}} style={{width:focused&&wide?280:undefined,gap:12}}>
      {storageError?<View style={{gap:8}}><Text accessibilityRole="alert" style={{color:d.text2,fontSize:12}}>{storageError}</Text>{button(ready?'重试保存批注':'重新读取批注',()=>{if(ready)void write(recordRef.current).catch(()=>{});else setRestoreAttempt(value=>value+1);})}</View>:null}
      {images.length?<View style={[s.noteBox,{borderColor:d.line}]}><Text style={{color:d.muted,fontSize:12}}>{editingId?'编辑批注':current?'批注当前图片':`批注所选 ${selectedImages.length} 张图片`}</Text><TextInput accessibilityLabel="图片修改要求" value={draft.comment} editable={!sending&&ready} onChangeText={comment=>updateDraft({comment})} maxLength={4000} multiline placeholder="描述你希望修改的内容…" placeholderTextColor={d.muted} style={{color:d.text,minHeight:76,fontSize:14,lineHeight:22,padding:0}}/>
        {button(editingId?'保存批注':'添加批注',add,!ready||!draft.comment.trim()||(!current&&!selectedImages.length))}{editingId?button('取消编辑',()=>{setEditingId(undefined);setMarking(false);}):null}
      </View>:null}
      {notes.length?<Text style={{color:d.muted,fontSize:12}}>已添加 {activeNotes.length} 条批注{notes.length!==activeNotes.length?` · ${notes.length-activeNotes.length} 条原图不可用`:''}</Text>:null}
      {notes.map((note,index)=>{const number=canvasNoteNumber(note,index),image=images.find(i=>imageNoteMatches(note,i));return <View key={note.id} testID={`image-note-${number}`} onLayout={event=>{notePositions.current[note.id]=event.nativeEvent.layout.y;}} style={[s.noteBox,{borderColor:activeNoteId===note.id?d.text:d.line}]}>
        <Text style={{color:d.muted,fontSize:12}}>{number} · {image?.name??'原图片或版本不可用'}{note.region?' · 区域批注':''}</Text>
        <Text selectable style={{color:d.text,fontSize:13,lineHeight:20}}>{note.comment}</Text>
        <View style={[s.row,{justifyContent:'flex-end',gap:0}]}>{iconButton(`定位批注 ${number}`,'target',()=>openNote(note),!image)}{iconButton(`编辑批注 ${number}`,'edit',()=>openNote(note,true),!image)}{iconButton(`删除批注 ${number}`,'trash',()=>{persist(notesRef.current.filter(n=>n.id!==note.id));if(editingId===note.id)setEditingId(undefined);})}</View>
      </View>;})}
      </View></View>
    </ScrollView>
    {sendError?<Text accessibilityRole="alert" style={{paddingHorizontal:12,paddingVertical:8,color:d.text2,fontSize:12}}>{sendError}</Text>:null}
    <View style={[s.bar,{borderColor:d.line,borderTopWidth:1,borderBottomWidth:0}]}><Text accessibilityLiveRegion="polite" style={{flex:1,paddingLeft:8,color:d.muted,fontSize:12}}>{sending?'正在添加…':`${activeNotes.length} 条批注`}</Text>{button('添加到对话',()=>{void send();},!ready||!imageNotesPrompt(images,notes),false,true)}</View>
  </View>;
}
const s=StyleSheet.create({bar:{paddingHorizontal:8,paddingVertical:4,gap:2,flexDirection:'row',alignItems:'center',borderBottomWidth:StyleSheet.hairlineWidth},toolbar:{gap:8},navigation:{flex:1,minWidth:0,flexDirection:'row',alignItems:'center'},controlGroup:{flexShrink:0,flexDirection:'row',alignItems:'center'},title:{fontSize:14,fontWeight:'600',flex:1,minWidth:0},page:{fontSize:12,textAlign:'center',fontVariant:['tabular-nums'],flexShrink:0},zoom:{width:52,height:44,flexShrink:0,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:3},button:{minHeight:44,paddingHorizontal:10,paddingVertical:9,borderRadius:8,alignItems:'center',justifyContent:'center'},row:{flexDirection:'row',alignItems:'center',gap:8},grid:{flexDirection:'row',flexWrap:'wrap',gap:12},tile:{borderWidth:1,borderRadius:12,overflow:'hidden'},noteBox:{padding:12,borderWidth:1,borderRadius:12,gap:10}});
