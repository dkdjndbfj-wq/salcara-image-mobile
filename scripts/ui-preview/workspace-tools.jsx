// Local interaction fixtures only; no remote requests or model calls.
import React, {useEffect,useMemo,useState} from 'react';
import {Pressable,ScrollView,Text,View,useWindowDimensions} from 'react-native';
import {BrowserElementEditor} from '../../src/remote/BrowserElementEditor';
import {RemoteReviewPage} from '../../src/remote/RemoteReviewPage';
import {ComputerUsePage} from '../../src/remote/ComputerUsePage';
import {TemporarySideChat} from '../../src/remote/TemporarySideChat';
import {DEMO_AGENT_FEATURES} from '../../src/remote/demo-agent-features';

export function TemporarySideToolsFixture(){
 const transport=useMemo(()=>{
  const sessionKey='codex:local-tools-fixture',revision='fixture-side-tools';
  const reading={scope:'local-tools-fixture',value:{sessionKey,revision,available:true,contextScope:'loadedSnapshot',contextMessages:2,contextTruncated:false,inputOptions:{version:1,model:true,effort:true,images:false,readOnly:true,defaultModel:'model-a',tools:{version:1,permissions:['workspace-write'],features:true}}}};
  let value;
  return {isCurrent:()=>true,read:async()=>reading,ask:async(_reading,_input,operationId)=>({sessionKey,operationId,state:'completed',answer:'本地只读示例回答',contextScope:'loadedSnapshot',contextMessages:2,contextTruncated:false}),models:async()=>({models:['model-a'],modelCapabilities:{'model-a':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['high']}}}),tools:async(_reading,request)=>{
   value={sessionKey,chainId:request.chainId,revision,permission:'workspace-write',state:'idle',canSend:true,answer:'',events:[],approvals:[],expiresAt:Date.now()+45000,...value,sequence:(value?.sequence||0)+1};
   const base={deviceId:'fixture',sessionKey,tool:'codex',ts:Date.now(),turnId:'private-fixture-turn'};
   if(request.action==='features')value={...value,features:DEMO_AGENT_FEATURES};
   if(request.action==='send')value={...value,state:'waiting_approval',canSend:false,turnId:base.turnId,lastOperationId:request.operationId,answer:'已读取项目结构，下一步等待确认。',events:[{...base,type:'tool',id:'fixture-side-read',kind:'command',title:'检查项目结构',status:'done',output:'src/\npackage.json\n项目检查完成'}],approvals:[{...base,type:'approval.request',approvalId:'fixture-side-approval',kind:'command',title:'允许项目内检查',detail:'npm run check',approvalOptions:{version:1,decisions:['allow','deny']}}]};
   if(request.action==='approve')value={...value,state:request.decision==='allow'?'running':'interrupted',canSend:request.decision!=='allow',approvals:[],answer:request.decision==='allow'?'已允许，正在检查项目。':'本次操作已拒绝。'};
   if(request.action==='stop')value={...value,state:'interrupted',canSend:true,approvals:[],answer:'临时任务已停止。'};
   if(request.action==='close')value={...value,state:'closed',canSend:false,approvals:[]};
   return {...value};
  }};
 },[]);
 return <View style={{flex:1,minHeight:0,backgroundColor:'#fff'}}><Text style={{padding:10,fontSize:12,color:'#666'}}>临时工具侧聊 · 本地交互示例</Text><TemporarySideChat visible scopeKey="local-tools-fixture" sessionKey="codex:local-tools-fixture" transport={transport}/></View>;
}

export function ComputerUseFixture(){
 const [uri,setUri]=useState(''),[connected,setConnected]=useState(true),[waiting,setWaiting]=useState(false),[running,setRunning]=useState(true),[enlarged,setEnlarged]=useState(false);
 useEffect(()=>{const accept=event=>{if(typeof event.detail==='string'&&event.detail.startsWith('data:image/png;base64,'))setUri(event.detail);};window.addEventListener('fixture-computer-frame',accept);return()=>window.removeEventListener('fixture-computer-frame',accept);},[]);
 const tools=[{kind:'tool',id:'fixture-frame',turnId:'fixture-turn',tool:'mcp',title:'本地预览截图',status:'done',ts:1000,computer:{version:1,surface:'browser',action:'screenshot',provider:'playwright'},...(uri?{attachments:[{id:`att_${'a'.repeat(32)}`,mime:'image/png',width:733,height:900,uri}]}:{})},{kind:'tool',id:'fixture-click',turnId:'fixture-turn',tool:'mcp',title:'示例操作状态',status:running?'running':'interrupted',ts:2000,computer:{version:1,surface:'browser',action:'click',provider:'playwright'}}];
 return <View style={{flex:1,minHeight:0,backgroundColor:'#fff'}}><Text style={{padding:10,fontSize:12,color:'#666'}}>电脑操作 · 本地交互示例，画面来自预览页</Text><ComputerUsePage items={tools} active connected={connected} sessionRunning={running} liveActivityIds={new Set(running?['fixture-click']:[])} waitingApproval={waiting} onStop={()=>setRunning(false)} onImage={()=>setEnlarged(true)}/><View style={{flexDirection:'row',gap:18,padding:12}}><Pressable accessibilityRole="button" accessibilityLabel="示例切换连接" onPress={()=>setConnected(value=>!value)}><Text>切换连接</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="示例切换审批" onPress={()=>setWaiting(value=>!value)}><Text>切换审批</Text></Pressable>{enlarged?<Text accessibilityLabel="已打开示例截图">已查看画面</Text>:null}</View></View>;
}

