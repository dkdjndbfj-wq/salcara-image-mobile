import {Image} from 'react-native';
import {manipulateAsync,SaveFormat} from 'expo-image-manipulator';
import {assertBrowserCaptureCurrent,browserCropImage,browserCropRect,frameImageSource,type BrowserAnnotationFrame,type BrowserAnnotationRect,type CropGuard} from './browser-annotation-image-shared';
export type {BrowserAnnotationFrame,BrowserAnnotationRect,CropGuard} from './browser-annotation-image-shared';

/** Crops only the bytes captured by the current remote page; never downloads a URL. */
export async function cropBrowserAnnotation(frame:BrowserAnnotationFrame,rect:BrowserAnnotationRect,isCurrent:CropGuard) {
  assertBrowserCaptureCurrent(isCurrent);const uri=frameImageSource(frame);
  const pixels=await new Promise<{width:number;height:number}>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('网页截图读取超时，请重试；批注已保留')),15000);
    const fail=()=>{clearTimeout(timer);reject(new Error('网页截图无法解码，请重试；批注已保留'));};
    try{Image.getSize(uri,(width,height)=>{clearTimeout(timer);resolve({width,height});},fail);}catch{fail();}
  });
  assertBrowserCaptureCurrent(isCurrent);const crop=browserCropRect(frame,rect,pixels);
  const actions:Array<{crop:typeof crop}|{resize:{width:number}|{height:number}}>=[{crop}];
  if(Math.max(crop.width,crop.height)>1600)actions.push({resize:crop.width>=crop.height?{width:1600}:{height:1600}});
  const result=await manipulateAsync(uri,actions,{format:SaveFormat.PNG,base64:true,compress:1});
  assertBrowserCaptureCurrent(isCurrent);return browserCropImage(result.base64,result.width,result.height);
}
