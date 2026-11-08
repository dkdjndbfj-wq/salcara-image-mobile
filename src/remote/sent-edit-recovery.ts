import type {RemoteImage} from './attachments';
import {copyTurnFeatures,skillKey,type TurnFeatures} from './agent-features';
import {appendContextReference,contextReferenceKey} from './context-references';
import {joinPastedText,namedTextAttachment,splitPastedText} from './pasted-text';

export interface SentEditRecovery {text:string;images:RemoteImage[];features:TurnFeatures}
export type SentEditRestorer=(value:SentEditRecovery,operationId:string,policy?:{allowRunning?:boolean;isCurrent?:()=>boolean})=>Promise<boolean>;
/** A recovery adds the complete saved input without replacing a newer draft. */
export function mergeSentEditRecovery(current:SentEditRecovery,saved:SentEditRecovery,maxLength=100_000):SentEditRecovery {
  const first=copyTurnFeatures(current.features),second=copyTurnFeatures(saved.features);
  if(first.collaborationMode&&second.collaborationMode&&first.collaborationMode!==second.collaborationMode)throw new Error('当前草稿与修改内容的工作模式不同，请先处理当前草稿');
  const before=splitPastedText(current.text),incoming=splitPastedText(saved.text),attachments=[...before.attachments];
  for(const attachment of incoming.attachments)attachments.push(namedTextAttachment(attachment.name,attachment.text,attachments));
  if(attachments.length>8)throw new Error('合并后超过 8 个文本附件，当前草稿未改变');
  const text=joinPastedText([before.prompt,incoming.prompt].filter(Boolean).join('\n\n'),attachments);
  if(text.length>maxLength)throw new Error('合并后消息过长，请先处理当前草稿；修改备份仍保留');
  const images=[...current.images];
  for(const image of saved.images)if(!images.some(value=>value.uri===image.uri&&value.mime===image.mime&&value.width===image.width&&value.height===image.height))images.push({...image});
  if(images.length>4)throw new Error('合并后超过 4 张图片，请先处理当前草稿；图片不会被丢弃');
  const skills=[...new Map([...(first.skills??[]),...(second.skills??[])].map(skill=>[skillKey(skill),skill])).values()];
  if(skills.length>8)throw new Error('合并后超过 8 个技能，请先处理当前草稿');
  let refs=[...(first.contextReferences??[])];
  for(const ref of second.contextReferences??[]){
    const existing=refs.find(value=>contextReferenceKey(value)===contextReferenceKey(ref));
    if(existing){
      if(existing.text!==ref.text||existing.annotation!==ref.annotation)throw new Error('同一位置的上下文内容已变化，请先处理当前引用；修改备份仍保留');
    }else refs=appendContextReference(refs,ref);
  }
  return {text,images,features:copyTurnFeatures({...(first.collaborationMode??second.collaborationMode?{collaborationMode:first.collaborationMode??second.collaborationMode}:{}),...(skills.length?{skills}:{}),...(refs.length?{contextReferences:refs}:{})})};
}
