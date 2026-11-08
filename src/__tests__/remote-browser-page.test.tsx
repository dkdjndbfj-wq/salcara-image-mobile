import React, { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteBrowserPage } from '../remote/RemoteBrowserPage';
import type { RemoteToolPreviewTarget } from '../remote/RemoteToolPreview';
import {Linking} from 'react-native';
import * as Clipboard from 'expo-clipboard';

jest.mock('expo-clipboard',()=>({setStringAsync:jest.fn(async()=>{})}));
jest.mock('../remote/RemoteComputerPreview',()=>({RemoteComputerPreview:()=>null}));

jest.mock('react-native',()=>{
 const React=require('react'),actual=jest.requireActual('react-native'),replacement=Object.create(actual);
 Object.defineProperty(replacement,'Pressable',{enumerable:true,value:({children,style,...props}:any)=>React.createElement(actual.View,{...props,accessible:true,accessibilityState:{...props.accessibilityState,disabled:props.disabled},style:typeof style==='function'?style({pressed:false}):style},children)});
 return replacement;
});

let mockBrowserProps: { uri: string; onNavigate: (url: string) => void };
jest.mock('../remote/RemoteDemoBrowser', () => ({ RemoteDemoBrowser: (props: typeof mockBrowserProps) => { mockBrowserProps = props; return null; } }));

function Page() {
  const [target, setTarget] = useState<RemoteToolPreviewTarget>({ kind: 'web', url: 'https://example.com/a' });
  return <RemoteBrowserPage target={target} onNavigate={setTarget} />;
}

test('completed in-page navigation updates the address without issuing another load', async () => {
  const view = await render(<Page />);
  expect(mockBrowserProps.uri).toBe('https://example.com/a');
  await act(async () => mockBrowserProps.onNavigate('https://example.com/b'));
  expect(view.getByLabelText('浏览器地址').props.value).toBe('https://example.com/b');
  expect(mockBrowserProps.uri).toBe('https://example.com/a');
  await fireEvent.press(view.getByLabelText('网页更多操作'));
  await fireEvent.press(view.getByLabelText('刷新网页'));
  expect(mockBrowserProps.uri).toBe('https://example.com/b');
});

test('an explicit new address or back action still issues a navigation request', async () => {
  const view = await render(<Page />);
  await act(async () => mockBrowserProps.onNavigate('https://example.com/b'));
  await fireEvent.changeText(view.getByLabelText('浏览器地址'), 'https://example.com/c');
  await fireEvent.press(view.getByLabelText('打开网址'));
  expect(mockBrowserProps.uri).toBe('https://example.com/c');
  await fireEvent.press(view.getByLabelText('网页后退'));
  expect(mockBrowserProps.uri).toBe('https://example.com/b');
});

test('a captured annotation action cannot append from a hidden or navigated browser tab',async()=>{
 const compose=jest.fn(),props={onCompose:compose,onNavigate:jest.fn(),target:{kind:'web' as const,url:'https://a.example/'}};
 const view=await render(<RemoteBrowserPage {...props}/>);
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 await fireEvent.press(view.getByLabelText('批注网页'));
 await fireEvent(view.getByTestId('browser-annotation-viewport'),'layout',{nativeEvent:{layout:{width:400,height:200}}});
 const overlay=view.getByLabelText('拖动选择网页批注区域');
 await fireEvent(overlay,'responderGrant',{nativeEvent:{locationX:20,locationY:20}});
 await fireEvent(overlay,'responderRelease',{nativeEvent:{locationX:100,locationY:100}});
 await fireEvent.changeText(view.getByLabelText('网页批注意见'),'旧页面批注');
 const stale=view.getByLabelText('将网页批注加入对话').props.onPress;
 await view.rerender(<RemoteBrowserPage {...props} active={false}/>);await act(async()=>stale());
 expect(compose).not.toHaveBeenCalled();
 await view.rerender(<RemoteBrowserPage {...props} target={{kind:'web',url:'https://b.example/'}}/>);await act(async()=>stale());
 expect(compose).not.toHaveBeenCalled();
 await view.unmount();
});

test('phone browser keeps actions in its address toolbar menu and preserves copy and external open',async()=>{
 const external=jest.spyOn(Linking,'openURL').mockResolvedValue(undefined);
 const view=await render(<Page/>);
 expect(view.queryByLabelText('复制网页地址')).toBeNull();
 expect(view.queryByLabelText('在系统浏览器打开')).toBeNull();
 expect(view.queryByLabelText('网页前进')).toBeNull();
 expect(view.queryByLabelText('打开网址')).toBeNull();
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 await fireEvent.press(view.getByLabelText('复制网页地址'));
 expect(Clipboard.setStringAsync).toHaveBeenCalledWith('https://example.com/a');
 expect(view.queryByTestId('browser-actions-menu')).toBeNull();
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 await fireEvent.press(view.getByLabelText('在系统浏览器打开'));
 expect(external).toHaveBeenCalledWith('https://example.com/a');
 external.mockRestore();
});

