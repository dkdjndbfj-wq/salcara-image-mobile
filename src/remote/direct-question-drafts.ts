import {sha256} from '@noble/hashes/sha2.js';
import {createComposerDraftSession} from './composer-drafts';
import type {QuestionDraft} from './QuestionCard';
import type {ApprovalItem} from './thread-rows';

export interface DirectQuestionDraftSource {scope:string;key:string;request:string;requestedAt:number;questionIds:string[]}
type Envelope={version:1;request:string;requestedAt:number;draft:QuestionDraft};
const hash=(value:string)=>Array.from(sha256(new TextEncoder().encode(value)),byte=>byte.toString(16).padStart(2,'0')).join('');
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const keyFor=(scope:string,deviceId:string,sessionKey:string,id:string)=>`${scope}|${deviceId}|direct-question:${hash(JSON.stringify([sessionKey,id]))}`;
let writes:Promise<unknown>=Promise.resolve();
const active=new Map<string,{request:string;requestedAt:number;closed:boolean}>();
const serial=<T,>(run:()=>Promise<T>)=>{const result=writes.then(run);writes=result.catch(()=>undefined);return result;};
const current=(source:DirectQuestionDraftSource)=>active.get(source.key)?.request===source.request&&!active.get(source.key)?.closed;

export function directQuestionDraftSource(scope:string,deviceId:string,sessionKey:string,question:ApprovalItem):DirectQuestionDraftSource {
  return {scope,key:keyFor(scope,deviceId,sessionKey,question.id),requestedAt:question.ts,questionIds:(question.questions??[]).map(item=>item.id),
    request:hash(JSON.stringify([question.id,question.turnId,question.ts,question.title,question.questions,question.expiresAt,question.approvalOptions]))};
}
function validDraft(value:unknown,ids?:readonly string[]):value is QuestionDraft {
  if(!record(value)||Object.keys(value).some(key=>!['answers','custom','customPresent','page','customOpen'].includes(key))
    ||!Number.isSafeInteger(value.page)||Number(value.page)<0||Number(value.page)>=Math.max(1,ids?.length??64))return false;
  const map=(candidate:unknown,valid:(value:unknown)=>boolean)=>record(candidate)&&Object.keys(candidate).length<=64
    &&Object.entries(candidate).every(([key,item])=>key.length<=256&&(!ids||ids.includes(key))&&valid(item));
  return map(value.answers,item=>Array.isArray(item)&&item.length<=64&&item.every(answer=>typeof answer==='string'&&answer.length<=4000))
    &&map(value.custom,item=>typeof item==='string'&&item.length<=4000)&&map(value.customPresent,item=>typeof item==='boolean')
    &&map(value.customOpen,item=>typeof item==='boolean')&&JSON.stringify(value).length<=90_000;
}
function decode(text:string):Envelope|undefined {
  if(!text)return;
  let value:unknown;try{value=JSON.parse(text);}catch{throw new Error('问答草稿无法读取，原内容未覆盖');}
  if(!record(value)||value.version!==1||typeof value.request!=='string'||!/^[a-f0-9]{64}$/.test(value.request)
    ||typeof value.requestedAt!=='number'||!Number.isFinite(value.requestedAt)||!validDraft(value.draft)
    ||Object.keys(value).some(key=>!['version','request','requestedAt','draft'].includes(key)))throw new Error('问答草稿无效，原内容未覆盖');
  return value as unknown as Envelope;
}
const copy=(value:QuestionDraft):QuestionDraft=>JSON.parse(JSON.stringify(value));
const empty=(value:QuestionDraft)=>value.page===0&&!Object.values(value.answers).some(values=>values.length)
  &&!Object.values(value.custom).some(Boolean)&&!Object.values(value.customPresent).some(Boolean)&&!Object.values(value.customOpen).some(Boolean);

/** The shared composer store already fences retired pairings and deletes these
 * private rows on unpairing. Short-lived owners are serialized here so a rapid
 * reconnect drains the last local keystroke before restoring the same request. */
export function readDirectQuestionDraft(source:DirectQuestionDraftSource):Promise<QuestionDraft|undefined> {
  const previous=active.get(source.key);
  if(!previous||previous.request!==source.request)active.set(source.key,{request:source.request,requestedAt:source.requestedAt,closed:false});
  if(active.size>256)active.delete(active.keys().next().value!);
  return serial(async()=>{
    if(!current(source))return;
    const session=createComposerDraftSession(source.key,source.scope);
    try{const row=await session.restore(),saved=decode(row?.text??'');if(!current(source))return;
      if(saved?.request!==source.request)return;
      if(!validDraft(saved.draft,source.questionIds))throw new Error('问答草稿与原问题不匹配');return copy(saved.draft);
    }finally{session.dispose();}
  });
}
export function saveDirectQuestionDraft(source:DirectQuestionDraftSource,draft:QuestionDraft):Promise<void> {
  if(!validDraft(draft,source.questionIds))return Promise.reject(new Error('问答草稿超出限制，输入仍保留'));
  const snapshot=copy(draft);
  return serial(async()=>{
    if(!current(source))return;
    const session=createComposerDraftSession(source.key,source.scope);
    try{const row=await session.restore();decode(row?.text??'');if(!current(source))return;
      if(empty(snapshot)){if(row&&await session.consume(row.revision,row.identity))await session.pruneEmpty();return;}
      await session.save({text:JSON.stringify({version:1,request:source.request,requestedAt:source.requestedAt,draft:snapshot}),images:[]});
    }finally{session.dispose();}
  });
}
export function finishDirectQuestionDraft(scope:string,deviceId:string,sessionKey:string,id:string,resolvedAt:number,request?:string):Promise<void> {
  const key=keyFor(scope,deviceId,sessionKey,id),owner=active.get(key);
  if(owner&&(request?owner.request===request:owner.requestedAt<=resolvedAt))owner.closed=true;
  return serial(async()=>{
    const session=createComposerDraftSession(key,scope);
    try{const row=await session.restore(),saved=decode(row?.text??'');
      if(!row||!saved||(request?saved.request!==request:saved.requestedAt>resolvedAt))return;
      if(await session.consume(row.revision,row.identity))await session.pruneEmpty();
    }finally{session.dispose();}
  });
}
