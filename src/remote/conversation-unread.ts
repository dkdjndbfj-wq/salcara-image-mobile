import {sha256} from '@noble/hashes/sha2.js';
import {getSetting,setSetting} from '../storage/database';
import type {AgentProfile,SessionInfo,WorkspaceMode} from './client';
import type {Timeline} from './store';
import {sidebarSessionStatus} from './sidebar-session-status';
import {sessionWorkspaceMode} from './projection';

export interface ResultStamp {id:string;at:number;turnId:string;messageId?:string}
interface ReadRecord {observed:string;read:string;at:number;touched:number}
const hash=(value:string)=>Array.from(sha256(new TextEncoder().encode(value)),byte=>byte.toString(16).padStart(2,'0')).join('');
const storage='remote_conversation_reads_v1',records=new Map<string,ReadRecord>(),listeners=new Set<()=>void>();
let loaded:Promise<void>|undefined,revision=0,writeTimer:ReturnType<typeof setTimeout>|undefined,writes=Promise.resolve();
const publish=()=>{revision++;for(const listener of listeners)listener();};
export const subscribeConversationReads=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
export const conversationReadRevision=()=>revision;
export function conversationReadScope(pairing:string,device:string,agent:Pick<AgentProfile,'id'|'api'>,mode:WorkspaceMode){return JSON.stringify([pairing,device,agent.id,mode,agent.api.accountId??[agent.api.source,agent.api.name]]);}
export function conversationReadKey(scope:string,session:Pick<SessionInfo,'sessionKey'|'controlSurface'|'sessionScope'>){return hash(JSON.stringify([scope,session.sessionKey,session.controlSurface??'cli',session.sessionScope??'']));}
export function sessionResultStamp(session?:SessionInfo,timeline?:Timeline):ResultStamp|undefined{
  if(!session||session.parentSessionKey||sidebarSessionStatus(session,timeline)!=='idle')return;
  const observed=timeline?.session;
  if(observed&&timeline?.snapshotAt&&!timeline.cachedAt&&!timeline.error&&observed.updatedAt>=session.updatedAt
    &&observed.sessionKey===session.sessionKey&&observed.tool===session.tool&&(observed.controlSurface??'cli')===(session.controlSurface??'cli')
    &&observed.sessionScope===session.sessionScope&&sessionWorkspaceMode(observed)===sessionWorkspaceMode(session))session=observed;
  const turn=[...(timeline?.items??[])].reverse().find(item=>item.kind==='turn'&&!item.parentId&&item.status!=='started'&&(!session.lastTerminalTurnId||item.turnId===session.lastTerminalTurnId));
  if(turn?.kind==='turn'&&turn.status!=='completed')return;
  const turnId=session.lastTerminalTurnId??(turn?.kind==='turn'?turn.turnId:undefined);if(!turnId)return;
  if(session.activeTurnId&&session.activeTurnId!==turnId)return;
  const answer=[...(timeline?.items??[])].reverse().find(item=>item.kind==='message'&&item.role==='assistant'&&!item.parentId&&item.final&&item.turnId===turnId);
  return {id:hash(turnId),turnId,at:Math.max(0,turn?.ts??session.updatedAt),...(answer?{messageId:answer.id}:{})};
}
export async function loadConversationReads(){
  if(!loaded)loaded=(async()=>{const raw=await getSetting(storage);if(raw){try{const table=JSON.parse(raw);if(table?.version===1&&Array.isArray(table.rows))for(const [key,row] of table.rows.slice(0,2000)){
    if(typeof key==='string'&&/^[a-f0-9]{64}$/.test(key)&&row&&typeof row.observed==='string'&&/^(?:[a-f0-9]{64})?$/.test(row.observed)&&typeof row.read==='string'&&/^(?:[a-f0-9]{64})?$/.test(row.read)&&Number.isFinite(row.at)&&Number.isFinite(row.touched))records.set(key,row);
  }}catch{/* A malformed local read index cannot affect the transcript. */}}publish();})().catch(error=>{loaded=undefined;throw error;});
  await loaded;
}
function persist(){
  if(records.size>2000){const newest=[...records].sort((a,b)=>b[1].touched-a[1].touched).slice(0,2000);records.clear();for(const [key,row] of newest)records.set(key,row);}
  if(writeTimer)clearTimeout(writeTimer);
  writeTimer=setTimeout(()=>{writeTimer=undefined;const rows=[...records].sort((a,b)=>b[1].touched-a[1].touched).slice(0,2000);const value=JSON.stringify({version:1,rows});writes=writes.catch(()=>{}).then(()=>setSetting(storage,value));void writes.catch(()=>{});},180);
}
export function conversationUnread(key:string){const row=records.get(key);return Boolean(row?.observed&&row.observed!==row.read);}
/** First observation establishes a baseline, rather than marking every old
 * conversation unread on install. A later completed turn creates the dot. */
export async function observeConversationResult(key:string,stamp?:ResultStamp){
  await loadConversationReads();const previous=records.get(key);
  if(!previous){records.set(key,{observed:stamp?.id??'',read:stamp?.id??'',at:stamp?.at??0,touched:Date.now()});}
  else if(!stamp||stamp.at<previous.at||previous.observed===stamp.id)return;
  else records.set(key,{...previous,observed:stamp.id,at:stamp.at,touched:Date.now()});
  publish();persist();
}
export async function readConversationResult(key:string,stamp:ResultStamp,current:()=>boolean=()=>true){
  await loadConversationReads();if(!current())return;
  const previous=records.get(key);if(previous&&previous.observed!==stamp.id&&previous.at>=stamp.at)return;
  if(previous?.read===stamp.id)return;
  records.set(key,{observed:stamp.id,read:stamp.id,at:stamp.at,touched:Date.now()});publish();persist();
}
