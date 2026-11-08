import React from 'react';
import {Pressable,Text,View} from 'react-native';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {useConversationOutputs} from '../remote/ConversationOutputLibrary';

let mockCanvas:any,mockViewer:any,mockImageViewer:any,mockOutputs:any;
const mockPrepareImages=jest.fn();
jest.mock('../remote/canvas-image-input',()=>({prepareCanvasImageInput:(...args:any[])=>mockPrepareImages(...args)}));
jest.mock('../remote/ConversationImageCanvas',()=>{const React=require('react'),{View,Text,Pressable}=require('react-native');return {ConversationImageCanvas:(props:any)=>{mockCanvas=props;return <View><Text>图片画布网格</Text><Pressable accessibilityRole="button" accessibilityLabel="读取文件图片" onPress={()=>props.onLoadImage(props.images.find((image:any)=>image.path))}/><Pressable accessibilityRole="button" accessibilityLabel="返回图片" onPress={props.onClose}/></View>;}};});
jest.mock('../remote/thread-extras',()=>{const React=require('react'),{View,Text,Pressable}=require('react-native');return {ImageViewer:(props:any)=>{mockImageViewer=props;return <View><Text>单图查看器</Text><Text>{props.uri}</Text><Pressable accessibilityRole="button" accessibilityLabel="打开图片画布" onPress={props.onOpenCanvas}/><Pressable accessibilityRole="button" accessibilityLabel="关闭预览" onPress={props.onClose}/></View>;}};});
jest.mock('../components/ArtifactViewer',()=>{const React=require('react'),{Text}=require('react-native');return {ArtifactViewer:(props:any)=>{mockViewer=props;return <Text>文件预览</Text>;}};});
jest.mock('../components/ui',()=>({Sheet:({children}:any)=>children,showToast:jest.fn()}));
jest.mock('../remote/conversation-artifacts',()=>({captureConversationArtifacts:jest.fn()}));

const uri='file:///message-cover.png';
const timeline:any[]=[{kind:'message',id:'m',role:'assistant',text:'生成封面',final:true,ts:1,images:[uri]}];
const first={id:'artifact_x',path:'cover.png',name:'cover.png',kind:'image',mime:'image/png',revision:'a'.repeat(64),size:30,updatedAt:1};
const second={...first,revision:'b'.repeat(64),updatedAt:2};
let listing=first;
const service={list:jest.fn(async()=>({artifacts:[listing]})),read:jest.fn(async()=>({artifact:listing,encoding:'base64',content:'AA=='})),save:jest.fn(),dispose:jest.fn()};
const runtime:any={captureArtifacts:jest.fn(()=>service)};
const compose=jest.fn((_text:string)=>true);
const imageCompose=jest.fn(async(_text:string,_images:readonly any[])=>true);
function Screen({scope='A',generation='1',items=timeline}:{scope?:string;generation?:string;items?:any[]}){
 const outputs=useConversationOutputs({scopeKey:scope,generationKey:generation,active:true,items,available:true,writable:true,runtime,selection:{deviceId:scope,agentId:'codex',sessionKey:'codex:one',surface:'cli'},requestAttachment:jest.fn(),onCompose:compose,onComposeImages:imageCompose,isCurrent:()=>true});mockOutputs=outputs;
 return <View>{outputs.button}<Pressable accessibilityLabel="测试：读取文件产物" onPress={outputs.openLibrary}/><Pressable accessibilityLabel="测试：点击消息图片" onPress={()=>outputs.openImage(uri)}/>{outputs.panel}</View>;
}
beforeEach(()=>{jest.clearAllMocks();mockPrepareImages.mockResolvedValue([{uri,base64:'Ynl0ZXM=',mime:'image/png',width:10,height:10}]);listing=first;mockCanvas=undefined;mockViewer=undefined;mockImageViewer=undefined;mockOutputs=undefined;});

test('image annotations pass actual prepared image bytes to their original draft and never fall back to text',async()=>{
 const view=await render(<Screen/>);await fireEvent.press(view.getByLabelText('测试：点击消息图片'));await fireEvent.press(view.getByLabelText('打开图片画布'));
 const sourceImages=mockCanvas.images.filter((image:any)=>image.uri===uri);
 await act(async()=>{expect(await mockCanvas.onCompose('调整标题',sourceImages)).toBe(true);});
 expect(imageCompose).toHaveBeenCalledWith('调整标题',[expect.objectContaining({base64:'Ynl0ZXM='})]);expect(compose).not.toHaveBeenCalled();
 mockPrepareImages.mockRejectedValueOnce(new Error('原图未读取完整'));
 await act(async()=>{await expect(mockCanvas.onCompose('保留批注',sourceImages)).rejects.toThrow('原图未读取完整');});
 expect(imageCompose).toHaveBeenCalledTimes(1);
});

test('changing the source while image bytes are preparing cannot append to the replacement draft',async()=>{
 let finish!:(images:any[])=>void;mockPrepareImages.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const view=await render(<Screen/>);await fireEvent.press(view.getByLabelText('测试：点击消息图片'));await fireEvent.press(view.getByLabelText('打开图片画布'));
 const result=mockCanvas.onCompose('旧来源批注',mockCanvas.images);const caught=result.catch((error:Error)=>error.message);
 await view.rerender(<Screen scope="B"/>);await act(async()=>finish([]));
 expect(await caught).toMatch(/已切换/);expect(imageCompose).not.toHaveBeenCalled();
});

