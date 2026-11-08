import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { BrowserElementEditor, browserElementInstruction } from '../remote/BrowserElementEditor';
import { RemotePreviewCanvas } from '../remote/RemotePreviewCanvas';
import { parsePreviewFrame, type PreviewFrame } from '../remote/workspace-preview';
import {ArtifactAnnotationProvider} from '../remote/ArtifactAnnotationContext';
import {cropBrowserAnnotation} from '../remote/browser-annotation-image';
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('../remote/browser-annotation-image',()=>({cropBrowserAnnotation:jest.fn()}));
const image={uri:'data:image/png;base64,iVBORw0KGgo=',base64:'iVBORw0KGgo=',mime:'image/png' as const,width:120,height:40};
beforeEach(()=>{jest.clearAllMocks();jest.mocked(cropBrowserAnnotation).mockResolvedValue(image);});

const frame: PreviewFrame = { pageId: 'preview_page_123', url: 'http://localhost:3000/', width: 800, height: 600, nextSequence: 1, domSupported: true, documentId: 'document_123',
  element: { id: 'element_123', documentId: 'document_123', revision: 1, url: 'http://localhost:3000/', tag: 'button', selector: '#save', text: '保存', outerHTML: '<button id="save">保存</button>', rect: { x: 80, y: 60, width: 120, height: 40 }, computed: { color: 'rgb(0, 0, 0)', 'font-size': '16px' }, changes: [], sources: [{ url: 'http://localhost:3000/style.css', line: 3, column: 1, selector: '#save' }] } };
const props = () => ({ frame, active: true, picking: false, onPickingChange: jest.fn(), onInput: jest.fn(async () => frame), onCompose: jest.fn() });

test('DOM frame parser validates identity, bounds and style data while accepting old hosts', () => {
  expect(parsePreviewFrame(frame)).toBe(frame);
  const { element, domSupported, documentId, ...old } = frame;
  expect(parsePreviewFrame(old)).toBe(old);
  for (const bad of [ { documentId: 'wrong' }, { domSupported: false }, { element: { ...element, documentId: 'other_document' } }, { element: { ...element, rect: { x: NaN, y: 0, width: 1, height: 1 } } }, { element: { ...element, computed: { 'background-image': 'url(file://secret)' } } }, { element: { ...element, sources: [{ url: 'x', line: -1, column: 1, selector: 'x' }] } } ]) expect(() => parsePreviewFrame({ ...frame, ...bad })).toThrow();
});

test('native element picking sends document-bound coordinates and never clicks the site', async () => {
  const input = jest.fn();
  const view = await render(<RemotePreviewCanvas frame={frame} width={400} disabled={false} elementPicking selectionMode onInput={input} />);
  await fireEvent.press(view.getByLabelText('选择网页元素'), { nativeEvent: { locationX: 60, locationY: 40 } });
  expect(input).toHaveBeenCalledWith({ action: 'element-pick', documentId: frame.documentId, x: 120, y: 80 });
  expect(input).toHaveBeenCalledTimes(1);
  expect(view.getByTestId('preview-element-outline').props.style).toMatchObject({ left: 40, top: 30, width: 60, height: 20 });
});

test('editing previews real style inputs with element revision and undo restores the same selection', async () => {
  const p = props(); const view = await render(<BrowserElementEditor {...p} />);
  await fireEvent.press(view.getByLabelText('展开元素编辑'));
  await fireEvent.press(view.getByLabelText('编辑 font-size'));
  await fireEvent.changeText(view.getByLabelText('CSS 值'), '20px');
  await fireEvent.press(view.getByLabelText('使用 important'));
  await fireEvent.press(view.getByLabelText('预览元素样式'));
  expect(p.onInput).toHaveBeenCalledWith({ action: 'style-preview', documentId: 'document_123', elementId: 'element_123', revision: 1, property: 'font-size', value: '20px', important: true });
  const changed = { ...frame, element: { ...frame.element!, revision: 2, changes: [{ property: 'font-size', before: '', beforePriority: '', value: '20px', priority: 'important' }] } };
  await view.rerender(<BrowserElementEditor {...p} frame={changed} />);
  await fireEvent.press(view.getByLabelText('撤销元素全部临时样式'));
  expect(p.onInput).toHaveBeenLastCalledWith({ action: 'style-undo', documentId: 'document_123', elementId: 'element_123', revision: 2 });
});

test('compose carries accurate source hints and actual changes without claiming source edits', async () => {
  const p = props(),append=jest.fn(async(_text:string,_images:readonly unknown[])=>true); const view = await render(<ArtifactAnnotationProvider value={append}><BrowserElementEditor {...p} frame={{...frame,imageBase64:'/9j/AA=='}} /></ArtifactAnnotationProvider>);
  await fireEvent.press(view.getByLabelText('展开元素编辑'));
  await fireEvent.changeText(view.getByLabelText('元素修改意见'), '加大这个按钮');
  await fireEvent.press(view.getByLabelText('将元素修改加入对话'));
  const text = append.mock.calls[0][0];
  expect(text).toContain('加大这个按钮'); expect(text).toContain('"selectorHint": "#save"'); expect(text).toContain('http://localhost:3000/style.css'); expect(text).toContain('尚未修改源文件');
  expect(p.onInput).not.toHaveBeenCalled();
  expect(p.onCompose).not.toHaveBeenCalled();expect(append).toHaveBeenCalledWith(expect.any(String),[image]);expect(text).toContain('附图 1：元素批注 1');
  expect(browserElementInstruction(frame.element!, '')).toContain('"elementId": "element_123"');
});

