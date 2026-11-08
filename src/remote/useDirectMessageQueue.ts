import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProfile, ApprovalMode, PermissionMode, SessionInfo, WorkspaceMode } from './client';
import type { Timeline } from './store';
import type { DirectDraftInput } from './direct-composer-drafts';
import { createDirectMessageQueue, type DirectQueueEntry } from './direct-message-queue';
import type { DirectSessionServices } from './direct-session-services';
import { requestDirect } from './direct-api';
import { turnControlTarget, validTurnId } from './turn-control';
import { copyTurnFeatures, skillKey } from './agent-features';
import { directActionUncertain } from './direct-turn-actions';
import { reportedEfforts, reportsTextOnly } from './effort';
import { isApprovalMode, isPermissionMode } from './permission-mode';

function lastTerminal(timeline:Timeline) {
  return [...timeline.items].reverse().find(item=>item.kind==='turn'&&!item.parentId&&item.status!=='started'&&validTurnId(item.turnId));
}

/** A queue owns complete payloads, while every dispatch remains fenced by the
 * currently verified desktop, API, session and terminal turn boundary. */
export function useDirectMessageQueue({pairing,deviceId,workspaceMode,services,profile,session,timeline,canSend,sending,uncertain,autoAll,onRefresh}:{
  pairing:string;deviceId:string;workspaceMode:WorkspaceMode;services:DirectSessionServices;profile:AgentProfile;session:SessionInfo;
  timeline:Timeline;canSend:boolean;sending:boolean;uncertain:boolean;autoAll:boolean;onRefresh:()=>void;
}) {
  const queue=useMemo(()=>createDirectMessageQueue({pairing,deviceId,owner:JSON.stringify([services.scope,workspaceMode]),isCurrent:services.isCurrent}),[pairing,deviceId,services,workspaceMode]);
  const [entries,setEntries]=useState<DirectQueueEntry[]>([]),[ready,setReady]=useState(false),[error,setError]=useState(''),[dispatching,setDispatching]=useState(false);
  const mounted=useRef(true),identity=useRef(queue);identity.current=queue;
  const flight=useRef<object|undefined>(undefined),paused=useRef(false),explicitResumes=useRef(new Set<string>());
  const live=useRef({timeline,session,canSend,sending,uncertain,autoAll});live.current={timeline,session,canSend,sending,uncertain,autoAll};
  const current=()=>mounted.current&&identity.current===queue&&services.isCurrent();
  const reload=async()=>{const rows=await queue.load();if(current()){setEntries(rows);setError('');setReady(true);}return rows;};
  useEffect(()=>{
    mounted.current=true;setReady(false);setEntries([]);setError('');setDispatching(false);flight.current=undefined;paused.current=false;explicitResumes.current.clear();
    void reload().catch(reason=>{if(current())setError(reason instanceof Error?reason.message:'排队消息读取失败');});
    return()=>{mounted.current=false;queue.dispose();};
  },[queue]);
  const enqueue=async(input:DirectDraftInput)=>{
    if(!current()||!ready||!live.current.canSend||live.current.uncertain)return false;
    const terminal=lastTerminal(live.current.timeline);
    const saved=await queue.enqueue(input,terminal?.kind==='turn'?terminal.turnId:live.current.session.lastTerminalTurnId);
    if(current())setEntries(rows=>[...rows,saved]);
    try{await reload();}catch(reason){if(current())setError(reason instanceof Error?reason.message:'消息已排队，读取列表失败，请重试');}
    return true;
  };
  const pause=async()=>{
    paused.current=true;explicitResumes.current.clear();
    await queue.pause();
    await reload();
  };
  const editText=async(row:DirectQueueEntry,text:string)=>{paused.current=true;explicitResumes.current.clear();await queue.editText(row.id,row.revision,text);await reload();};
  const move=async(row:DirectQueueEntry,offset:-1|1)=>{paused.current=true;explicitResumes.current.clear();await queue.move(row.id,row.revision,offset);await reload();};
  const remove=async(row:DirectQueueEntry)=>{await queue.remove(row.id,row.revision);await reload();};
  const resume=async(row:DirectQueueEntry)=>{
    if(!current()||!live.current.canSend||live.current.uncertain)return;
    // Explicit resume may use the current idle terminal; further queued rows
    // still acquire the newly dispatched message's boundary in consume().
    await queue.resume(row.id,row.revision);explicitResumes.current.add(row.id);paused.current=false;await reload();
  };
  useEffect(()=>{
    if(!ready||!entries.length||flight.current||!current())return;
    const head=entries[0],snapshot=live.current;
    // Only an exact host user-message clientId confirms a lost response. A
    // refresh, assistant reply, or coincidentally equal prompt is not proof.
    if(head.state==='unconfirmed'){
      const accepted=snapshot.timeline.items.some(item=>item.kind==='message'&&item.role==='user'&&!item.local&&!item.messageOrigin&&item.clientId===head.id);
      if(!accepted||!head.afterTurnId)return;
      const token={};flight.current=token;
      void queue.reconcileAccepted(head.id,head.revision,head.afterTurnId).then(reload).catch(reason=>{if(current())setError(reason instanceof Error?reason.message:'送达记录核对失败');}).finally(()=>{if(flight.current===token)flight.current=undefined;});
      return;
    }
    if(head.state!=='waiting'||paused.current||sending||uncertain||!canSend)return;
    const boundary=turnControlTarget(snapshot.timeline,'continue');
    if(!boundary||boundary===head.afterTurnId)return;
    const terminal=lastTerminal(snapshot.timeline);
    const token={};flight.current=token;
    if(!explicitResumes.current.has(head.id)&&(snapshot.session.status==='failed'||terminal?.kind==='turn'&&(terminal.status==='failed'||terminal.status==='interrupted'))){
      void queue.block(head.id,head.revision,'上一轮未正常完成，排队消息已暂停').then(reload).catch(reason=>{if(current())setError(reason instanceof Error?reason.message:'暂停队列失败');}).finally(()=>{if(flight.current===token)flight.current=undefined;});
      return;
    }
    setDispatching(true);
    void (async()=>{
      let attempt:DirectQueueEntry|undefined,dispatched=false,receiptAccepted=false;
      try{
        const input=head.input;
        services.guard();
        if(input.missingImages||(input.imageCount??input.images.length)!==input.images.length)throw new Error('原排队图片不可用，请先恢复原图');
        if(input.model||input.effort||input.images.length){
          if(input.model&&!profile.capabilities?.modelOverride)throw new Error('所选模型已不可用');
          const catalog=profile.capabilities?.modelOverride?await services.models():undefined,effective=input.model||session.model||profile.api.model;
          if(input.model&&!catalog?.models.includes(input.model))throw new Error('所选模型已不可用');
          if(input.effort&&!reportedEfforts(catalog?.modelCapabilities?.[effective]).includes(input.effort))throw new Error('所选推理级别已不可用');
          if(input.images.length&&(!profile.capabilities?.imageInput||reportsTextOnly(catalog?.modelCapabilities?.[effective])))throw new Error('所选 Agent 或模型不支持原图片');
        }
        if(input.options.skills?.length||input.options.collaborationMode){
          if(!profile.capabilities?.features)throw new Error('所选技能或计划模式已不可用');
          const features=await services.features();
          if(input.options.skills?.some(skill=>!features.skills.some(item=>skillKey(item)===skillKey(skill)))||input.options.collaborationMode&&!features.collaborationModes.includes(input.options.collaborationMode))throw new Error('所选技能或计划模式已不可用');
        }
        if(input.options.contextReferences?.length&&!profile.capabilities?.contextReferences)throw new Error('当前 Agent 不支持原上下文引用');
        if(input.permission){
          const valid=profile.tool==='codex'?isPermissionMode(input.permission)&&profile.capabilities?.permissionModes?.includes(input.permission):isApprovalMode(input.permission)&&profile.capabilities?.approvalModes?.includes(input.permission);
          if(!valid||!live.current.autoAll&&(input.permission==='full_access'||input.permission==='auto_all'))throw new Error('所选批准权限已不可用');
        }
        if(!current()||!live.current.canSend||live.current.sending||live.current.uncertain||paused.current||turnControlTarget(live.current.timeline,'continue')!==boundary)throw new Error('回合或电脑状态已变化，排队消息已暂停');
        attempt=await queue.markAttempting(head.id,head.revision,boundary);
        const attachments=input.images.length?await services.uploadImages(await queue.hydrate(attempt)):undefined;
        services.guard();
        if(!live.current.canSend||live.current.sending||live.current.uncertain||paused.current||turnControlTarget(live.current.timeline,'continue')!==boundary)throw new Error('回合或电脑状态已变化，排队消息已暂停');
        dispatched=true;
        const receipt=await requestDirect({type:'session.send',sessionKey:session.sessionKey,text:input.text,operationId:head.id,controlSurface:'cli',
          ...copyTurnFeatures(input.options),...(input.model?{model:input.model}:{}),...(input.effort?{effort:input.effort}:{}),...(attachments?.length?{attachments}:{}),
          ...(input.permission?(profile.tool==='codex'?{permissionMode:input.permission as PermissionMode}:{approval:input.permission as ApprovalMode}):{}),
          ...(profile.api.accountId?{accountId:profile.api.accountId}:{})},{timeoutMs:100000}) as {via?:string};
        if(receipt?.via!=='background')throw Object.assign(new Error('排队消息的送达结果未确认'),{code:'protocol'});
        receiptAccepted=true;
        await queue.consume(head.id,attempt.revision,boundary);
        explicitResumes.current.delete(head.id);
        if(current())onRefresh();
      }catch(reason){
        if(current()){
          const message=reason instanceof Error?reason.message:'排队发送失败';
          try{await queue.block(head.id,attempt?.revision??head.revision,message,receiptAccepted||dispatched&&directActionUncertain(reason));}catch{setError(message);}
        }
      }finally{
        if(current()){
          try{await reload();}catch(reason){setError(reason instanceof Error?reason.message:'排队消息读取失败');}
          setDispatching(false);
        }
        if(flight.current===token)flight.current=undefined;
      }
    })();
  },[entries,ready,timeline,canSend,sending,uncertain,services]);
  return {entries,ready,error,dispatching,unconfirmed:entries.some(entry=>entry.state==='unconfirmed'||entry.state==='attempting'),enqueue,pause,remove,resume,editText,move,reload};
}
