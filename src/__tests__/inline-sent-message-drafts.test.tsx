import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { InlineSentMessageEditor } from '../remote/InlineSentMessageEditor';
import type { SentUserMessage } from '../remote/sent-message-revision';

const mockSettings=new Map<string,string>(),mockToast=jest.fn();
const mockGet=jest.fn(async(key:string):Promise<string|null>=>mockSettings.get(key)??null);
const mockSet=jest.fn(async(key:string,value:string)=>{mockSettings.set(key,value);});
jest.mock('../storage/database',()=>({getSetting:(key:string)=>mockGet(key),setSetting:(key:string,value:string)=>mockSet(key,value)}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_:string,value:string)=>require('node:crypto').createHash('sha256').update(value).digest('hex')}));
jest.mock('../theme',()=>({useDesk:()=>({text:'#222',muted:'#888',surface2:'#eee',warn:'#a50'})}));
jest.mock('../components/Icon',()=>({Icon:()=>null}));
jest.mock('../components/ui',()=>({Sheet:({visible,children}:any)=>visible?children:null,showToast:(...args:unknown[])=>mockToast(...args)}));
jest.mock('../components/MotionPressable',()=>({MotionPressable:(props:object)=>require('react').createElement(require('react-native').Pressable,props)}));
jest.mock('../remote/ConversationMotion',()=>({WorkbenchReveal:({children}:any)=>children}));
jest.mock('../remote/SkillComposerInput',()=>({SkillComposerInput:require('react').forwardRef((props:object,ref:unknown)=>require('react').createElement(require('react-native').TextInput,{...props,ref}))}));
const original:SentUserMessage={kind:'message',id:'user',role:'user',text:'Original',final:true,turnId:'turn',ts:1};
type Props=React.ComponentProps<typeof InlineSentMessageEditor>;
const props=(identity:string,changes:Partial<Props>={}):Props=>({message:original,scopeKey:identity,draftScope:'paired|credential:one',draftDeviceId:'pc',onSubmit:jest.fn(async()=>true),onClose:jest.fn(),...changes});
async function mount(value:Props){const view=await render(<InlineSentMessageEditor {...value}/>);await waitFor(()=>expect(view.getByLabelText('编辑最新消息正文').props.editable).toBe(true));return view;}
beforeEach(()=>{mockSettings.clear();mockToast.mockClear();mockGet.mockReset().mockImplementation(async key=>mockSettings.get(key)??null);mockSet.mockReset().mockImplementation(async(key,value)=>{mockSettings.set(key,value);});});

test('navigation during the typing debounce preserves the last input and never sends',async()=>{
 const value=props('navigation'),first=await mount(value);
 await fireEvent.changeText(first.getByLabelText('编辑最新消息正文'),'Keep my last change');await first.unmount();
 const second=await mount(value);expect(second.getByLabelText('编辑最新消息正文').props.value).toBe('Keep my last change');expect(value.onSubmit).not.toHaveBeenCalled();await second.unmount();
});

test('explicit cancel discards the saved edit and reopens the original',async()=>{
 const value=props('cancel'),first=await mount(value);await fireEvent.changeText(first.getByLabelText('编辑最新消息正文'),'Discard');
 await fireEvent.press(first.getByLabelText('取消编辑最新消息'));await waitFor(()=>expect(value.onClose).toHaveBeenCalled());await first.unmount();
 const second=await mount(value);expect(second.getByLabelText('编辑最新消息正文').props.value).toBe('Original');await second.unmount();
});

test('different API scope and changed original message never inherit another edit',async()=>{
 const first=await mount(props('source-a'));await fireEvent.changeText(first.getByLabelText('编辑最新消息正文'),'Private edit');await first.unmount();
 const other=await mount(props('source-b'));expect(other.getByLabelText('编辑最新消息正文').props.value).toBe('Original');await other.unmount();
 const changed=await mount(props('source-a',{message:{...original,text:'Changed on computer'}}));expect(changed.getByLabelText('编辑最新消息正文').props.value).toBe('Changed on computer');await changed.unmount();
});

test('storage failure prevents native submission and keeps the visible text for retry',async()=>{
 const value=props('save-error'),view=await mount(value);await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'),'Do not lose');
 mockSet.mockRejectedValueOnce(new Error('Storage failed'));
 await fireEvent.press(view.getByLabelText('发送修改后的消息'));await waitFor(()=>expect(view.getByRole('alert').props.children).toContain('Storage failed'));
 expect(value.onSubmit).not.toHaveBeenCalled();expect(view.getByLabelText('编辑最新消息正文').props.value).toBe('Do not lose');
 await fireEvent.press(view.getByLabelText('发送修改后的消息'));await waitFor(()=>expect(value.onSubmit).toHaveBeenCalledTimes(1));await view.unmount();
});

