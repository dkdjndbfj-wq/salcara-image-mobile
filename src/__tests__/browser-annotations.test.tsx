import React from 'react';
import {View} from 'react-native';
import {act,fireEvent,render,waitFor,within} from '@testing-library/react-native';
import {BrowserAnnotations} from '../remote/BrowserAnnotations';
import {ArtifactAnnotationProvider} from '../remote/ArtifactAnnotationContext';
import {cropBrowserAnnotation} from '../remote/browser-annotation-image';
import type {PreviewFrame} from '../remote/workspace-preview';
import * as Clipboard from 'expo-clipboard';
jest.mock('expo-clipboard',()=>({setStringAsync:jest.fn(async()=>true)}));
jest.mock('../remote/browser-annotation-image',()=>({cropBrowserAnnotation:jest.fn()}));
const image={uri:'data:image/png;base64,iVBORw0KGgo=',base64:'iVBORw0KGgo=',mime:'image/png' as const,width:160,height:80};
const frame:PreviewFrame={pageId:'page_annotations',documentId:'doc_annotations',url:'http://localhost:3000/a',width:800,height:400,nextSequence:1,imageBase64:'/9j/AA==',scrollX:0,scrollY:250};
beforeEach(()=>{jest.clearAllMocks();jest.mocked(cropBrowserAnnotation).mockResolvedValue(image);});

async function select(view:any,from={x:40,y:30},to={x:120,y:70}){
 await fireEvent(view.getByTestId('browser-annotation-viewport'),'layout',{nativeEvent:{layout:{width:400,height:200}}});
 const overlay=view.getByLabelText('拖动选择网页批注区域');
 expect(overlay.props.onStartShouldSetResponder()).toBe(true);
 await fireEvent(overlay,'responderGrant',{nativeEvent:{locationX:from.x,locationY:from.y}});
 await fireEvent(overlay,'responderRelease',{nativeEvent:{locationX:to.x,locationY:to.y}});
 await fireEvent.changeText(view.getByLabelText('网页批注意见'),'  调整这里的间距  ');
}

test('annotation scales the selected viewport, includes scroll and only appends to the composer',async()=>{
 const compose=jest.fn(),done=jest.fn(),site=jest.fn();
 const view=await render(<BrowserAnnotations url="http://localhost:3000/a" enabled onDone={done} onCompose={compose} viewport={{width:800,height:400}} scroll={{x:0,y:250}}><View onTouchStart={site}/></BrowserAnnotations>);
 await select(view);await fireEvent.press(view.getByLabelText('将网页批注加入对话'));
 expect(compose).toHaveBeenCalledTimes(1);expect(compose.mock.calls[0][0]).toContain('x=80, y=60, width=160, height=80');
 expect(compose.mock.calls[0][0]).toContain('页面滚动：x=0, y=250');expect(compose.mock.calls[0][0]).toContain('意见：调整这里的间距');
 expect(site).not.toHaveBeenCalled();expect(done).toHaveBeenCalledTimes(1);
});

test('a refused composer append retains the comment for retry or copy',async()=>{
 const compose=jest.fn(()=>false),done=jest.fn();
 const view=await render(<BrowserAnnotations url="https://a.example/" enabled onDone={done} onCompose={compose}><View/></BrowserAnnotations>);
 await select(view);await fireEvent.press(view.getByLabelText('将网页批注加入对话'));
 expect(done).not.toHaveBeenCalled();expect(within(view.getByTestId('browser-note:1')).getByText(/调整这里/)).toBeTruthy();
 expect(view.getByText('当前对话暂不能接收批注，请稍后重试或复制保存')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('复制网页批注'));expect(Clipboard.setStringAsync).toHaveBeenCalledWith(expect.stringContaining('https://a.example/'));
});

test('remote annotations keep stable numbers across editing/deletion and append actual crops as one batch',async()=>{
 const append=jest.fn(async(_text:string,_images:readonly unknown[])=>true),done=jest.fn(),locate=jest.fn(async()=>{});
 const view=await render(<ArtifactAnnotationProvider value={append}><BrowserAnnotations scopeKey="pc/agent/api/project/code/session" frame={frame} url={frame.url} viewport={frame} scroll={{x:0,y:250}} enabled onDone={done} onLocate={locate}><View/></BrowserAnnotations></ArtifactAnnotationProvider>);
 await select(view);await fireEvent.press(view.getByLabelText('保存网页批注'));
 expect(cropBrowserAnnotation).toHaveBeenCalledWith(expect.objectContaining({imageBase64:frame.imageBase64}),{x:80,y:60,width:160,height:80},expect.any(Function));
 await select(view,{x:160,y:100},{x:220,y:150});await fireEvent.changeText(view.getByLabelText('网页批注意见'),'第二处');await fireEvent.press(view.getByLabelText('保存网页批注'));
 await fireEvent.press(view.getByLabelText('删除网页批注 1'));expect(view.queryByTestId('browser-note:1')).toBeNull();
 await fireEvent.press(view.getByLabelText('编辑网页批注 2'));expect(locate).toHaveBeenCalledWith({x:0,y:250});
 await fireEvent.changeText(view.getByLabelText('网页批注意见'),'第二处修改');await fireEvent.press(view.getByLabelText('保存网页批注修改'));
 await select(view);await fireEvent.changeText(view.getByLabelText('网页批注意见'),'第三处');await fireEvent.press(view.getByLabelText('保存网页批注'));
 expect(view.getByLabelText('网页批注标记 2')).toBeTruthy();expect(view.getByLabelText('网页批注标记 3')).toBeTruthy();expect(append).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('将网页批注加入对话'));
 expect(append).toHaveBeenCalledWith(expect.stringContaining('附图 1：批注 2'),[image,image]);expect(append.mock.calls[0][0]).toContain('附图 2：批注 3');expect(done).toHaveBeenCalledTimes(1);
});

