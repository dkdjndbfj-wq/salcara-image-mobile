import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {emptyCanvasHistory,loadCanvasRecord,saveCanvasRecord,validCanvasNotes} from './canvas-session';
import type { AttachmentRef } from './client';
import { attachmentContentKey } from './attachment-ref';
import type { TimelineItem } from './store';

export interface CanvasImage { id:string; messageId:string; name:string; uri?:string; ref?:AttachmentRef; path?:string; revision?:string; width?:number; height?:number; role:'user'|'assistant'|'tool' }
export interface ImageRegion { x:number;y:number;width:number;height:number }
export interface ImageNote { id:string; imageId:string; imageRevision?:string; number?:number; comment:string; region?:ImageRegion }
/** URI can arrive asynchronously; identity is the immutable attachment/file revision. */
export const canvasImageRevision=(image:CanvasImage)=>image.revision??image.ref?.sha256??image.id;
export const canvasImageKey=(image:CanvasImage)=>JSON.stringify([image.id,canvasImageRevision(image)]);
export const imageNoteMatches=(note:ImageNote,image:CanvasImage)=>note.imageId===image.id&&(!note.imageRevision||note.imageRevision===canvasImageRevision(image));
export function conversationImages(items:readonly TimelineItem[]):CanvasImage[] {
  return items.flatMap(item=>{
    if(item.kind!=='message'&&item.kind!=='tool'||item.parentId)return [];
    const refs=item.attachments??[],role=item.kind==='message'?item.role:'tool';
    const images:CanvasImage[]=refs.map(ref=>({id:JSON.stringify([item.id,attachmentContentKey(ref)]),messageId:item.id,name:ref.name||`图片 ${ref.id.slice(-6)}`,uri:ref.uri,ref,width:ref.width,height:ref.height,role}));
    if(item.kind==='message')for(const [index,uri] of (item.images??[]).entries()) {
      if(refs.some(ref=>ref.uri===uri)||refs.length)continue;
      images.push({id:JSON.stringify([item.id,index,bytesToHex(sha256(new TextEncoder().encode(uri)))]),messageId:item.id,name:`图片 ${index+1}`,uri,role});
    }
    return images;
  });
}
export function normalizedRegion(a:{x:number;y:number},b:{x:number;y:number}):ImageRegion|undefined {
  const clamp=(n:number)=>Math.max(0,Math.min(1,n));
  if(![a.x,a.y,b.x,b.y].every(Number.isFinite))return;
  const x=Math.min(clamp(a.x),clamp(b.x)),y=Math.min(clamp(a.y),clamp(b.y));
  const width=Math.abs(clamp(a.x)-clamp(b.x)),height=Math.abs(clamp(a.y)-clamp(b.y));
  return width>=.01&&height>=.01?{x,y,width,height}:undefined;
}
export function imageNotesPrompt(images:readonly CanvasImage[],notes:readonly ImageNote[]):string {
  const attached=[...new Map(images.filter(image=>notes.some(note=>imageNoteMatches(note,image))).map(image=>[canvasImageKey(image),image])).values()];
  const entries=notes.flatMap(note=>{
    const image=images.find(item=>imageNoteMatches(note,item));if(!image||!note.comment.trim())return [];
    const source=image.path?`文件：${image.path}\n版本：${image.revision??'未知'}`:`原消息：${image.messageId}\n图片附件：${image.ref?.id??image.name}${image.ref?.sha256?`\nSHA-256：${image.ref.sha256}`:''}`;
    const r=note.region,region=r?`\n区域（以图片左上角为原点，0–1 归一化）：x=${r.x.toFixed(3)}, y=${r.y.toFixed(3)}, width=${r.width.toFixed(3)}, height=${r.height.toFixed(3)}`:'';
    return [`附图 ${attached.findIndex(item=>canvasImageKey(item)===canvasImageKey(image))+1}：${image.name}\n${source}${region}\n修改要求：${note.comment.trim()}`];
  });
  return entries.length?`请根据以下图片批注继续修改本会话中的原图：\n\n${entries.join('\n\n')}`:'';
}
export async function loadImageNotes(scope:string):Promise<ImageNote[]> {
  return (await loadCanvasRecord(scope)).notes;
}
export async function saveImageNotes(scope:string,notes:readonly ImageNote[]):Promise<void> {
  const record=await loadCanvasRecord(scope);
  return saveCanvasRecord({...record,notes:validCanvasNotes(notes),history:emptyCanvasHistory()});
}
