jest.mock('../remote/useManagedImage', () => ({ useManagedImage: (uri?: string) => ({ uri, active: Boolean(uri), foreground: true, loading: false }) }));
import React from 'react';
import {act,fireEvent,render,waitFor,within} from '@testing-library/react-native';
import {ConversationImageCanvas,type CanvasSessionState} from '../remote/ConversationImageCanvas';
import {conversationImages,imageNotesPrompt,loadImageNotes,normalizedRegion,saveImageNotes,type CanvasImage} from '../remote/conversation-images';
import type {TimelineItem} from '../remote/store';
import {getSetting,setSetting} from '../storage/database';
import {Dimensions,Image} from 'react-native';
import {canvasImageGeometry,fittedCanvasImageView} from '../remote/CanvasImageStage';
import {CANVAS_STORE_KEY,loadCanvasRecord} from '../remote/canvas-session';
const mockSettings=new Map<string,string>();
jest.mock('../storage/database',()=>({getSetting:jest.fn(async(key:string)=>mockSettings.get(key)),setSetting:jest.fn(async(key:string,value:string)=>{mockSettings.set(key,value);})}));
const ref={id:`att_${'a'.repeat(32)}`,mime:'image/png',sha256:'a'.repeat(64),name:'封面.png',width:400,height:300};
const image:CanvasImage={id:'img',messageId:'message-1',name:'封面.png',ref,role:'assistant'};
const originalDimensions={window:Dimensions.get('window'),screen:Dimensions.get('screen')};
beforeEach(async()=>{mockSettings.clear();await act(async()=>{Dimensions.set({window:{...originalDimensions.window,fontScale:1},screen:{...originalDimensions.screen,fontScale:1}});});});
afterEach(async()=>{await act(async()=>{Dimensions.set(originalDimensions);});});
async function canvasAction(view:Awaited<ReturnType<typeof render>>,label:string){
 const menu=['全选','清空选择','只看已选','显示全部','全部图片','聚焦','撤销批注','重做批注'].includes(label)?'画布更多操作':['适应画布','画布原始尺寸','缩小画布图片','放大画布图片'].includes(label)?'画布缩放选项':undefined;
 if(menu&&!view.queryByLabelText(label))await fireEvent.press(view.getByLabelText(menu));
 await fireEvent.press(view.getByLabelText(label));
}

function captureCanvasPress(view:Awaited<ReturnType<typeof render>>,label:string):()=>void{
 let fiber=view.getByLabelText(label).unstable_fiber;
 while(fiber){if(typeof fiber.memoizedProps?.onPress==='function')return fiber.memoizedProps.onPress;fiber=fiber.return;}
 throw Error(`Missing press callback: ${label}`);
}

test.each([320,390,733])('the %i-wide canvas keeps navigation and zoom in its only top toolbar',async width=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(1000,500);return Promise.resolve({width:1000,height:500});});
 const view=await render(<ConversationImageCanvas scopeKey={`single-toolbar-${width}`} images={[{...image,uri:'file:///first'},{...image,id:'second',name:'第二张.png',uri:'file:///second'}]} initialId="img" onRequest={jest.fn()} onCompose={()=>false} onClose={jest.fn()}/>);
 await waitFor(()=>expect(view.getByLabelText('图片修改要求').props.editable).toBe(true));
 await fireEvent(view.getByTestId('conversation-image-canvas'),'layout',{nativeEvent:{layout:{width,height:844}}});
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:200,height:200}}});
 const header=within(view.getByTestId('canvas-header-toolbar'));
 expect(header.getByTestId('canvas-image-toolbar')).toBeTruthy();expect(view.getAllByTestId('canvas-image-toolbar')).toHaveLength(1);
 expect(header.getByLabelText('上一张')).toBeTruthy();expect(header.getByLabelText('下一张')).toBeTruthy();expect(header.getByTestId('canvas-zoom-level')).toHaveTextContent('20%');
 const pages=within(header.getByTestId('canvas-page-controls'));
 expect(pages.getByText('1/2')).toBeTruthy();expect(pages.getByLabelText('上一张')).toBeDisabled();expect(pages.getByLabelText('下一张')).not.toBeDisabled();
 expect(header.getByTestId('canvas-image-title')).toHaveTextContent(width<520?'1/2':'封面.png');
 expect(header.getByTestId('canvas-image-title').props.accessibilityLabel).toContain('第 1 张，共 2 张');
 expect(within(view.getByTestId('canvas-image-viewport')).queryByTestId('canvas-image-toolbar')).toBeNull();
 expect(header.queryByLabelText('放大画布图片')!==null).toBe(width>=390);expect(header.queryByLabelText('撤销批注')!==null).toBe(width>=680);
 expect(header.getByLabelText('画布缩放选项')).toHaveStyle({height:44,width:52});
 await canvasAction(view,'放大画布图片');expect(header.getByTestId('canvas-zoom-level')).toHaveTextContent('25%');expect(view.getByTestId('canvas-focused-image')).toHaveStyle({width:250});
 await fireEvent.press(view.getByLabelText('画布更多操作'));if(width<680){expect(view.getByLabelText('撤销批注')).toBeDisabled();expect(view.getByLabelText('重做批注')).toBeDisabled();}
 await view.unmount();size.mockRestore();
});

