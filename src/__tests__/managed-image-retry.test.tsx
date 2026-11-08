import React from 'react';
import {act,fireEvent,render} from '@testing-library/react-native';
import {ManagedImage} from '../remote/ManagedImage';
const mockPreview=jest.fn();
jest.mock('../remote/useManagedImage',()=>({useManagedImage:(...args:unknown[])=>mockPreview(...args)}));
jest.mock('../components/Icon',()=>({Icon:()=>null}));
jest.mock('../theme',()=>({useDesk:()=>({muted:'#888'})}));
beforeEach(()=>{mockPreview.mockReset().mockImplementation((uri:string,_variant:string,_visible:boolean,_region:unknown,retry:number)=>({uri:retry?`${uri}-preview`:undefined,error:retry?undefined:'Preview failed',active:true,foreground:true,loading:false}));});
const press=async(view:Awaited<ReturnType<typeof render>>)=>{const event={stopPropagation:jest.fn()};await fireEvent.press(view.getByLabelText('重新加载图片预览'),event);expect(event.stopPropagation).toHaveBeenCalled();};

test('failed thumbnail retries in place and does not open its surrounding viewer',async()=>{
 const view=await render(<ManagedImage uri="image-a" testID="thumbnail" style={{width:64,height:64}}/>);await press(view);
 expect(view.queryByLabelText('重新加载图片预览')).toBeNull();expect(view.getByTestId('thumbnail').props.source).toEqual({uri:'image-a-preview'});await view.unmount();
});
test('a native image error can be retried and late callbacks from the old attempt stay retired',async()=>{
 mockPreview.mockImplementation((uri:string)=>({uri,active:true,foreground:true,loading:false}));
 const view=await render(<ManagedImage uri="image-a" testID="thumbnail"/>),old=view.getByTestId('thumbnail').props.onError;
 await act(async()=>old({nativeEvent:{error:'decode failure'}}));await press(view);await act(async()=>old({nativeEvent:{error:'late error'}}));
 expect(view.queryByLabelText('重新加载图片预览')).toBeNull();expect(view.getByTestId('thumbnail')).toBeTruthy();await view.unmount();
});
test('rapid retry taps share one original read and changing source retires its outcome',async()=>{
 let finish!:()=>void;const retry=jest.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
 const view=await render(<ManagedImage uri="image-a" onRetry={retry}/>);await press(view);await fireEvent.press(view.getByLabelText('重新加载图片预览'),{stopPropagation:jest.fn()});expect(retry).toHaveBeenCalledTimes(1);
 await view.rerender(<ManagedImage uri="image-b" onRetry={retry}/>);await act(async()=>finish());
 expect(mockPreview.mock.calls.at(-1)?.[0]).toBe('image-b');expect(mockPreview.mock.calls.at(-1)?.[4]).toBe(0);expect(view.getByLabelText('重新加载图片预览')).toBeTruthy();await view.unmount();
});
test('failed original recovery keeps the placeholder for another retry',async()=>{
 const retry=jest.fn(async()=>{throw new Error('Offline');}),view=await render(<ManagedImage uri="image-a" onRetry={retry}/>);await press(view);expect(view.getByLabelText('重新加载图片预览')).toBeTruthy();expect(mockPreview.mock.calls.at(-1)?.[4]).toBe(0);await view.unmount();
});