test('multiple element opinions retain their sampled DOM and cropped screenshots until one explicit append',async()=>{
 const append=jest.fn(async(_text:string,_images:readonly unknown[])=>true),p=props(),first={...frame,imageBase64:'/9j/AA=='};
 const page=(value:PreviewFrame)=><ArtifactAnnotationProvider value={append}><BrowserElementEditor {...p} frame={value}/></ArtifactAnnotationProvider>;
 const view=await render(page(first));await fireEvent.press(view.getByLabelText('展开元素编辑'));await fireEvent.changeText(view.getByLabelText('元素修改意见'),'修改保存按钮');await fireEvent.press(view.getByLabelText('保存元素批注'));
 const second={...first,element:{...frame.element!,id:'element_second',selector:'#cancel',text:'取消'}};
 await view.rerender(page(second));await fireEvent.changeText(view.getByLabelText('元素修改意见'),'修改取消按钮');await fireEvent.press(view.getByLabelText('保存元素批注'));
 expect(view.getByTestId('element-note:1')).toBeTruthy();expect(view.getByTestId('element-note:2')).toBeTruthy();expect(append).not.toHaveBeenCalled();
 await fireEvent.press(view.getByLabelText('将元素修改加入对话'));
 expect(append).toHaveBeenCalledWith(expect.stringContaining('"selectorHint": "#save"'),[image,image]);expect(append.mock.calls[0][0]).toContain('"selectorHint": "#cancel"');
 expect(view.queryByTestId('element-note:1')).toBeNull();
});

test('failed element crops remain retryable and cannot fall back to a text-only append',async()=>{
 jest.mocked(cropBrowserAnnotation).mockRejectedValueOnce(new Error('无法读取元素截图'));
 const append=jest.fn(async(_text:string,_images:readonly unknown[])=>true),p=props(),withImage={...frame,imageBase64:'/9j/AA=='};
 const view=await render(<ArtifactAnnotationProvider value={append}><BrowserElementEditor {...p} frame={withImage} onCaptureFrame={async()=>withImage}/></ArtifactAnnotationProvider>);
 await fireEvent.press(view.getByLabelText('展开元素编辑'));await fireEvent.changeText(view.getByLabelText('元素修改意见'),'修改按钮');await fireEvent.press(view.getByLabelText('将元素修改加入对话'));
 expect(append).not.toHaveBeenCalled();expect(p.onCompose).not.toHaveBeenCalled();expect(view.getByTestId('element-note:1')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('重试元素截图 1'));await fireEvent.press(view.getByLabelText('将元素修改加入对话'));expect(append).toHaveBeenCalledWith(expect.any(String),[image]);
});

test('a replacement document invalidates a pending element screenshot',async()=>{
 let finish!:(value:typeof image)=>void;jest.mocked(cropBrowserAnnotation).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const append=jest.fn(async(_text:string,_images:readonly unknown[])=>true),p=props();const page=(scope:string)=><ArtifactAnnotationProvider value={append}><BrowserElementEditor {...p} scopeKey={scope} frame={{...frame,imageBase64:'/9j/AA=='}}/></ArtifactAnnotationProvider>;
 const view=await render(page('first'));await fireEvent.press(view.getByLabelText('展开元素编辑'));await fireEvent.changeText(view.getByLabelText('元素修改意见'),'旧元素意见');await fireEvent.press(view.getByLabelText('将元素修改加入对话'));
 await view.rerender(page('new-computer'));await act(async()=>finish(image));expect(append).not.toHaveBeenCalled();expect(view.queryByTestId('element-note:1')).toBeNull();
});

test('old hosts, hidden previews and unsafe CSS cannot dispatch style operations', async () => {
  const p = props(); const view = await render(<BrowserElementEditor {...p} />);
  await fireEvent.press(view.getByLabelText('展开元素编辑'));
  await fireEvent.changeText(view.getByLabelText('CSS 值'), 'url(https://bad.test)');
  await fireEvent.press(view.getByLabelText('预览元素样式')); expect(p.onInput).not.toHaveBeenCalled();
  await view.rerender(<BrowserElementEditor {...p} active={false} />);
  await fireEvent.press(view.getByLabelText('预览元素样式')); expect(p.onInput).not.toHaveBeenCalled();
  await view.rerender(<BrowserElementEditor {...p} frame={{ ...frame, domSupported: undefined, documentId: undefined, element: undefined }} />);
  await fireEvent.press(view.getByLabelText('选择网页元素')); expect(p.onPickingChange).not.toHaveBeenCalled();
});

test('late preview completion cannot show success in a replacement document', async () => {
  let resolve!: (value: PreviewFrame) => void;
  const p = { ...props(), onInput: jest.fn(() => new Promise<PreviewFrame>(r => { resolve = r; })) };
  const view = await render(<BrowserElementEditor {...p} />);
  await fireEvent.press(view.getByLabelText('展开元素编辑'));
  await fireEvent.changeText(view.getByLabelText('CSS 值'), 'red');
  await fireEvent.press(view.getByLabelText('预览元素样式'));
  await view.rerender(<BrowserElementEditor {...p} frame={{ ...frame, documentId: 'replacement_doc', element: undefined }} />);
  await act(async () => { resolve(frame); });
  expect(view.queryByText('样式已在网页中预览，尚未修改源文件')).toBeNull();
});

test('known DOM conflicts remain visible and do not show a success message', async () => {
  const p = { ...props(), onInput: jest.fn(async () => ({ ...frame, domError: '网页已自行修改样式' })) };
  const view = await render(<BrowserElementEditor {...p} />);
  await fireEvent.press(view.getByLabelText('展开元素编辑'));
  await fireEvent.changeText(view.getByLabelText('CSS 值'), 'red');
  await fireEvent.press(view.getByLabelText('预览元素样式'));
  expect(view.getByText('网页已自行修改样式')).toBeTruthy();
});