test('long page numbers keep their full text while zoom controls move into the menu before the header becomes crowded',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(1000,500);return Promise.resolve({width:1000,height:500});});
 const images=Array.from({length:100},(_,index)=>({...image,id:`image-${index}`,name:`图片 ${index+1}.png`,uri:`file:///image-${index}`}));
 const view=await render(<ConversationImageCanvas scopeKey="long-page-toolbar" images={images} initialId="image-99" onRequest={jest.fn()} onCompose={()=>false} onClose={jest.fn()}/>);
 await waitFor(()=>expect(view.getByLabelText('图片修改要求').props.editable).toBe(true));
 await fireEvent(view.getByTestId('conversation-image-canvas'),'layout',{nativeEvent:{layout:{width:390,height:844}}});
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:200,height:200}}});
 const header=within(view.getByTestId('canvas-header-toolbar'));
 expect(header.getByTestId('canvas-image-title')).toHaveTextContent('100/100');expect(header.getByLabelText('下一张')).toBeDisabled();
 expect(header.queryByLabelText('放大画布图片')).toBeNull();
 await canvasAction(view,'放大画布图片');expect(header.getByTestId('canvas-zoom-level')).toHaveTextContent('25%');
 await fireEvent.press(header.getByLabelText('上一张'));expect(header.getByTestId('canvas-image-title')).toHaveTextContent('99/100');
 expect(header.queryByLabelText('放大画布图片')).toBeNull();
 await fireEvent(view.getByTestId('conversation-image-canvas'),'layout',{nativeEvent:{layout:{width:320,height:844}}});
 expect(header.getByTestId('canvas-image-title')).toHaveTextContent('99/100');expect(header.getByLabelText('画布缩放选项')).toHaveStyle({width:52,height:44});
 await fireEvent(view.getByTestId('conversation-image-canvas'),'layout',{nativeEvent:{layout:{width:410,height:844}}});
 expect(header.getByLabelText('放大画布图片')).toBeTruthy();
 await view.unmount();size.mockRestore();
});

test('single-image header hides page arrows and retained zoom callbacks cannot edit a replacement image',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(1000,500);return Promise.resolve({width:1000,height:500});});
 const first={...image,uri:'file:///first'},second={...image,id:'second',name:'第二张.png',uri:'file:///second'};
 const props={scopeKey:'header-zoom-owner',initialId:image.id,onRequest:jest.fn(),onCompose:()=>false,onClose:jest.fn()};
 const view=await render(<ConversationImageCanvas {...props} images={[first]}/>);
 await fireEvent(view.getByTestId('conversation-image-canvas'),'layout',{nativeEvent:{layout:{width:390,height:844}}});
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:200,height:200}}});
 expect(view.queryByLabelText('上一张')).toBeNull();expect(view.queryByLabelText('下一张')).toBeNull();
 const oldZoom=captureCanvasPress(view,'放大画布图片');
 await view.rerender(<ConversationImageCanvas {...props} images={[first,second]}/>);await fireEvent.press(view.getByLabelText('下一张'));
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:200,height:200}}});
 await act(async()=>{oldZoom();});expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('20%');
 await fireEvent.press(view.getByLabelText('上一张'));await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:200,height:200}}});
 await act(async()=>{oldZoom();});expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('20%');
 await fireEvent.press(view.getByLabelText('放大画布图片'));expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('25%');await view.unmount();size.mockRestore();
});

test('top zoom controls and retained callbacks cannot change the image during an async handoff',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(1000,500);return Promise.resolve({width:1000,height:500});});
 await saveImageNotes('header-handoff',[{id:'note',imageId:image.id,comment:'已确认的修改'}]);
 let finish!:(accepted:boolean)=>void;const compose=jest.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
 const view=await render(<ConversationImageCanvas scopeKey="header-handoff" initialId={image.id} images={[{...image,uri:'file:///first'}]} onRequest={jest.fn()} onCompose={compose} onClose={jest.fn()}/>);
 await waitFor(()=>expect(view.getByText('已确认的修改')).toBeTruthy());
 await fireEvent(view.getByTestId('conversation-image-canvas'),'layout',{nativeEvent:{layout:{width:390,height:844}}});
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:200,height:200}}});
 const oldZoom=captureCanvasPress(view,'放大画布图片');
 await fireEvent.press(view.getByLabelText('添加到对话'));expect(view.getByLabelText('画布缩放选项')).toBeDisabled();expect(view.getByLabelText('放大画布图片')).toBeDisabled();
 await act(async()=>{oldZoom();});expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('20%');
 await act(async()=>{finish(false);});await fireEvent.press(view.getByLabelText('放大画布图片'));expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('25%');
 await view.unmount();size.mockRestore();
});

