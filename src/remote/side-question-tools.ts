import {parseHubEvent,type HubEvent} from './client';
import type {SideQuestionReading} from './side-question';
import {parseAgentFeatures,type AgentFeatures,type CollaborationMode,type SkillReference} from './agent-features';

export interface SideToolOptions { version:1; permissions:['workspace-write']; features?:true }
export interface SideToolRequest {
  action:'open'|'read'|'features'|'send'|'stop'|'approve'|'close'; chainId:string; expectedRevision:string;
  operationId?:string; permission?:'workspace-write'; question?:string; model?:string; effort?:string;
  skills?:SkillReference[]; collaborationMode?:CollaborationMode;
  expectedTurnId?:string; approvalId?:string; decision?:'allow'|'deny';
}
export interface SideToolState {
  sessionKey:string;chainId:string;revision:string;permission:'workspace-write';
  state:'idle'|'starting'|'running'|'waiting_approval'|'completed'|'interrupted'|'failed'|'unconfirmed'|'closed';
  turnId?:string;lastOperationId?:string;sequence:number;answer:string;error?:string;canSend:boolean;expiresAt:number;
  events:HubEvent[];approvals:Extract<HubEvent,{type:'approval.request'}>[];truncated?:boolean;
  features?:AgentFeatures;
}
export type SideToolTransport=(reading:SideQuestionReading,request:SideToolRequest)=>Promise<SideToolState>;
const record=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const text=(value:unknown,bytes:number):value is string=>typeof value==='string'&&new TextEncoder().encode(value).length<=bytes&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
export function parseSideToolOptions(value:unknown):SideToolOptions|undefined {
  const raw=record(value);return raw?.version===1&&Array.isArray(raw.permissions)&&raw.permissions.length===1&&raw.permissions[0]==='workspace-write'?{version:1,permissions:['workspace-write'],...(raw.features===true?{features:true}:{})}:undefined;
}
export function parseSideToolState(value:unknown,sessionKey:string,request:SideToolRequest):SideToolState|undefined {
  const raw=record(value);
  if(!raw||raw.sessionKey!==sessionKey||raw.chainId!==request.chainId||raw.revision!==request.expectedRevision||raw.permission!=='workspace-write'
    ||!['idle','starting','running','waiting_approval','completed','interrupted','failed','unconfirmed','closed'].includes(String(raw.state))
    ||!count(raw.sequence)||!count(raw.expiresAt)||typeof raw.canSend!=='boolean'||!text(raw.answer,64*1024)
    ||raw.error!==undefined&&!text(raw.error,4096)||raw.lastOperationId!==undefined&&!uuid(raw.lastOperationId)||raw.truncated!==undefined&&typeof raw.truncated!=='boolean'
    ||raw.turnId!==undefined&&(typeof raw.turnId!=='string'||!raw.turnId.length||raw.turnId.length>256||/[\s\p{Cc}\p{Cf}]/u.test(raw.turnId))
    ||!Array.isArray(raw.events)||raw.events.length>128||!Array.isArray(raw.approvals)||raw.approvals.length>16
    ||raw.canSend&&!['idle','completed','interrupted','failed'].includes(String(raw.state)))return;
  if(new TextEncoder().encode(JSON.stringify(raw)).length>240*1024)return;
  let features:AgentFeatures|undefined;
  if(raw.features!==undefined){try{features=parseAgentFeatures(raw.features,true);}catch{return;}}
  const events:HubEvent[]=[],approvals:SideToolState['approvals']=[];
  for(const [entries,approval] of [[raw.events,false],[raw.approvals,true]] as const){
    for(const input of entries){
      const item=record(input);
      if(!item||item.sessionKey!==sessionKey||item.tool!=='codex')return;
      // Private tool output is interpreted only inside this temporary panel.
      // It never reaches the global timeline or attachment download pipeline.
      const isolated={...item,deviceId:'temporary-side-tools'};
      for(const key of ['attachments','imageData','session','childSessionKeys','messageOrigin'])delete (isolated as Record<string,unknown>)[key];
      // The Go event envelope omits false values. A streaming message is still
      // valid even when its optional wire-level final flag is absent.
      if(item.type==='message'&&item.final===undefined)(isolated as Record<string,unknown>).final=false;
      let parsed:HubEvent|undefined;
      try{parsed=parseHubEvent(isolated);}catch{return;}
      if(approval){
        if(!parsed||parsed.type!=='approval.request'||!raw.turnId||parsed.turnId!==raw.turnId||raw.state!=='waiting_approval'||parsed.kind==='question'
          ||parsed.approvalOptions?.version!==1||!parsed.approvalOptions.decisions.length||parsed.approvalOptions.decisions.some(decision=>decision!=='allow'&&decision!=='deny'))return;
        approvals.push(parsed);
      }else if(parsed&&['message','tool','notice','turn','approval.resolved'].includes(parsed.type))events.push(parsed);
    }
  }
  return {sessionKey,chainId:request.chainId,revision:request.expectedRevision,permission:'workspace-write',state:raw.state as SideToolState['state'],sequence:raw.sequence,expiresAt:raw.expiresAt,answer:raw.answer,canSend:raw.canSend,events,approvals,
    ...(raw.turnId?{turnId:raw.turnId as string}:{}),...(raw.lastOperationId?{lastOperationId:raw.lastOperationId as string}:{}),...(raw.error?{error:raw.error as string}:{}),...(raw.truncated===true?{truncated:true}:{}),...(features?{features}:{})};
}
