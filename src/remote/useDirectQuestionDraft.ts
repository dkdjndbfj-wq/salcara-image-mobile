import {useEffect,useRef,useState} from 'react';
import type {ApprovalItem} from './thread-rows';
import type {QuestionDraft} from './QuestionCard';
import type {TimelineItem} from './store';
import {directQuestionDraftSource,finishDirectQuestionDraft,readDirectQuestionDraft,saveDirectQuestionDraft} from './direct-question-drafts';

export function useDirectQuestionDraft({scope,deviceId,sessionKey,question,items,isCurrent}:{
  scope:string;deviceId:string;sessionKey:string;question:ApprovalItem|null;items:TimelineItem[];isCurrent:()=>boolean;
}) {
  const source=question?directQuestionDraftSource(scope,deviceId,sessionKey,question):undefined;
  const identity=source?JSON.stringify([source.key,source.request]):'';
  const [state,setState]=useState<{identity:string;ready:boolean;draft?:QuestionDraft;error?:string}>({identity:'',ready:false});
  const [revision,retry]=useState(0),[clock,setClock]=useState(0);
  const latestDraft=useRef<{identity:string;draft:QuestionDraft}|undefined>(undefined);
  const live=useRef({identity,isCurrent});live.current={identity,isCurrent};
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!source)return;
    let alive=true;setState({identity,ready:false});
    void readDirectQuestionDraft(source).then(draft=>{if(alive)setState({identity,ready:true,draft});},reason=>{if(alive)setState({identity,ready:false,error:reason instanceof Error?reason.message:'问答草稿读取失败'});});
    return()=>{alive=false;};
  },[identity,revision]);
  const completed=useRef(new Set<string>());
  useEffect(()=>{
    const now=Date.now();let next=Infinity;
    for(const item of items){
      if(item.kind!=='approval'||item.approval!=='question')continue;
      if(item.state==='pending'&&(!item.expiresAt||item.expiresAt>now)){if(item.expiresAt)next=Math.min(next,item.expiresAt);continue;}
      const key=JSON.stringify([scope,deviceId,sessionKey,item.id,item.ts,item.state,item.expiresAt]);if(completed.current.has(key))continue;
      completed.current.add(key);if(completed.current.size>256)completed.current.delete(completed.current.values().next().value!);
      void finishDirectQuestionDraft(scope,deviceId,sessionKey,item.id,item.state==='pending'?item.expiresAt!:item.ts)
        .catch(reason=>{completed.current.delete(key);if(mounted.current)setState(value=>({...value,error:reason instanceof Error?reason.message:'问答草稿清理失败'}));});
    }
    if(Number.isFinite(next)){const timer=setTimeout(()=>setClock(value=>value+1),Math.min(next-now+1,2_147_483_647));return()=>clearTimeout(timer);}
  },[scope,deviceId,sessionKey,items,clock]);
  const ready=!source||state.identity===identity&&state.ready;
  const save=(id:string,draft:QuestionDraft)=>{
      if(!mounted.current||!source||!ready||id!==question?.id||live.current.identity!==identity||!live.current.isCurrent())return;
      latestDraft.current={identity,draft:JSON.parse(JSON.stringify(draft))};
      void saveDirectQuestionDraft(source,draft).then(()=>{if(mounted.current&&live.current.identity===identity)setState(value=>value.error?{...value,error:undefined}:value);},reason=>{
        if(mounted.current&&live.current.identity===identity)setState(value=>({...value,error:reason instanceof Error?reason.message:'问答草稿保存失败，输入仍保留'}));
      });
    };
  return {identity,ready,draft:state.identity===identity?state.draft:undefined,error:state.identity===identity?state.error:undefined,save,
    retry:()=>{if(question&&ready&&latestDraft.current?.identity===identity)save(question.id,latestDraft.current.draft);else retry(value=>value+1);}};
}