test('gathers real message and tool images without optimistic duplicates or child-session mixing',()=>{
 const items:TimelineItem[]=[{kind:'message',id:'m',role:'assistant',text:'',final:true,ts:1,attachments:[{...ref,uri:'file:///a'}],images:['file:///a']},
 {kind:'tool',id:'child',parentId:'sub',tool:'other',title:'image',status:'done',ts:2,attachments:[ref]},
 {kind:'message',id:'legacy',role:'assistant',text:'',final:true,ts:3,images:['data:image/png;base64,abc']}];
 const result=conversationImages(items);expect(result).toHaveLength(2);expect(result[0].uri).toBe('file:///a');expect(result[1].id).not.toContain('base64');
});
test('regions are clamped, direction independent and reject invalid/tiny selections',()=>{
 expect(normalizedRegion({x:.8,y:.9},{x:.2,y:.1})).toEqual({x:.2,y:.1,width:.6000000000000001,height:.8});
 expect(normalizedRegion({x:-1,y:-1},{x:2,y:2})).toEqual({x:0,y:0,width:1,height:1});
 expect(normalizedRegion({x:0,y:0},{x:.001,y:.001})).toBeUndefined();expect(normalizedRegion({x:NaN,y:0},{x:1,y:1})).toBeUndefined();
});
test('stored annotations never cross computer/API/session scopes and preserve exact image revision and region',async()=>{
 const note={id:'note',imageId:image.id,comment:'调整标题',region:{x:.1,y:.2,width:.3,height:.4}};
 await saveImageNotes('computer-A/api-1/session-1',[note]);expect(await loadImageNotes('computer-B/api-1/session-1')).toEqual([]);expect(await loadImageNotes('computer-A/api-2/session-1')).toEqual([]);
 expect(await loadImageNotes('computer-A/api-1/session-1')).toEqual([note]);const prompt=imageNotesPrompt([image],[note]);
 expect(prompt).toContain('原消息：message-1');expect(prompt).toContain(ref.id);expect(prompt).toContain(ref.sha256);expect(prompt).toContain('x=0.100');expect(imageNotesPrompt([], [note])).toBe('');
});
test('multi-selection adds explicit annotations to the original draft only after user action',async()=>{
 const compose=jest.fn((_text:string)=>true),close=jest.fn(),second={...image,id:'img2',name:'备选.png'};
 const view=await render(<ConversationImageCanvas scopeKey="canvas-test" images={[image,second]} onRequest={jest.fn()} onCompose={compose} onClose={close}/>);
 await waitFor(()=>expect(view.getByLabelText('图片修改要求')).toBeTruthy());
 await fireEvent.press(view.getByLabelText('选择图片 封面.png'));await fireEvent.press(view.getByLabelText('选择图片 备选.png'));
 await fireEvent.changeText(view.getByLabelText('图片修改要求'),'使用更浅的背景');await fireEvent.press(view.getByLabelText('添加批注'));
 expect(compose).not.toHaveBeenCalled();await fireEvent.press(view.getByLabelText('添加到对话'));expect(compose).toHaveBeenCalledTimes(1);expect(compose.mock.calls[0][0]).toContain('封面.png');expect(compose.mock.calls[0][0]).toContain('备选.png');expect(close).toHaveBeenCalled();
});
test('an unavailable draft keeps notes and the canvas open',async()=>{
 await saveImageNotes('not-ready',[{id:'n',imageId:image.id,comment:'保留'}]);const close=jest.fn();
 const view=await render(<ConversationImageCanvas scopeKey="not-ready" images={[image]} onRequest={jest.fn()} onCompose={()=>false} onClose={close}/>);
 await waitFor(()=>expect(view.getByText('保留')).toBeTruthy());await fireEvent.press(view.getByLabelText('添加到对话'));expect(close).not.toHaveBeenCalled();expect(view.getByText('保留')).toBeTruthy();
});
test('a failed note write does not poison reopening or lose the current in-memory note',async()=>{
 const note={id:'failed-write',imageId:image.id,comment:'保留失败写入的批注'};
 jest.mocked(setSetting).mockRejectedValueOnce(new Error('disk busy'));
 await expect(saveImageNotes('write-failure',[note])).rejects.toThrow('disk busy');
 expect(await loadImageNotes('write-failure')).toEqual([note]);
 await saveImageNotes('write-failure',[note]);expect(await loadImageNotes('write-failure')).toEqual([note]);
});
test('a failed storage read is visible and retry restores the canvas',async()=>{
 jest.mocked(getSetting).mockRejectedValueOnce(new Error('storage unavailable'));
 const view=await render(<ConversationImageCanvas scopeKey="read-failure" images={[image]} onRequest={jest.fn()} onCompose={()=>false} onClose={jest.fn()}/>);
 await waitFor(()=>expect(view.getByText('批注暂时无法读取，请重试。')).toBeTruthy());await fireEvent.press(view.getByLabelText('重新读取批注'));
 await waitFor(()=>expect(view.queryByText('批注暂时无法读取，请重试。')).toBeNull());
});

