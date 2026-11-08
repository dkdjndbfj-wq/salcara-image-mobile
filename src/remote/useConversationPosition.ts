import {useEffect, useMemo, useRef} from 'react';
import {AppState, type FlatList, type NativeScrollEvent, type NativeSyntheticEvent, type ViewToken} from 'react-native';
import {getSetting, setSetting} from '../storage/database';
import {showToast} from '../components/ui';

type Row = {id:string};
export interface ConversationPosition {
  anchor?:string;
  tail?:string;
  distance:number;
  offset:number;
  atBottom:boolean;
}
type Options<T extends Row> = {
  scope:string; active:boolean; blocks:readonly T[];
  list:React.RefObject<FlatList<T>|null>;
  earlierCursor?:string|null; earlierLoading?:boolean; earlierError?:boolean;
  loadEarlier?:()=>void|Promise<unknown>;
  onFollow:(follow:boolean)=>void;
};
const writes = new Map<string,Promise<void>>();
export const conversationPositionKey=(scope:string)=>`remote.reading-position.v1:${scope}`;
function parse(raw:string|null|undefined):ConversationPosition|undefined {
  if(!raw)return;
  try {
    const value=JSON.parse(raw);
    if(!Number.isFinite(value.distance)||value.distance<0||!Number.isFinite(value.offset)||value.offset<0||typeof value.atBottom!=='boolean')return;
    return {distance:value.distance,offset:value.offset,atBottom:value.atBottom,
      ...(typeof value.anchor==='string'?{anchor:value.anchor}:{}),...(typeof value.tail==='string'?{tail:value.tail}:{})};
  }catch{return;}
}
type Owner = {
  scope:string; active:boolean; alive:boolean; reading:boolean; restoring:boolean; intent:number;
  height:number; viewport:number; offset:number; anchor?:string; snapshot?:ConversationPosition; saved?:ConversationPosition;
  measuredRows?:string;
  dirty:boolean; timer?:ReturnType<typeof setTimeout>; retry?:ReturnType<typeof setTimeout>; deadline?:ReturnType<typeof setTimeout>;
  target?:number; attempts:number; requested:Set<string>; waiting?:string; sawLoading:boolean;
};
const newOwner=(scope:string,active:boolean):Owner=>({scope,active,alive:true,reading:active,restoring:active,intent:0,height:0,viewport:0,offset:0,dirty:false,attempts:0,requested:new Set(),sawLoading:false});
const rowSignature=(rows:readonly Row[])=>JSON.stringify([rows.length,rows[0]?.id,rows.at(-1)?.id]);

