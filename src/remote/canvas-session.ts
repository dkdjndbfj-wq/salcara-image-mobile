import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {getSetting,setSetting} from '../storage/database';
import type {ImageNote,ImageRegion} from './conversation-images';
import type {CanvasImageView} from './CanvasImageStage';

export interface CanvasDraft {comment:string;region?:ImageRegion}
export interface CanvasSessionState {scopeKey:string;initialized?:boolean;focused?:string;focusedKey?:string;selected:string[];drafts:Record<string,CanvasDraft>;views:Record<string,CanvasImageView>;selectedOnly:boolean}
export interface CanvasHistory {past:ImageNote[][];future:ImageNote[][];nextNumber:number}
export interface CanvasRecord {version:2;scopeKey:string;notes:ImageNote[];session:CanvasSessionState;history:CanvasHistory;updatedAt:number}
export const CANVAS_STORE_KEY='remote_image_canvas_sessions_v2';
export const CANVAS_LIMITS={scopes:16,storeBytes:8*1024*1024,recordBytes:2*1024*1024,draftBytes:256*1024,historyBytes:256*1024,historySteps:20,drafts:64,views:64,notes:100} as const;
const hash=(scope:string)=>bytesToHex(sha256(new TextEncoder().encode(scope)));
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
const text=(value:unknown,max=8192):value is string=>typeof value==='string'&&value.length>0&&value.length<=max;
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const region=(value:unknown):value is ImageRegion=>object(value)&&[value.x,value.y,value.width,value.height].every(n=>typeof n==='number'&&Number.isFinite(n))&&(value.x as number)>=0&&(value.y as number)>=0&&(value.width as number)>=.01&&(value.height as number)>=.01&&(value.x as number)+(value.width as number)<=1.000001&&(value.y as number)+(value.height as number)<=1.000001;
export function validCanvasNotes(value:unknown):ImageNote[] {
  if(!Array.isArray(value))return [];
  const seen=new Set<string>();
  return value.slice(-CANVAS_LIMITS.notes).filter((n):n is ImageNote=>{
    if(!object(n)||!text(n.id)||seen.has(n.id)||!text(n.imageId,20000)||n.imageRevision!==undefined&&!text(n.imageRevision,20000)||typeof n.comment!=='string'||n.comment.length>4000||n.region!==undefined&&!region(n.region)||n.number!==undefined&&(!Number.isInteger(n.number)||(n.number as number)<1||(n.number as number)>1000000))return false;
    seen.add(n.id);return true;
  }).map(n=>({id:n.id,imageId:n.imageId,comment:n.comment,...(n.imageRevision?{imageRevision:n.imageRevision}:{}),...(n.region?{region:{...n.region}}:{}),...(n.number?{number:n.number}:{})}));
}
const imageKey=(value:unknown):value is string=>{
  if(!text(value,40000))return false;
  try{const parts:unknown=JSON.parse(value);return Array.isArray(parts)&&parts.length===2&&parts.every(part=>text(part,20000));}catch{return false;}
};
const draftKey=(value:string)=>{
  if(imageKey(value as unknown)||value.startsWith('edit:')&&text(value.slice(5)))return true;
  if(!value.startsWith('batch:')||value.length>200000)return false;
  try{const keys:unknown=JSON.parse(value.slice(6));return Array.isArray(keys)&&keys.length<=100&&keys.every(imageKey);}catch{return false;}
};
export function boundedCanvasSession(scopeKey:string,value:unknown):CanvasSessionState {
  const input=object(value)?value:{};
  const drafts:Record<string,CanvasDraft>=Object.create(null),views:Record<string,CanvasImageView>=Object.create(null);
  if(object(input.drafts))for(const [key,value] of Object.entries(input.drafts).slice(-CANVAS_LIMITS.drafts))if(draftKey(key)&&object(value)&&typeof value.comment==='string'&&value.comment.length<=4000&&(value.region===undefined||region(value.region)))drafts[key]={comment:value.comment,...(value.region?{region:{...value.region as ImageRegion}}:{})};
  while(bytes(drafts)>CANVAS_LIMITS.draftBytes)delete drafts[Object.keys(drafts)[0]];
  if(object(input.views))for(const [key,value] of Object.entries(input.views).slice(-CANVAS_LIMITS.views))if(imageKey(key)&&object(value)&&(value.zoom===null||typeof value.zoom==='number'&&Number.isFinite(value.zoom)&&value.zoom>0&&value.zoom<=8)&&typeof value.x==='number'&&Number.isFinite(value.x)&&Math.abs(value.x)<=1000000&&typeof value.y==='number'&&Number.isFinite(value.y)&&Math.abs(value.y)<=1000000)views[key]={zoom:value.zoom as number|null,x:value.x,y:value.y};
  return {scopeKey,initialized:input.initialized===true,...(text(input.focused,20000)?{focused:input.focused}:{}),...(imageKey(input.focusedKey)?{focusedKey:input.focusedKey}:{}),selected:Array.isArray(input.selected)?[...new Set(input.selected.filter(imageKey))].slice(-100):[],drafts,views,selectedOnly:input.selectedOnly===true};
}
export const canvasNoteNumber=(note:ImageNote,index:number)=>note.number??index+1;
export const emptyCanvasHistory=():CanvasHistory=>({past:[],future:[],nextNumber:1});
const nextNumber=(notes:ImageNote[])=>Math.max(1,...notes.map((note,index)=>canvasNoteNumber(note,index)+1));
function boundedHistory(value:unknown,notes:ImageNote[]):CanvasHistory {
  const input=object(value)?value:{};
  const past=Array.isArray(input.past)?input.past.slice(-CANVAS_LIMITS.historySteps).map(validCanvasNotes):[];
  const future=Array.isArray(input.future)?input.future.slice(0,CANVAS_LIMITS.historySteps).map(validCanvasNotes):[];
  while(bytes([past,future])>CANVAS_LIMITS.historyBytes){if(past.length)past.shift();else if(future.length)future.pop();else break;}
  return {past,future,nextNumber:Math.min(1000000,Math.max(nextNumber(notes),...past.map(nextNumber),...future.map(nextNumber),Number.isInteger(input.nextNumber)?Number(input.nextNumber):1))};
}
export function freshCanvasRecord(scopeKey:string,notes:ImageNote[]=[]):CanvasRecord {return {version:2,scopeKey,notes,session:boundedCanvasSession(scopeKey,{}),history:{...emptyCanvasHistory(),nextNumber:nextNumber(notes)},updatedAt:Date.now()};}
function sanitizeRecord(value:unknown):CanvasRecord|undefined {
  if(!object(value)||value.version!==2||!text(value.scopeKey,40000))return;
  const notes=validCanvasNotes(value.notes),record:CanvasRecord={version:2,scopeKey:value.scopeKey,notes,session:boundedCanvasSession(value.scopeKey,value.session),history:boundedHistory(value.history,notes),updatedAt:typeof value.updatedAt==='number'&&Number.isFinite(value.updatedAt)?value.updatedAt:0};
  return bytes(record)<=CANVAS_LIMITS.recordBytes?record:undefined;
}
export function recordCanvasNotes(record:CanvasRecord,next:ImageNote[]):CanvasRecord {
  const previous=record.notes.map((note,index)=>note.number?note:{...note,number:canvasNoteNumber(note,index)}),numbers=new Map(previous.map(note=>[note.id,note.number!]));
  let number=Math.max(record.history.nextNumber,nextNumber(previous));
  const notes=next.map(note=>({...note,number:note.number??numbers.get(note.id)??number++}));
  if(JSON.stringify(record.notes)===JSON.stringify(notes))return record;
  return {...record,notes,history:boundedHistory({past:[...record.history.past,previous],future:[],nextNumber:Math.max(number,nextNumber(notes))},notes)};
}
export function undoCanvasNotes(record:CanvasRecord):CanvasRecord {
  const notes=record.history.past.at(-1);if(!notes)return record;
  return {...record,notes,history:boundedHistory({...record.history,past:record.history.past.slice(0,-1),future:[record.notes,...record.history.future].slice(0,CANVAS_LIMITS.historySteps)},notes)};
}
export function redoCanvasNotes(record:CanvasRecord):CanvasRecord {
  const notes=record.history.future[0];if(!notes)return record;
  return {...record,notes,history:boundedHistory({...record.history,past:[...record.history.past,record.notes].slice(-CANVAS_LIMITS.historySteps),future:record.history.future.slice(1)},notes)};
}
/** Submitted IDs are removed from both directions of history in the same write. */
export function retireCanvasNotes(record:CanvasRecord,ids:ReadonlySet<string>):CanvasRecord {
  const retain=(notes:ImageNote[])=>notes.filter(note=>!ids.has(note.id)),notes=retain(record.notes),drafts={...record.session.drafts};
  for(const id of ids)delete drafts[`edit:${id}`];
  const history=(states:ImageNote[][])=>states.map(retain).filter((state,index,all)=>JSON.stringify(state)!==JSON.stringify(notes)&&(!index||JSON.stringify(state)!==JSON.stringify(all[index-1])));
  return {...record,notes,session:{...record.session,drafts},history:{...record.history,past:history(record.history.past),future:history(record.history.future)}};
}

