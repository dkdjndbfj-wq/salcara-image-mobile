import type { TimelineItem } from './store';
import {copyTurnFeatures,type TurnFeatures} from './agent-features';

export interface PromptHistoryEntry { id: string; text: string; hasImages: boolean; message?:Extract<TimelineItem,{kind:'message'}>&TurnFeatures }
export const promptHistoryIdentity=(entry:PromptHistoryEntry)=>JSON.stringify([entry.id,entry.text,entry.message?.attachments,entry.message?.images,entry.message?.skills,entry.message?.contextReferences,entry.message?.collaborationMode]);
/** The authenticated transcript is the source; pending sends and delegated
 * instructions must not become user prompt history. Nothing is shared globally. */
export function promptHistory(items: readonly TimelineItem[]): PromptHistoryEntry[] {
  const result: PromptHistoryEntry[] = [], seen = new Set<string>();
  for (let i = items.length - 1; i >= 0 && result.length < 40; i--) {
    const item = items[i];
    if (item.kind !== 'message' || item.role !== 'user' || item.local || item.parentId || item.messageOrigin
      || item.text.length > 100_000) continue;
    const hasImages=Boolean(item.images?.length||item.attachments?.length);
    if(!item.text.trim()&&!hasImages&&!item.skills?.length&&!item.contextReferences?.length)continue;
    let features;try{features=copyTurnFeatures(item);}catch{continue;}
    const signature=JSON.stringify([item.text,item.attachments?.map(ref=>[ref.id,ref.mime,ref.width,ref.height]),item.images,features]);
    if(seen.has(signature))continue;
    seen.add(signature);result.push({id:item.id,text:item.text,hasImages,message:{...item,...features,attachments:item.attachments?.map(ref=>({...ref})),images:item.images?[...item.images]:undefined}});
  }
  return result;
}