test('image drafts and regions stay with their image when switching and are never applied to the next image',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(400,300);return Promise.resolve({width:400,height:300});});
 const first={...image,uri:'file:///first'},second={...image,id:'second',name:'备选.png',uri:'file:///second'};
 const compose=jest.fn(()=>true),view=await render(<ConversationImageCanvas scopeKey="image-drafts" images={[first,second]} initialId="img" onRequest={jest.fn()} onCompose={compose} onClose={jest.fn()}/>);
 await waitFor(()=>expect(view.getByLabelText('图片修改要求')).toBeTruthy());
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:400,height:300}}});
 await fireEvent.press(view.getByLabelText('框选区域'));
 await fireEvent(view.getByTestId('image-region-surface'),'responderGrant',{nativeEvent:{locationX:40,locationY:30,pageX:40,pageY:30}});
 await fireEvent(view.getByTestId('image-region-surface'),'responderRelease',{nativeEvent:{locationX:200,locationY:150,pageX:200,pageY:150}});
 await fireEvent.changeText(view.getByLabelText('图片修改要求'),'第一张的标题变小');
 await fireEvent.press(view.getByLabelText('下一张'));expect(view.getByLabelText('图片修改要求').props.value).toBe('');expect(view.queryByTestId('image-region-selection')).toBeNull();
 await fireEvent.changeText(view.getByLabelText('图片修改要求'),'第二张的背景变浅');
 await fireEvent.press(view.getByLabelText('上一张'));expect(view.getByLabelText('图片修改要求').props.value).toBe('第一张的标题变小');expect(view.getByTestId('image-region-selection')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('添加批注'));await fireEvent.press(view.getByLabelText('下一张'));expect(view.getByLabelText('图片修改要求').props.value).toBe('第二张的背景变浅');
 await fireEvent.press(view.getByLabelText('添加批注'));await fireEvent.press(view.getByLabelText('添加到对话'));
 expect(compose.mock.calls).toHaveLength(1);const prompt=(compose.mock.calls[0] as unknown as [string])[0];expect(prompt).toContain('x=0.100');expect(prompt).toContain('第一张的标题变小');expect(prompt).toContain('第二张的背景变浅');
 size.mockRestore();
});

test('selection, drafts and saved notes cannot silently transfer to a new revision of the same file',async()=>{
 const first={...image,revision:'v1'},second={...image,revision:'v2'};
 const props={scopeKey:'revision-change',onRequest:jest.fn(),onCompose:jest.fn(()=>true),onClose:jest.fn()};
 const view=await render(<ConversationImageCanvas {...props} images={[first]}/>);
 await waitFor(()=>expect(view.getByLabelText('图片修改要求')).toBeTruthy());
 await canvasAction(view,'全选');await fireEvent.changeText(view.getByLabelText('图片修改要求'),'只改旧版本');await fireEvent.press(view.getByLabelText('添加批注'));
 await fireEvent.press(view.getByLabelText('查看图片 封面.png'));await fireEvent.changeText(view.getByLabelText('图片修改要求'),'尚未保存的旧版本草稿');
 await view.rerender(<ConversationImageCanvas {...props} images={[second]}/>);
 expect(view.getByLabelText('图片修改要求').props.value).toBe('');expect(view.getByLabelText('添加到对话')).toBeDisabled();expect(view.getByText('1 · 原图片或版本不可用')).toBeTruthy();
 await canvasAction(view,'全部图片');expect(view.getByText('已选择 0 / 1')).toBeTruthy();
 expect(imageNotesPrompt([second],await loadImageNotes('revision-change'))).toBe('');
});

test('all/selected-only/clear keep selection accurate as images disappear',async()=>{
 const second={...image,id:'second',name:'备选.png'},props={scopeKey:'selection-tools',onRequest:jest.fn(),onCompose:()=>true,onClose:jest.fn()};
 const view=await render(<ConversationImageCanvas {...props} images={[image,second]}/>);
 await canvasAction(view,'全选');expect(view.getByText('已选择 2 / 2')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('选择图片 备选.png'));await canvasAction(view,'只看已选');
 expect(view.queryByLabelText('查看图片 备选.png')).toBeNull();expect(view.getByLabelText('查看图片 封面.png')).toBeTruthy();
 await view.rerender(<ConversationImageCanvas {...props} images={[second]}/>);expect(view.getByText('已选择 0 / 1')).toBeTruthy();
 await canvasAction(view,'显示全部');await canvasAction(view,'全选');await canvasAction(view,'清空选择');expect(view.getByText('已选择 0 / 1')).toBeTruthy();
});

test('saved numbered regions can be located, edited and deleted without losing an unsaved image draft',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(400,300);return Promise.resolve({width:400,height:300});});
 await saveImageNotes('edit-regions',[{id:'note',imageId:image.id,comment:'原来的批注',region:{x:.2,y:.2,width:.4,height:.3}}]);
 const view=await render(<ConversationImageCanvas scopeKey="edit-regions" images={[{...image,uri:'file:///image'}]} onRequest={jest.fn()} onCompose={()=>false} onClose={jest.fn()}/>);
 await waitFor(()=>expect(view.getByText('原来的批注')).toBeTruthy());
 await fireEvent.press(view.getByLabelText('定位批注 1'));expect(view.getByLabelText('定位图片批注 1')).toBeTruthy();expect(view.getByTestId('image-region-selection')).toBeTruthy();
 await fireEvent.changeText(view.getByLabelText('图片修改要求'),'尚未添加的另一条');await fireEvent.press(view.getByLabelText('编辑批注 1'));
 expect(view.getByLabelText('图片修改要求').props.value).toBe('原来的批注');await fireEvent.changeText(view.getByLabelText('图片修改要求'),'已修改的批注');await fireEvent.press(view.getByLabelText('保存批注'));
 expect(view.getByText('已修改的批注')).toBeTruthy();expect(view.getByLabelText('图片修改要求').props.value).toBe('尚未添加的另一条');
 const [saved]=await loadImageNotes('edit-regions');expect(saved.comment).toBe('已修改的批注');expect(saved.region).toEqual({x:.2,y:.2,width:.4,height:.3});
 await fireEvent.press(view.getByLabelText('删除批注 1'));expect(view.queryByLabelText('定位图片批注 1')).toBeNull();size.mockRestore();
});

