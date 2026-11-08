import {attachmentBytes,attachmentMagic} from './attachment-ref';
import type {RemoteImage} from './attachment-chunks';
import type {PreviewFrame} from './workspace-preview';

export interface BrowserAnnotationRect {x:number;y:number;width:number;height:number}
export type BrowserAnnotationFrame=Pick<PreviewFrame,'pageId'|'documentId'|'url'|'width'|'height'|'scrollX'|'scrollY'|'imageBase64'|'nextSequence'>;
export type CropGuard=()=>boolean;
export function assertBrowserCaptureCurrent(isCurrent:CropGuard){if(!isCurrent())throw new Error('网页或对话已变化，批注未加入新的页面');}
export function frameImageSource(frame:BrowserAnnotationFrame):string {
  if(!Number.isFinite(frame.width)||!Number.isFinite(frame.height)||frame.width<=0||frame.height<=0)throw new Error('网页视口尺寸无效，请重新读取截图');
  if(!frame.imageBase64)throw new Error('电脑网页截图尚未读取，批注已保留，请重试截图');
  const bytes=attachmentBytes(frame.imageBase64,2_000_000);
  const mime=(['image/jpeg','image/png','image/webp'] as const).find(type=>attachmentMagic(bytes,type));
  if(!mime)throw new Error('电脑网页截图无法解码，批注已保留，请重试截图');
  return `data:${mime};base64,${frame.imageBase64}`;
}
export function browserCropRect(frame:BrowserAnnotationFrame,rect:BrowserAnnotationRect,pixels:{width:number;height:number}) {
  if(![rect.x,rect.y,rect.width,rect.height,pixels.width,pixels.height].every(Number.isFinite)||rect.width<=0||rect.height<=0||pixels.width<=0||pixels.height<=0||pixels.width>20000||pixels.height>20000)throw new Error('选区尺寸无效，请重新选择网页区域');
  const left=Math.max(0,rect.x),top=Math.max(0,rect.y),right=Math.min(frame.width,rect.x+rect.width),bottom=Math.min(frame.height,rect.y+rect.height);
  if(right<=left||bottom<=top)throw new Error('所选元素已在视口外，请定位后重新选择');
  const originX=Math.floor(left*pixels.width/frame.width),originY=Math.floor(top*pixels.height/frame.height);
  return {originX,originY,width:Math.max(1,Math.min(pixels.width-originX,Math.ceil(right*pixels.width/frame.width)-originX)),height:Math.max(1,Math.min(pixels.height-originY,Math.ceil(bottom*pixels.height/frame.height)-originY))};
}
export function browserCropImage(base64:string|undefined,width:number,height:number):RemoteImage {
  if(!base64||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>1600||height>1600)throw new Error('局部截图未完整生成，请重试；批注已保留');
  if(!attachmentMagic(attachmentBytes(base64,1_500_000),'image/png'))throw new Error('局部截图无效，请重试；批注已保留');
  return {base64,mime:'image/png',uri:`data:image/png;base64,${base64}`,width,height};
}
export function sameBrowserCapture(first:BrowserAnnotationFrame,next:BrowserAnnotationFrame) {
  return first.pageId===next.pageId&&first.documentId===next.documentId&&first.url===next.url&&first.width===next.width&&first.height===next.height&&(first.scrollX??0)===(next.scrollX??0)&&(first.scrollY??0)===(next.scrollY??0);
}
