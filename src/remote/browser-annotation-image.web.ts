import {assertBrowserCaptureCurrent,browserCropImage,browserCropRect,frameImageSource,type BrowserAnnotationFrame,type BrowserAnnotationRect,type CropGuard} from './browser-annotation-image-shared';
export type {BrowserAnnotationFrame,BrowserAnnotationRect,CropGuard} from './browser-annotation-image-shared';

export async function cropBrowserAnnotation(frame:BrowserAnnotationFrame,rect:BrowserAnnotationRect,isCurrent:CropGuard) {
  assertBrowserCaptureCurrent(isCurrent);const uri=frameImageSource(frame);
  const image=await new Promise<HTMLImageElement>((resolve,reject)=>{
    const element=new Image(),timer=setTimeout(()=>{element.onload=null;element.onerror=null;reject(new Error('网页截图读取超时，请重试；批注已保留'));},15000);
    element.onload=()=>{clearTimeout(timer);resolve(element);};element.onerror=()=>{clearTimeout(timer);reject(new Error('网页截图无法解码，请重试；批注已保留'));};element.src=uri;
  });
  assertBrowserCaptureCurrent(isCurrent);const rectPixels=browserCropRect(frame,rect,{width:image.naturalWidth,height:image.naturalHeight});
  const factor=Math.min(1,1600/Math.max(rectPixels.width,rectPixels.height)),canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(rectPixels.width*factor));canvas.height=Math.max(1,Math.round(rectPixels.height*factor));
  try {
    const context=canvas.getContext('2d');if(!context)throw new Error('浏览器暂时无法创建局部截图，批注已保留');
    context.drawImage(image,rectPixels.originX,rectPixels.originY,rectPixels.width,rectPixels.height,0,0,canvas.width,canvas.height);
    const data=canvas.toDataURL('image/png');assertBrowserCaptureCurrent(isCurrent);
    return browserCropImage(data.startsWith('data:image/png;base64,')?data.slice(22):undefined,canvas.width,canvas.height);
  }finally{canvas.width=0;canvas.height=0;image.src='';}
}
