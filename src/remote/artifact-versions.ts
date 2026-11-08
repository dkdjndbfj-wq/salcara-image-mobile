import { randomUUID } from 'expo-crypto';
import { getSetting, setSetting } from '../storage/database';
import { conversationArtifactRevision, validConversationArtifact, type ConversationArtifactTarget } from './conversation-artifact-target';

export const ARTIFACT_VERSION_LIMIT=30;
export const ARTIFACT_VERSION_SOURCE_LIMIT=512*1024;
const STORAGE='remote.artifact.versions.v1',MAX_STORAGE=8*1024*1024,MAX_SERIES=32;
export interface ArtifactVersion {id:string;revision:string;source:string;createdAt:number;origin:'message'|'edit'|'restore';restoredFrom?:string}
export interface ArtifactVersionSeries {scopeKey:string;messageId:string;index:number;versions:ArtifactVersion[]}
type Table=Record<string,ArtifactVersionSeries>;
let writes:Promise<unknown>=Promise.resolve();
const serial=<T,>(action:()=>Promise<T>):Promise<T>=>{const result=writes.then(action);writes=result.catch(()=>undefined);return result;};
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const artifactVersionSeriesKey=(target:Pick<ConversationArtifactTarget,'scopeKey'|'messageId'|'index'>)=>conversationArtifactRevision(JSON.stringify([target.scopeKey,target.messageId,target.index]));
const clone=(series:ArtifactVersionSeries):ArtifactVersionSeries=>({...series,versions:series.versions.map(version=>({...version}))});
const validSource=(source:unknown):source is string=>typeof source==='string'&&source.length>0&&new TextEncoder().encode(source).length<=ARTIFACT_VERSION_SOURCE_LIMIT;
async function readTable():Promise<Table>{
  const raw=await getSetting(STORAGE);if(raw===null)return Object.create(null) as Table;
  let table:unknown;try{table=JSON.parse(raw);}catch{throw new Error('版本记录无法读取，已有内容未覆盖');}
  if(raw.length>MAX_STORAGE||!record(table)||Object.keys(table).length>MAX_SERIES)throw new Error('版本记录无效，已有内容未覆盖');
  for(const [key,row] of Object.entries(table)){
    if(!record(row)||Object.keys(row).some(field=>!['scopeKey','messageId','index','versions'].includes(field))||typeof row.scopeKey!=='string'||!row.scopeKey||row.scopeKey.length>8192
      ||typeof row.messageId!=='string'||!row.messageId||row.messageId.length>1024||!Number.isInteger(row.index)||Number(row.index)<0||Number(row.index)>=1000
      ||key!==artifactVersionSeriesKey(row as unknown as ArtifactVersionSeries)||!Array.isArray(row.versions)||!row.versions.length||row.versions.length>ARTIFACT_VERSION_LIMIT)throw new Error('版本来源无效，已有内容未覆盖');
    const ids=new Set<string>();
    for(const version of row.versions){
      if(!record(version)||Object.keys(version).some(field=>!['id','revision','source','createdAt','origin','restoredFrom'].includes(field))||!validId(version.id)||ids.has(version.id)
        ||!validSource(version.source)||version.revision!==conversationArtifactRevision(version.source)||!Number.isSafeInteger(version.createdAt)||Number(version.createdAt)<0
        ||!['message','edit','restore'].includes(String(version.origin))||version.origin==='restore'&&(!validId(version.restoredFrom)||!ids.has(version.restoredFrom))
        ||version.origin!=='restore'&&version.restoredFrom!==undefined)throw new Error('版本内容校验失败，已有内容未覆盖');
      ids.add(version.id);
    }
  }
  return Object.assign(Object.create(null),table) as Table;
}
async function writeTable(table:Table){const raw=JSON.stringify(table);if(new TextEncoder().encode(raw).length>MAX_STORAGE)throw new Error('本地版本空间已满，已有历史和编辑草稿均保留');await setSetting(STORAGE,raw);}
function validate(target:ConversationArtifactTarget){if(!target.scopeKey||target.scopeKey.length>8192||!validConversationArtifact(target,target.scopeKey)||!validSource(target.source))throw new Error('此成果超出版本大小限制或来源已变化');}
function append(row:ArtifactVersionSeries,source:string,origin:ArtifactVersion['origin'],restoredFrom?:string){
  if(!validSource(source))throw new Error('源码须为非空文本且不超过 512 KB');
  if(row.versions.length>=ARTIFACT_VERSION_LIMIT)throw new Error('此成果已保存 30 个版本，历史和当前草稿均保留');
  row.versions.push({id:randomUUID(),revision:conversationArtifactRevision(source),source,origin,createdAt:Date.now(),...(restoredFrom?{restoredFrom}:{})});
}

