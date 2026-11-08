import {act,renderHook} from '@testing-library/react-native';
import {Animated} from 'react-native';
import {useSidebarPresence,type SidebarPresenceOptions} from '../remote/useSidebarPresence';

type PendingAnimation={kind:'spring'|'timing';value:Animated.Value;config:Animated.SpringAnimationConfig|Animated.TimingAnimationConfig;
  complete?:(result:{finished:boolean})=>void;stop:jest.Mock};
let animations:PendingAnimation[];
const options:SidebarPresenceOptions={visible:false,docked:false,scopeKey:'computer-a/agent/code',reduced:false};
const valueOf=(value:Animated.Value)=>(value as Animated.Value&{__getValue:()=>number}).__getValue();
const latest=()=>animations[animations.length-1];
function animation(kind:PendingAnimation['kind'],value:Animated.Value|Animated.ValueXY,config:PendingAnimation['config']):Animated.CompositeAnimation {
  const pending:PendingAnimation={kind,value:value as Animated.Value,config,stop:jest.fn(()=>pending.complete?.({finished:false}))};
  animations.push(pending);
  return {start:complete=>{pending.complete=complete;},stop:pending.stop,reset:jest.fn()};
}
async function complete(pending:PendingAnimation,finished=true) {
  await act(async()=>{
    if(finished&&!pending.stop.mock.calls.length)pending.value.setValue(pending.config.toValue as number);
    // Retired native completion notifications may still arrive after stop().
    pending.complete?.({finished});
  });
}
beforeEach(()=>{
  animations=[];
  jest.spyOn(Animated,'spring').mockImplementation((value,config)=>animation('spring',value,config));
  jest.spyOn(Animated,'timing').mockImplementation((value,config)=>animation('timing',value,config));
});
afterEach(()=>jest.restoreAllMocks());

test('a phone drawer appears immediately and stays mounted until its exit finishes',async()=>{
  const hook=await renderHook(useSidebarPresence,{initialProps:options});
  expect(hook.result.current.present).toBe(false);expect(animations).toHaveLength(0);
  await hook.rerender({...options,visible:true});
  expect(hook.result.current.present).toBe(true);expect(latest().kind).toBe('spring');
  expect(latest().config).toMatchObject({toValue:1,useNativeDriver:true,isInteraction:false});
  await complete(latest());
  await hook.rerender(options);
  expect(hook.result.current.present).toBe(true);expect(latest().kind).toBe('timing');
  expect(latest().config).toMatchObject({toValue:0,duration:160,useNativeDriver:true,isInteraction:false});
  await complete(latest());
  expect(hook.result.current.present).toBe(false);expect(valueOf(hook.result.current.progress)).toBe(0);
  await hook.unmount();
});

test('rapid reopening preserves the current progress and a late exit cannot hide the reopened drawer',async()=>{
  const hook=await renderHook(useSidebarPresence,{initialProps:{...options,visible:true}});
  const progress=hook.result.current.progress;
  await complete(latest());await hook.rerender(options);
  const closing=latest();await act(async()=>progress.setValue(.45));
  await hook.rerender({...options,visible:true});
  expect(closing.stop).toHaveBeenCalledTimes(1);expect(hook.result.current.progress).toBe(progress);
  expect(valueOf(progress)).toBe(.45);expect(hook.result.current.present).toBe(true);
  await complete(closing);expect(hook.result.current.present).toBe(true);
  await complete(latest());await hook.rerender(options);
  expect(hook.result.current.present).toBe(true);
  await complete(latest());
  expect(hook.result.current.present).toBe(false);await hook.unmount();
});

test.each([false,true])('a source change cannot retain old exit content or accept its completion: visible=%s',async visible=>{
  const renders:Array<{scopeKey:string;present:boolean}>=[];
  const hook=await renderHook((props:SidebarPresenceOptions)=>{
    const state=useSidebarPresence(props);renders.push({scopeKey:props.scopeKey,present:state.present});return state;
  },{initialProps:{...options,visible:true}});
  await complete(latest());await hook.rerender(options);const closing=latest();
  const next={...options,scopeKey:'computer-b/agent/code',visible};
  await hook.rerender(next);
  expect(renders.find(render=>render.scopeKey===next.scopeKey)?.present).toBe(false);
  expect(closing.stop).toHaveBeenCalledTimes(1);
  expect(hook.result.current.present).toBe(visible);expect(valueOf(hook.result.current.progress)).toBe(0);
  await complete(closing);expect(hook.result.current.present).toBe(visible);
  await hook.rerender({...options,visible:true});
  await complete(closing);expect(hook.result.current.present).toBe(true);
  await hook.unmount();
});

test.each(['reduced','docked'] as const)('%s drawers settle immediately without starting animations',async mode=>{
  const initial={...options,[mode]:true};
  const hook=await renderHook(useSidebarPresence,{initialProps:initial});
  expect(hook.result.current.present).toBe(false);
  await hook.rerender({...initial,visible:true});
  expect(hook.result.current.present).toBe(true);expect(valueOf(hook.result.current.progress)).toBe(1);
  await hook.rerender(initial);
  expect(hook.result.current.present).toBe(false);expect(valueOf(hook.result.current.progress)).toBe(0);
  expect(animations).toHaveLength(0);await hook.unmount();
});

test.each(['reduced','docked'] as const)('switching to %s cancels a pending exit and its late completion',async mode=>{
  const hook=await renderHook(useSidebarPresence,{initialProps:{...options,visible:true}});
  await complete(latest());await hook.rerender(options);const closing=latest();
  await hook.rerender({...options,[mode]:true});
  expect(closing.stop).toHaveBeenCalledTimes(1);expect(hook.result.current.present).toBe(false);
  await hook.rerender({...options,[mode]:true,visible:true});
  await complete(closing);expect(hook.result.current.present).toBe(true);
  expect(valueOf(hook.result.current.progress)).toBe(1);expect(animations).toHaveLength(2);
  await hook.unmount();
});

test('an unchanged render does not restart motion and unmount retires pending callbacks',async()=>{
  let renders=0;
  const hook=await renderHook((props:SidebarPresenceOptions)=>{renders++;return useSidebarPresence(props);},{initialProps:{...options,visible:true}});
  await hook.rerender({...options,visible:true});expect(animations).toHaveLength(1);
  await hook.rerender(options);const closing=latest(),count=renders;
  await hook.unmount();expect(closing.stop).toHaveBeenCalledTimes(1);
  await complete(closing);expect(renders).toBe(count);
});
