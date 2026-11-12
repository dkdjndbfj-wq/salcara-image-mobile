import type { Timeline, TimelineItem } from './store';
import { turnControlTarget, validTurnId } from './turn-control';

export interface DirectRetryTarget {
  failed: Extract<TimelineItem,{kind:'turn'}>;
  message: Extract<TimelineItem,{kind:'message'}>;
  turnId: string;
}

/** Retry only an observed terminal failure and its own ordinary user input. */
export function directRetryTarget(timeline:Timeline):DirectRetryTarget|undefined {
  const turnId=turnControlTarget(timeline,'continue');if(!turnId)return;
  const top=timeline.items.filter(item=>!item.parentId);
  const last=top[top.length-1];
  if(last?.kind!=='turn'||last.status!=='failed'||!validTurnId(last.turnId)||last.turnId!==turnId)return;
  for(let index=top.length-2;index>=0;index--){
    const item=top[index];
    if(item.kind==='turn'&&(item.status!=='started'||item.turnId&&item.turnId!==turnId))return;
    if(item.kind!=='message'||item.role!=='user')continue;
    if(item.local||item.messageOrigin||item.turnId&&item.turnId!==turnId||!(item.text.trim()||item.attachments?.length||item.images?.length||item.contextReferences?.length))return;
    return {failed:last,message:item,turnId};
  }
}

/** A remote error may itself report ambiguous dispatch, even with a valid RPC envelope. */
export function directActionUncertain(reason:unknown):boolean {
  const code=reason&&typeof reason==='object'&&'remoteCode'in reason&&reason.remoteCode?String(reason.remoteCode):reason&&typeof reason==='object'&&'code'in reason?String(reason.code):'';
  const message=reason instanceof Error?reason.message:String(reason??'');
  return ['timeout','disconnected','protocol','command_delivery_uncertain'].includes(code)
    || /(?:delivery_uncertain|unconfirmed|送达.*未确认|结果未确认|可能.*(?:已执行|已接收|已开始))/i.test(message);
}
