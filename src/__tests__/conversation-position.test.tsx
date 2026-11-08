import {act,renderHook,waitFor} from '@testing-library/react-native';
import type {FlatList} from 'react-native';
import {conversationPositionKey,useConversationPosition,type ConversationPosition} from '../remote/useConversationPosition';

const mockRead=jest.fn(),mockWrite=jest.fn(),mockToast=jest.fn(),saved=new Map<string,string>();
jest.mock('../storage/database',()=>({getSetting:(...args:unknown[])=>mockRead(...args),setSetting:(...args:unknown[])=>mockWrite(...args)}));
jest.mock('../components/ui',()=>({showToast:(...args:unknown[])=>mockToast(...args)}));
const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const stored:ConversationPosition={anchor:'middle',tail:'last',distance:600,offset:400,atBottom:false};
const rows=[{id:'first'},{id:'middle'},{id:'last'}];
const scroll=(y:number,height=1500)=>({nativeEvent:{contentOffset:{y},contentSize:{height},layoutMeasurement:{height:500}}} as never);
const layout={nativeEvent:{layout:{height:500}}};
type PositionOptions=Parameters<typeof useConversationPosition<{id:string}>>[0];
async function setup(scope='pc/agent/api/project/code/session',extra:Partial<PositionOptions>={}){
  const methods={scrollToEnd:jest.fn(),scrollToOffset:jest.fn(),scrollToIndex:jest.fn()},follow=jest.fn(),load=jest.fn();
  const list={current:methods as unknown as FlatList<{id:string}>};
  const initial:PositionOptions={scope,active:true,blocks:rows,list,onFollow:follow,loadEarlier:load,...extra};
  const hook=await renderHook((props:typeof initial)=>useConversationPosition(props),{initialProps:initial});
  return {...hook,methods,follow,load,initial};
}
beforeEach(()=>{saved.clear();jest.clearAllMocks();mockRead.mockImplementation(async(key:string)=>saved.get(key)??null);mockWrite.mockImplementation(async(key:string,value:string)=>{saved.set(key,value);});});

test('reopening a conversation restores its saved distance without following later messages',async()=>{
  const first=await setup();await act(async()=>{});
  await act(async()=>{first.result.current.onLayout(layout);first.result.current.onContentSizeChange(700,1500);first.result.current.interact();first.result.current.onScroll(scroll(400));first.result.current.onViewableItemsChanged({viewableItems:[{item:rows[1],key:'middle',index:1,isViewable:true}]});});
  await first.unmount();await waitFor(()=>expect(saved.has(conversationPositionKey(first.initial.scope))).toBe(true));
  expect(JSON.parse(saved.get(conversationPositionKey(first.initial.scope))!)).toEqual(stored);
  const reopened=await setup();await act(async()=>{});
  await act(async()=>{reopened.result.current.onLayout(layout);reopened.result.current.onContentSizeChange(700,1500);});
  expect(reopened.methods.scrollToOffset).toHaveBeenLastCalledWith({offset:400,animated:false});
  expect(reopened.methods.scrollToEnd).not.toHaveBeenCalled();expect(reopened.follow).toHaveBeenLastCalledWith(false);
  await act(async()=>{reopened.result.current.onContentSizeChange(700,1700);});
  expect(reopened.methods.scrollToOffset).toHaveBeenCalledTimes(1);expect(reopened.methods.scrollToEnd).not.toHaveBeenCalled();
  await reopened.unmount();
});

test('a changed tail restores the saved message identity instead of applying the old bottom distance',async()=>{
  saved.set(conversationPositionKey('new-reply'),JSON.stringify(stored));const hook=await setup('new-reply',{blocks:[...rows,{id:'new-answer'}]});
  await act(async()=>{hook.result.current.onLayout(layout);hook.result.current.onContentSizeChange(700,1800);});
  expect(hook.methods.scrollToIndex).toHaveBeenCalledWith({index:1,viewPosition:0,animated:false});
  expect(hook.methods.scrollToEnd).not.toHaveBeenCalled();await hook.unmount();
});

test.each(['drag','wheel'])('a %s before hydration outruns a late stored position',async(kind)=>{
  const pending=deferred<string|null>();mockRead.mockReturnValueOnce(pending.promise);const hook=await setup(`late-${kind}`);
  await act(async()=>{hook.result.current.onLayout(layout);hook.result.current.onContentSizeChange(700,1500);if(kind==='drag')hook.result.current.interact();hook.result.current.onScroll(scroll(550));});
  await act(async()=>pending.resolve(JSON.stringify(stored)));
  expect(hook.methods.scrollToEnd).not.toHaveBeenCalled();expect(hook.methods.scrollToIndex).not.toHaveBeenCalled();expect(hook.methods.scrollToOffset).not.toHaveBeenCalled();
  await hook.unmount();await waitFor(()=>expect(JSON.parse(saved.get(conversationPositionKey(`late-${kind}`))!).offset).toBe(550));
});