/** Exact message/block identity defines a series. A matching title never joins
 * two unrelated outputs. Snapshots are immutable and edits use a head CAS. */
export function ensureArtifactVersion(target:ConversationArtifactTarget):Promise<ArtifactVersionSeries>{
  const snapshot={...target};return serial(async()=>{
    validate(snapshot);const table=await readTable(),key=artifactVersionSeriesKey(snapshot);
    let row=table[key];if(!row){if(Object.keys(table).length>=MAX_SERIES)throw new Error('本地成果版本记录已满，已有内容保留');row={scopeKey:snapshot.scopeKey,messageId:snapshot.messageId,index:snapshot.index,versions:[]};table[key]=row;}
    if(!row.versions.some(version=>version.origin==='message'&&version.revision===snapshot.revision)){append(row,snapshot.source,'message');await writeTable(table);}
    return clone(row);
  });
}
export function saveArtifactVersion(target:ConversationArtifactTarget,source:string,expectedHead:string):Promise<ArtifactVersionSeries>{
  const snapshot={...target};return serial(async()=>{validate(snapshot);const table=await readTable(),row=table[artifactVersionSeriesKey(snapshot)];
    if(!row||row.versions.at(-1)?.id!==expectedHead)throw new Error('成果已有新版本，请重新读取后比较；当前编辑仍保留');
    append(row,source,'edit');await writeTable(table);return clone(row);
  });
}
export function restoreArtifactVersion(target:ConversationArtifactTarget,id:string,expectedHead:string):Promise<ArtifactVersionSeries>{
  const snapshot={...target};return serial(async()=>{validate(snapshot);const table=await readTable(),row=table[artifactVersionSeriesKey(snapshot)];
    if(!row||row.versions.at(-1)?.id!==expectedHead)throw new Error('成果已有新版本，请重新读取后比较；当前编辑仍保留');
    const version=row.versions.find(item=>item.id===id);if(!version)throw new Error('所选版本不属于当前成果');
    append(row,version.source,'restore',version.id);await writeTable(table);return clone(row);
  });
}

export interface ArtifactSourceChange {kind:'same'|'add'|'remove';text:string;oldLine?:number;newLine?:number}
/** Bounded LCS keeps ordinary source changes readable. Large documents show a
 * precise replace region after common prefix/suffix, avoiding quadratic work. */
export function compareArtifactSources(before:string,after:string):ArtifactSourceChange[]{
  const left=before.split('\n'),right=after.split('\n');let prefix=0,suffix=0;
  while(prefix<left.length&&prefix<right.length&&left[prefix]===right[prefix])prefix++;
  while(suffix<left.length-prefix&&suffix<right.length-prefix&&left[left.length-1-suffix]===right[right.length-1-suffix])suffix++;
  const rows:ArtifactSourceChange[]=left.slice(0,prefix).map((text,index)=>({kind:'same',text,oldLine:index+1,newLine:index+1}));
  const a=left.slice(prefix,left.length-suffix),b=right.slice(prefix,right.length-suffix);
  if(a.length*b.length<=160000){
    const width=b.length+1,dp=new Uint16Array((a.length+1)*width);
    for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i*width+j]=a[i]===b[j]?1+dp[(i+1)*width+j+1]:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
    let i=0,j=0;while(i<a.length||j<b.length){
      if(i<a.length&&j<b.length&&a[i]===b[j]){rows.push({kind:'same',text:a[i],oldLine:prefix+i+1,newLine:prefix+j+1});i++;j++;}
      else if(j<b.length&&(i===a.length||dp[i*width+j+1]>=dp[(i+1)*width+j])){rows.push({kind:'add',text:b[j],newLine:prefix+j+1});j++;}
      else{rows.push({kind:'remove',text:a[i],oldLine:prefix+i+1});i++;}
    }
  }else{a.forEach((text,index)=>rows.push({kind:'remove',text,oldLine:prefix+index+1}));b.forEach((text,index)=>rows.push({kind:'add',text,newLine:prefix+index+1}));}
  for(let i=suffix;i>0;i--)rows.push({kind:'same',text:left[left.length-i],oldLine:left.length-i+1,newLine:right.length-i+1});
  return rows;
}
