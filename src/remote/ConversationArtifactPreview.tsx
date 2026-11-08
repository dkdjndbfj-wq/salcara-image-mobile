import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import {useDesk} from '../theme';
import {InlineConversationArtifact} from './InlineConversationArtifact';
import {conversationArtifactId,conversationArtifactRevision,type ConversationArtifactTarget} from './conversation-artifact-target';
import {artifactVersionSeriesKey,compareArtifactSources,ensureArtifactVersion,restoreArtifactVersion,saveArtifactVersion,type ArtifactVersion,type ArtifactVersionSeries} from './artifact-versions';
import {artifactDraftKey,readArtifactDraft,writeArtifactDraft} from './artifact-drafts';
import {ToolbarButton,ToolbarMenu,type ToolbarAction} from './WorkbenchToolbar';

export function ConversationArtifactPreview(props:{target:ConversationArtifactTarget;onCompose?:(text:string)=>boolean|void;active?:boolean}) {
  return <ArtifactVersionPreview key={conversationArtifactId(props.target)} {...props}/>;
}

/** Preview stays mounted across tabs; only a selected immutable source changes
 * its revision. Draft editing never writes computer files or submits a task. */
function ArtifactVersionPreview({target,onCompose,active=true}:{target:ConversationArtifactTarget;onCompose?:(text:string)=>boolean|void;active?:boolean}) {
  const d=useDesk(),[mode,setMode]=useState<'preview'|'source'|'versions'>('preview');
  const [series,setSeries]=useState<ArtifactVersionSeries>(),[selectedId,setSelectedId]=useState(''),[compareId,setCompareId]=useState('');
  const [source,setSource]=useState(target.source),[editing,setEditing]=useState(false),[draftReady,setDraftReady]=useState(false);
  const [draftReload,setDraftReload]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [menu,setMenu]=useState(false),[showVersionTitle,setShowVersionTitle]=useState(false),menuAnchor=useRef<View>(null);
  const mounted=useRef(true),selectedRef=useRef(selectedId),draftOwner=useRef<string|undefined>(undefined);selectedRef.current=selectedId;
  const selected=series?.versions.find(version=>version.id===selectedId),head=series?.versions.at(-1);
  const draftKey=selected?artifactDraftKey(target.scopeKey,`conversation:${artifactVersionSeriesKey(target)}`,String(target.index),selected.id):undefined;
  const draft=useRef({key:draftKey,source,dirty:false,ready:draftReady});
  draft.current={key:draftKey,source,dirty:Boolean(selected&&source!==selected.source),ready:draftReady&&draftOwner.current===draftKey};
  const current=(id=selectedId)=>mounted.current&&selectedRef.current===id;
  const menuOwner=useMemo(()=>({}),[mode,selectedId,editing,source,draftReady,busy,onCompose]);
  const activeMenuOwner=useRef(menuOwner);activeMenuOwner.current=menuOwner;
  const currentMenu=()=>current()&&mode==='source'&&activeMenuOwner.current===menuOwner;
  useEffect(()=>{setMenu(false);},[mode,selectedId]);
  const selectSnapshot=(next:ArtifactVersionSeries,id=next.versions.at(-1)!.id)=>{
    draftOwner.current=undefined;setDraftReady(false);setDraftReload(value=>value+1);setSeries(next);setSelectedId(id);setCompareId(next.versions.length>1?next.versions.at(-2)!.id:'');setError('');
  };
  useEffect(()=>{
    mounted.current=true;
    void ensureArtifactVersion(target).then(value=>{if(mounted.current)selectSnapshot(value);},reason=>{if(mounted.current)setError(reason instanceof Error?reason.message:'版本读取失败');});
    return()=>{mounted.current=false;const value=draft.current;if(value.key&&value.ready&&value.dirty)void writeArtifactDraft(value.key,value.source).catch(()=>undefined);};
  },[]);
  useEffect(()=>{
    setDraftReady(false);setEditing(false);setSource(selected?.source??target.source);
    if(!selected||!draftKey)return;
    let active=true;
    void readArtifactDraft(draftKey).then(value=>{if(active){draftOwner.current=draftKey;setSource(value??selected.source);setEditing(value!==null&&value!==selected.source);setDraftReady(true);}},reason=>{if(active)setError(reason instanceof Error?reason.message:'源码草稿读取失败');});
    return()=>{active=false;};
  },[draftKey,draftReload]);
  useEffect(()=>{
    if(!draftKey||!draftReady||draftOwner.current!==draftKey||!editing||!selected||source===selected.source)return;
    const id=selected.id,timer=setTimeout(()=>{void writeArtifactDraft(draftKey,source).catch(reason=>{if(current(id))setError(reason instanceof Error?reason.message:'源码草稿保存失败');});},300);
    return()=>clearTimeout(timer);
  },[draftKey,draftReady,editing,source]);
  const switchVersion=async(version:ArtifactVersion)=>{
    if(busy||!series||!current()||version.id===selectedId)return;
    setBusy(true);
    try{if(draftKey&&draftReady&&selected&&source!==selected.source)await writeArtifactDraft(draftKey,source);
      if(current()){draftOwner.current=undefined;setDraftReady(false);setSelectedId(version.id);setNotice('');setError('');}
    }catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'源码草稿保存失败');}
    finally{if(mounted.current)setBusy(false);}
  };
  const save=async()=>{
    if(!selected||!head||!draftKey||!draftReady||busy||!current())return;
    setBusy(true);setError('');
    try{
      await writeArtifactDraft(draftKey,source);
      const next=await saveArtifactVersion(target,source,head.id);
      let cleanupError='';try{await writeArtifactDraft(draftKey,null);}catch{cleanupError='版本已保存，旧源码草稿清理失败；历史完整保留。';}
      if(current()){draft.current.dirty=false;selectSnapshot(next);setMode('preview');setNotice('已保存新的预览版本');if(cleanupError)setError(cleanupError);}
    }catch(reason){if(current())setError(reason instanceof Error?reason.message:'保存版本失败');}
    finally{if(mounted.current)setBusy(false);}
  };
  const restore=async()=>{
    if(!selected||!head||busy||!current())return;
    setBusy(true);setError('');
    try{
      if(draftKey&&draftReady&&source!==selected.source)await writeArtifactDraft(draftKey,source);
      const next=await restoreArtifactVersion(target,selected.id,head.id);
      if(current()){selectSnapshot(next);setMode('preview');setNotice('已将所选内容恢复为新版本，历史仍保留');}
    }catch(reason){if(current())setError(reason instanceof Error?reason.message:'恢复版本失败');}
    finally{if(mounted.current)setBusy(false);}
  };
  const discard=async()=>{
    if(!selected||!draftKey||!draftReady||busy||!current())return;
    setBusy(true);
    try{await writeArtifactDraft(draftKey,null);if(current()){draft.current.dirty=false;setSource(selected.source);setEditing(false);setError('');}}
    catch(reason){if(current())setError(reason instanceof Error?reason.message:'草稿清理失败');}
    finally{if(mounted.current)setBusy(false);}
  };
  const compose=()=>{
    if(!onCompose||!current()||busy)return;
    const content=editing?source:selected?.source??target.source;
    const fence='`'.repeat((content.match(/`+/g)??[]).reduce((max,value)=>Math.max(max,value.length+1),3));
    const text=`请基于这个界面源码副本继续修改。\n原消息：${target.messageId}\n代码块：${target.index+1}\n版本：${conversationArtifactRevision(content)}\n${fence}html\n${content}\n${fence}`;
    try{if(onCompose(text)===false)setError('对话草稿未接收，源码副本仍保留');else{setNotice('已加入对话草稿');setError('');}}
    catch(reason){setError(reason instanceof Error?reason.message:'对话草稿未接收，源码副本仍保留');}
  };
  const reload=async()=>{
    if(busy||!mounted.current)return;setBusy(true);
    try{const value=draft.current;if(value.key&&value.ready&&value.dirty)await writeArtifactDraft(value.key,value.source);
      const next=await ensureArtifactVersion(target);if(mounted.current)selectSnapshot(next);
    }catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'版本读取失败');}
    finally{if(mounted.current)setBusy(false);}
  };
  const comparison=series?.versions.find(version=>version.id===compareId);
  const changes=useMemo(()=>mode==='versions'&&comparison&&selected?compareArtifactSources(comparison.source,selected.source):[],[mode,comparison?.id,selected?.id]);
  const stats=useMemo(()=>changes.reduce((value,line)=>({...value,[line.kind]:value[line.kind]+1}),{add:0,remove:0,same:0}),[changes]);
  const versionNumber=(id:string)=>Math.max(0,series?.versions.findIndex(version=>version.id===id)??0)+1;
  const label=(version:ArtifactVersion)=>version.origin==='message'?'消息原稿':version.origin==='restore'?'恢复副本':'源码编辑';
  const canSave=Boolean(editing&&selected&&draftReady&&!busy&&source.trim()&&source!==selected.source);
  const menuActions:ToolbarAction[]=[
    !editing?{label:'编辑预览副本',icon:'edit',disabled:!draftReady||busy,onPress:()=>{if(currentMenu())setEditing(true);}}:
      {label:'丢弃本次修改',icon:'undo',disabled:!draftReady||busy,onPress:()=>{if(currentMenu())void discard();}},
    ...(onCompose?[{label:'加入对话草稿',icon:'compose' as const,disabled:busy||!draftReady,onPress:()=>{if(currentMenu())compose();}}]:[]),
  ];
  return <View testID="conversation-artifact-preview" style={{flex:1,minHeight:0,backgroundColor:d.surface}}>
    <View testID="artifact-version-toolbar" onLayout={event=>setShowVersionTitle(event.nativeEvent.layout.width>=440)} style={[s.toolbar,{borderBottomColor:d.line}]}>{(['preview','source','versions'] as const).map(value=><Pressable key={value} accessibilityRole="tab" accessibilityLabel={value==='preview'?'界面预览':value==='source'?'界面源码':'界面版本'} accessibilityState={{selected:mode===value}} onPress={()=>setMode(value)} style={[s.tab,{backgroundColor:mode===value?d.surface2:'transparent'}]}><Text style={{color:d.text,fontSize:12}}>{value==='preview'?'预览':value==='source'?'源码':'版本'}</Text></Pressable>)}
      <View style={s.title}>{selected&&showVersionTitle?<Text testID="artifact-version-title" numberOfLines={1} style={{color:d.muted,fontSize:11}}>v{versionNumber(selected.id)} · {label(selected)}</Text>:null}</View>
      {mode==='source'&&canSave?<Pressable accessibilityRole="button" accessibilityLabel="保存为新版本" onPress={()=>{if(currentMenu())void save();}} style={[s.save,{backgroundColor:d.surface2}]}><Text style={{fontSize:12,color:d.text}}>保存</Text></Pressable>:null}
      {mode==='source'?<ToolbarButton icon="more" label="界面源码更多操作" selected={menu} anchorRef={menuAnchor} onPress={()=>{if(currentMenu())setMenu(true);}}/>:null}
    </View>
    <ToolbarMenu visible={menu&&mode==='source'} anchorRef={menuAnchor} onClose={()=>setMenu(false)} label="界面源码操作" testID="artifact-source-actions-menu" actions={menuActions}/>
    {error?<View style={{paddingHorizontal:16,paddingVertical:8,gap:6}}><Text accessibilityRole="alert" style={{fontSize:12,color:d.warn}}>{error}</Text><Action label="重新读取版本" disabled={busy} onPress={()=>void reload()}/></View>:notice?<Text style={[s.notice,{color:d.muted}]}>{notice}</Text>:null}
    <ScrollView testID="artifact-live-preview" style={{flex:1,display:mode==='preview'?'flex':'none'}} contentContainerStyle={{flexGrow:1}} keyboardShouldPersistTaps="handled">
      <InlineConversationArtifact scopeKey={selected?JSON.stringify([target.scopeKey,'artifact-version',selected.id]):target.scopeKey} messageId={target.messageId} index={target.index} source={selected?.source??target.source} inline={false} active={active&&mode==='preview'} onCompose={onCompose&&selected?text=>current(selected.id)&&active&&onCompose(text)!==false:undefined}/>
    </ScrollView>
    {mode==='source'?<ScrollView style={{flex:1}} contentContainerStyle={{padding:16,gap:12}} keyboardShouldPersistTaps="handled">
      <Text style={{color:d.muted,fontSize:12}}>编辑预览副本，保存为新版本。</Text>
      {editing?<TextInput accessibilityLabel="界面源码副本" multiline autoCapitalize="none" autoCorrect={false} editable={draftReady&&!busy} value={source} onChangeText={value=>{setSource(value);setNotice('');}} style={[s.source,{color:d.text,borderColor:d.line,textAlignVertical:'top',minHeight:300,borderWidth:1,padding:12}]}/>:<Text selectable style={[s.source,{color:d.text}]}>{selected?.source??target.source}</Text>}
    </ScrollView>:null}
    {mode==='versions'?<ScrollView style={{flex:1}} contentContainerStyle={{padding:16,gap:12}} keyboardShouldPersistTaps="handled">
      <Text style={{color:d.muted,fontSize:12}}>同一条消息的同一成果 · {series?.versions.length??0} 个版本</Text>
      {[...(series?.versions??[])].reverse().map(version=><View key={version.id} style={[s.version,{borderColor:d.line,backgroundColor:version.id===selectedId?d.surface2:d.surface}]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`查看版本 ${versionNumber(version.id)}`} accessibilityState={{selected:version.id===selectedId}} disabled={busy} onPress={()=>void switchVersion(version)} style={{flex:1,minHeight:44,justifyContent:'center',gap:4}}><Text style={{fontSize:13,color:d.text}}>v{versionNumber(version.id)} · {label(version)}{version.id===head?.id?' · 最新':''}</Text><Text style={{fontSize:11,color:d.muted}}>{new Date(version.createdAt).toLocaleString()} · {version.revision.slice(0,8)}</Text></Pressable>
        <Action label={`比较基准 v${versionNumber(version.id)}`} disabled={busy||version.id===selectedId} selected={compareId===version.id} onPress={()=>setCompareId(version.id)}/>
      </View>)}
      {selected?<Action label={`将版本 ${versionNumber(selected.id)} 恢复为新版本`} disabled={busy||selected.id===head?.id} onPress={()=>void restore()}/>:null}
      {comparison&&selected&&comparison.id!==selected.id?<View style={{gap:8}}><Text style={{fontSize:12,color:d.text}}>v{versionNumber(comparison.id)} → v{versionNumber(selected.id)} · +{stats.add} / −{stats.remove}</Text>
        <ScrollView horizontal><View>{changes.slice(0,600).map((line,index)=><Text key={index} selectable style={[s.source,{color:line.kind==='remove'?d.warn:line.kind==='add'?d.accentText:d.muted,backgroundColor:line.kind==='same'?'transparent':d.surface2}]}>{`${line.oldLine??''}\t${line.newLine??''}\t${line.kind==='add'?'+':line.kind==='remove'?'−':' '} ${line.text}`}</Text>)}</View></ScrollView>
        {changes.length>600?<Text style={{color:d.muted,fontSize:11}}>比较共 {changes.length} 行，此处显示前 600 行；各版本完整源码可在源码页查看。</Text>:null}
      </View>:<Text style={{color:d.muted,fontSize:12}}>选择另一个版本作为比较基准。</Text>}
    </ScrollView>:null}
  </View>;
}
function Action({label,disabled,onPress,selected=false}:{label:string;disabled?:boolean;onPress:()=>void;selected?:boolean}){
  const d=useDesk();return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled,selected}} disabled={disabled} onPress={onPress} style={[s.action,{backgroundColor:selected?d.surface2:'transparent',opacity:disabled?.45:1,borderColor:d.line}]}><Text style={{fontSize:11,color:d.text2}}>{label}</Text></Pressable>;
}
const s=StyleSheet.create({toolbar:{minHeight:52,flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:8,paddingVertical:4,borderBottomWidth:StyleSheet.hairlineWidth},tab:{minWidth:44,minHeight:44,flexShrink:0,paddingHorizontal:10,justifyContent:'center',alignItems:'center',borderRadius:7},title:{flex:1,minWidth:0},save:{minWidth:44,minHeight:44,flexShrink:0,paddingHorizontal:10,justifyContent:'center',alignItems:'center',borderRadius:8},notice:{paddingHorizontal:16,paddingVertical:8,fontSize:12},action:{minHeight:44,paddingHorizontal:9,justifyContent:'center',borderWidth:StyleSheet.hairlineWidth,borderRadius:6},source:{fontSize:12,lineHeight:20,fontFamily:'monospace'},version:{flexDirection:'row',alignItems:'center',gap:8,padding:10,borderWidth:StyleSheet.hairlineWidth,borderRadius:8}});
