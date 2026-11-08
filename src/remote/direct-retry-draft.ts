import type { AttachmentRef } from './client';
import type { TimelineItem } from './store';
import type { DirectDraftInput } from './direct-composer-drafts';
import { copyTurnFeatures, skillKey } from './agent-features';
import { appendContextReference } from './context-references';
import { cachedAttachment, parseAttachmentPage } from './attachment-cache';
import { readRemoteRetryImages, type QueuedImageDraft } from './drafts';
import { requestDirect } from './direct-api';
import type { DirectSessionServices } from './direct-session-services';

export interface DirectDraftRestoreRequest {
  id:string;
  text:string;
  attachments:AttachmentRef[];
  load:(signal:AbortSignal)=>Promise<DirectDraftInput>;
}

/** Retrying a failed image turn first recovers the exact bytes into an ordinary
 * draft. Continue cannot accept images, and a partial restoration is never sent. */
export async function recoverDirectMessageDraft({pairing,deviceId,sessionKey,message,services,signal}:{
  pairing:string;deviceId:string;sessionKey:string;message:Extract<TimelineItem,{kind:'message'}>;services:DirectSessionServices;signal:AbortSignal;
}):Promise<DirectDraftInput> {
  const check=()=>{services.guard();if(signal.aborted)throw new Error('恢复已取消');};check();
  const refs=message.attachments??[],imageCount=Math.max(refs.length,message.images?.length??0);
  if(imageCount&&(!refs.length||refs.length!==imageCount||refs.length>4))throw new Error('原图片引用不完整，请保留原消息并重新选择全部原图');
  const sources:QueuedImageDraft[]=[];
  for(const ref of refs){
    if(!/^image\/(jpeg|png|webp)$/.test(ref.mime)||!ref.width||!ref.height)throw new Error('原图片的尺寸或格式未确认，不能只恢复文字重发');
    const uri=await cachedAttachment(`${pairing}\0${JSON.stringify([deviceId,sessionKey])}`,ref,async offset=>{
      check();const raw=await requestDirect({type:'attachment.read',sessionKey,id:ref.id,offset,length:80000});check();return parseAttachmentPage(raw);
    },signal);check();
    sources.push({uri,mime:ref.mime as QueuedImageDraft['mime'],width:ref.width,height:ref.height});
  }
  const images=sources.length?await readRemoteRetryImages(sources):[];check();
  if(images.length!==imageCount||images.some(image=>!image.base64))throw new Error('原图片尚未完整恢复，不能发送');
  return {text:message.text,options:copyTurnFeatures(message),images,imageCount:images.length,missingImages:false,model:'',effort:'',permission:''};
}

/** Explicit append keeps unrelated unsent text, images and choices. Bounds are
 * checked before changing the visible or durable composer draft. */
export function appendRecoveredDirectDraft(current:DirectDraftInput,recovered:DirectDraftInput):DirectDraftInput {
  if(current.missingImages||recovered.missingImages)throw new Error('请先处理原草稿缺失的图片');
  const images=[...current.images,...recovered.images];if(images.length>4)throw new Error('合并后超过 4 张图片，请先保留或发送当前草稿');
  const skills=[...(current.options.skills??[])];for(const skill of recovered.options.skills??[])if(!skills.some(value=>skillKey(value)===skillKey(skill)))skills.push(skill);
  if(skills.length>8)throw new Error('合并后超过 8 个技能，请先处理当前草稿');
  let references=[...(current.options.contextReferences??[])];for(const ref of recovered.options.contextReferences??[])references=appendContextReference(references,ref);
  const text=[current.text,recovered.text].filter(Boolean).join('\n\n');if(text.length>40000)throw new Error('合并后消息过长，请先处理当前草稿');
  return {...current,text,images,imageCount:images.length,missingImages:false,options:{...current.options,...(skills.length?{skills}:{}),...(references.length?{contextReferences:references}:{})}};
}
