import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Pressable,ScrollView,Text,View} from 'react-native';
import {setStringAsync} from 'expo-clipboard';
import {sha256} from '@noble/hashes/sha2.js';
import {Sheet,showToast} from '../components/ui';
import {Icon} from '../components/Icon';
import {useDesk} from '../theme';
import {createComposerDraftSession,hydrateComposerImages,type ComposerDraft} from './composer-drafts';
import type {SentEditRestorer} from './sent-edit-recovery';
import type {RemoteImage} from './attachments';
import {copyTurnFeatures,type TurnFeatures} from './agent-features';
import {ManagedImage} from './ManagedImage';
import {ImageViewer} from './thread-extras';
import {conversationFontFamily} from './conversation-typography';
import {MotionPressable} from '../components/MotionPressable';

export type EditPhase='prepared'|'reverting'|'reverted'|'sending';
export interface EditBackupBody {version:1;text:string;features:TurnFeatures;phase:EditPhase;messageId:string;turnId:string;operationId:string}
export function decodeEditBackup(row:ComposerDraft):EditBackupBody {
  const raw=JSON.parse(row.text) as EditBackupBody;
  if(raw?.version!==1||typeof raw.text!=='string'||raw.text.length>100_000||!['prepared','reverting','reverted','sending'].includes(raw.phase)
    ||!raw.messageId||!raw.turnId||!raw.operationId)throw new Error('编辑备份无法读取，请保留应用数据');
  return {...raw,features:copyTurnFeatures(raw.features)};
}
/** Separate from the main composer: editing never overwrites a newer draft.
 * A network-side commit cannot be canceled by unmounting its message bubble. */
