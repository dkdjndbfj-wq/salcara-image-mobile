import React from 'react';
import {act, fireEvent, render} from '@testing-library/react-native';
import {RemoteComputerPreview} from '../remote/RemoteComputerPreview';
import {ArtifactAnnotationProvider} from '../remote/ArtifactAnnotationContext';
import {cropBrowserAnnotation} from '../remote/browser-annotation-image';
jest.mock('../remote/browser-annotation-image',()=>({cropBrowserAnnotation:jest.fn()}));
const mockOpen=jest.fn(), mockFrame=jest.fn(), mockInput=jest.fn(), mockDispose=jest.fn(),mockDownload=jest.fn();
const mockPick=jest.fn(),mockSave=jest.fn();
jest.mock('../remote/preview-transfer',()=>({...jest.requireActual('../remote/preview-transfer-bytes'),pickPreviewUpload:(...args:unknown[])=>mockPick(...args),savePreviewDownload:(...args:unknown[])=>mockSave(...args)}));
jest.mock('expo/fetch',()=>({fetch:jest.fn()}));
jest.mock('../remote/workspace-preview',()=>({...jest.requireActual('../remote/workspace-preview'),captureComputerPreview:()=>({open:mockOpen,frame:mockFrame,input:mockInput,download:mockDownload,dispose:mockDispose})}));
const selection={deviceId:'pc',sessionKey:'codex:one',agentId:'codex',surface:'cli' as const,cwd:'C:/project'};
const frame={pageId:'test-page-12345',url:'http://localhost:3000/',width:640,height:640,nextSequence:1,imageBase64:'/9j/AA=='};
beforeEach(()=>{jest.clearAllMocks();mockOpen.mockResolvedValue(frame);mockFrame.mockResolvedValue(frame);mockInput.mockResolvedValue(undefined);});

test('background preview stays mounted, accepts Agent navigation, and blocks hidden user input',async()=>{
 const props={selection,url:frame.url,revision:0,onNavigate:jest.fn(),active:true};
 const view=await render(<RemoteComputerPreview {...props}/>);
 await fireEvent.press(view.getByLabelText('展开网页操作'));
 await view.rerender(<RemoteComputerPreview {...props} active={false} url="http://localhost:3000/next"/>);
 expect(mockOpen).toHaveBeenCalledTimes(1);expect(mockDispose).not.toHaveBeenCalled();
 expect(mockInput).toHaveBeenCalledWith({action:'navigate',url:'http://localhost:3000/next'});
 mockInput.mockClear();await fireEvent.changeText(view.getByLabelText('网页输入内容'),'hidden');await fireEvent.press(view.getByLabelText('输入到电脑网页'));
 expect(mockInput).not.toHaveBeenCalled();await view.unmount();expect(mockDispose).toHaveBeenCalledTimes(1);
});
test('visible text is sent to the computer page and changing computers releases the old page',async()=>{
 const props={selection,url:frame.url,revision:0,onNavigate:jest.fn(),active:true};
 const view=await render(<RemoteComputerPreview {...props}/>);
 await fireEvent.press(view.getByLabelText('展开网页操作'));
 await fireEvent.changeText(view.getByLabelText('网页输入内容'),'平板输入');await fireEvent.press(view.getByLabelText('输入到电脑网页'));
 expect(mockInput).toHaveBeenCalledWith({action:'text',text:'平板输入'});
 await view.rerender(<RemoteComputerPreview {...props} selection={{...selection,deviceId:'other-pc'}}/>);
 expect(mockDispose).toHaveBeenCalledTimes(1);expect(mockOpen).toHaveBeenCalledTimes(2);
});
test('restores scroll once and keeps dialog responses scoped to the actual dialog',async()=>{
 const value={...frame,scrollX:0,scrollY:240,dialog:{id:'9',type:'prompt',message:'请输入名称',defaultPrompt:'原名称'}};mockOpen.mockResolvedValue(value);mockFrame.mockResolvedValue(value);
 const onScrollChange=jest.fn(),props={selection,url:frame.url,revision:0,onNavigate:jest.fn(),active:true,initialScroll:{x:0,y:240},onScrollChange};
 const view=await render(<RemoteComputerPreview {...props}/>);
 expect(mockInput).toHaveBeenCalledWith({action:'scrollTo',x:0,y:240});expect(onScrollChange).toHaveBeenCalledWith({x:0,y:240,url:frame.url});
 await fireEvent.changeText(view.getByLabelText('网页对话框输入'),'新名称');await fireEvent.press(view.getByLabelText('网页确认对话框'));
 expect(mockInput).toHaveBeenCalledWith({action:'dialog',dialogId:'9',accept:true,prompt:'新名称'});
 await view.rerender(<RemoteComputerPreview {...props} initialScroll={{x:0,y:500}}/>);expect(mockOpen).toHaveBeenCalledTimes(1);
});
test('upload cancellation does not send data and actual selection transfers bytes',async()=>{
 const value={...frame,chooser:{id:'12',multiple:false}};mockOpen.mockResolvedValue(value);mockFrame.mockResolvedValue(value);
 const view=await render(<RemoteComputerPreview selection={selection} url={frame.url} revision={0} onNavigate={jest.fn()} active/>);
 mockPick.mockResolvedValueOnce(null);await fireEvent.press(view.getByLabelText('网页选择文件'));expect(mockInput.mock.calls.some(([input])=>input.action==='upload')).toBe(false);
 mockPick.mockResolvedValueOnce({name:'a.txt',bytes:new Uint8Array([97,98,99])});await fireEvent.press(view.getByLabelText('网页选择文件'));
 expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({action:'upload',chooserId:'12',name:'a.txt',offset:0,total:3,dataBase64:'YWJj',final:true}));
});
test('download decodes each base64 chunk before joining bytes',async()=>{
 const value={...frame,downloads:[{id:'abc-12345678',name:'a.txt',size:3,state:'completed'}]};mockOpen.mockResolvedValue(value);mockFrame.mockResolvedValue(value);
 mockDownload.mockResolvedValueOnce({name:'a.txt',total:3,dataBase64:'YQ==',done:false}).mockResolvedValueOnce({name:'a.txt',total:3,dataBase64:'YmM=',done:true});mockSave.mockResolvedValue(undefined);
 const view=await render(<RemoteComputerPreview selection={selection} url={frame.url} revision={0} onNavigate={jest.fn()} active/>);
 await fireEvent.press(view.getByLabelText('网页保存 a.txt'));expect(mockDownload).toHaveBeenNthCalledWith(2,'abc-12345678',1);expect(mockSave).toHaveBeenCalledWith('a.txt',new Uint8Array([97,98,99]));
});