/** Only this hook owns restoration; normal scrolling and history prepends stay with FlatList. */
export function useConversationPosition<T extends Row>(options:Options<T>) {
  const latest=useRef(options);latest.current=options;
  const ownerRef=useRef<Owner>(newOwner(options.scope,options.active));
  if(ownerRef.current.scope!==options.scope||ownerRef.current.active!==options.active)ownerRef.current=newOwner(options.scope,options.active);
  const owner=ownerRef.current;
  const current=()=>ownerRef.current===owner&&owner.alive&&owner.active;
  const flush=(value:Owner)=>{
    if(value.timer)clearTimeout(value.timer);value.timer=undefined;
    if(!value.dirty||!value.snapshot)return;
    value.dirty=false;
    const key=conversationPositionKey(value.scope),serialized=JSON.stringify(value.snapshot);
    const run=(writes.get(key)??Promise.resolve()).catch(()=>{}).then(()=>setSetting(key,serialized));
    writes.set(key,run);
    void run.catch(()=>{value.dirty=true;if(ownerRef.current===value&&value.alive)showToast('阅读位置暂未保存，本次仍然有效','alert');})
      .finally(()=>{if(writes.get(key)===run)writes.delete(key);});
  };
  const capture=()=>{
    if(!current()||owner.restoring||owner.height<=0||owner.viewport<=0)return;
    const distance=Math.max(0,owner.height-owner.viewport-owner.offset);
    owner.snapshot={anchor:owner.anchor,tail:latest.current.blocks.at(-1)?.id,distance,offset:owner.offset,atBottom:distance<40};
    owner.dirty=true;if(owner.timer)clearTimeout(owner.timer);owner.timer=setTimeout(()=>flush(owner),250);
  };
  const finish=(follow:boolean)=>{
    owner.restoring=false;owner.waiting=undefined;
    if(owner.deadline)clearTimeout(owner.deadline);owner.deadline=undefined;
    latest.current.onFollow(follow);
  };
  const fallback=()=>{
    if(!current()||owner.reading||!owner.height||!owner.viewport)return;
    const saved=owner.saved;
    finish(saved?.atBottom??true);
    if(!saved||saved.atBottom)latest.current.list.current?.scrollToEnd({animated:false});
    else latest.current.list.current?.scrollToOffset({offset:Math.max(0,owner.height-owner.viewport-saved.distance),animated:false});
  };
  const attempt=()=>{
    if(!current()||!owner.restoring||owner.reading)return;
    const {blocks,earlierCursor,earlierLoading,earlierError,loadEarlier,list}=latest.current,saved=owner.saved;
    if(!saved||saved.atBottom){finish(true);if(owner.height&&blocks.length)list.current?.scrollToEnd({animated:false});return;}
    if(!owner.height||!owner.viewport||!blocks.length)return;
    const index=saved.anchor?blocks.findIndex(block=>block.id===saved.anchor):-1;
    if(index>=0){
      // A prepended page must finish layout before its new height can restore pixels.
      if(owner.measuredRows!==rowSignature(blocks))return;
      finish(false);
      // Unchanged tail keeps the exact pixel position. New tail uses the message identity.
      if(saved.tail===blocks.at(-1)?.id)list.current?.scrollToOffset({offset:Math.max(0,owner.height-owner.viewport-saved.distance),animated:false});
      else {owner.target=index;try{list.current?.scrollToIndex({index,viewPosition:0,animated:false});}catch{fallback();}}
      return;
    }
    if(saved.anchor&&earlierCursor&&loadEarlier&&!earlierError){
      if(earlierLoading){owner.sawLoading=true;return;}
      if(!owner.requested.has(earlierCursor)){
        owner.requested.add(earlierCursor);owner.waiting=earlierCursor;owner.sawLoading=false;
        try {
          const result=loadEarlier();
          if(result&&typeof result.then==='function')void result.catch(()=>{if(current()&&owner.restoring)fallback();});
        }catch{fallback();}
        if(!owner.deadline)owner.deadline=setTimeout(()=>{if(current()&&owner.restoring){fallback();showToast('较早的阅读位置尚未加载，已显示最近可用记录','alert');}},15000);
        return;
      }
      if(owner.waiting===earlierCursor&&!owner.sawLoading)return;
    }
    fallback();
  };
  useEffect(()=>{
    owner.alive=true;
    if(!owner.active)return()=>{owner.alive=false;};
    latest.current.onFollow(false);
    const key=conversationPositionKey(owner.scope),intent=owner.intent;
    void (writes.get(key)??Promise.resolve()).catch(()=>{}).then(()=>getSetting(key)).then(raw=>{
      if(!current()||owner.intent!==intent)return;
      owner.reading=false;owner.saved=parse(raw);owner.snapshot=owner.saved;owner.anchor=owner.saved?.anchor;attempt();
    }).catch(()=>{if(current()&&owner.intent===intent){owner.reading=false;attempt();}});
    const subscription=AppState.addEventListener('change',state=>{if(state!=='active')flush(owner);});
    return()=>{
      owner.alive=false;flush(owner);subscription.remove();
      if(owner.retry)clearTimeout(owner.retry);if(owner.deadline)clearTimeout(owner.deadline);
    };
  },[owner]); // Each owner is a single mount/source generation; old callbacks are inert.
  useEffect(()=>{attempt();},[owner,options.blocks,options.earlierCursor,options.earlierLoading,options.earlierError]);
  const interact=()=>{
    if(!current())return;
    owner.intent+=1;owner.reading=false;owner.target=undefined;
    if(owner.retry)clearTimeout(owner.retry);finish(false);
  };
  const onScroll=(event:NativeSyntheticEvent<NativeScrollEvent>)=>{
    if(!current())return false;
    const {contentOffset,contentSize,layoutMeasurement}=event.nativeEvent;
    // Wheel/trackpad scrolling on web may not emit a native drag-begin event.
    if(owner.reading&&contentOffset.y>0&&contentOffset.y!==owner.offset)interact();
    owner.offset=Math.max(0,contentOffset.y);owner.height=contentSize.height;owner.viewport=layoutMeasurement.height;
    if(owner.restoring){attempt();return false;}
    capture();return true;
  };
  const onContentSizeChange=(_width:number,height:number)=>{if(!current())return true;owner.height=height;owner.measuredRows=rowSignature(latest.current.blocks);const restoring=owner.restoring;attempt();return restoring;};
  const onLayout=(event:{nativeEvent:{layout:{height:number}}})=>{if(current()){owner.viewport=event.nativeEvent.layout.height;attempt();}};
  const onViewableItemsChanged=useMemo(()=>({viewableItems}:{viewableItems:ViewToken<T>[]})=>{
    if(!current()||owner.restoring)return;
    owner.anchor=viewableItems.find(item=>item.isViewable)?.item.id;
    if(owner.dirty&&owner.snapshot)owner.snapshot={...owner.snapshot,anchor:owner.anchor};
  },[owner]);
  const onScrollToIndexFailed=(info:{index:number;averageItemLength:number})=>{
    if(!current()||owner.target!==info.index)return false;
    const intent=owner.intent;owner.attempts+=1;
    latest.current.list.current?.scrollToOffset({offset:Math.max(0,info.averageItemLength*info.index),animated:false});
    if(owner.attempts<=2)owner.retry=setTimeout(()=>{
      if(!current()||intent!==owner.intent||owner.target!==info.index)return;
      try{latest.current.list.current?.scrollToIndex({index:info.index,viewPosition:0,animated:false});}catch{owner.target=undefined;}
    },120);
    else owner.target=undefined;
    return true;
  };
  const captureInteraction=()=>{const intent=owner.intent;return()=>current()&&owner.intent===intent;};
  return {interact,onScroll,onLayout,onContentSizeChange,onViewableItemsChanged,onScrollToIndexFailed,captureInteraction,canFollow:()=>current()&&!owner.restoring};
}
