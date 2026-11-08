import React, {createContext, useContext, useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, Text, View, useWindowDimensions} from 'react-native';
import {IconButton, showToast} from '../components/ui';
import {getSetting, setSetting} from '../storage/database';
import {useDesk} from '../theme';
import type {ConversationBlock} from './blocks';
import {WorkbenchPresentationProvider} from './workbench-presentation';

type Preferences = {textScale:number; simple:boolean};
const defaults:Preferences = {textScale:1, simple:false};
const Reading = createContext({ ...defaults, open:false, toggle:()=>{}, update:(_patch:Partial<Preferences>)=>{} });
const writes = new Map<string,Promise<void>>();

/** Reading preferences follow the same source boundary as the conversation. */
export function ConversationReadingProvider({scope,children}:{scope:string;children:React.ReactNode}) {
  const tablet=useWindowDimensions().width>=1000;
  const [state,setState]=useState({scope,preferences:defaults,open:false});
  const latest=useRef(scope);latest.current=scope;
  const revision=useRef(0);
  const preferences=state.scope===scope?state.preferences:defaults;
  const key=`remote.reading.v1:${scope}`;
  useEffect(()=>{
    let active=true;const version=revision.current;
    setState({scope,preferences:defaults,open:false});
    void (writes.get(key)??Promise.resolve()).catch(()=>{}).then(()=>getSetting(key)).then(raw=>{
      if(!active||latest.current!==scope||revision.current!==version||!raw)return;
      try {const value=JSON.parse(raw);setState(current=>({scope,open:current.scope===scope&&current.open,preferences:{textScale:[.9,1,1.15].includes(value.textScale)?value.textScale:1,simple:value.simple===true}}));} catch { /* Invalid old preferences use the readable defaults. */ }
    }).catch(()=>{});
    return()=>{active=false;};
  },[scope,key]);
  const update=(patch:Partial<Preferences>)=>{
    if(latest.current!==scope)return;
    revision.current+=1;
    const next={...preferences,...patch};setState({scope,preferences:next,open:state.scope===scope&&state.open});
    const write=(writes.get(key)??Promise.resolve()).catch(()=>{}).then(()=>setSetting(key,JSON.stringify(next)));
    writes.set(key,write);
    void write.catch(()=>{if(latest.current===scope)showToast('阅读设置暂未保存，本次仍然有效','alert');}).finally(()=>{if(writes.get(key)===write)writes.delete(key);});
  };
  return <Reading.Provider value={{...preferences,open:state.scope===scope&&state.open,update,toggle:()=>{if(latest.current===scope)setState(current=>({scope,preferences:current.scope===scope?current.preferences:defaults,open:current.scope===scope?!current.open:true}));}}}>
    <WorkbenchPresentationProvider presentation={tablet?'tablet':'phone'} textScale={preferences.textScale}>{children}</WorkbenchPresentationProvider>
  </Reading.Provider>;
}
export const useConversationReading=()=>useContext(Reading);
export function ConversationReadingButton(){const reading=useConversationReading();return <IconButton icon="settings" label="阅读设置与消息导航" size={36} iconSize={16} onPress={reading.toggle}/>;}

export function ConversationReadingPanel({blocks,onNavigate}:{blocks:readonly ConversationBlock[];onNavigate:(index:number)=>void}) {
  const d=useDesk(),reading=useConversationReading();
  if(!reading.open)return null;
  const prompts=blocks.flatMap((block,index)=>block.type==='user'?[{id:block.id,index,text:block.item.text.trim()||'图片或附件消息'}]:[]);
  const choice=(label:string,selected:boolean,onPress:()=>void)=><Pressable key={label} accessibilityRole="radio" accessibilityLabel={label} accessibilityState={{selected,checked:selected}} onPress={onPress} style={{minHeight:36,paddingHorizontal:12,justifyContent:'center',borderRadius:7,backgroundColor:selected?d.surface2:'transparent'}}><Text style={{fontSize:12,color:d.text}}>{label}</Text></Pressable>;
  return <View testID="conversation-reading-panel" style={{paddingHorizontal:16,paddingVertical:10,gap:8,borderBottomWidth:1,borderColor:d.line,backgroundColor:d.surface}}>
    <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:4}}><Text style={{fontSize:12,color:d.muted,marginRight:8}}>对话文字</Text>{([['紧凑',.9],['标准',1],['大字',1.15]] as const).map(([label,value])=>choice(label,reading.textScale===value,()=>reading.update({textScale:value})))}</View>
    <View style={{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:4}}><Text style={{fontSize:12,color:d.muted,marginRight:8}}>执行过程</Text>{choice('完整',!reading.simple,()=>reading.update({simple:false}))}{choice('简洁',reading.simple,()=>reading.update({simple:true}))}</View>
    {prompts.length?<><Text style={{fontSize:12,color:d.muted}}>消息导航 · 已加载 {prompts.length} 条提问</Text><ScrollView style={{maxHeight:160}} keyboardShouldPersistTaps="handled">{prompts.map((prompt,index)=><Pressable key={prompt.id} accessibilityRole="button" accessibilityLabel={`跳到提问 ${index+1}：${prompt.text.slice(0,60)}`} onPress={()=>{onNavigate(prompt.index);reading.toggle();}} style={{minHeight:36,paddingVertical:7,flexDirection:'row',gap:10}}><Text style={{color:d.muted,fontSize:12,width:24}}>{index+1}</Text><Text numberOfLines={1} style={{flex:1,fontSize:13,color:d.text}}>{prompt.text.replace(/\s+/g,' ')}</Text></Pressable>)}</ScrollView></>:null}
  </View>;
}
