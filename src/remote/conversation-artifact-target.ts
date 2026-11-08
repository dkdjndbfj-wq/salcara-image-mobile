import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

/** Runtime-only content. Never serialize source into the workspace layout. */
export interface ConversationArtifactTarget {
  scopeKey:string;
  messageId:string;
  index:number;
  revision:string;
  source:string;
  title:string;
}
export function conversationArtifactRevision(source:string):string {
  return bytesToHex(sha256(new TextEncoder().encode(source)));
}
export function conversationArtifactTitle(source:string):string {
  const title=source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? source.match(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i)?.[1];
  return title?.replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,100)||'界面预览';
}
export function conversationArtifactId(target:ConversationArtifactTarget):string {
  return JSON.stringify([target.scopeKey,target.messageId,target.index,target.revision]);
}
export function validConversationArtifact(target:ConversationArtifactTarget,scopeKey:string):boolean {
  return target?.scopeKey===scopeKey&&typeof target.source==='string'&&target.source.length>0&&target.source.length<=512*1024
    &&typeof target.messageId==='string'&&target.messageId.length>0&&target.messageId.length<=1024
    &&Number.isInteger(target.index)&&target.index>=0&&target.index<1000
    &&typeof target.title==='string'&&target.title.length<=100
    &&target.revision===conversationArtifactRevision(target.source);
}
