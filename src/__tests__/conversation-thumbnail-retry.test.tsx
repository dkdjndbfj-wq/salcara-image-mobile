import React from 'react';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {BlockRow,ThreadUi} from '../remote/thread-rows';
import type {SentUserMessage} from '../remote/sent-message-revision';
jest.mock('../storage/database',()=>({getSetting:async()=>null,setSetting:async()=>{}}));
jest.mock('../remote/ManagedImage',()=>({ManagedImage:(props:object)=>require('react').createElement(require('react-native').View,{...props,testID:'loaded-thumbnail'})}));
const message:SentUserMessage={kind:'message',id:'image-input',role:'user',text:'Original picture',final:true,ts:1,attachments:[{id:'att_picture',mime:'image/png',width:20,height:20}]};
const ui={openDiff:jest.fn(),openImage:jest.fn(),requestAttachment:jest.fn(),openAttachment:jest.fn(),presentation:'tablet' as const};
const row=(load:(ref:any,signal:AbortSignal)=>Promise<string|undefined>)=><ThreadUi.Provider value={{...ui,getAttachmentThumbnail:load}}><BlockRow tool="codex" block={{type:'user',id:'image-row',item:message}} onOpenChild={jest.fn()}/></ThreadUi.Provider>;
beforeEach(()=>jest.clearAllMocks());
test('a failed remote thumbnail retries inside its bubble without opening the image workspace',async()=>{
 const load=jest.fn<Promise<string|undefined>,[any,AbortSignal]>(async()=>{throw new Error('Connection interrupted');});
 const view=await render(row(load));await waitFor(()=>expect(view.getByLabelText('重新加载图片预览')).toBeTruthy());load.mockResolvedValueOnce('file:///recovered.png');
 const stopPropagation=jest.fn();await fireEvent.press(view.getByLabelText('重新加载图片预览'),{stopPropagation});await waitFor(()=>expect(view.getByTestId('loaded-thumbnail').props.uri).toBe('file:///recovered.png'));
 expect(stopPropagation).toHaveBeenCalled();expect(load).toHaveBeenCalledTimes(2);expect(ui.openAttachment).not.toHaveBeenCalled();expect(ui.openImage).not.toHaveBeenCalled();await view.unmount();
});
test('a thumbnail response from the old computer cannot replace the next computer image',async()=>{
 let finish!:(uri:string)=>void;const old=jest.fn((_ref:any,_signal:AbortSignal)=>new Promise<string>(resolve=>{finish=resolve;})),next=jest.fn(async()=>'file:///new.png');
 const view=await render(row(old));await view.rerender(row(next));await waitFor(()=>expect(view.getByTestId('loaded-thumbnail').props.uri).toBe('file:///new.png'));expect(old.mock.calls[0][1].aborted).toBe(true);
 await act(async()=>finish('file:///old.png'));expect(view.getByTestId('loaded-thumbnail').props.uri).toBe('file:///new.png');await view.unmount();
});
