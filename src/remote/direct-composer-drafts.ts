import { sha256 } from '@noble/hashes/sha2.js';
import type { ApprovalMode, Effort, PermissionMode } from './client';
import { copyTurnFeatures, validTurnFeatures, type TurnFeatures } from './agent-features';
import { isEffort } from './effort';
import { isApprovalMode, isPermissionMode } from './permission-mode';
import { createComposerDraftSession, copyMissingComposerDraft, hydrateComposerImages, type ComposerDraft, type ComposerDraftOrigin, type MissingSessionEvidence } from './composer-drafts';
import type { RemoteImage } from './attachments';

export interface DirectDraftInput {
  text:string;options:TurnFeatures;model:string;effort:Effort|'';permission:PermissionMode|ApprovalMode|'';
  images:RemoteImage[];imageCount?:number;missingImages?:boolean;
  origin?:ComposerDraftOrigin;
  lastRestoredEdit?:string;
}
export interface DirectSavedDraft extends DirectDraftInput {revision:number;identity?:string}
const hash=(text:string)=>Array.from(sha256(new TextEncoder().encode(text)),byte=>byte.toString(16).padStart(2,'0')).join('');

/** Direct keeps its complete composer selection in one versioned draft body.
 * Image bytes, optimistic revisions and mounted-owner fencing remain in the
 * shared draft store. This private key is never read as a Hub plain-text draft. */
export function directDraftKey(pairing:string,deviceId:string,owner:string){
  if(!pairing||!deviceId||deviceId.includes('|')||!owner)throw new Error('草稿来源无效');
  return `${pairing}|${deviceId}|direct-composer:${hash(owner)}`;
}
function encode(owner:string,value:DirectDraftInput):string {
  if(typeof value.text!=='string'||value.text.length>40000||!value.options||typeof value.options!=='object'||Array.isArray(value.options)||!validTurnFeatures(value.options)
    ||typeof value.model!=='string'||value.model.length>200||/[\r\n\0]/.test(value.model)
    ||value.effort!==''&&!isEffort(value.effort)||value.permission!==''&&!isPermissionMode(value.permission)&&!isApprovalMode(value.permission))throw new Error('本地输入草稿无效，原内容未覆盖');
  if(!value.text&&!value.images?.length&&!value.imageCount&&!value.model&&!value.effort&&!value.permission&&!value.options.collaborationMode&&!value.options.skills?.length&&!value.options.contextReferences?.length)return '';
  return JSON.stringify({version:1,owner,text:value.text,options:copyTurnFeatures(value.options),model:value.model,effort:value.effort,permission:value.permission});
}
function decode(owner:string,row:ComposerDraft):DirectSavedDraft|undefined {
  if(!row.text&&!row.imageCount)return undefined;
  let raw:unknown;try{raw=JSON.parse(row.text);}catch{throw new Error('直连草稿无法读取，原内容未覆盖');}
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('直连草稿无法读取，原内容未覆盖');
  const value=raw as DirectDraftInput&{version:number;owner:string};
  if(value.version!==1||value.owner!==owner||Object.keys(value).some(key=>!['version','owner','text','options','model','effort','permission'].includes(key)))throw new Error('草稿来源已变化，原内容未覆盖');
  encode(owner,value);
  return {text:value.text,options:copyTurnFeatures(value.options),model:value.model,effort:value.effort,permission:value.permission,
    images:row.images.map(image=>({...image})),imageCount:row.imageCount,missingImages:row.missingImages,revision:row.revision,identity:row.identity,...(row.lastRestoredEdit?{lastRestoredEdit:row.lastRestoredEdit}:{}),...(row.origin?{origin:{...row.origin}}:{})};
}
export function createDirectComposerDraft(pairing:string,deviceId:string,owner:string){
  const base=createComposerDraftSession(directDraftKey(pairing,deviceId,owner),pairing);
  let pending:Promise<unknown>=Promise.resolve(),closed=false,restored=false;
  const track=<T>(promise:Promise<T>)=>{pending=promise.catch(()=>undefined);return promise;};
  return {
    restore:()=>{restored=false;return track(base.restore().then(row=>{const value=row?decode(owner,row):undefined;restored=true;return value;}));},
    save:(value:DirectDraftInput)=>{
      if(closed)return Promise.reject(new Error('草稿窗口已关闭'));
      if(!restored)return Promise.reject(new Error('草稿尚未读取，原内容未覆盖'));
      let body:string;try{body=encode(owner,value);}catch(error){return Promise.reject(error);}
      return track(base.save({text:body,images:value.images,imageCount:value.imageCount,missingImages:value.missingImages,origin:value.origin,lastRestoredEdit:value.lastRestoredEdit}).then(async row=>{
        const decoded=decode(owner,row);if(!decoded)await base.pruneEmpty();
        return decoded??{...value,images:row.images,revision:row.revision,identity:row.identity};
      }));
    },
    hydrate:(value:DirectSavedDraft)=>hydrateComposerImages(pairing,{images:value.images,imageCount:value.imageCount??value.images.length,missingImages:value.missingImages}),
    consume:(value:DirectSavedDraft)=>track(base.consume(value.revision,value.identity)),
    close:()=>{if(!closed){closed=true;void pending.finally(()=>base.dispose());}},
  };
}
export type DirectComposerDraft=ReturnType<typeof createDirectComposerDraft>;

/** Rebind the validated Direct envelope to the exact new-project owner. A Hub
 * copy would preserve the old encoded owner and could never be restored. */
export async function copyMissingDirectComposerDraft(input:{
  pairing:string;deviceId:string;sourceOwner:string;targetOwner:string;origin:ComposerDraftOrigin;evidence:MissingSessionEvidence;
  expectedRevision:number;expectedIdentity?:string;isCurrent?:()=>boolean;
}) {
  const {pairing,deviceId,sourceOwner,targetOwner,origin}=input;
  let source:unknown,target:unknown;
  try{source=JSON.parse(sourceOwner);target=JSON.parse(targetOwner);}catch{throw new Error('直连草稿来源无法确认');}
  const expectedSource=[pairing,deviceId,origin.sessionKey,origin.agentId,origin.apiIdentity,origin.cwd];
  const expectedTarget=[pairing,deviceId,null,origin.agentId,origin.apiIdentity,origin.projectless?'':origin.cwd,origin.mode,...(origin.projectless?['projectless']:[])];
  if(origin.transport!=='direct'||origin.deviceId!==deviceId||JSON.stringify(source)!==JSON.stringify(expectedSource)||JSON.stringify(target)!==JSON.stringify(expectedTarget))throw new Error('直连草稿的电脑、项目或模式不匹配');
  const result=await copyMissingComposerDraft({scope:pairing,sourceKey:directDraftKey(pairing,deviceId,sourceOwner),targetKey:directDraftKey(pairing,deviceId,targetOwner),
    origin,evidence:input.evidence,expectedRevision:input.expectedRevision,expectedIdentity:input.expectedIdentity,isCurrent:input.isCurrent},row=>{
    const value=decode(sourceOwner,row);if(!value)throw new Error('原会话没有待恢复的草稿');return encode(targetOwner,value);
  });
  return {receipt:result.receipt,draft:decode(targetOwner,result.draft)!};
}
