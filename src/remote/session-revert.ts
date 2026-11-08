import type {Timeline} from './store';
import {latestRevisableMessage,sentMessageRevisionIdentity,type SentUserMessage} from './sent-message-revision';
import {turnControlTarget} from './turn-control';

export interface SessionRevertRequest {sessionKey:string;expectedTurnId:string;expectedMessageId:string;operationId:string}
export interface SessionRevertResult {status:'completed'|'unconfirmed';sessionKey:string;turnId:string;messageId:string;operationId:string}
export function parseSessionRevertResult(raw:unknown,request:SessionRevertRequest):SessionRevertResult {
  const value=raw as SessionRevertResult|undefined;
  if(!value||!['completed','unconfirmed'].includes(value.status)||value.sessionKey!==request.sessionKey||value.turnId!==request.expectedTurnId
    ||value.messageId!==request.expectedMessageId||value.operationId!==request.operationId)throw new Error('编辑回退结果未确认，请刷新原会话核对；不会自动重发');
  return value;
}
/** A message with no exact native turn cannot authorize deleting history. */
export function latestEditableTurn(timeline:Timeline,message:SentUserMessage):string|undefined {
  const latest=latestRevisableMessage(timeline.items),turn=turnControlTarget(timeline,'continue');
  if(!latest||!turn||!message.turnId||message.turnId!==turn||timeline.session?.latestTurnRevert!==true
    ||sentMessageRevisionIdentity(latest)!==sentMessageRevisionIdentity(message))return;
  // Steered user inputs can share a turn. Reverting it would remove more than
  // the single latest message that the user selected.
  if(timeline.items.filter(item=>item.kind==='message'&&item.role==='user'&&!item.parentId&&item.turnId===turn).length!==1)return;
  return turn;
}