test('forward remains available in the compact menu and wider panes expose forward and reload',async()=>{
 const view=await render(<Page/>);
 await act(async()=>mockBrowserProps.onNavigate('https://example.com/b'));
 await fireEvent.press(view.getByLabelText('网页后退'));
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 await fireEvent.press(view.getByLabelText('网页前进'));
 expect(view.getByLabelText('浏览器地址').props.value).toBe('https://example.com/b');
 await fireEvent(view.getByTestId('remote-browser-page'),'layout',{nativeEvent:{layout:{width:680,height:600}}});
 expect(view.getByLabelText('网页前进')).toBeTruthy();
 expect(view.getByLabelText('刷新网页')).toBeTruthy();
 await view.unmount();
});

test('annotation exit shares the address toolbar and submitted address still navigates',async()=>{
 const view=await render(<Page/>);
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 await fireEvent.press(view.getByLabelText('批注网页'));
 expect(view.getByLabelText('退出网页批注')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('退出网页批注'));
 expect(view.queryByLabelText('退出网页批注')).toBeNull();
 await fireEvent.changeText(view.getByLabelText('浏览器地址'),'https://example.com/keyboard');
 await fireEvent(view.getByLabelText('浏览器地址'),'submitEditing');
 expect(mockBrowserProps.uri).toBe('https://example.com/keyboard');
 await view.unmount();
});

test('a dismissed menu cannot act for a hidden tab or a changed page owner',async()=>{
 const copy=Clipboard.setStringAsync as jest.Mock;copy.mockClear();
 const props={onNavigate:jest.fn(),target:{kind:'web' as const,url:'https://a.example/'}};
 const view=await render(<RemoteBrowserPage {...props}/>);
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 const stale=view.getByLabelText('复制网页地址').props.onPress;
 await view.rerender(<RemoteBrowserPage {...props} active={false}/>);
 expect(view.queryByTestId('browser-actions-menu')).toBeNull();
 await act(async()=>stale());
 await view.rerender(<RemoteBrowserPage {...props} target={{kind:'web',url:'https://b.example/'}}/>);
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 await act(async()=>stale());
 expect(copy).not.toHaveBeenCalled();
 await view.unmount();
});

test('long pressing an icon menu action explains it without executing and a later tap still works',async()=>{
 const copy=Clipboard.setStringAsync as jest.Mock;copy.mockClear();
 const view=await render(<Page/>);
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 const action=view.getByLabelText('复制网页地址');
 await fireEvent(action,'longPress');
 expect(view.getByText('复制网页地址')).toBeTruthy();
 await fireEvent.press(action);
 expect(copy).not.toHaveBeenCalled();
 expect(view.getByTestId('browser-actions-menu')).toBeTruthy();
 await fireEvent(action,'pressIn');
 await fireEvent.press(action);
 expect(copy).toHaveBeenCalledTimes(1);
 expect(copy).toHaveBeenCalledWith('https://example.com/a');
 expect(view.queryByTestId('browser-actions-menu')).toBeNull();
 await view.unmount();
});

test('icon menu rejects disabled actions and executes an enabled action only once per opening',async()=>{
 const copy=Clipboard.setStringAsync as jest.Mock;copy.mockClear();
 const navigate=jest.fn();
 const view=await render(<RemoteBrowserPage target={{kind:'web',url:'https://example.com/a'}} onNavigate={navigate}/>);
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 const forward=view.getByLabelText('网页前进');
 expect(forward).toBeDisabled();
 await act(async()=>forward.props.onPress());
 expect(navigate).not.toHaveBeenCalled();
 expect(view.getByTestId('browser-actions-menu')).toBeTruthy();
 const activate=view.getByLabelText('复制网页地址').props.onPress;
 await act(async()=>{activate();activate();});
 expect(copy).toHaveBeenCalledTimes(1);
 expect(view.queryByTestId('browser-actions-menu')).toBeNull();
 await view.unmount();
});

test('computer loopback preview does not offer opening a phone system browser',async()=>{
 const view=await render(<RemoteBrowserPage target={{kind:'local-service',url:'http://127.0.0.1:3000/'}} onNavigate={jest.fn()}
   computer={{deviceId:'pc',agentId:'codex',sessionKey:'codex:task',surface:'cli',cwd:'/project'}}/>);
 await fireEvent.press(view.getByLabelText('网页更多操作'));
 expect(view.queryByLabelText('在系统浏览器打开')).toBeNull();
 expect(view.getByLabelText('复制网页地址')).toBeTruthy();
 await view.unmount();
});
