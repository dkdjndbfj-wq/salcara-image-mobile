import React,{useMemo,useState} from 'react';
import {Text,View} from 'react-native';
import {DirectComposer} from '../../src/remote/DirectComposer';
import {KeyboardSafeView} from '../../src/components/KeyboardSafeView';
import {DEMO_AGENT_FEATURES} from '../../src/remote/demo-agent-features';
import {createContextFixture} from './context-fixture';
import {createSessionCommandFixture} from './remote-store';

/** Real Direct composer with local services; never opens a remote connection. */
export function DirectComposerFixture(){
 const [text,setText]=useState(''),[submitted,setSubmitted]=useState(''),[commandResult,setCommandResult]=useState('');
 const context=useMemo(()=>createContextFixture('codex:composer-fixture','local-composer-services'),[]);
 const sessionCommands=useMemo(()=>createSessionCommandFixture('codex:composer-fixture','local-composer-services'),[]);
 const profile={id:'codex',name:'Codex',tool:'codex',available:true,remoteSendSupported:true,api:{model:'gpt-5.1-codex'},capabilities:{features:true,modelOverride:true,imageInput:true,context:context.enabled,compact:context.enabled,contextReferences:true,sessionActions:sessionCommands.enabled,sessionWorkflows:sessionCommands.enabled,permissionModes:['ask','auto_review','full_access']}};
 const session={sessionKey:context.mode==='new'?undefined:'codex:composer-fixture',cwd:'C:/fixture',tool:'codex',title:'本地示例',status:'idle',collaborationMode:'default',model:'gpt-5.1-codex'};
 const services=useMemo(()=>({scope:'local-composer-services',isCurrent:()=>true,guard:()=>{},features:async()=>DEMO_AGENT_FEATURES,
  models:async()=>({models:['gpt-5.1-codex','model-with-a-long-name'],modelCapabilities:{'gpt-5.1-codex':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['low','medium','high']},'model-with-a-long-name':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['high']}}}),context,sessionCommands:sessionCommands.enabled?sessionCommands:undefined,sideQuestions:{},uploadImages:async()=>[]}),[context,sessionCommands]);
 const runtime=useMemo(()=>({scope:'local-composer-fixture',remote:{agents:{fixture:{autoAll:false}},devices:[],sessions:{fixture:{list:[]}}}}),[]);
 return <KeyboardSafeView style={{flex:1,minHeight:0,backgroundColor:'#fff'}}><Text style={{padding:12,fontSize:12,color:'#666'}}>直连输入框 · 本地交互示例</Text><View style={{flex:1}}/>{submitted?<Text accessibilityLabel="示例已发送" style={{padding:12}}>{submitted}</Text>:null}{commandResult?<Text accessibilityLabel="示例会话操作" style={{padding:12}}>{commandResult}</Text>:null}<DirectComposer services={services} runtime={runtime} deviceId="fixture" profile={profile} session={session} timeline={{items:[],loading:false}} tablet={false} text={text} onText={setText} getLatestText={()=>text} sending={false} canSend uncertain={false} onSend={async input=>{setSubmitted(input.inputText);return true;}} onStop={()=>{}} onReferenceConsumed={()=>{}}
  onNew={sessionCommands.enabled?()=>{setText('');setCommandResult('已打开新对话 · 本地示例');}:undefined}
  onOpenSession={sessionCommands.enabled?key=>setCommandResult(`已创建分支：${key}`):undefined}
  onArchive={sessionCommands.enabled?()=>setCommandResult('对话已归档 · 本地示例'):undefined}
  onReviewStarted={sessionCommands.enabled?()=>setCommandResult('审查已开始 · 本地示例'):undefined}/></KeyboardSafeView>;
}