test('a failed crop preserves its note, blocks text-only success, and can retry before appending',async()=>{
 jest.mocked(cropBrowserAnnotation).mockRejectedValueOnce(new Error('截图读取失败'));
 const append=jest.fn(async(_text:string,_images:readonly unknown[])=>true),compose=jest.fn(),done=jest.fn(),capture=jest.fn(async()=>frame);
 const view=await render(<ArtifactAnnotationProvider value={append}><BrowserAnnotations frame={frame} url={frame.url} viewport={frame} enabled onDone={done} onCompose={compose} onCaptureFrame={capture}><View/></BrowserAnnotations></ArtifactAnnotationProvider>);
 await select(view);await fireEvent.press(view.getByLabelText('将网页批注加入对话'));
 expect(view.getByTestId('browser-note:1')).toBeTruthy();expect(append).not.toHaveBeenCalled();expect(compose).not.toHaveBeenCalled();expect(done).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('重试网页截图 1'));expect(capture).toHaveBeenCalledTimes(1);
 await fireEvent.press(view.getByLabelText('将网页批注加入对话'));expect(append).toHaveBeenCalledWith(expect.any(String),[image]);expect(done).toHaveBeenCalledTimes(1);
});

test.each(['document','scope'])('a %s change retires a pending crop without adding to the replacement conversation',async(change)=>{
 let finish!:(value:typeof image)=>void;jest.mocked(cropBrowserAnnotation).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const append=jest.fn(async(_text:string,_images:readonly unknown[])=>true),done=jest.fn();
 const page=(scope:string,next:PreviewFrame)=><ArtifactAnnotationProvider value={append}><BrowserAnnotations scopeKey={scope} frame={next} url={next.url} viewport={next} enabled onDone={done}><View/></BrowserAnnotations></ArtifactAnnotationProvider>;
 const view=await render(page('first',frame));await select(view);await fireEvent.press(view.getByLabelText('将网页批注加入对话'));
 await view.rerender(page(change==='scope'?'other':'first',change==='document'?{...frame,documentId:'other-doc'}:frame));
 await act(async()=>finish(image));expect(append).not.toHaveBeenCalled();expect(done).not.toHaveBeenCalled();expect(view.queryByTestId('browser-note:1')).toBeNull();
});

test('duplicate submit is locked until the original draft acknowledges screenshots',async()=>{
 let finish!:(value:boolean)=>void;const append=jest.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;})),done=jest.fn();
 const view=await render(<ArtifactAnnotationProvider value={append}><BrowserAnnotations frame={frame} url={frame.url} viewport={frame} enabled onDone={done}><View/></BrowserAnnotations></ArtifactAnnotationProvider>);
 await select(view);await fireEvent.press(view.getByLabelText('将网页批注加入对话'));await waitFor(()=>expect(append).toHaveBeenCalledTimes(1));
 await fireEvent.press(view.getByLabelText('将网页批注加入对话'));expect(append).toHaveBeenCalledTimes(1);expect(done).not.toHaveBeenCalled();
 await act(async()=>finish(false));expect(view.getByTestId('browser-note:1')).toBeTruthy();expect(done).not.toHaveBeenCalled();
});

test('navigation clears unfinished regions and does not expose another URL’s saved annotations',async()=>{
 const props={enabled:true,onDone:jest.fn(),onCompose:jest.fn()};
 const view=await render(<BrowserAnnotations {...props} url="https://a.example/"><View/></BrowserAnnotations>);
 await select(view);await fireEvent.press(view.getByLabelText('将网页批注加入对话'));
 await view.rerender(<BrowserAnnotations {...props} enabled={false} url="https://a.example/"><View/></BrowserAnnotations>);
 expect(view.getByLabelText('复制当前网页全部批注')).toBeTruthy();
 await view.rerender(<BrowserAnnotations {...props} enabled={false} url="https://b.example/"><View/></BrowserAnnotations>);
 expect(view.queryByLabelText('复制当前网页全部批注')).toBeNull();
 await view.rerender(<BrowserAnnotations {...props} url="https://b.example/"><View/></BrowserAnnotations>);
 expect(view.getByLabelText('网页批注意见').props.value).toBe('');
 expect(view.getByLabelText('将网页批注加入对话').props.accessibilityState.disabled).toBe(true);
});

test('click regions stay within the viewport at its bottom-right edge',async()=>{
 const compose=jest.fn();const view=await render(<BrowserAnnotations url="https://a.example/" enabled onDone={()=>{}} onCompose={compose}><View/></BrowserAnnotations>);
 await select(view,{x:400,y:200},{x:400,y:200});await fireEvent.press(view.getByLabelText('将网页批注加入对话'));
 expect(compose.mock.calls[0][0]).toContain('x=396, y=196, width=4, height=4');
});