test('a lost network result retains the edit when reopened',async()=>{
 const value=props('network',{onSubmit:jest.fn(async()=>{throw new Error('Result unconfirmed');})}),first=await mount(value);
 await fireEvent.changeText(first.getByLabelText('编辑最新消息正文'),'Keep pending edit');await fireEvent.press(first.getByLabelText('发送修改后的消息'));
 await waitFor(()=>expect(first.getByRole('alert').props.children).toBe('Result unconfirmed'));await first.unmount();
 const second=await mount(value);expect(second.getByLabelText('编辑最新消息正文').props.value).toBe('Keep pending edit');expect(value.onSubmit).toHaveBeenCalledTimes(1);await second.unmount();
});

test('successful submission after native revert unmounts the row still consumes the accepted draft',async()=>{
 let finish!:(value:boolean)=>void;
 const value=props('accept-unmount',{onSubmit:jest.fn(()=>new Promise(resolve=>{finish=resolve;}))}),first=await mount(value);
 await fireEvent.changeText(first.getByLabelText('编辑最新消息正文'),'Accepted');await fireEvent.press(first.getByLabelText('发送修改后的消息'));
 await waitFor(()=>expect(value.onSubmit).toHaveBeenCalledTimes(1));await first.unmount();await act(async()=>finish(true));
 const second=await mount(value);expect(second.getByLabelText('编辑最新消息正文').props.value).toBe('Original');await second.unmount();
});

test('a failed restore blocks editing but still allows leaving without deleting the stored record',async()=>{
 mockGet.mockRejectedValueOnce(new Error('Read failed'));const value=props('read-error'),view=await render(<InlineSentMessageEditor {...value}/>);
 await waitFor(()=>expect(view.getByRole('alert').props.children).toContain('无法读取'));
 expect(view.getByLabelText('编辑最新消息正文').props.editable).toBe(false);await fireEvent.press(view.getByLabelText('取消编辑最新消息'));
 expect(value.onClose).toHaveBeenCalledTimes(1);expect(value.onSubmit).not.toHaveBeenCalled();await view.unmount();
});

test('a save failure on departure is explained and the same source can recover its in-memory edit',async()=>{
 const value=props('leave-error'),first=await mount(value);await fireEvent.changeText(first.getByLabelText('编辑最新消息正文'),'Unsaved departure');
 mockSet.mockRejectedValueOnce(new Error('Disk unavailable'));await first.unmount();
 await waitFor(()=>expect(mockToast).toHaveBeenCalledWith('修改暂未保存，请返回原会话重试','alert'));
 const second=await mount(value);expect(second.getByLabelText('编辑最新消息正文').props.value).toBe('Unsaved departure');
 expect(second.getByRole('alert').props.children).toContain('尚未保存');await second.unmount();
});

test('the background transition flushes pending typing before its debounce',async()=>{
 let change!:(state:any)=>void;const listener=jest.spyOn(AppState,'addEventListener').mockImplementation((_event,callback:any)=>{change=callback;return {remove:jest.fn()};});
 const value=props('background'),view=await mount(value);await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'),'Background text');
 await act(async()=>change('background'));
 await waitFor(()=>expect(mockSettings.get('remote_composer_drafts_v1')).toContain('Background text'));expect(value.onSubmit).not.toHaveBeenCalled();
 await view.unmount();listener.mockRestore();
});

test('changing the private pairing invalidates the old editor even if the display scope was reused',async()=>{
 const value=props('same-display'),view=await mount(value);await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'),'Private A');
 const lateChange=view.getByLabelText('编辑最新消息正文').props.onChangeText;
 await view.rerender(<InlineSentMessageEditor {...value} draftScope="paired|credential:two"/>);
 await act(async()=>lateChange('Late A callback'));
 await view.rerender(<InlineSentMessageEditor {...value}/>);
 expect(view.queryByLabelText('编辑最新消息正文')).toBeNull();expect(value.onSubmit).not.toHaveBeenCalled();await view.unmount();
 const next=await mount(value);expect(next.getByLabelText('编辑最新消息正文').props.value).toBe('Private A');await next.unmount();
});
