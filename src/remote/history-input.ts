import type {LocalAttachment} from './attachment-ref';
import type {AgentCapabilities} from './client';
import type {PromptHistoryEntry} from './prompt-history';
import {copyTurnFeatures} from './agent-features';
import {readRemoteRetryImages,type QueuedImageDraft} from './drafts';
import type {SentEditRecovery} from './sent-edit-recovery';
import {hasResponseAnnotations,hasDiffAnnotations} from './context-references';

export function requireHistoryCapabilities(entry:PromptHistoryEntry,capabilities?:AgentCapabilities){
  const features=copyTurnFeatures(entry.message??{});
  if((features.skills?.length||features.collaborationMode)&&!capabilities?.features)throw new Error('当前 Agent 不支持原消息的技能或计划模式，当前草稿未改变');
  if(features.contextReferences?.length&&(!capabilities?.contextReferences||hasResponseAnnotations(features.contextReferences)&&!capabilities.contextAnnotations||hasDiffAnnotations(features.contextReferences)&&!capabilities.contextDiffAnnotations))throw new Error('当前 Agent 不支持原消息中的引用或批注，当前草稿未改变');
}

/** Restore authenticated input as a complete draft, never as a new request. */
export async function recoverHistoryInput(entry:PromptHistoryEntry,load:(ref:LocalAttachment)=>Promise<string|null>,current:()=>boolean):Promise<SentEditRecovery>{
  const check=()=>{if(!current())throw new Error('会话或原消息已变化，当前草稿未改变');};check();
  const message=entry.message;if(!message)throw new Error('原消息不再可用');
  const features=copyTurnFeatures(message),refs=message.attachments??[],count=Math.max(refs.length,message.images?.length??0);
  if(count&&(!refs.length||refs.length!==count||count>4))throw new Error('原图片引用不完整，当前草稿未改变');
  const sources:QueuedImageDraft[]=[];
  for(const ref of refs){
    if(!/^image\/(jpeg|png|webp)$/.test(ref.mime)||!ref.width||!ref.height)throw new Error('原图片的格式或尺寸尚未确认，当前草稿未改变');
    const uri=await load(ref);check();if(!uri)throw new Error('原图片无法读取，当前草稿未改变');
    sources.push({uri,mime:ref.mime as QueuedImageDraft['mime'],width:ref.width,height:ref.height});
  }
  const images=sources.length?await readRemoteRetryImages(sources):[];check();
  if(images.length!==count||images.some(image=>!image.base64))throw new Error('原图片没有完整恢复，当前草稿未改变');
  return {text:message.text,images,features};
}