test('no permanent canvas entry is rendered, and ordinary file listing has no image-canvas shortcut',async()=>{
 const view=await render(<Screen/>);expect(mockOutputs.button).toBeNull();expect(view.queryByLabelText('查看对话产物与图片画布')).toBeNull();expect(view.queryByLabelText('打开图片画布')).toBeNull();
 await fireEvent.press(view.getByLabelText('测试：读取文件产物'));await waitFor(()=>expect(view.getByText('cover.png')).toBeTruthy());expect(view.queryByLabelText('打开图片画布')).toBeNull();
});

test('message images first open the existing single-image viewer, then its canvas opens the whole grid and returns to the original image',async()=>{
 const view=await render(<Screen/>);await fireEvent.press(view.getByLabelText('测试：点击消息图片'));expect(view.getByText('单图查看器')).toBeTruthy();expect(mockImageViewer.uri).toBe(uri);expect(mockCanvas).toBeUndefined();
 await fireEvent.press(view.getByLabelText('打开图片画布'));await waitFor(()=>expect(view.getByText('图片画布网格')).toBeTruthy());expect(mockCanvas.initialId).toBeUndefined();expect(mockCanvas.images.some((image:any)=>image.uri===uri)).toBe(true);
 await fireEvent.press(view.getByLabelText('返回图片'));expect(view.getByText('单图查看器')).toBeTruthy();expect(mockImageViewer.uri).toBe(uri);expect(view.queryByText('图片画布网格')).toBeNull();
 await fireEvent.press(view.getByLabelText('关闭预览'));expect(view.queryByText('单图查看器')).toBeNull();expect(view.queryByTestId('conversation-output-library')).toBeNull();expect(compose).not.toHaveBeenCalled();
});

test('artifact image payloads with a changed revision are rejected rather than cached under old metadata',async()=>{
 const view=await render(<Screen/>);await fireEvent.press(view.getByLabelText('测试：点击消息图片'));await waitFor(()=>expect(service.list).toHaveBeenCalled());await fireEvent.press(view.getByLabelText('打开图片画布'));
 await waitFor(()=>expect(mockCanvas.images.some((image:any)=>image.path===first.path)).toBe(true));listing=second;
 await fireEvent.press(view.getByLabelText('读取文件图片'));await waitFor(()=>expect(service.read).toHaveBeenCalled());
 expect(mockCanvas.images.find((image:any)=>image.path===first.path).uri).toBeUndefined();
 listing=first;await fireEvent.press(view.getByLabelText('读取文件图片'));await waitFor(()=>expect(mockCanvas.images.find((image:any)=>image.path===first.path).uri).toBe('data:image/png;base64,AA=='));
});

test('switching computers closes previews and rejects retained viewer and file annotation callbacks',async()=>{
 const view=await render(<Screen/>);await fireEvent.press(view.getByLabelText('测试：点击消息图片'));const oldImage=mockImageViewer;
 await view.rerender(<Screen scope="B"/>);expect(view.queryByText('单图查看器')).toBeNull();expect(service.dispose).toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('测试：点击消息图片'));await act(async()=>{oldImage.onOpenCanvas();oldImage.onClose();});expect(view.getByText('单图查看器')).toBeTruthy();expect(view.queryByText('图片画布网格')).toBeNull();
 await fireEvent.press(view.getByLabelText('关闭预览'));await fireEvent.press(view.getByLabelText('测试：读取文件产物'));await waitFor(()=>expect(view.getByLabelText('打开产物 cover.png')).toBeTruthy());await fireEvent.press(view.getByLabelText('打开产物 cover.png'));
 const annotate=mockViewer.onAnnotate;await view.rerender(<Screen scope="C"/>);await act(async()=>annotate({artifactId:first.id,path:first.path,name:first.name,revision:first.revision,comment:'旧电脑内容'}));expect(compose).not.toHaveBeenCalled();
});

test('an earlier generation cannot reopen a canvas or close a newer preview even within the same conversation',async()=>{
 const view=await render(<Screen/>);const oldOpen=mockOutputs.openImage;await fireEvent.press(view.getByLabelText('测试：点击消息图片'));const oldViewer=mockImageViewer;
 await view.rerender(<Screen generation="2"/>);expect(view.queryByText('单图查看器')).toBeNull();await act(async()=>{expect(oldOpen(uri)).toBe(false);oldViewer.onOpenCanvas();});expect(view.queryByText('图片画布网格')).toBeNull();
 await fireEvent.press(view.getByLabelText('测试：点击消息图片'));await act(async()=>oldViewer.onClose());expect(view.getByText('单图查看器')).toBeTruthy();
});

test('a current file annotation preserves source path and revision in the original draft',async()=>{
 const view=await render(<Screen/>);await fireEvent.press(view.getByLabelText('测试：读取文件产物'));await waitFor(()=>expect(view.getByLabelText('打开产物 cover.png')).toBeTruthy());await fireEvent.press(view.getByLabelText('打开产物 cover.png'));
 await act(async()=>mockViewer.onAnnotate({artifactId:first.id,path:first.path,name:first.name,revision:first.revision,comment:'调整字体',page:2}));
 expect(compose).toHaveBeenCalledWith(expect.stringContaining('文件：cover.png'));expect(compose).toHaveBeenCalledWith(expect.stringContaining(first.revision));expect(compose).toHaveBeenCalledWith(expect.stringContaining('第 2 页'));expect(view.queryByText('文件预览')).toBeNull();
});