test('zoom geometry fits wide/tall images and bounds pan without drifting into letterbox space',()=>{
 const stage={width:400,height:400};
 expect(canvasImageGeometry({width:800,height:200},stage,fittedCanvasImageView)).toMatchObject({zoom:.5,width:400,height:100,left:0,top:150});
 expect(canvasImageGeometry({width:800,height:200},stage,{zoom:1,x:999,y:999})).toMatchObject({zoom:1,x:200,y:0});
 expect(canvasImageGeometry({width:100,height:1000},stage,{zoom:1,x:-999,y:-999})).toMatchObject({x:0,y:-300});
 expect(canvasImageGeometry({width:400,height:300},stage,{zoom:100,x:0,y:0}).zoom).toBe(8);
});

test('canvas zoom controls use actual pixels, fit resets position, and each image remembers its view',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(800,600);return Promise.resolve({width:800,height:600});});
 const view=await render(<ConversationImageCanvas scopeKey="zoom-state" images={[{...image,uri:'file:///first'},{...image,id:'second',uri:'file:///second'}]} initialId="img" onRequest={jest.fn()} onCompose={()=>false} onClose={jest.fn()}/>);
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:400,height:300}}});
 expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('50%');await canvasAction(view,'画布原始尺寸');expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('100%');
 await fireEvent.press(view.getByLabelText('放大画布图片'));expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('125%');
 await fireEvent.press(view.getByLabelText('下一张'));await fireEvent.press(view.getByLabelText('上一张'));expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('125%');
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:400,height:300}}});await canvasAction(view,'适应画布');expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('50%');size.mockRestore();
});

test('returning through the single image viewer restores canvas session state without crossing scope',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(800,600);return Promise.resolve({width:800,height:600});});
 const sessionStateRef:{current:CanvasSessionState|undefined}={current:undefined};
 const props={scopeKey:'reopen-canvas',sessionStateRef,images:[{...image,uri:'file:///first'},{...image,id:'second',name:'备选.png',uri:'file:///second'}],onRequest:jest.fn(),onCompose:()=>false,onClose:jest.fn()};
 const first=await render(<ConversationImageCanvas {...props}/>);
 await canvasAction(first,'全选');await canvasAction(first,'只看已选');await fireEvent.press(first.getByLabelText('查看图片 封面.png'));
 await fireEvent.changeText(first.getByLabelText('图片修改要求'),'返回图片后还要继续编辑');await canvasAction(first,'画布原始尺寸');
 await first.unmount();
 const reopened=await render(<ConversationImageCanvas {...props}/>);
 expect(reopened.getByLabelText('图片修改要求').props.value).toBe('返回图片后还要继续编辑');expect(reopened.getByTestId('canvas-zoom-level')).toHaveTextContent('100%');
 await canvasAction(reopened,'全部图片');expect(reopened.getByText('已选择 2 / 2')).toBeTruthy();await fireEvent.press(reopened.getByLabelText('画布更多操作'));expect(reopened.getByLabelText('显示全部')).toBeTruthy();
 await reopened.rerender(<ConversationImageCanvas {...props} scopeKey="another-computer-session"/>);
 expect(reopened.getByLabelText('图片修改要求').props.value).toBe('');expect(reopened.getByText('已选择 0 / 2')).toBeTruthy();await fireEvent.press(reopened.getByLabelText('画布更多操作'));expect(reopened.getByLabelText('只看已选')).toBeTruthy();
 expect(sessionStateRef.current?.scopeKey).toBe('another-computer-session');size.mockRestore();
});

test('panning is bounded and two-finger gestures resize without producing an accidental region',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(800,600);return Promise.resolve({width:800,height:600});});
 const view=await render(<ConversationImageCanvas scopeKey="canvas-gestures" images={[{...image,uri:'file:///image'}]} initialId="img" onRequest={jest.fn()} onCompose={()=>false} onClose={jest.fn()}/>);
 await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:400,height:300}}});await canvasAction(view,'画布原始尺寸');
 await fireEvent(view.getByTestId('image-region-surface'),'responderGrant',{nativeEvent:{locationX:100,locationY:100,pageX:100,pageY:100,touches:[]}});
 await fireEvent(view.getByTestId('image-region-surface'),'responderMove',{nativeEvent:{locationX:900,locationY:900,pageX:900,pageY:900,touches:[]}});
 expect(view.getByTestId('canvas-focused-image')).toHaveStyle({left:0,top:0});
 await fireEvent(view.getByTestId('image-region-surface'),'responderGrant',{nativeEvent:{locationX:100,locationY:100,pageX:100,pageY:100,touches:[{pageX:100,pageY:100},{pageX:200,pageY:100}]}});
 await fireEvent(view.getByTestId('image-region-surface'),'responderMove',{nativeEvent:{locationX:100,locationY:100,pageX:100,pageY:100,touches:[{pageX:100,pageY:100},{pageX:300,pageY:100}]}});
 expect(view.getByTestId('canvas-zoom-level')).toHaveTextContent('200%');expect(view.queryByTestId('image-region-selection')).toBeNull();size.mockRestore();
});

