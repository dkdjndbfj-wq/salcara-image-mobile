import {useLayoutEffect, useRef, useState} from 'react';
import {Animated, Easing} from 'react-native';

export type SidebarPresenceOptions = {visible:boolean; docked:boolean; scopeKey:string; reduced:boolean};

/** Retain only this source's drawer while its non-interactive exit finishes. */
export function useSidebarPresence({visible,docked,scopeKey,reduced}:SidebarPresenceOptions):{present:boolean;progress:Animated.Value} {
  const [progress] = useState(()=>new Animated.Value(visible&&(docked||reduced)?1:0));
  const [retained,setRetained] = useState({scopeKey,present:visible});
  const generation = useRef(0);
  const owner = useRef({visible,docked,scopeKey,reduced});
  if(owner.current.visible!==visible||owner.current.docked!==docked||owner.current.scopeKey!==scopeKey||owner.current.reduced!==reduced) {
    owner.current={visible,docked,scopeKey,reduced};
  }
  const renderedOwner=owner.current;

  useLayoutEffect(()=>{
    const version=++generation.current;
    const current=()=>generation.current===version&&owner.current===renderedOwner;
    const retain=(present:boolean)=>{
      if(!current())return;
      setRetained(previous=>previous.scopeKey===scopeKey&&previous.present===present?previous:{scopeKey,present});
    };
    const changedScope=retained.scopeKey!==scopeKey;
    let animation:Animated.CompositeAnimation|undefined;
    if(docked||reduced) {
      progress.setValue(visible?1:0);
      retain(visible);
    } else if(visible) {
      if(changedScope)progress.setValue(0);
      retain(true);
      animation=Animated.spring(progress,{toValue:1,stiffness:280,damping:32,mass:1,overshootClamping:true,
        useNativeDriver:true,isInteraction:false});
      animation.start();
    } else if(!changedScope&&retained.present) {
      animation=Animated.timing(progress,{toValue:0,duration:160,easing:Easing.out(Easing.cubic),useNativeDriver:true,isInteraction:false});
      animation.start(({finished})=>{if(finished)retain(false);});
    } else {
      progress.setValue(0);
      retain(false);
    }
    return ()=>{
      // Invalidate before stop: a native driver may synchronously finish its callback.
      ++generation.current;
      animation?.stop();
      progress.stopAnimation();
    };
  },[visible,docked,scopeKey,reduced,progress]);

  // A new source must never inherit the previous source's retained exit render.
  return {present:retained.scopeKey===scopeKey&&(visible||(!docked&&!reduced&&retained.present)),progress};
}