export function useSentEditBackup(scope:string,deviceId:string,identity:string,recovery?:{restore:SentEditRestorer;verify:()=>Promise<unknown>;revertOperations?:readonly string[];disabled?:boolean}) {
  const d=useDesk(),key=useMemo(()=>`${scope}|${deviceId}|sent-edit:${Array.from(sha256(new TextEncoder().encode(identity)),v=>v.toString(16).padStart(2,'0')).join('')}`,[scope,deviceId,identity]);
  const owner=useMemo(()=>scope&&deviceId?createComposerDraftSession(key,scope):undefined,[key,scope,deviceId]);
  const [snapshot,setSnapshot]=useState<{owner:typeof owner;row?:ComposerDraft;error?:string}>(),[open,setOpen]=useState(false),[image,setImage]=useState<string|null>(null),[active,setActive]=useState(false);
  const latest=useRef(owner);latest.current=owner;
  const rowRef=useRef<ComposerDraft|undefined>(undefined),ready=useRef(false),mounted=useRef(true);
  const [recoveryBusy,setRecoveryBusy]=useState(false),[recoveryError,setRecoveryError]=useState('');
  const recoveryOwner=useRef(recovery);recoveryOwner.current=recovery;
  const recoveryFlight=useRef<object|undefined>(undefined);
  useEffect(()=>{mounted.current=true;ready.current=false;rowRef.current=undefined;setOpen(false);setImage(null);setActive(false);
    recoveryFlight.current=undefined;setRecoveryBusy(false);setRecoveryError('');
    void owner?.restore().then(row=>{if(latest.current!==owner||!mounted.current)return;rowRef.current=row?.text?row:undefined;ready.current=true;setSnapshot({owner,row:rowRef.current});})
      .catch(reason=>{if(latest.current===owner&&mounted.current)setSnapshot({owner,error:reason instanceof Error?reason.message:'编辑备份读取失败'});});
    return()=>{mounted.current=false;owner?.dispose();};
  },[owner]);
  const current=()=>mounted.current&&latest.current===owner;
  const save=async(body:EditBackupBody,images:RemoteImage[])=>{
    if(!owner||!current()||!ready.current)throw new Error('编辑备份尚未准备好');
    if(body.text.length>100_000)throw new Error('消息不能超过 100,000 字符，原会话尚未回退');
    const row=await owner.save({text:JSON.stringify(body),images});
    if(current()){rowRef.current=row;setSnapshot({owner,row});}return row;
  };
  const clear=async()=>{const row=rowRef.current;if(!owner||!row||!current())return;if(!await owner.consume(row.revision,row.identity))throw new Error('编辑备份已变化，请重新读取');if(current()){rowRef.current=undefined;setSnapshot({owner});setOpen(false);}};
  const begin=async(body:EditBackupBody,images:RemoteImage[])=>{
    if(!ready.current||rowRef.current?.text)throw new Error('请先核对上次编辑保留的内容');
    if(current())setActive(true);return save(body,images);
  };
  const row=snapshot?.owner===owner?snapshot?.row:undefined;
  let body:EditBackupBody|undefined,problem=snapshot?.owner===owner?snapshot?.error:undefined;
  try{if(row)body=decodeEditBackup(row);}catch(reason){problem=reason instanceof Error?reason.message:'编辑备份无效';}
  const safeToRestore=(value:EditBackupBody)=>value.phase==='prepared'||value.phase==='reverted'||value.phase==='reverting'&&Boolean(recoveryOwner.current?.revertOperations?.includes(value.operationId));
  const restore=async()=>{
    const original=rowRef.current,handler=recoveryOwner.current;
    if(!original||!handler||handler.disabled||!current()||recoveryFlight.current)return;
    const token={};recoveryFlight.current=token;setRecoveryBusy(true);setRecoveryError('');
    const same=()=>current()&&rowRef.current===original&&recoveryFlight.current===token&&!recoveryOwner.current?.disabled;
    try{
      const saved=decodeEditBackup(original);
      if(!safeToRestore(saved))throw new Error('请先核对原会话的回退和送达状态，避免重复发送');
      const images=await hydrateComposerImages(scope,original);
      if(!same())return;
      if(!await recoveryOwner.current!.restore({text:saved.text,images,features:saved.features},saved.operationId))throw new Error('当前草稿尚未准备好，修改备份仍保留');
      if(!same())return;
      await clear();showToast('已恢复到输入框，尚未发送','check');
    }catch(reason){if(current())setRecoveryError(reason instanceof Error?reason.message:'恢复失败，修改备份仍保留');}
    finally{if(recoveryFlight.current===token){recoveryFlight.current=undefined;if(current())setRecoveryBusy(false);}}
  };
  const verify=async()=>{
    if(!recoveryOwner.current||!current()||recoveryFlight.current)return;
    const token={};recoveryFlight.current=token;setRecoveryBusy(true);setRecoveryError('');
    try{await recoveryOwner.current.verify();}catch(reason){if(current())setRecoveryError(reason instanceof Error?reason.message:'状态核对失败，请稍后重试');}
    finally{if(recoveryFlight.current===token){recoveryFlight.current=undefined;if(current())setRecoveryBusy(false);}}
  };
  const panel=<>
    {!active&&(row||problem)?<Pressable accessibilityRole="button" accessibilityLabel="查看未完成的消息编辑" onPress={()=>setOpen(true)} style={{flexDirection:'row',alignItems:'center',gap:6,minHeight:32,paddingHorizontal:12}}>
      <Icon name="edit" size={13} color={d.muted}/><Text style={{fontSize:12,color:d.muted}}>{problem?'编辑记录需检查':'编辑未完成 · 修改内容已保留'}</Text><Icon name="chevronRight" size={12} color={d.muted}/>
    </Pressable>:null}
    <Sheet visible={open&&Boolean(row||problem)} title="保留的修改内容" subtitle="备份已保留 · 不会自动发送" dismissible={!recoveryBusy} onClose={()=>{if(!recoveryBusy)setOpen(false);}}>
      <View style={{paddingHorizontal:18,paddingBottom:10,gap:10}}>
        <Text style={{fontFamily:conversationFontFamily,fontSize:12,lineHeight:19,color:d.muted}}>{problem|| (body?.phase==='prepared'?'原会话尚未开始回退。':body?.phase==='reverting'?'回退结果需要核对，请先刷新原会话。':body?.phase==='reverted'?'原会话已回退，修正版尚未确认发送。':'修正版送达状态需要核对，请先刷新原会话。')}</Text>
        {body?<ScrollView style={{maxHeight:200,backgroundColor:d.surface2,borderRadius:12}} contentContainerStyle={{padding:12}}><Text selectable style={{fontFamily:conversationFontFamily,fontSize:13,lineHeight:20,color:d.text}}>{body.text}</Text></ScrollView>:null}
        {row?.images.length?<ScrollView horizontal contentContainerStyle={{gap:8}}>{row.images.map(item=><Pressable key={item.uri} accessibilityRole="button" accessibilityLabel="查看原消息图片" onPress={()=>setImage(item.uri)}><ManagedImage uri={item.uri} style={{width:56,height:56,borderRadius:10}} resizeMode="cover"/></Pressable>)}</ScrollView>:null}
        {body?.features.skills?.length?<Text style={{fontSize:12,color:d.muted}}>技能：{body.features.skills.map(skill=>skill.name).join('、')}</Text>:null}
        {body&&recovery?<Text style={{fontSize:11,lineHeight:17,color:d.muted}}>{safeToRestore(body)?'文字、图片和上下文会一起恢复；当前输入会保留。恢复后由你确认发送。':'回退或送达结果仍需核对，暂不恢复为可重发的草稿。'}</Text>:null}
        {recoveryError?<Text accessibilityRole="alert" style={{fontSize:12,lineHeight:18,color:d.warn}}>{recoveryError}</Text>:null}
        <View style={{flexDirection:'row',flexWrap:'wrap',justifyContent:'flex-end',gap:8,marginTop:2}}>
          {body?<MotionPressable scaleTo={0.98} hitSlop={4} accessibilityRole="button" accessibilityLabel="复制修改内容" onPress={()=>void setStringAsync(body!.text).then(()=>showToast('已复制','copy'))} style={{minHeight:34,paddingHorizontal:14,borderRadius:10,backgroundColor:d.surface2,justifyContent:'center'}}><Text style={{fontFamily:conversationFontFamily,fontSize:12,color:d.text}}>复制内容</Text></MotionPressable>:null}
          {body&&recovery?(safeToRestore(body)?<MotionPressable scaleTo={0.98} hitSlop={4} accessibilityRole="button" accessibilityLabel="恢复修改到输入框" disabled={recoveryBusy||recovery.disabled} onPress={()=>void restore()} style={{minHeight:34,paddingHorizontal:14,borderRadius:10,backgroundColor:d.ink,justifyContent:'center',opacity:(recoveryBusy||recovery.disabled)?0.5:1}}><Text style={{fontFamily:conversationFontFamily,fontSize:12,fontWeight:'500',color:d.onInk}}>{recoveryBusy?'恢复中…':'恢复到输入框'}</Text></MotionPressable>:<MotionPressable scaleTo={0.98} hitSlop={4} accessibilityRole="button" accessibilityLabel="核对消息编辑状态" disabled={recoveryBusy} onPress={()=>void verify()} style={{minHeight:34,paddingHorizontal:14,borderRadius:10,backgroundColor:d.ink,justifyContent:'center',opacity:recoveryBusy?0.5:1}}><Text style={{fontFamily:conversationFontFamily,fontSize:12,fontWeight:'500',color:d.onInk}}>{recoveryBusy?'核对中…':'核对状态'}</Text></MotionPressable>):null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="已核对，清除编辑备份" disabled={recoveryBusy} onPress={()=>void clear().catch(reason=>showToast(String(reason),'alert'))} style={{alignSelf:'flex-end',minHeight:28,justifyContent:'center',opacity:recoveryBusy?0.5:1}}><Text style={{fontFamily:conversationFontFamily,fontSize:11,color:d.muted}}>已核对，清除备份</Text></Pressable>
      </View>
    </Sheet><ImageViewer uri={image} onClose={()=>setImage(null)}/>
  </>;
  return {begin,save,clear,settle:()=>{if(current())setActive(false);},blocked:Boolean(row||problem),panel};
}
