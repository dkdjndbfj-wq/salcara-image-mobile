import {useEffect,useRef} from 'react';
import {ScrollView,type LayoutChangeEvent,type NativeScrollEvent,type NativeSyntheticEvent} from 'react-native';

/** Keep the selected page label visible as the tab strip grows on tablets. */
export function useWorkspaceTabScroll(activeId:string){
  const ref=useRef<ScrollView>(null),active=useRef(activeId),width=useRef(0),offset=useRef(0);
  const positions=useRef(new Map<string,{x:number;width:number}>());active.current=activeId;
  const reveal=()=>{
    const tab=positions.current.get(active.current);if(!tab||!width.current)return;
    const next=tab.x<offset.current?tab.x:tab.x+tab.width>offset.current+width.current?tab.x+tab.width-width.current:offset.current;
    if(next!==offset.current){offset.current=Math.max(0,next);ref.current?.scrollTo({x:offset.current,animated:false});}
  };
  useEffect(reveal,[activeId]);
  return {ref,onLayout:(event:LayoutChangeEvent)=>{width.current=event.nativeEvent.layout.width;reveal();},onContentSizeChange:reveal,
    onScroll:(event:NativeSyntheticEvent<NativeScrollEvent>)=>{offset.current=event.nativeEvent.contentOffset.x;},
    tabLayout:(id:string,event:LayoutChangeEvent)=>{positions.current.set(id,event.nativeEvent.layout);if(id===active.current)reveal();}};
}