const element={id:'fixture-element',documentId:'fixture-document',revision:'a'.repeat(64),url:'http://localhost:4173/example',tag:'button',selector:'#continue',text:'继续',outerHTML:'<button id="continue">继续</button>',rect:{x:20,y:30,width:160,height:44},computed:{color:'rgb(255, 255, 255)','background-color':'rgb(24, 24, 27)','border-radius':'8px'},changes:[],sources:[{url:'http://localhost:4173/app.css',line:12,column:1,selector:'#continue'}]};
export function BrowserElementsFixture(){
 const {height}=useWindowDimensions(),[picking,setPicking]=useState(false),[draft,setDraft]=useState('');
 const [frame,setFrame]=useState({pageId:'fixture-page',url:element.url,width:640,height:480,nextSequence:1,domSupported:true,documentId:element.documentId,element});
 const input=async value=>{const next={...frame,element:{...frame.element,revision:(frame.element.revision[0]==='a'?'b':'a').repeat(64),changes:value.action==='style-undo'?[]:[{property:value.property,before:'',beforePriority:'',value:value.value,priority:value.important?'important':''}]}};setFrame(next);return next;};
 const changes=Object.fromEntries(frame.element.changes.map(change=>[change.property,change.value]));
 return <View style={{flex:1,minHeight:0,backgroundColor:'#fff'}}><Text style={{padding:16,fontSize:12,color:'#666'}}>网页元素 · 本地交互示例</Text><View style={{flex:1,minHeight:90,alignItems:'center',justifyContent:'center'}}><button id="fixture-button" onClick={()=>setPicking(false)} style={{color:changes.color||'white',background:'#18181b',border:0,borderRadius:changes['border-radius']||8,padding:'14px 52px',fontSize:16}}>继续</button></View><ScrollView style={{maxHeight:Math.max(160,height*.6),flexGrow:0,flexShrink:1}}><BrowserElementEditor frame={frame} active picking={picking} onPickingChange={setPicking} onInput={input} onCompose={text=>{setDraft(text);return true;}}/></ScrollView>{draft?<Text accessibilityLabel="已接收元素修改" style={{padding:12,fontSize:12,color:'#147d64'}}>元素修改已加入草稿</Text>:null}</View>;
}

export function RepositoryReviewFixture(){
 const factory=useMemo(()=>{
  const repositories=[{path:'web',name:'web',id:'a'.repeat(64)},{path:'api',name:'api',id:'b'.repeat(64)}],staged=new Set();
  const state=repo=>({repository:repo,revision:(repo.path==='web'?'c':'d').repeat(64),branch:'main',head:'a'.repeat(40),upstream:'',files:[],branches:['main'],worktrees:[],githubCLI:false});
  return ()=>({repositories:async()=>({repositories,truncated:false}),status:async path=>state(repositories.find(repo=>repo.path===path)||repositories[0]),review:async input=>{const repo=repositories.find(repo=>repo.path===input.repositoryPath)||repositories[0];return {scope:input.reviewScope,ref:'',base:'HEAD',state:state(repo),commits:[],files:staged.has(repo.path)&&input.reviewScope==='unstaged'?[]:[{path:'src/index.ts',diff:`diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const source = '${repo.path}-old';\n+export const source = '${repo.path}-new';`,patchRevision:repo.id,additions:1,deletions:1,binary:false,added:false,deleted:false,hunks:[{id:repo.id,header:'@@ -1 +1 @@',oldStart:1,oldCount:1,newStart:1,newCount:1}]}]};},mutate:async(_action,_revision,input)=>{const repo=repositories.find(repo=>repo.path===input.repositoryPath)||repositories[0];staged.add(repo.path);return {state:state(repo)};},diff:async()=>({path:'',diff:'',revision:'a'.repeat(64)}),dispose:()=>{}});
 },[]);
 return <View style={{flex:1,minHeight:0,backgroundColor:'#fff'}}><Text style={{padding:12,fontSize:12,color:'#666'}}>多仓库审查 · 本地交互示例</Text><RemoteReviewPage active selection={{deviceId:'fixture',agentId:'codex',sessionKey:'codex:fixture',surface:'cli',cwd:'/fixture'}} factory={factory}/></View>;
}
