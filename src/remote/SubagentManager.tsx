import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import { childAgentTitle } from './conversation-metadata';
import { SubagentList, type SubagentGroup } from './SubagentList';
import { useWorkspaceRuntime } from './WorkspaceRuntimeContext';
import { captureHubSubagents, subagentControlReason, type SubagentSelection, type SubagentSnapshot } from './subagent-controls';

/** Child status comes from an authenticated child snapshot, never the parent's
 * completed spawn call. Bulk stop freezes those exact turn identities. */
export function SubagentManager({visible,selection,onOpenSession}:{visible:boolean;selection:SubagentSelection;onOpenSession:(key:string)=>void}) {
  const d=useDesk(),runtime=useWorkspaceRuntime();
  const identity=JSON.stringify([runtime?.scope,selection.deviceId,selection.parentSessionKey,selection.agent.id,selection.agent.api.accountId,selection.surface,selection.children,selection.agent.capabilities]);
  const current=useRef(identity);current.current=identity;
  const active=useRef(visible);active.current=visible;
  const [snapshots,setSnapshots]=useState<Record<string,SubagentSnapshot>>({}),[busy,setBusy]=useState<Record<string,boolean>>({}),[messages,setMessages]=useState<Record<string,string>>({});
  const [batch,setBatch]=useState(false);
  const [expanded,setExpanded]=useState<string|null>(null),[management,setManagement]=useState(false);
  const pending=useRef(new Set<string>()),mounted=useRef(true);
  const transport=useMemo(()=>runtime ? runtime.captureSubagents?.(selection) ?? {isCurrent:()=>false,read:async()=>{throw new Error('当前连接未开放子智能体控制');},stop:async()=>{throw new Error('当前连接未开放子智能体控制');},continue:async()=>{throw new Error('当前连接未开放子智能体控制');}} : captureHubSubagents(selection),[identity]);
  const wanted=()=>mounted.current&&current.current===identity&&active.current&&transport.isCurrent();
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setSnapshots({});setBusy({});setMessages({});setBatch(false);setExpanded(null);setManagement(false);pending.current.clear();},[identity]);
  const read=async(key:string)=>{
    if(!wanted()||pending.current.has(key))return;pending.current.add(key);setBusy(value=>({...value,[key]:true}));
    try {const snapshot=await transport.read(key);if(wanted()){setSnapshots(value=>({...value,[key]:snapshot}));setMessages(value=>({...value,[key]:''}));}}
    catch(reason){if(wanted()){setMessages(value=>({...value,[key]:reason instanceof Error?reason.message:'状态读取失败'}));setSnapshots(value=>{const next={...value};delete next[key];return next;});}}
    finally {if(current.current===identity){pending.current.delete(key);if(mounted.current)setBusy(value=>({...value,[key]:false}));}}
  };
  const refresh=async(keys=selection.children)=>{
    const queue=keys.slice(0,64);await Promise.all([0,1].map(async()=>{while(queue.length&&wanted())await read(queue.shift()!);}));
  };
  useEffect(()=>{if(visible)void refresh(selection.children.slice(0,8));},[identity,visible]);
  const control=async(key:string,action:'stop'|'continue',frozen=snapshots[key])=>{
    if(!wanted()||pending.current.has(key))return;
    const reason=subagentControlReason(selection,frozen,action);if(reason){setMessages(value=>({...value,[key]:reason}));return;}
    pending.current.add(key);setBusy(value=>({...value,[key]:true}));
    try {
      if(action==='stop'){const status=await transport.stop(frozen);if(wanted())setMessages(value=>({...value,[key]:status==='stopped'?'已停止':status==='already_finished'?'这一轮已经结束':status==='requested'?'已请求停止，刷新核对':'停止结果未确认，请刷新核对'}));}
      else {await transport.continue(frozen);if(wanted())setMessages(value=>({...value,[key]:'已继续此子会话，请刷新查看进度'}));}
      if(wanted())setSnapshots(value=>{const next={...value};delete next[key];return next;});
    } catch(reason) {if(wanted()){setMessages(value=>({...value,[key]:`${reason instanceof Error?reason.message:'执行结果未确认'}；不会自动重发`}));setSnapshots(value=>{const next={...value};delete next[key];return next;});}}
    finally {if(current.current===identity){pending.current.delete(key);if(mounted.current)setBusy(value=>({...value,[key]:false}));}}
  };
  const stoppable=selection.children.filter(key=>!subagentControlReason(selection,snapshots[key],'stop')&&!busy[key]);
  const stopAll=async()=>{
    if(!wanted()||batch)return;
    const targets=stoppable.map(key=>({key,snapshot:snapshots[key]}));setBatch(true);
    try{for(const target of targets){if(!wanted())break;await control(target.key,'stop',target.snapshot);}}
    finally{if(mounted.current&&current.current===identity)setBatch(false);}
  };
  const groupOf=(key:string):SubagentGroup=>{const status=snapshots[key]?.session.status;return status==='running'||status==='waiting_approval'?'running':status==='idle'?'ended':status==='failed'?'failed':'unconfirmed';};
  const managementMenu=management?<View style={[styles.menu,{backgroundColor:d.surface2}]}>
    <Pressable accessibilityRole="button" accessibilityLabel="刷新子智能体状态" onPress={()=>void refresh()} style={styles.button}><Text style={{fontSize:13,color:d.text2}}>刷新全部状态</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="停止所有已确认运行的子智能体" disabled={!stoppable.length||batch} onPress={()=>void stopAll()} style={[styles.button,(!stoppable.length||batch)&&styles.disabled]}>{batch?<ActivityIndicator size="small" color={d.muted}/>:<Text style={{fontSize:13,color:d.text2}}>全部停止</Text>}</Pressable>
    {selection.surface!=='cli'?<Text style={[styles.meta,{color:d.muted}]}>桌面宿主尚未开放停止和继续接口。</Text>:null}
  </View>:null;
  return <SubagentList items={selection.children.map(key=>{
    const snapshot=snapshots[key],info=snapshot?.session;
    const title=info?childAgentTitle(info):'子智能体';
    const stopReason=subagentControlReason(selection,snapshot,'stop'),continueReason=subagentControlReason(selection,snapshot,'continue');
    return {id:key,title,group:groupOf(key),updatedAt:info?.updatedAt,busy:busy[key],detail:<>
      {expanded===key?<View style={[styles.menu,{backgroundColor:d.surface2}]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`刷新${title}`} onPress={()=>void read(key)} style={styles.button}><Text style={{fontSize:13,color:d.text2}}>刷新</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={stopReason||`停止${title}`} disabled={Boolean(stopReason)||batch||busy[key]} onPress={()=>void control(key,'stop')} style={[styles.button,(Boolean(stopReason)||batch||busy[key])&&styles.disabled]}><Text style={{fontSize:13,color:d.text2}}>停止</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={continueReason||`继续${title}会话`} disabled={Boolean(continueReason)||batch||busy[key]} onPress={()=>void control(key,'continue')} style={[styles.button,(Boolean(continueReason)||batch||busy[key])&&styles.disabled]}><Text style={{fontSize:13,color:d.text2}}>继续会话</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="收起子智能体操作" onPress={()=>setExpanded(null)} style={styles.iconButton}><View style={{transform:[{rotate:'180deg'}]}}><Icon name="chevronDown" size={18} color={d.muted} accent={d.muted}/></View></Pressable>
      </View>:null}
      {messages[key]?<Text accessibilityRole="alert" style={[styles.meta,{color:d.muted}]}>{messages[key]}</Text>:expanded===key&&info&&stopReason&&continueReason?<Text style={[styles.meta,{color:d.muted}]}>{info.controllable?info.status==='unknown'?'状态未确认，刷新后才能操作':'':stopReason}</Text>:null}
    </>};
  })} onOpen={key=>{if(wanted())onOpenSession(key);}}
    onActions={key=>{if(wanted())setExpanded(value=>value===key?null:key);}}
    onManage={()=>setManagement(value=>!value)} management={managementMenu}/>;
}
const styles=StyleSheet.create({
  menu:{padding:5,borderRadius:8,flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:4},
  meta:{fontSize:12,lineHeight:18,paddingVertical:6},
  button:{minHeight:34,paddingHorizontal:10,alignItems:'center',justifyContent:'center'},
  iconButton:{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center'},
  disabled:{opacity:0.4},
});
