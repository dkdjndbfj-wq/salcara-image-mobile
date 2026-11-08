import {MAX_REMOTE_IMAGES,type RemoteImage} from './attachment-chunks';
export type ImageAnnotationAppender=(text:string,images:readonly RemoteImage[])=>Promise<boolean>;

/** An annotation carries the original image bytes, never just opaque attachment IDs. */
export function appendImageAnnotation<T extends {text:string;images:RemoteImage[];missingImages?:boolean}>(current:T,text:string,images:readonly RemoteImage[]):T {
  if(current.missingImages)throw new Error('请先恢复或移除当前草稿缺失的图片');
  if(!images.length||images.some(image=>!image.base64))throw new Error('批注原图未完整读取，批注已保留');
  const merged=[...current.images];for(const image of images)if(!merged.some(existing=>existing.uri===image.uri&&existing.base64===image.base64))merged.push(image);
  if(merged.length>MAX_REMOTE_IMAGES)throw new Error(`合并后超过 ${MAX_REMOTE_IMAGES} 张图片，请先处理当前草稿`);
  const combined=[current.text,text].filter(Boolean).join('\n\n');
  if(combined.length>40000)throw new Error('合并后消息过长，请先处理当前草稿');
  return {...current,text:combined,images:merged,imageCount:merged.length,missingImages:false};
}
