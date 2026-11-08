import type {TimelineItem} from './store';

export type SentUserMessage=Extract<TimelineItem,{kind:'message'}>;
export type SentMessageRevisionHandler=(message:SentUserMessage,revisedText:string,signal:AbortSignal)=>Promise<boolean>;
export function canReviseSentMessage(item:TimelineItem):item is SentUserMessage {
  return item.kind==='message'&&item.role==='user'&&item.final&&!item.streamState&&!item.local&&!item.parentId&&!item.messageOrigin
    &&Boolean(item.text.trim()||item.attachments?.length||item.images?.length);
}
/** A newer pending user message is a boundary, not a reason to edit an older one. */
export function latestRevisableMessage(items:readonly TimelineItem[]):SentUserMessage|undefined {
  for(let index=items.length-1;index>=0;index--){
    const item=items[index];
    if(item.kind==='message'&&item.role==='user'&&!item.parentId&&!item.messageOrigin)return canReviseSentMessage(item)?item:undefined;
  }
  return undefined;
}
/** A thumbnail arriving is not an edit to the authenticated message. */
export function sentMessageRevisionIdentity(item:SentUserMessage):string {
  const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical)
    :value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,canonical(entry)])):value;
  return JSON.stringify(canonical([item.id,item.role,item.text,item.local,item.parentId,item.messageOrigin,item.turnId,
    item.attachments?.map(({uri,...ref})=>ref),item.attachments?.length?undefined:item.images,item.skills,item.contextReferences]));
}
