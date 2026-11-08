import React,{useEffect,useRef,useSyncExternalStore} from 'react';
import {AppState,Platform,View,type ViewToken} from 'react-native';
import {useDesk} from '../theme';
import type {SessionInfo} from './client';
import type {Timeline} from './store';
import type {ConversationBlock} from './blocks';
import {conversationReadKey,conversationReadRevision,conversationUnread,observeConversationResult,readConversationResult,sessionResultStamp,subscribeConversationReads} from './conversation-unread';

export interface ConversationResultSource {scope:string;session?:SessionInfo;timeline?:Timeline;active:boolean}
export function useConversationUnread({scope,session,timeline,active}:ConversationResultSource){
  const revision=useSyncExternalStore(subscribeConversationReads,conversationReadRevision,conversationReadRevision);
  const key=scope&&session?conversationReadKey(scope,session):'',stamp=sessionResultStamp(session,timeline);
  useEffect(()=>{if(key&&active&&!session?.parentSessionKey)void observeConversationResult(key,stamp).catch(()=>{});},[key,active,stamp?.id,stamp?.at]);
  return {key,stamp,revision,unread:Boolean(key&&conversationUnread(key))};
}
/** Observe the loaded directory, including rows outside the virtualized viewport. */
export function useConversationResultIndex(sources:readonly ConversationResultSource[]){
  const snapshot=JSON.stringify(sources.filter(source=>source.active&&source.scope&&source.session&&!source.session.parentSessionKey).map(source=>[conversationReadKey(source.scope,source.session!),sessionResultStamp(source.session,source.timeline)]));
  useEffect(()=>{const entries=JSON.parse(snapshot) as [string,ReturnType<typeof sessionResultStamp>][];void Promise.all(entries.map(([key,stamp])=>observeConversationResult(key,stamp))).catch(()=>{});},[snapshot]);
}
export function UnreadResultDot({source,title,status}:{source:ConversationResultSource;title:string;status:string}){
  const d=useDesk(),result=useConversationUnread(source);
  return status==='idle'&&result.unread?<View accessible accessibilityRole="text" accessibilityLabel={`${title}有未读结果`} style={{width:6,height:6,borderRadius:3,backgroundColor:d.muted,marginHorizontal:5}}/>:null;
}
/** Mark only a visible final answer/terminal row, never merely opening a tab. */
export function useConversationResultReader(source:ConversationResultSource,blocks:readonly ConversationBlock[],onViewableItemsChanged:(info:{viewableItems:ViewToken[];changed:ViewToken[]})=>void){
  const result=useConversationUnread(source),latest=useRef({source,blocks,result,onViewableItemsChanged});latest.current={source,blocks,result,onViewableItemsChanged};
  const visible=useRef({key:result.key,ids:new Set<string>()});if(visible.current.key!==result.key)visible.current={key:result.key,ids:new Set()};
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const acknowledge=()=>{
    const owner=latest.current,{key,stamp}=owner.result;
    const foreground=()=>AppState.currentState!=='background'&&AppState.currentState!=='inactive'&&(Platform.OS!=='web'||typeof document==='undefined'||document.visibilityState!=='hidden');
    const current=()=>alive.current&&latest.current.result.key===key&&latest.current.result.stamp?.id===stamp?.id&&latest.current.source.active&&foreground();
    if(!key||!stamp||!current())return;
    const seen=owner.blocks.some(block=>visible.current.ids.has(block.id)&&('item'in block)&&
      (block.type==='assistant'&&block.item.id===stamp.messageId||!stamp.messageId&&block.type==='turn'&&block.item.turnId===stamp.turnId&&block.item.status==='completed'));
    if(seen)void readConversationResult(key,stamp,current).catch(()=>{});
  };
  const acknowledgeRef=useRef(acknowledge);acknowledgeRef.current=acknowledge;
  useEffect(()=>{acknowledgeRef.current();},[result.key,result.stamp?.id,result.revision,source.active,blocks]);
  useEffect(()=>{const sub=AppState.addEventListener('change',()=>acknowledgeRef.current());const onVisibility=()=>acknowledgeRef.current();if(Platform.OS==='web'&&typeof document!=='undefined')document.addEventListener('visibilitychange',onVisibility);return()=>{sub.remove();if(Platform.OS==='web'&&typeof document!=='undefined')document.removeEventListener('visibilitychange',onVisibility);};},[]);
  return useRef((info:{viewableItems:ViewToken[];changed:ViewToken[]})=>{visible.current={key:latest.current.result.key,ids:new Set(info.viewableItems.filter(item=>item.isViewable&&latest.current.blocks.includes(item.item)).map(item=>String(item.key??item.item?.id)))};latest.current.onViewableItemsChanged(info);acknowledgeRef.current();}).current;
}
