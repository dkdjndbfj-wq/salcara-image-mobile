import React from 'react';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {QueuedMessages,type QueuedMessagesProps} from '../remote/QueuedMessages';

const mockSettings=new Map<string,string>(),mockSet=jest.fn(async(key:string,value:string)=>{mockSettings.set(key,value);});
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,setSetting:(key:string,value:string)=>mockSet(key,value)}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_:string,value:string)=>require('node:crypto').createHash('sha256').update(value).digest('hex')}));
jest.mock('../theme',()=>({useDesk:()=>({text:'#222',muted:'#888',surface2:'#eee',line:'#ddd',warn:'#a50'})}));
jest.mock('../components/Icon',()=>({Icon:()=>null}));
jest.mock('../components/ui',()=>({Sheet:({visible,children,onClose}:any)=>visible?require('react').createElement(require('react-native').View,null,children,require('react').createElement(require('react-native').Pressable,{accessibilityLabel:'Dismiss sheet',onPress:onClose})):null,showToast:jest.fn()}));
jest.mock('../components/MotionPressable',()=>({MotionPressable:(props:object)=>require('react').createElement(require('react-native').Pressable,props)}));
jest.mock('../remote/ConversationMotion',()=>({WorkbenchReveal:({children,visible=true}:any)=>visible?children:null}));
jest.mock('../remote/ManagedImage',()=>({ManagedImage:()=>null}));
jest.mock('../remote/thread-extras',()=>({ImageViewer:()=>null}));
const row={id:'queued',text:'Original queued request',images:[],detail:'已暂停',options:'model · high',editable:true,removable:true};
const props=(name:string):QueuedMessagesProps=>({scopeKey:name,draftScope:'pairing',draftDeviceId:'pc',entries:[row],onPause:jest.fn(async()=>{}),onEdit:jest.fn(async()=>{}),onMove:jest.fn(async()=>{}),onRemove:jest.fn(async()=>{}),onResume:jest.fn(async()=>{})});
async function open(view:Awaited<ReturnType<typeof render>>){if(view.queryByLabelText('展开排队消息'))await fireEvent.press(view.getByLabelText('展开排队消息'));await fireEvent.press(view.getByLabelText('编辑排队消息 1'));await waitFor(()=>expect(view.getByLabelText('排队消息正文').props.editable).toBe(true));}

test('outside dismissal keeps unfinished queue edits and never sends or resumes',async()=>{
 const value=props('outside'),view=await render(<QueuedMessages {...value}/>);await open(view);
 await fireEvent.changeText(view.getByLabelText('排队消息正文'),'Keep my unfinished edit');await fireEvent.press(view.getByLabelText('Dismiss sheet'));await open(view);
 expect(view.getByLabelText('排队消息正文').props.value).toBe('Keep my unfinished edit');expect(value.onEdit).not.toHaveBeenCalled();expect(value.onResume).not.toHaveBeenCalled();await view.unmount();
});

test('switching computers, API, mode or conversation isolates drafts and returning restores them',async()=>{
 const value=props('pc-a/api-a/code/session-a'),view=await render(<QueuedMessages {...value}/>);await open(view);await fireEvent.changeText(view.getByLabelText('排队消息正文'),'Private queue edit');
 for(const scope of ['pc-b/api-a/code/session-a','pc-a/api-b/code/session-a','pc-a/api-a/work/session-a','pc-a/api-a/code/session-b']){await view.rerender(<QueuedMessages {...value} scopeKey={scope}/>);await open(view);expect(view.getByLabelText('排队消息正文').props.value).toBe(row.text);}
 await view.rerender(<QueuedMessages {...value}/>);await open(view);expect(view.getByLabelText('排队消息正文').props.value).toBe('Private queue edit');await view.unmount();
});

test('explicit cancel and successful save clear only that edit draft',async()=>{
 const value=props('cancel-save'),view=await render(<QueuedMessages {...value}/>);await open(view);
 await fireEvent.changeText(view.getByLabelText('排队消息正文'),'Discard');await fireEvent.press(view.getByLabelText('取消编辑排队消息'));await waitFor(()=>expect(view.queryByLabelText('排队消息正文')).toBeNull());await open(view);expect(view.getByLabelText('排队消息正文').props.value).toBe(row.text);
 await fireEvent.changeText(view.getByLabelText('排队消息正文'),'Accepted');await fireEvent.press(view.getByLabelText('保存排队消息'));await waitFor(()=>expect(value.onEdit).toHaveBeenCalledWith(row.id,'Accepted',row.text));await waitFor(()=>expect(view.queryByLabelText('排队消息正文')).toBeNull());
 await open(view);expect(view.getByLabelText('排队消息正文').props.value).toBe(row.text);expect(value.onResume).not.toHaveBeenCalled();await view.unmount();
});

test('network rejection keeps the edit across a complete unmount',async()=>{
 const value={...props('rejected'),onEdit:jest.fn(async()=>{throw new Error('Computer unavailable');})},first=await render(<QueuedMessages {...value}/>);await open(first);
 await fireEvent.changeText(first.getByLabelText('排队消息正文'),'Retry this later');await fireEvent.press(first.getByLabelText('保存排队消息'));await waitFor(()=>expect(first.getByText('Computer unavailable')).toBeTruthy());await first.unmount();
 const second=await render(<QueuedMessages {...value}/>);await open(second);expect(second.getByLabelText('排队消息正文').props.value).toBe('Retry this later');expect(value.onResume).not.toHaveBeenCalled();await second.unmount();
});

test('a queue that becomes locked while the draft is saving cannot mutate the remote row',async()=>{
 const value=props('lock-race'),view=await render(<QueuedMessages {...value}/>);await open(view);await fireEvent.changeText(view.getByLabelText('排队消息正文'),'Preserve locked edit');
 let finish!:()=>void;mockSet.mockImplementationOnce((key,value)=>new Promise<void>(resolve=>{finish=()=>{mockSettings.set(key,value);resolve();};}));
 await fireEvent.press(view.getByLabelText('保存排队消息'));await waitFor(()=>expect(finish).toBeDefined());await view.rerender(<QueuedMessages {...value} disabled/>);await act(async()=>finish());
 expect(value.onEdit).not.toHaveBeenCalled();expect(view.getByLabelText('排队消息正文').props.value).toBe('Preserve locked edit');await view.unmount();
});

test('losing the connection still permits cancelling a local edit without changing the queued message',async()=>{
 const value=props('offline-cancel'),view=await render(<QueuedMessages {...value}/>);await open(view);
 await fireEvent.changeText(view.getByLabelText('排队消息正文'),'Discard only this local edit');
 await view.rerender(<QueuedMessages {...value} disabled/>);
 await fireEvent.press(view.getByLabelText('取消编辑排队消息'));
 await waitFor(()=>expect(view.queryByLabelText('排队消息正文')).toBeNull());
 expect(value.onEdit).not.toHaveBeenCalled();expect(value.onResume).not.toHaveBeenCalled();
 await view.rerender(<QueuedMessages {...value}/>);await open(view);
 expect(view.getByLabelText('排队消息正文').props.value).toBe(row.text);await view.unmount();
});
