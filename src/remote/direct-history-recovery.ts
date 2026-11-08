import type {Timeline,TimelineItem} from './store';

type Output=Extract<TimelineItem,{kind:'message'|'reasoning'}>;
const partial=(item:TimelineItem):item is Output=>(item.kind==='reasoning'||item.kind==='message'&&item.role==='assistant')&&!item.final;
const key=(item:Output)=>`${item.kind}:${item.id}`;
const fingerprint=(item:Output)=>JSON.stringify([item.turnId,item.text]);
const GRACE_MS=60_000;
/** Only successful terminal-session snapshots count as evidence. Exhaustion
 * also requires a stable minute in the foreground. Returning from suspension
 * or a failed read starts a new observation window, never an overdue warning. */
export function createDirectHistoryRepairTracker(){
  const observations=new Map<string,{fingerprint:string;reads:number;since:number;exhausted:boolean}>();
  let failurePending=false,failedSince:number|undefined;
  return {
    suspend:()=>{observations.clear();failedSince=undefined;},
    failed:()=>{
      observations.clear();failurePending=true;
      const now=Date.now();if(failedSince===undefined||now<failedSince)failedSince=now;
      return now-failedSince>=GRACE_MS;
    },
    needed:(timeline:Timeline)=>failurePending||timeline.session?.status==='running'||Boolean(timeline.error)||timeline.items.some(item=>{
      if(!partial(item))return false;
      const observed=observations.get(key(item)),changed=observed&&observed.fingerprint!==fingerprint(item);
      return item.kind==='message'?item.streamState!=='incomplete'||Boolean(changed):!observed||Boolean(changed)||!observed.exhausted;
    }),
    observe:(timeline:Timeline):Timeline=>{
      failurePending=false;failedSince=undefined;
      if(timeline.session?.status==='running'){observations.clear();return timeline;}
      if(timeline.session?.status!=='idle'&&timeline.session?.status!=='failed')return timeline;
      const present=new Set<string>(),now=Date.now();let changed=false;
      const items=timeline.items.map(item=>{
        if(!partial(item))return item;
        const id=key(item),signature=fingerprint(item),previous=observations.get(id);present.add(id);
        const stable=previous?.fingerprint===signature&&now>=previous.since;
        const reads=stable?Math.min(3,previous.reads+1):1,since=stable?previous.since:now;
        const exhausted=reads>=3&&now-since>=GRACE_MS;
        observations.set(id,{fingerprint:signature,reads,since,exhausted});
        if(item.kind!=='message')return item;
        const streamState=exhausted?'incomplete' as const:item.streamState==='incomplete'&&!stable?undefined:item.streamState;
        if(streamState===item.streamState)return item;changed=true;return {...item,streamState};
      });
      for(const id of observations.keys())if(!present.has(id))observations.delete(id);
      return changed?{...timeline,items}:timeline;
    },
  };
}