test('source changes retire reads, layout and viewability callbacks from the old computer',async()=>{
  const pending=deferred<string|null>();mockRead.mockReturnValueOnce(pending.promise);const hook=await setup('old');const old=hook.result.current;
  await hook.rerender({...hook.initial,scope:'new'});await act(async()=>{});
  await act(async()=>{old.onLayout(layout);old.onContentSizeChange(700,1500);old.onScroll(scroll(400));old.onViewableItemsChanged({viewableItems:[{item:rows[1],key:'middle',index:1,isViewable:true}]});pending.resolve(JSON.stringify(stored));});
  expect(hook.methods.scrollToOffset).not.toHaveBeenCalled();expect(hook.methods.scrollToIndex).not.toHaveBeenCalled();expect(mockWrite).not.toHaveBeenCalled();
  await hook.unmount();
});

test('restoration loads older pages only until the saved anchor is available',async()=>{
  saved.set(conversationPositionKey('older'),JSON.stringify(stored));const hook=await setup('older',{blocks:[{id:'new'}],earlierCursor:'page-1',earlierLoading:false});
  await act(async()=>{hook.result.current.onLayout(layout);hook.result.current.onContentSizeChange(700,900);});
  expect(hook.load).toHaveBeenCalledTimes(1);expect(hook.result.current.canFollow()).toBe(false);
  await hook.rerender({...hook.initial,blocks:[{id:'new'}],earlierCursor:'page-1',earlierLoading:true});
  await hook.rerender({...hook.initial,blocks:[{id:'older-but-not-anchor'},{id:'new'}],earlierCursor:'page-2',earlierLoading:false});
  expect(hook.load).toHaveBeenCalledTimes(2);
  await hook.rerender({...hook.initial,blocks:[...rows,{id:'new'}],earlierCursor:undefined,earlierLoading:false});
  expect(hook.methods.scrollToIndex).not.toHaveBeenCalled();
  await act(async()=>{hook.result.current.onContentSizeChange(700,2200);});
  expect(hook.methods.scrollToIndex).toHaveBeenCalledWith({index:1,viewPosition:0,animated:false});expect(hook.methods.scrollToEnd).not.toHaveBeenCalled();
  await hook.unmount();
});

test('manual scrolling cancels history restoration and later prepends do not reposition it',async()=>{
  saved.set(conversationPositionKey('cancel-history'),JSON.stringify(stored));const hook=await setup('cancel-history',{blocks:[{id:'new'}],earlierCursor:'page-1'});
  await act(async()=>{hook.result.current.onLayout(layout);hook.result.current.onContentSizeChange(700,900);hook.result.current.interact();hook.result.current.onScroll(scroll(100,900));});
  await hook.rerender({...hook.initial,blocks:[...rows,{id:'new'}],earlierCursor:undefined});
  await act(async()=>{expect(hook.result.current.onContentSizeChange(700,2200)).toBe(false);});
  expect(hook.methods.scrollToIndex).not.toHaveBeenCalled();expect(hook.methods.scrollToOffset).not.toHaveBeenCalled();expect(hook.methods.scrollToEnd).not.toHaveBeenCalled();
  await hook.unmount();
});

test('a failed indexed restore retry cannot override a later user navigation',async()=>{
  saved.set(conversationPositionKey('retry'),JSON.stringify(stored));const hook=await setup('retry',{blocks:[...rows,{id:'new'}]});
  await act(async()=>{hook.result.current.onLayout(layout);hook.result.current.onContentSizeChange(700,1800);});
  await act(async()=>{expect(hook.result.current.onScrollToIndexFailed({index:1,averageItemLength:200})).toBe(true);hook.result.current.interact();});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,150));});
  expect(hook.methods.scrollToIndex).toHaveBeenCalledTimes(1);await hook.unmount();
});

test('save failures keep the position in memory and retry on a later flush',async()=>{
  mockWrite.mockRejectedValueOnce(new Error('disk busy'));const hook=await setup('failure');await act(async()=>{});
  await act(async()=>{hook.result.current.onLayout(layout);hook.result.current.onContentSizeChange(700,1500);hook.result.current.interact();hook.result.current.onScroll(scroll(400));});
  await waitFor(()=>expect(mockToast).toHaveBeenCalledWith('阅读位置暂未保存，本次仍然有效','alert'));
  await hook.unmount();await waitFor(()=>expect(JSON.parse(saved.get(conversationPositionKey('failure'))!).offset).toBe(400));
});

test('reopening waits for a pending durable write before reading the position',async()=>{
  const pending=deferred<void>();mockWrite.mockImplementationOnce(async(key:string,value:string)=>{await pending.promise;saved.set(key,value);});
  const first=await setup('write-order');await act(async()=>{});
  await act(async()=>{first.result.current.onLayout(layout);first.result.current.onContentSizeChange(700,1500);first.result.current.interact();first.result.current.onScroll(scroll(400));first.result.current.onViewableItemsChanged({viewableItems:[{item:rows[1],key:'middle',index:1,isViewable:true}]});});
  await first.unmount();await waitFor(()=>expect(mockWrite).toHaveBeenCalledTimes(1));
  const next=await setup('write-order');await act(async()=>{next.result.current.onLayout(layout);next.result.current.onContentSizeChange(700,1500);});
  expect(next.methods.scrollToEnd).not.toHaveBeenCalled();expect(next.methods.scrollToOffset).not.toHaveBeenCalled();
  await act(async()=>pending.resolve());
  expect(next.methods.scrollToOffset).toHaveBeenCalledWith({offset:400,animated:false});await next.unmount();
});
