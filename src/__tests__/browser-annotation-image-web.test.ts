import {cropBrowserAnnotation} from '../remote/browser-annotation-image.web';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/kR8AAAAASUVORK5CYII=';
const frame={pageId:'page',documentId:'doc',url:'http://localhost:3000/',width:800,height:600,nextSequence:1,imageBase64:'/9j/AA=='};
const draw=jest.fn(),encode=jest.fn(),create=jest.fn();let fail=false,context=true,loaded:undefined|(()=>void),autoLoad=true;
const originalImage=globalThis.Image,originalDocument=globalThis.document;
beforeEach(()=>{
 jest.clearAllMocks();fail=false;context=true;autoLoad=true;loaded=undefined;
 class Picture {naturalWidth=1600;naturalHeight=1200;onload:undefined|(()=>void);onerror:undefined|(()=>void);set src(value:string){if(!value)return;loaded=()=>{if(fail)this.onerror?.();else this.onload?.();};if(autoLoad)loaded();}}
 Object.defineProperty(globalThis,'Image',{configurable:true,writable:true,value:Picture});
 encode.mockReturnValue(`data:image/png;base64,${png}`);create.mockImplementation(()=>({width:0,height:0,getContext:()=>context?{drawImage:draw}:null,toDataURL:encode}));
 Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:{createElement:create}});
});
afterEach(()=>{Object.defineProperty(globalThis,'Image',{configurable:true,writable:true,value:originalImage});Object.defineProperty(globalThis,'document',{configurable:true,writable:true,value:originalDocument});});
test('web crop draws only the selected true screenshot pixels and returns its PNG data',async()=>{
 const image=await cropBrowserAnnotation(frame,{x:100,y:50,width:200,height:100},()=>true);
 expect(draw).toHaveBeenCalledWith(expect.any(Object),200,100,400,200,0,0,400,200);expect(encode).toHaveBeenCalledWith('image/png');expect(image.base64).toBe(png);expect(image.width).toBe(400);
});
test('decode and missing canvas failures never return an invented screenshot',async()=>{
 fail=true;await expect(cropBrowserAnnotation(frame,{x:1,y:1,width:10,height:10},()=>true)).rejects.toThrow('无法解码');expect(draw).not.toHaveBeenCalled();
 fail=false;context=false;await expect(cropBrowserAnnotation(frame,{x:1,y:1,width:10,height:10},()=>true)).rejects.toThrow('无法创建局部截图');
});
test('changing source while image decode is pending prevents canvas work',async()=>{
 autoLoad=false;let current=true;const pending=cropBrowserAnnotation(frame,{x:1,y:1,width:10,height:10},()=>current);current=false;loaded?.();
 await expect(pending).rejects.toThrow('网页或对话已变化');expect(create).not.toHaveBeenCalled();
});