const domFrame = {...frame, domSupported:true, documentId:'document_test_123'};
const selectedFrame = {...domFrame,element:{id:'element_test_123',documentId:domFrame.documentId,revision:1,url:frame.url,tag:'button',selector:'#submit',text:'Submit',outerHTML:'<button id="submit">Submit</button>',rect:{x:50,y:50,width:100,height:40},computed:{color:'rgb(0, 0, 0)'},changes:[],sources:[]}};

test('actual computer logs append only after selection and a hidden page blocks log actions',async()=>{
 const value={...domFrame,logsSupported:true,logs:[{id:'cdp:1',level:'error',message:'ReferenceError: widget is not defined',source:'http://localhost:3000/app.js',line:7,column:2}]};mockOpen.mockResolvedValue(value);mockFrame.mockResolvedValue(value);
 const compose=jest.fn((_text:string)=>true),props={selection,url:frame.url,revision:0,onNavigate:jest.fn(),active:true,onCompose:compose};
 const view=await render(<RemoteComputerPreview {...props}/>);expect(compose).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('展开预览日志'));
 await fireEvent.press(view.getByLabelText('将日志 cdp:1 加入对话'));
 expect(compose).toHaveBeenCalledWith(expect.stringContaining('http://localhost:3000/app.js:7:2'));
 await view.rerender(<RemoteComputerPreview {...props} active={false}/>);await fireEvent.press(view.getByLabelText('将日志 cdp:1 加入对话'));
 expect(compose).toHaveBeenCalledTimes(1);
});

