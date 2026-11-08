import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/** Recovery only reads host snapshots. It never replays a task command. A
 * failed/busy attempt remains eligible for the next bounded interval. */
export function useDirectHistoryRecovery({enabled,source,revision,needed,recover,onSuspend}:{
  enabled:boolean;source:string;revision:number;needed:boolean;recover:()=>Promise<'success'|'failure'|void>;
  onSuspend?:()=>void;
}) {
  const live=useRef({enabled,needed,recover,onSuspend});live.current={enabled,needed,recover,onSuspend};
  useEffect(()=>{
    if(!enabled)return;
    let active=AppState.currentState!=='background'&&AppState.currentState!=='inactive',disposed=false,delay=15000,flight=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const run=async(force=false)=>{
      if(disposed||flight||!active)return;
      if(timer)clearTimeout(timer);flight=true;
      try{if(active&&live.current.enabled&&(force||live.current.needed)){
        const result=await live.current.recover();
        if(result==='failure')delay=Math.min(60000,delay*2);else if(result==='success')delay=15000;
      }}catch{delay=Math.min(60000,delay*2);}
      finally{flight=false;if(!disposed&&active)timer=setTimeout(()=>void run(),delay);}
    };
    if(active){if(revision>0)void run(true);else timer=setTimeout(()=>void run(),delay);}
    const subscription=AppState.addEventListener('change',state=>{
      const wasActive=active;active=state==='active';
      if(!active){if(timer)clearTimeout(timer);if(wasActive)live.current.onSuspend?.();}
      else if(!wasActive){delay=15000;void run(true);}
    });
    return()=>{disposed=true;if(timer)clearTimeout(timer);subscription.remove();};
  },[enabled,source,revision]);
}