test('async handoff includes unique source images, blocks duplicate submits and preserves unsent notes',async()=>{
 const other={...image,id:'other',name:'其他.png'};
 await saveImageNotes('async-handoff',[{id:'one',imageId:image.id,comment:'第一条'},{id:'two',imageId:image.id,comment:'同一图片第二条'},{id:'other-note',imageId:other.id,comment:'尚未载入的图片'}]);
 let finish!:(value:boolean)=>void;
 const compose=jest.fn((_text:string,_images:CanvasImage[])=>new Promise<boolean>(resolve=>{finish=resolve;})),close=jest.fn();
 const submitting=jest.fn(),props={scopeKey:'async-handoff',onRequest:jest.fn(),onCompose:compose,onClose:close,onSubmittingChange:submitting};
 const view=await render(<ConversationImageCanvas {...props} images={[image]}/>);
 await waitFor(()=>expect(view.getByText('第一条')).toBeTruthy());
 await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('添加到对话'));
 expect(compose).toHaveBeenCalledTimes(1);expect(compose.mock.calls[0][1]).toEqual([image]);expect(compose.mock.calls[0][0]).toContain('同一图片第二条');
 expect(view.getByLabelText('添加到对话')).toBeDisabled();expect(view.getByLabelText('返回图片')).toBeDisabled();expect(submitting).toHaveBeenLastCalledWith(true);expect(view.getByLabelText('编辑批注 1')).toBeDisabled();expect(view.getByLabelText('删除批注 1')).toBeDisabled();expect(view.getByLabelText('图片修改要求').props.editable).toBe(false);
 await view.rerender(<ConversationImageCanvas {...props} images={[image,other]}/>);
 await act(async()=>{finish(true);});await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));
 expect(await loadImageNotes('async-handoff')).toEqual([{id:'other-note',imageId:other.id,comment:'尚未载入的图片'}]);expect(submitting).toHaveBeenLastCalledWith(false);
});

test('a rejected or declined asynchronous image handoff keeps notes available for retry',async()=>{
 await saveImageNotes('async-failed',[{id:'one',imageId:image.id,comment:'不能丢失'}]);
 const compose=jest.fn<Promise<boolean>,[string,CanvasImage[]]>().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('图片读取失败')).mockResolvedValueOnce(true),close=jest.fn();
 const view=await render(<ConversationImageCanvas scopeKey="async-failed" images={[image]} onRequest={jest.fn()} onCompose={compose} onClose={close}/>);
 await waitFor(()=>expect(view.getByText('不能丢失')).toBeTruthy());
 await fireEvent.press(view.getByLabelText('添加到对话'));await waitFor(()=>expect(view.getByText('图片和批注尚未加入对话，已保留批注，请重试。')).toBeTruthy());
 expect(close).not.toHaveBeenCalled();expect(await loadImageNotes('async-failed')).toHaveLength(1);expect(view.getByLabelText('添加到对话')).not.toBeDisabled();
 await fireEvent.press(view.getByLabelText('添加到对话'));await waitFor(()=>expect(view.getByText('未能添加到对话：图片读取失败')).toBeTruthy());
 expect(close).not.toHaveBeenCalled();expect(await loadImageNotes('async-failed')).toHaveLength(1);
 await fireEvent.press(view.getByLabelText('添加到对话'));await waitFor(()=>expect(close).toHaveBeenCalledTimes(1));expect(await loadImageNotes('async-failed')).toEqual([]);
});

test('an async result after scope unmount cannot clear saved notes or close the replacement conversation',async()=>{
 const oldNote={id:'one',imageId:image.id,comment:'原会话的批注'},newNote={id:'two',imageId:image.id,comment:'新会话的批注'};
 await saveImageNotes('async-old',[oldNote]);await saveImageNotes('async-new',[newNote]);
 let finish!:(value:boolean)=>void;
 const compose=jest.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;})),close=jest.fn(),submitting=jest.fn(),props={images:[image],onRequest:jest.fn(),onCompose:compose,onClose:close,onSubmittingChange:submitting};
 const view=await render(<ConversationImageCanvas {...props} scopeKey="async-old"/>);
 await waitFor(()=>expect(view.getByText('原会话的批注')).toBeTruthy());await fireEvent.press(view.getByLabelText('添加到对话'));
 await view.rerender(<ConversationImageCanvas {...props} scopeKey="async-new"/>);await waitFor(()=>expect(view.getByText('新会话的批注')).toBeTruthy());
 await act(async()=>{finish(true);});
 expect(close).not.toHaveBeenCalled();expect(await loadImageNotes('async-old')).toEqual([oldNote]);expect(await loadImageNotes('async-new')).toEqual([newNote]);expect(view.getByLabelText('添加到对话')).not.toBeDisabled();expect(submitting).toHaveBeenLastCalledWith(false);
});

