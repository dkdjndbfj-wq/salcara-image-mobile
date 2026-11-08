import React from 'react';
import {StyleSheet} from 'react-native';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {ConversationArtifactPreview} from '../remote/ConversationArtifactPreview';
import {conversationArtifactRevision} from '../remote/conversation-artifact-target';
import {ensureArtifactVersion,saveArtifactVersion} from '../remote/artifact-versions';
const mockSettings=new Map<string,string>();let mockPreview:any;
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,setSetting:async(key:string,value:string|null)=>{if(value===null)mockSettings.delete(key);else mockSettings.set(key,value);}}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID()}));
jest.mock('../remote/InlineConversationArtifact',()=>({InlineConversationArtifact:(props:any)=>{mockPreview=props;return null;}}));
jest.mock('react-native',()=>{
  const React=require('react'),actual=jest.requireActual('react-native'),replacement=Object.create(actual);
  Object.defineProperty(replacement,'Pressable',{enumerable:true,value:({children,style,...props}:any)=>React.createElement(actual.View,{...props,accessible:true,accessibilityState:{...props.accessibilityState,disabled:props.disabled},style:typeof style==='function'?style({pressed:false}):style},children)});
  return replacement;
});
let counter=0;
const target=()=>{const source='<h1>Original</h1>';return {scopeKey:`scope-${++counter}`,messageId:'answer',index:0,source,revision:conversationArtifactRevision(source),title:'Original'};};
async function edit(view:any){await fireEvent.press(view.getByLabelText('界面源码'));await fireEvent.press(view.getByLabelText('界面源码更多操作'));await waitFor(()=>expect(view.getByLabelText('编辑预览副本')).toBeEnabled());await fireEvent.press(view.getByLabelText('编辑预览副本'));}
beforeEach(()=>{mockSettings.clear();});
test('source edits save a preview copy, compare, switch and restore while no callback sends automatically',async()=>{
  const original=target(),compose=jest.fn(()=>true),view=await render(<ConversationArtifactPreview target={original} onCompose={compose}/>);
  await edit(view);const originalScope=mockPreview.scopeKey,originalCompose=mockPreview.onCompose;await fireEvent.changeText(view.getByLabelText('界面源码副本'),'<h1>New design</h1>');expect(mockPreview.source).toBe(original.source);
  await fireEvent.press(view.getByLabelText('保存为新版本'));await waitFor(()=>expect(mockPreview.source).toBe('<h1>New design</h1>'));expect(originalCompose('late old version annotation')).toBe(false);expect(compose).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('界面版本'));expect(view.getByText('v1 → v2 · +1 / −1')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('查看版本 1'));expect(mockPreview.source).toBe(original.source);
  await fireEvent.press(view.getByLabelText('将版本 1 恢复为新版本'));await waitFor(()=>expect((mockPreview.source)).toBe(original.source));
  expect((await ensureArtifactVersion(original)).versions).toHaveLength(3);expect(mockPreview.scopeKey).not.toBe(originalScope);expect(mockPreview.messageId).toBe(original.messageId);expect(compose).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('界面源码'));await fireEvent.press(view.getByLabelText('界面源码更多操作'));await waitFor(()=>expect(view.getByLabelText('加入对话草稿')).toBeEnabled());await fireEvent.press(view.getByLabelText('加入对话草稿'));
  expect(compose).toHaveBeenCalledTimes(1);expect(compose).toHaveBeenCalledWith(expect.stringContaining(original.source));await view.unmount();
});
test('an unsaved source draft survives closing and remains isolated from another scope',async()=>{
  const original=target();let view=await render(<ConversationArtifactPreview target={original}/>);await edit(view);await fireEvent.changeText(view.getByLabelText('界面源码副本'),'<p>unsaved copy</p>');await view.unmount();
  view=await render(<ConversationArtifactPreview target={original}/>);await fireEvent.press(view.getByLabelText('界面源码'));await waitFor(()=>expect(view.getByLabelText('界面源码副本').props.value).toBe('<p>unsaved copy</p>'));await view.unmount();
  view=await render(<ConversationArtifactPreview target={{...original,scopeKey:'another-pairing'}}/>);await edit(view);expect(view.getByLabelText('界面源码副本').props.value).toBe(original.source);await view.unmount();
});
test('an old source callback cannot add content after the target changes',async()=>{
  const original=target(),compose=jest.fn(()=>true),view=await render(<ConversationArtifactPreview target={original} onCompose={compose}/>);
  const old=mockPreview.onCompose;await view.rerender(<ConversationArtifactPreview target={{...original,scopeKey:'different'}} onCompose={compose}/>);
  await act(async()=>{expect(old('old source')).toBe(false);});expect(compose).not.toHaveBeenCalled();await view.unmount();
});
test('a concurrent version blocks overwrite and reloading keeps the older editor draft available',async()=>{
  const original=target(),initial=await ensureArtifactVersion(original),view=await render(<ConversationArtifactPreview target={original}/>);
  await edit(view);await fireEvent.changeText(view.getByLabelText('界面源码副本'),'<h1>my unsaved edit</h1>');
  await saveArtifactVersion(original,'<h1>other window edit</h1>',initial.versions[0].id);
  await fireEvent.press(view.getByLabelText('保存为新版本'));expect(view.getByLabelText('界面源码副本').props.value).toBe('<h1>my unsaved edit</h1>');
  expect(view.getByText('成果已有新版本，请重新读取后比较；当前编辑仍保留')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('重新读取版本'));await fireEvent.press(view.getByLabelText('界面版本'));await fireEvent.press(view.getByLabelText('查看版本 1'));
  await fireEvent.press(view.getByLabelText('界面源码'));await waitFor(()=>expect(view.getByLabelText('界面源码副本').props.value).toBe('<h1>my unsaved edit</h1>'));
  expect((await ensureArtifactVersion(original)).versions).toHaveLength(2);await view.unmount();
});