interface Stored {version:2;records:CanvasRecord[]}
let writes:Promise<void>=Promise.resolve();
let lastStamp=0;
const pending=new Map<string,CanvasRecord>();
const boundRecords=(records:CanvasRecord[])=>{
  const sorted=records.sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,CANVAS_LIMITS.scopes);
  while(sorted.length>1&&bytes({version:2,records:sorted})>CANVAS_LIMITS.storeBytes)sorted.pop();
  return sorted;
};
async function readStore():Promise<CanvasRecord[]> {
  const raw=await getSetting(CANVAS_STORE_KEY);if(!raw)return [];
  if(raw.length>CANVAS_LIMITS.storeBytes)throw new Error('图片画布存储超出大小限制');
  let data:unknown;try{data=JSON.parse(raw);}catch{throw new Error('图片画布存储格式无效');}
  if(!object(data)||data.version!==2||!Array.isArray(data.records))throw new Error('图片画布存储格式无效');
  return boundRecords(data.records.map(sanitizeRecord).filter((record):record is CanvasRecord=>Boolean(record)));
}
export function canvasRecordPending(scopeKey:string):boolean {return pending.has(hash(scopeKey));}
export async function loadCanvasRecord(scopeKey:string):Promise<CanvasRecord> {
  await writes.catch(()=>{});
  const memory=pending.get(hash(scopeKey));if(memory)return memory;
  const stored=(await readStore()).find(record=>record.scopeKey===scopeKey);if(stored)return stored;
  const legacy=await getSetting(`remote_image_canvas_v1_${hash(scopeKey)}`);
  let notes:ImageNote[]=[];if(legacy)try{notes=validCanvasNotes(JSON.parse(legacy));}catch{/* Preserve the old tolerant parser. */}
  return freshCanvasRecord(scopeKey,notes);
}
export function saveCanvasRecord(value:CanvasRecord):Promise<void> {
  lastStamp=Math.max(Date.now(),lastStamp+1);
  const record=sanitizeRecord({...value,updatedAt:lastStamp});if(!record)return Promise.reject(new Error('图片画布内容超过本机保存限制'));
  pending.set(hash(record.scopeKey),record);
  const bounded=boundRecords([...pending.values()]);for(const [key,item] of pending)if(!bounded.includes(item))pending.delete(key);
  const run=writes.catch(()=>{}).then(async()=>{
    if(!pending.size)return;
    const previous=await readStore(),records=new Map(previous.map(item=>[hash(item.scopeKey),item]));
    const saving=new Map(pending);for(const [key,item] of saving)records.set(key,item);
    const data:Stored={version:2,records:boundRecords([...records.values()])};
    // Never fall back to a stale legacy note list after its migrated record is evicted.
    for(const item of previous)if(!data.records.some(next=>next.scopeKey===item.scopeKey))await setSetting(`remote_image_canvas_v1_${hash(item.scopeKey)}`,null);
    await setSetting(CANVAS_STORE_KEY,JSON.stringify(data));
    for(const item of saving.values())await setSetting(`remote_image_canvas_v1_${hash(item.scopeKey)}`,null);
    for(const [key,item] of saving)if(pending.get(key)===item)pending.delete(key);
  });
  writes=run;return run;
}
