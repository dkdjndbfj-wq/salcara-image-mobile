import {Image} from 'react-native';
import {manipulateAsync} from 'expo-image-manipulator';
import {cropBrowserAnnotation} from '../remote/browser-annotation-image';
import {browserCropRect,frameImageSource} from '../remote/browser-annotation-image-shared';

jest.mock('expo-image-manipulator',()=>({manipulateAsync:jest.fn(),SaveFormat:{PNG:'png'}}));
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/kR8AAAAASUVORK5CYII=';
const frame={pageId:'page',documentId:'doc',url:'http://localhost:3000/',width:800,height:600,nextSequence:1,imageBase64:'/9j/AA=='};
const box={x:100,y:50,width:200,height:100};
beforeEach(()=>{jest.clearAllMocks();jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success?.(1600,1200);return Promise.resolve({width:1600,height:1200});});jest.mocked(manipulateAsync).mockResolvedValue({uri:'file:///crop.png',base64:png,width:400,height:200});});
afterEach(()=>jest.restoreAllMocks());

test('native crop uses decoded pixel dimensions and returns actual PNG bytes',async()=>{
 const image=await cropBrowserAnnotation(frame,box,()=>true);
 expect(manipulateAsync).toHaveBeenCalledWith('data:image/jpeg;base64,/9j/AA==',[{crop:{originX:200,originY:100,width:400,height:200}}],{format:'png',base64:true,compress:1});
 expect(image).toEqual({uri:`data:image/png;base64,${png}`,base64:png,mime:'image/png',width:400,height:200});
});
test('partially offscreen elements crop the visible intersection and fully offscreen selections fail',()=>{
 expect(browserCropRect(frame,{x:-10,y:580,width:50,height:40},{width:1600,height:1200})).toEqual({originX:0,originY:1160,width:80,height:40});
 expect(()=>browserCropRect(frame,{x:900,y:20,width:20,height:20},{width:1600,height:1200})).toThrow('视口外');
});
test('missing or invalid remote image bytes fail before any conversion',async()=>{
 await expect(cropBrowserAnnotation({...frame,imageBase64:undefined},box,()=>true)).rejects.toThrow('截图尚未读取');
 expect(()=>frameImageSource({...frame,imageBase64:'YWJj'})).toThrow('无法解码');expect(manipulateAsync).not.toHaveBeenCalled();
});
test('a scope change after decoding or cropping cannot return an image',async()=>{
 let current=true;jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{current=false;success?.(1600,1200);return Promise.resolve({width:1600,height:1200});});
 await expect(cropBrowserAnnotation(frame,box,()=>current)).rejects.toThrow('网页或对话已变化');expect(manipulateAsync).not.toHaveBeenCalled();
});
test('native conversion rejects a missing or non-PNG output instead of claiming screenshot success',async()=>{
 jest.mocked(manipulateAsync).mockResolvedValueOnce({uri:'file:///crop.png',width:400,height:200});
 await expect(cropBrowserAnnotation(frame,box,()=>true)).rejects.toThrow('未完整生成');
 jest.mocked(manipulateAsync).mockResolvedValueOnce({uri:'file:///crop.png',base64:'YWJj',width:400,height:200});
 await expect(cropBrowserAnnotation(frame,box,()=>true)).rejects.toThrow();
});