test('element picking waits for acknowledged input then refreshes the actual selected DOM',async()=>{
 mockOpen.mockResolvedValue(domFrame);mockFrame.mockResolvedValue(domFrame);
 const view=await render(<RemoteComputerPreview selection={selection} url={frame.url} revision={0} onNavigate={jest.fn()} active/>);
 let finish!:()=>void;mockInput.mockImplementation(input=>input.action==='element-pick'?new Promise<void>(resolve=>{finish=resolve;}):Promise.resolve());
 mockFrame.mockClear();mockFrame.mockResolvedValue(selectedFrame);
 await fireEvent.press(view.getByLabelText('选择网页元素'));
 await fireEvent.press(view.getByLabelText('选择网页元素'),{nativeEvent:{locationX:50,locationY:50}});
 expect(mockInput).toHaveBeenCalledWith(expect.objectContaining({action:'element-pick',documentId:domFrame.documentId}));
 expect(mockFrame).not.toHaveBeenCalled();
 await act(async()=>{finish();});
 expect(mockFrame).toHaveBeenCalledWith(true);expect(view.getByText('#submit')).toBeTruthy();
 expect(view.queryByLabelText('退出元素选择')).toBeNull();
});

test('hiding the preview during element delivery does not apply a late selection',async()=>{
 mockOpen.mockResolvedValue(domFrame);mockFrame.mockResolvedValue(domFrame);
 const props={selection,url:frame.url,revision:0,onNavigate:jest.fn(),active:true};
 const view=await render(<RemoteComputerPreview {...props}/>);
 let finish!:()=>void;mockInput.mockImplementation(input=>input.action==='element-pick'?new Promise<void>(resolve=>{finish=resolve;}):Promise.resolve());
 await fireEvent.press(view.getByLabelText('选择网页元素'));
 await fireEvent.press(view.getByLabelText('选择网页元素'),{nativeEvent:{locationX:50,locationY:50}});
 await view.rerender(<RemoteComputerPreview {...props} active={false}/>);
 mockFrame.mockClear();mockFrame.mockResolvedValue(selectedFrame);
 await act(async()=>{finish();});
 expect(mockFrame).not.toHaveBeenCalled();expect(view.queryByText('#submit')).toBeNull();
});

test('remote region annotations crop the actual page frame and append image bytes through the conversation owner',async()=>{
 const image={uri:'data:image/png;base64,iVBORw0KGgo=',base64:'iVBORw0KGgo=',mime:'image/png' as const,width:80,height:80};jest.mocked(cropBrowserAnnotation).mockResolvedValue(image);
 const append=jest.fn(async(_text:string,_images:readonly unknown[])=>true),textOnly=jest.fn(),done=jest.fn();
 const view=await render(<ArtifactAnnotationProvider value={append}><RemoteComputerPreview selection={selection} url={frame.url} revision={0} onNavigate={jest.fn()} active annotating onAnnotationDone={done} onCompose={textOnly}/></ArtifactAnnotationProvider>);
 await fireEvent(view.getByTestId('browser-annotation-viewport'),'layout',{nativeEvent:{layout:{width:320,height:320}}});
 const overlay=view.getByLabelText('拖动选择网页批注区域');
 await fireEvent(overlay,'responderGrant',{nativeEvent:{locationX:20,locationY:20}});await fireEvent(overlay,'responderRelease',{nativeEvent:{locationX:60,locationY:60}});
 await fireEvent.changeText(view.getByLabelText('网页批注意见'),'调整这个区域');await fireEvent.press(view.getByLabelText('将网页批注加入对话'));
 expect(cropBrowserAnnotation).toHaveBeenCalledWith(expect.objectContaining({pageId:frame.pageId,imageBase64:frame.imageBase64,width:640,height:640}),{x:40,y:40,width:80,height:80},expect.any(Function));
 expect(append).toHaveBeenCalledWith(expect.stringContaining('调整这个区域'),[image]);expect(textOnly).not.toHaveBeenCalled();expect(done).toHaveBeenCalledTimes(1);
});

test('a frame without pixels cannot reuse a screenshot from a different scroll position',async()=>{
 const props={selection,url:frame.url,revision:0,onNavigate:jest.fn(),active:true};const view=await render(<RemoteComputerPreview {...props}/>);
 await view.rerender(<RemoteComputerPreview {...props} active={false}/>);
 mockFrame.mockResolvedValue({...frame,imageBase64:undefined,scrollY:300,nextSequence:2});
 await view.rerender(<RemoteComputerPreview {...props}/>);
 expect(view.getByText('网页截图尚未读取，可重试截图后继续批注。')).toBeTruthy();expect(view.queryByLabelText('点击电脑网页')).toBeNull();
});