test('source toolbar keeps only dirty save visible and menus retain compose and discard',async()=>{
  const original=target(),compose=jest.fn(()=>true),view=await render(<ConversationArtifactPreview target={original} onCompose={compose}/>);
  await fireEvent.press(view.getByLabelText('界面源码'));
  await fireEvent(view.getByTestId('artifact-version-toolbar'),'layout',{nativeEvent:{layout:{width:320,height:52}}});
  expect(view.queryByLabelText('编辑预览副本')).toBeNull();expect(view.queryByLabelText('加入对话草稿')).toBeNull();expect(view.queryByLabelText('保存为新版本')).toBeNull();expect(view.queryByTestId('artifact-version-title')).toBeNull();
  await fireEvent.press(view.getByLabelText('界面源码更多操作'));await waitFor(()=>expect(view.getByLabelText('编辑预览副本')).toBeEnabled());await fireEvent.press(view.getByLabelText('编辑预览副本'));
  expect(view.queryByTestId('artifact-source-actions-menu')).toBeNull();expect(view.queryByLabelText('保存为新版本')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('界面源码副本'),'<h1>draft</h1>');
  expect(view.getByText('保存')).toBeTruthy();
  const saveStyle=StyleSheet.flatten(view.getByLabelText('保存为新版本').props.style);expect(saveStyle.minWidth).toBeGreaterThanOrEqual(44);expect(saveStyle.minHeight).toBeGreaterThanOrEqual(44);
  const moreStyle=StyleSheet.flatten(view.getByLabelText('界面源码更多操作').props.style);expect(moreStyle.width).toBe(44);expect(moreStyle.height).toBe(44);
  await fireEvent.press(view.getByLabelText('界面源码更多操作'));await fireEvent.press(view.getByLabelText('加入对话草稿'));expect(compose).toHaveBeenCalledWith(expect.stringContaining('<h1>draft</h1>'));
  await fireEvent.press(view.getByLabelText('界面源码更多操作'));await fireEvent.press(view.getByLabelText('丢弃本次修改'));
  expect(view.queryByLabelText('界面源码副本')).toBeNull();expect(view.queryByLabelText('保存为新版本')).toBeNull();
  await fireEvent(view.getByTestId('artifact-version-toolbar'),'layout',{nativeEvent:{layout:{width:440,height:52}}});expect(view.getByTestId('artifact-version-title')).toBeTruthy();
  await view.unmount();
});

test('a captured source menu action cannot compose after switching modes or replacing its target',async()=>{
  const original=target(),compose=jest.fn(()=>true),view=await render(<ConversationArtifactPreview target={original} onCompose={compose}/>);
  await fireEvent.press(view.getByLabelText('界面源码'));await fireEvent.press(view.getByLabelText('界面源码更多操作'));await waitFor(()=>expect(view.getByLabelText('加入对话草稿')).toBeEnabled());
  const stale=view.getByLabelText('加入对话草稿').props.onPress;
  await fireEvent.press(view.getByLabelText('界面版本'));expect(view.queryByTestId('artifact-source-actions-menu')).toBeNull();
  await fireEvent.press(view.getByLabelText('界面源码'));await fireEvent.press(view.getByLabelText('界面源码更多操作'));await act(async()=>stale());expect(compose).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('界面源码更多操作'));const oldTarget=view.getByLabelText('加入对话草稿').props.onPress;
  await view.rerender(<ConversationArtifactPreview target={{...original,scopeKey:'replacement'}} onCompose={compose}/>);await act(async()=>oldTarget());expect(compose).not.toHaveBeenCalled();
  await view.unmount();
});