test('undo and redo preserve annotation identity, numbering and versions through add, edit and delete',async()=>{
 const props={scopeKey:'canvas-history',images:[{...image,revision:'old'}],onRequest:jest.fn(),onCompose:()=>false,onClose:jest.fn()};
 const view=await render(<ConversationImageCanvas {...props}/>);
 await waitFor(()=>expect(view.getByLabelText('图片修改要求').props.editable).toBe(true));await canvasAction(view,'全选');
 await fireEvent.changeText(view.getByLabelText('图片修改要求'),'第一条');await fireEvent.press(view.getByLabelText('添加批注'));
 await fireEvent.changeText(view.getByLabelText('图片修改要求'),'第二条');await fireEvent.press(view.getByLabelText('添加批注'));
 const original=(await loadCanvasRecord('canvas-history')).notes;
 await fireEvent.press(view.getByLabelText('删除批注 1'));expect(view.getByLabelText('编辑批注 2')).toBeTruthy();expect(view.queryByLabelText('编辑批注 1')).toBeNull();
 await fireEvent.press(view.getByLabelText('撤销批注'));expect(view.getByLabelText('编辑批注 1')).toBeTruthy();expect((await loadCanvasRecord('canvas-history')).notes).toEqual(original);
 await fireEvent.press(view.getByLabelText('重做批注'));expect(view.queryByLabelText('编辑批注 1')).toBeNull();
 await fireEvent.press(view.getByLabelText('编辑批注 2'));await fireEvent.changeText(view.getByLabelText('图片修改要求'),'第二条已修改');await fireEvent.press(view.getByLabelText('保存批注'));
 await fireEvent.press(view.getByLabelText('撤销批注'));expect(view.getByText('第二条')).toBeTruthy();expect(view.queryByText('第二条已修改')).toBeNull();
 await fireEvent.press(view.getByLabelText('重做批注'));expect(view.getByText('第二条已修改')).toBeTruthy();
 await view.rerender(<ConversationImageCanvas {...props} images={[{...image,revision:'new'}]}/>);await fireEvent.press(view.getByLabelText('撤销批注'));
 expect(view.getByLabelText('添加到对话')).toBeDisabled();expect(view.getByLabelText('定位批注 2')).toBeDisabled();
});

test('successful handoff retires submitted annotations from both undo directions and restart storage',async()=>{
 const props={scopeKey:'retired-history',images:[image],onRequest:jest.fn(),onCompose:()=>true,onClose:jest.fn()};
 const view=await render(<ConversationImageCanvas {...props}/>);
 await waitFor(()=>expect(view.getByLabelText('图片修改要求').props.editable).toBe(true));await canvasAction(view,'全选');await fireEvent.changeText(view.getByLabelText('图片修改要求'),'已加入的批注');await fireEvent.press(view.getByLabelText('添加批注'));
 await fireEvent.press(view.getByLabelText('编辑批注 1'));await fireEvent.changeText(view.getByLabelText('图片修改要求'),'改过的批注');await fireEvent.press(view.getByLabelText('保存批注'));await fireEvent.press(view.getByLabelText('撤销批注'));
 expect(view.getByLabelText('重做批注')).not.toBeDisabled();await fireEvent.press(view.getByLabelText('添加到对话'));await waitFor(()=>expect(props.onClose).toHaveBeenCalled());
 expect(view.getByLabelText('撤销批注')).toBeDisabled();expect(view.getByLabelText('重做批注')).toBeDisabled();await view.unmount();
 const record=await loadCanvasRecord('retired-history');expect(record.notes).toEqual([]);expect(record.history.past.flat()).toEqual([]);expect(record.history.future.flat()).toEqual([]);
 const reopened=await render(<ConversationImageCanvas {...props}/>);await waitFor(()=>expect(reopened.getByLabelText('图片修改要求').props.editable).toBe(true));expect(reopened.getByLabelText('添加到对话')).toBeDisabled();expect(reopened.getByLabelText('重做批注')).toBeDisabled();
});

test('without an in-memory session ref, closing and reopening restores text, region, selection, focus and zoom',async()=>{
 const size=jest.spyOn(Image,'getSize').mockImplementation((_uri,success)=>{success(400,300);return Promise.resolve({width:400,height:300});});
 const props={scopeKey:'durable-canvas',images:[{...image,revision:'v1',uri:'file:///image'}],onRequest:jest.fn(),onCompose:()=>false,onClose:jest.fn()};
 const view=await render(<ConversationImageCanvas {...props}/>);await waitFor(()=>expect(view.getByLabelText('图片修改要求').props.editable).toBe(true));
 await canvasAction(view,'全选');await canvasAction(view,'只看已选');await fireEvent.press(view.getByLabelText('查看图片 封面.png'));await fireEvent(view.getByTestId('canvas-image-viewport'),'layout',{nativeEvent:{layout:{width:400,height:300}}});
 await fireEvent.press(view.getByLabelText('框选区域'));await fireEvent(view.getByTestId('image-region-surface'),'responderGrant',{nativeEvent:{locationX:40,locationY:30,pageX:40,pageY:30}});await fireEvent(view.getByTestId('image-region-surface'),'responderRelease',{nativeEvent:{locationX:200,locationY:150,pageX:200,pageY:150}});
 await fireEvent.changeText(view.getByLabelText('图片修改要求'),'重启后继续修改这个区域');await canvasAction(view,'画布原始尺寸');await fireEvent.press(view.getByLabelText('放大画布图片'));await view.unmount();
 await loadCanvasRecord('durable-canvas');expect(mockSettings.get(CANVAS_STORE_KEY)).toContain('重启后继续修改这个区域');
 const reopened=await render(<ConversationImageCanvas {...props}/>);await waitFor(()=>expect(reopened.getByLabelText('图片修改要求').props.value).toBe('重启后继续修改这个区域'));expect(reopened.getByTestId('canvas-zoom-level')).toHaveTextContent('125%');expect(reopened.getByTestId('image-region-selection')).toBeTruthy();
 await canvasAction(reopened,'全部图片');expect(reopened.getByText('已选择 1 / 1')).toBeTruthy();await fireEvent.press(reopened.getByLabelText('画布更多操作'));expect(reopened.getByLabelText('显示全部')).toBeTruthy();await reopened.unmount();await loadCanvasRecord('durable-canvas');
 const revised=await render(<ConversationImageCanvas {...props} images={[{...props.images[0],revision:'v2'}]}/>);await waitFor(()=>expect(revised.getByLabelText('图片修改要求').props.editable).toBe(true));expect(revised.getByLabelText('图片修改要求').props.value).toBe('');expect(revised.getByText('已选择 0 / 1')).toBeTruthy();size.mockRestore();
});

test('late storage load cannot overwrite the replacement scope or accept input before recovery finishes',async()=>{
 const first=await loadCanvasRecord('late-old'),second=await loadCanvasRecord('late-new');
 const {saveCanvasRecord}=require('../remote/canvas-session') as typeof import('../remote/canvas-session');
 const key=JSON.stringify([image.id,ref.sha256]);
 await saveCanvasRecord({...first,session:{...first.session,initialized:true,selected:[key],drafts:{[`batch:${JSON.stringify([key])}`]:{comment:'旧草稿'}}}});
 await saveCanvasRecord({...second,session:{...second.session,initialized:true,selected:[key],drafts:{[`batch:${JSON.stringify([key])}`]:{comment:'新草稿'}}}});
 const stored=mockSettings.get(CANVAS_STORE_KEY)!;let resolve!:(value:string)=>void;jest.mocked(getSetting).mockImplementationOnce(()=>new Promise<string>(done=>{resolve=done;}));
 const props={images:[image],onRequest:jest.fn(),onCompose:()=>false,onClose:jest.fn()};
 const view=await render(<ConversationImageCanvas {...props} scopeKey="late-old"/>);expect(view.getByLabelText('图片修改要求').props.editable).toBe(false);await fireEvent.press(view.getByLabelText('画布更多操作'));expect(view.getByLabelText('全选')).toBeDisabled();
 await view.rerender(<ConversationImageCanvas {...props} scopeKey="late-new"/>);await waitFor(()=>expect(view.getByLabelText('图片修改要求').props.value).toBe('新草稿'));
 await act(async()=>{resolve(stored);});expect(view.getByLabelText('图片修改要求').props.value).toBe('新草稿');
});

test('failed draft persistence remains visible and retry saves the same pending work',async()=>{
 const props={scopeKey:'draft-write-retry',images:[image],initialId:image.id,onRequest:jest.fn(),onCompose:()=>false,onClose:jest.fn()};
 const view=await render(<ConversationImageCanvas {...props}/>);await waitFor(()=>expect(view.getByLabelText('图片修改要求').props.editable).toBe(true));
 const original=jest.mocked(setSetting).getMockImplementation()!;jest.mocked(setSetting).mockRejectedValue(new Error('disk busy'));
 await fireEvent.changeText(view.getByLabelText('图片修改要求'),'保存失败也不能丢失');await waitFor(()=>expect(view.getByText('画布更改尚未保存到本机，请重试保存。')).toBeTruthy());
 expect(view.getByLabelText('图片修改要求').props.value).toBe('保存失败也不能丢失');jest.mocked(setSetting).mockImplementation(original);await fireEvent.press(view.getByLabelText('重试保存批注'));await waitFor(()=>expect(view.queryByText('画布更改尚未保存到本机，请重试保存。')).toBeNull());
 await view.unmount();const record=await loadCanvasRecord('draft-write-retry');expect(Object.values(record.session.drafts).some(draft=>draft.comment==='保存失败也不能丢失')).toBe(true);
});

test('after accepted handoff a storage failure cannot resend or undo submitted annotations, and save retry finishes retirement',async()=>{
 const original=jest.mocked(setSetting).getMockImplementation()!,close=jest.fn();
 const compose=jest.fn(()=>{jest.mocked(setSetting).mockRejectedValue(new Error('disk full'));return true;});
 const view=await render(<ConversationImageCanvas scopeKey="accepted-save-failure" images={[image]} onRequest={jest.fn()} onCompose={compose} onClose={close}/>);
 await waitFor(()=>expect(view.getByLabelText('图片修改要求').props.editable).toBe(true));await canvasAction(view,'全选');await fireEvent.changeText(view.getByLabelText('图片修改要求'),'已回填不可重复');await fireEvent.press(view.getByLabelText('添加批注'));
 await fireEvent.press(view.getByLabelText('添加到对话'));await waitFor(()=>expect(view.getByText('图片和批注已加入对话，画布状态尚未保存。请重试保存后再关闭。')).toBeTruthy());
 expect(compose).toHaveBeenCalledTimes(1);expect(close).not.toHaveBeenCalled();expect(view.getByLabelText('添加到对话')).toBeDisabled();expect(view.getByLabelText('撤销批注')).toBeDisabled();
 jest.mocked(setSetting).mockImplementation(original);await fireEvent.press(view.getByLabelText('重试保存批注'));await waitFor(()=>expect(view.queryByText('画布更改尚未保存到本机，请重试保存。')).toBeNull());
 expect(compose).toHaveBeenCalledTimes(1);const record=await loadCanvasRecord('accepted-save-failure');expect(record.notes).toEqual([]);expect(record.history.past.flat()).toEqual([]);expect(record.history.future.flat()).toEqual([]);
});
