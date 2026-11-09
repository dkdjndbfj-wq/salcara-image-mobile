import React, { useEffect, useState } from 'react';
import { AppState, BackHandler, Pressable, Text, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { DirectComposer } from '../remote/DirectComposer';
import type {SlashCommandMenuProps} from '../remote/SlashCommandMenu';
import type { DirectSessionServices } from '../remote/direct-session-services';
import type { AgentProfile, SessionInfo } from '../remote/client';
import type { WorkspaceRuntime } from '../remote/WorkspaceRuntimeContext';

jest.mock('../remote/attachments',()=>({pickRemoteImages:jest.fn()}));
let mockSlashMenu:SlashCommandMenuProps;
let mockComposerSend:()=>void;
jest.mock('../remote/MainComposer',()=>{
  const React=require('react'),actual=jest.requireActual('../remote/MainComposer');
  return {...actual,MainComposerAction:(props:{label:string;onPress:()=>void})=>{if(props.label==='发送')mockComposerSend=props.onPress;return React.createElement(actual.MainComposerAction,props);}};
});
jest.mock('../remote/SlashCommandMenu',()=>{
  const React=require('react'),Actual=jest.requireActual('../remote/SlashCommandMenu').SlashCommandMenu;
  return {SlashCommandMenu:(props:SlashCommandMenuProps)=>{mockSlashMenu=props;return React.createElement(Actual,props);}};
});
const mockDraftRestore=jest.fn(),mockDraftSave=jest.fn(),mockDraftConsume=jest.fn();
jest.mock('../remote/direct-composer-drafts',()=>({createDirectComposerDraft:()=>({restore:mockDraftRestore,save:mockDraftSave,consume:mockDraftConsume,hydrate:async(value:any)=>value.images,close:jest.fn()})}));
jest.mock('../remote/ContextBar',()=>({ContextBar:require('react').forwardRef(()=>null)}));
jest.mock('../remote/ContextReferencePicker',()=>({ContextReferencePicker:(props:any)=>{
  const React=require('react'),{Pressable,Text}=require('react-native');
  return React.createElement(Pressable,{accessibilityLabel:'选择测试引用',onPress:()=>props.onSelect({kind:'message',sessionKey:'codex:s',messageId:'message-1',label:'Agent',text:'exact lines',startOffset:0,endOffset:11,capturedAt:1})},React.createElement(Text,null,'引用'));
}}));
jest.mock('../remote/WegentComposer',()=>({WegentComposerSurface:({children}:any)=>children,WegentComposerToolbar:({features,actions}:any)=>require('react').createElement(require('react-native').View,null,features,actions)}));
const profile:AgentProfile={id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,api:{accountId:'a',model:'model-a'} as any,
  capabilities:{modelOverride:true,features:true,contextReferences:true,permissionModes:['ask','auto_review','full_access'],steer:true} as any};
const session:SessionInfo={sessionKey:'codex:s',tool:'codex',client:'Codex',title:'Task',cwd:'C:/project',status:'idle',controllable:true,updatedAt:1};
const featureCatalog={collaborationModes:['default','plan'],skillsSupported:true,skills:[{name:'review',path:'C:/skills/review/SKILL.md',description:'Review changes'}]};
const runtime={scope:'binding',remote:{agents:{pc:{autoAll:false}},devices:[],sessions:{pc:{list:[]}}}} as unknown as WorkspaceRuntime;
const models=jest.fn(),features=jest.fn(),guard=jest.fn(),send=jest.fn();
let services:DirectSessionServices;
function Harness({status='idle',uncertain=false,sending=false,canSend=true,currentSettings,onContinue,onQueue,restoreRequest,onRestoreConsumed,agentProfile=profile,onNew,onSideChat}: {status?:SessionInfo['status'];uncertain?:boolean;sending?:boolean;canSend?:boolean;currentSettings?:Partial<SessionInfo>;onContinue?:any;onQueue?:any;restoreRequest?:any;onRestoreConsumed?:()=>void;agentProfile?:AgentProfile;onNew?:()=>void;onSideChat?:()=>void}){
  const [text,setText]=useState('update this');
  return <DirectComposer services={services} runtime={runtime} deviceId="pc" profile={agentProfile} session={{...session,...currentSettings,status}} timeline={{items:[],loading:false}} tablet text={text} onText={setText} sending={sending} canSend={canSend} uncertain={uncertain} onSend={send} onContinue={onContinue} onQueue={onQueue} onStop={()=>{}} onReferenceConsumed={()=>{}} restoreRequest={restoreRequest} onRestoreConsumed={onRestoreConsumed} onNew={onNew} onSideChat={onSideChat}/>;
}
beforeEach(()=>{
  jest.clearAllMocks();guard.mockReset();models.mockResolvedValue({models:['model-a','model-b'],modelCapabilities:{'model-b':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['high']}}});features.mockResolvedValue(featureCatalog);send.mockResolvedValue(true);
  jest.spyOn(AppState,'addEventListener').mockImplementation(()=>({remove:jest.fn()}));
  mockDraftRestore.mockResolvedValue(undefined);mockDraftSave.mockImplementation(async(value:any)=>({...value,revision:1,identity:'snapshot'}));mockDraftConsume.mockResolvedValue(true);
  services={scope:'binding/pc/codex:s/a',models,features,guard,isCurrent:()=>true,context:{},sideQuestions:{},uploadImages:jest.fn()} as unknown as DirectSessionServices;
});
afterEach(()=>{jest.restoreAllMocks();});

async function choosePlan(view:Awaited<ReturnType<typeof render>>){if(view.queryByLabelText('切换计划模式'))await fireEvent.press(view.getByLabelText('切换计划模式'));else{await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('计划模式'));}}

test('system Back dismisses the inline slash menu without consuming text or sending',async()=>{
  let back:Parameters<typeof BackHandler.addEventListener>[1]|undefined;
  jest.spyOn(BackHandler,'addEventListener').mockImplementation((_event,handler)=>{back=handler;return {remove:()=>{back=undefined;}};});
  const view=await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/model');
  expect(view.getByLabelText('选择模型，/model')).toBeTruthy();
  await act(async()=>{expect(back?.({type:'hardwareBackPress',timeStamp:Date.now()})).toBe(true);});
  expect(view.queryByLabelText('选择模型，/model')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/model');
  expect(send).not.toHaveBeenCalled();
  expect(back?.({type:'hardwareBackPress',timeStamp:Date.now()})).toBe(false);
  await view.unmount();
});

test('Hermes permits model choice only before creating the conversation and never implies effort support',async()=>{
  const hermes:AgentProfile={...profile,id:'hermes',tool:'hermes',capabilities:{...profile.capabilities!,modelOverride:false,startModelOverride:true}};
  const view=await render(<Harness agentProfile={hermes} currentSettings={{sessionKey:undefined}}/>);
  await fireEvent.press(view.getByLabelText('选择模型'));
  await fireEvent.press(view.getByLabelText('model-b'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  expect(view.queryByTestId('remote-effort-chip')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({model:'model-b'}));
  await view.unmount();models.mockClear();
  const existing=await render(<Harness agentProfile={hermes} currentSettings={{sessionKey:'hermes:existing',model:'model-b'}}/>);
  expect(existing.getByLabelText('选择模型')).toBeDisabled();
  expect(models).not.toHaveBeenCalled();await existing.unmount();
});

test('model, reasoning, plan, permission, skills and references submit through the captured Direct owner',async()=>{
  const view=await render(<Harness/>);await act(async()=>{});
  await fireEvent.press(view.getByLabelText('选择模型'));await act(async()=>{});
  await fireEvent.press(view.getByLabelText('model-b'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  await fireEvent.press(view.getByTestId('remote-effort-chip'));await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  await choosePlan(view);
  await fireEvent.press(view.getByLabelText('选择批准权限'));await fireEvent.press(view.getByLabelText('帮我批准'));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/review');
  await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'update this');
  await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('添加上下文引用'));await fireEvent.press(view.getByLabelText('选择测试引用'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(send).toHaveBeenCalledWith({owner:services.scope,inputText:'update this',model:'model-b',effort:'high',collaborationMode:'plan',permissionMode:'auto_review',
    skills:[{name:'review',path:'C:/skills/review/SKILL.md'}],contextReferences:[expect.objectContaining({text:'exact lines',messageId:'message-1'})]});
  expect(view.queryByLabelText('移除技能 review')).toBeNull();await view.unmount();
});

test('a selected permission cannot bypass the computer auto-all policy',async()=>{
  const view=await render(<Harness/>);await act(async()=>{});
  await fireEvent.press(view.getByLabelText('选择批准权限'));await fireEvent.press(view.getByLabelText('完全访问权限'));await fireEvent.press(view.getByLabelText('请求批准'));
  await fireEvent.press(view.getByLabelText('发送'));expect(send).toHaveBeenCalledWith(expect.objectContaining({permissionMode:'ask'}));await view.unmount();
});

test('the anchored permission menu uses the actual session mode without a follow-computer option',async()=>{
  const view=await render(<Harness currentSettings={{permissionMode:'auto_review'}}/>);
  await fireEvent.press(view.getByLabelText('选择批准权限'));
  expect(view.getByTestId('composer-permission-menu')).toBeTruthy();
  expect(view.getByRole('radio',{name:'帮我批准'}).props.accessibilityState.checked).toBe(true);
  expect(view.getByRole('radio',{name:'完全访问权限'}).props.accessibilityState.disabled).toBe(true);
  expect(view.queryByText('跟随电脑')).toBeNull();expect(view.queryByText('应用到下一条消息')).toBeNull();
  await view.unmount();
});

test('model and reasoning panels stay separate and resetting effort preserves the inherited model',async()=>{
  models.mockResolvedValue({models:['model-a','model-b'],modelCapabilities:{'model-a':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['high']}}});
  const view=await render(<Harness/>);
  await fireEvent.press(view.getByLabelText('选择模型'));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();
  expect(view.queryByTestId('main-effort-slider')).toBeNull();expect(view.queryByText('推理强度')).toBeNull();expect(view.queryByLabelText('更换对话 API')).toBeNull();
  await fireEvent.press(view.getByLabelText('关闭模型选择'));
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  expect(view.queryByTestId('remote-model-popover')).toBeNull();expect(view.queryByLabelText('更换推理模型')).toBeNull();
  await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(send).toHaveBeenLastCalledWith({owner:services.scope,inputText:'update this',effort:'high'});
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'reset effort');
  await fireEvent.press(view.getByTestId('remote-effort-chip'));
  await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',0);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  await fireEvent.press(view.getByLabelText('发送'));
  expect(send).toHaveBeenLastCalledWith({owner:services.scope,inputText:'reset effort'});
  await view.unmount();
});

test('model changes retain compatible effort and only reset unsupported levels',async()=>{
  models.mockResolvedValue({models:['model-a','model-b','model-c'],modelCapabilities:Object.fromEntries([['model-a',['high']],['model-b',['high']],['model-c',['low']]].map(([id,reasoningEfforts])=>[id,{source:'codex-model-list',reasoningKnown:true,reasoningEfforts}]))});
  const view=await render(<Harness/>);
  await fireEvent.press(view.getByLabelText('选择批准权限'));await fireEvent.press(view.getByLabelText('帮我批准'));
  await fireEvent.press(view.getByTestId('remote-effort-chip'));await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  for(const target of ['model-a','model-b','使用默认模型']){
    await fireEvent.press(view.getByLabelText('选择模型'));await fireEvent.press(view.getByLabelText(target));await fireEvent.press(view.getByLabelText('关闭模型选择'));
    expect(view.getByTestId('remote-effort-chip').props.accessibilityLabel).toBe('High');
  }
  await fireEvent.press(view.getByLabelText('选择模型'));await fireEvent.press(view.getByLabelText('model-c'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  expect(view.getByTestId('remote-effort-chip').props.accessibilityLabel).toBe('Default');
  await fireEvent.press(view.getByTestId('remote-effort-chip'));await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  await fireEvent.press(view.getByLabelText('选择模型'));await fireEvent.press(view.getByLabelText('使用默认模型'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  expect(view.getByTestId('remote-effort-chip').props.accessibilityLabel).toBe('Default');
  expect(view.getByText('帮我批准')).toBeTruthy();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('update this');
  await fireEvent.press(view.getByLabelText('发送'));expect(send).toHaveBeenLastCalledWith({owner:services.scope,inputText:'update this',permissionMode:'auto_review'});
  await view.unmount();
});

test('rapid sends share a single flight and ambiguous submissions retain selected context',async()=>{
  let finish!:(value:boolean)=>void;send.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=await render(<Harness/>);await act(async()=>{});
  await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('添加上下文引用'));await fireEvent.press(view.getByLabelText('选择测试引用'));
  await fireEvent.press(view.getByLabelText('发送'));await fireEvent.press(view.getByLabelText('发送'));expect(send).toHaveBeenCalledTimes(1);
  await act(async()=>finish(false));expect(view.getByText('Agent')).toBeTruthy();await view.unmount();
});

test('running steer never discards a queued file or message reference',async()=>{
  const view=await render(<Harness/>);await act(async()=>{});
  await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('添加上下文引用'));await fireEvent.press(view.getByLabelText('选择测试引用'));
  await view.rerender(<Harness status="running"/>);await fireEvent.press(view.getByLabelText('补充指令'));
  expect(send).not.toHaveBeenCalled();expect(view.getByText('技能、引用和图片已保留，请在本轮结束后发送。')).toBeTruthy();await view.unmount();
});

test.each(['plan','model','effort','permission'] as const)('running steer preserves an explicit %s choice until an ordinary next-turn send',async(choice)=>{
  const view=await render(<Harness/>);
  if(choice==='plan')await choosePlan(view);
  if(choice==='model'||choice==='effort'){
    await fireEvent.press(view.getByLabelText('选择模型'));await fireEvent.press(view.getByLabelText('model-b'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
    if(choice==='effort'){await fireEvent.press(view.getByTestId('remote-effort-chip'));await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);await fireEvent.press(view.getByLabelText('关闭推理强度选择'));}
  }
  if(choice==='permission'){await fireEvent.press(view.getByLabelText('选择批准权限'));await fireEvent.press(view.getByLabelText('帮我批准'));}
  await view.rerender(<Harness status="running"/>);
  await fireEvent.press(view.getByLabelText('补充指令'));
  expect(send).not.toHaveBeenCalled();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('update this');
  expect(view.getByText('当前任务进行中，已选择的计划、模型、推理或权限不能用于补充指令。草稿已保留，请在本轮结束后发送。')).toBeTruthy();
  await view.rerender(<Harness status="idle"/>);await fireEvent.press(view.getByLabelText('发送'));
  const selected=choice==='plan'?{collaborationMode:'plan'}:choice==='model'?{model:'model-b'}:choice==='effort'?{model:'model-b',effort:'high'}:{permissionMode:'auto_review'};
  expect(send).toHaveBeenCalledWith(expect.objectContaining(selected));expect(send).toHaveBeenCalledTimes(1);await view.unmount();
});

test('running steer accepts plain text with current session settings but no deliberate next-turn overrides',async()=>{
  const view=await render(<Harness status="running" currentSettings={{model:'model-b',collaborationMode:'plan',permissionMode:'auto_review'}}/>);
  expect(view.queryByText('当前任务进行中，已选择的计划、模型、推理或权限不能用于补充指令。草稿已保留，请在本轮结束后发送。')).toBeNull();
  await fireEvent.press(view.getByLabelText('补充指令'));
  expect(send).toHaveBeenCalledWith({owner:services.scope,inputText:'update this'});expect(send).toHaveBeenCalledTimes(1);await view.unmount();
});

test('an empty running composer exposes only the precise Stop action',async()=>{
  profile.capabilities!.preciseInterrupt=true;
  try{
    const view=await render(<Harness status="running" onQueue={jest.fn()}/>);
    await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'');
    expect(view.getByLabelText('停止当前任务')).toBeTruthy();expect(view.queryByLabelText('加入消息队列')).toBeNull();expect(view.queryByLabelText('发送')).toBeNull();await view.unmount();
  }finally{delete profile.capabilities!.preciseInterrupt;}
});

test('a source change invalidates an already-open composer before sending',async()=>{
  const view=await render(<Harness/>);await act(async()=>{});guard.mockImplementation(()=>{throw new Error('电脑已变化');});
  await fireEvent.press(view.getByLabelText('发送'));expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('the initial model catalog exposes reasoning and late results cannot replace another computer catalog',async()=>{
  const old=deferred<{models:string[]}>();models.mockImplementation(()=>old.promise);
  const view=await render(<Harness/>);expect(models).toHaveBeenCalledTimes(1);
  services={...services,scope:'binding/other-device/session/b',models:jest.fn(async()=>({models:['current-model'],modelCapabilities:{'model-a':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['high']}}})) as DirectSessionServices['models']};
  await view.rerender(<Harness/>);expect(view.getByTestId('remote-effort-chip')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('选择模型'));expect(view.getByLabelText('current-model')).toBeTruthy();
  await act(async()=>old.resolve({models:['old-model']}));
  expect(view.getByLabelText('current-model')).toBeTruthy();expect(view.queryByLabelText('old-model')).toBeNull();await view.unmount();
});

test('idle Continue submits chosen options while leaving later text untouched',async()=>{
  const flight=deferred<boolean>(),onContinue=jest.fn(()=>flight.promise);
  const view=await render(<Harness onContinue={onContinue}/>);
  await choosePlan(view);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'');
  await fireEvent.press(view.getByLabelText('继续任务'));
  expect(onContinue).toHaveBeenCalledWith(expect.objectContaining({owner:services.scope,inputText:'',collaborationMode:'plan'}));
  await act(async()=>view.getByLabelText('给电脑上的 Agent 发消息').props.onChangeText('later draft'));
  await act(async()=>flight.resolve(true));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('later draft');
  expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('running messages persist their complete selected draft before consuming the composer and never steer implicitly',async()=>{
  const onQueue=jest.fn().mockResolvedValue(true);
  const view=await render(<Harness onQueue={onQueue}/>);
  await fireEvent.press(view.getByLabelText('选择模型'));await fireEvent.press(view.getByLabelText('model-b'));await fireEvent.press(view.getByLabelText('关闭模型选择'));
  await choosePlan(view);
  await view.rerender(<Harness status="running" onQueue={onQueue}/>);
  await fireEvent.press(view.getByLabelText('加入消息队列'));
  expect(onQueue).toHaveBeenCalledWith(expect.objectContaining({text:'update this',model:'model-b',options:{collaborationMode:'plan'},images:[]}));
  expect(send).not.toHaveBeenCalled();expect(mockDraftConsume).toHaveBeenCalledTimes(1);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');await view.unmount();
});

test('failed queue persistence retains all input and explicit immediate steer remains separate',async()=>{
  const onQueue=jest.fn().mockRejectedValue(new Error('disk full'));
  const view=await render(<Harness status="running" onQueue={onQueue}/>);
  await fireEvent.press(view.getByLabelText('加入消息队列'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('update this');expect(mockDraftConsume).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('立即补充当前任务'));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({inputText:'update this'}));await view.unmount();
});

test('image retry requires explicit append and preserves the current unsent text and recovered pictures',async()=>{
  const restored={text:'original image task',options:{},model:'',effort:'',permission:'',images:[imageA],imageCount:1};
  const consumed=jest.fn(),request={id:'restore-image',text:restored.text,attachments:[{id:'image'}],load:jest.fn().mockResolvedValue(restored)};
  const view=await render(<Harness restoreRequest={request} onRestoreConsumed={consumed}/>);
  expect(request.load).not.toHaveBeenCalled();await fireEvent.press(view.getByLabelText('发送'));expect(send).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('将原消息追加到草稿'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('update this\n\noriginal image task');
  expect(view.getAllByLabelText(/^移除待发送图片 /)).toHaveLength(1);expect(consumed).toHaveBeenCalledTimes(1);
  expect(mockDraftSave).toHaveBeenCalledWith(expect.objectContaining({text:'update this\n\noriginal image task',images:[imageA]}));await view.unmount();
});

test('an unavailable original image keeps its restoration request and never submits a text-only retry',async()=>{
  const consumed=jest.fn(),request={id:'restore-missing',text:'Original photo',attachments:[{id:'image'}],load:jest.fn().mockRejectedValue(new Error('原图片读取失败'))};
  const view=await render(<Harness restoreRequest={request} onRestoreConsumed={consumed}/>);
  await fireEvent.press(view.getByLabelText('将原消息追加到草稿'));
  expect(view.getByText('原图片读取失败')).toBeTruthy();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('update this');
  await fireEvent.press(view.getByLabelText('发送'));expect(send).not.toHaveBeenCalled();expect(consumed).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('取消恢复并保留当前草稿'));expect(consumed).toHaveBeenCalledTimes(1);await view.unmount();
});

test('draft hydration restores choices and blocks sends before local state has been read',async()=>{
  let resolve!:(value:any)=>void;mockDraftRestore.mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const view=await render(<Harness/>);await fireEvent.press(view.getByLabelText('发送'));expect(send).not.toHaveBeenCalled();expect(mockDraftSave).not.toHaveBeenCalled();
  await act(async()=>resolve({text:'Saved prompt',images:[],imageCount:0,model:'model-b',effort:'high',permission:'ask',options:{collaborationMode:'plan'},revision:1}));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('Saved prompt');
  await fireEvent.press(view.getByLabelText('发送'));expect(send).toHaveBeenCalledWith(expect.objectContaining({model:'model-b',collaborationMode:'plan',permissionMode:'ask'}));
  expect(mockDraftConsume).toHaveBeenCalledTimes(1);await view.unmount();
});

test('background transition flushes the latest text and images before the debounce timer',async()=>{
  jest.useFakeTimers();const listeners=new Set<(state:string)=>void>();
  const listener=jest.spyOn(AppState,'addEventListener').mockImplementation((_event,callback:any)=>{listeners.add(callback);return {remove:()=>listeners.delete(callback)};});
  const imageInput=profile.capabilities!.imageInput;profile.capabilities!.imageInput=true;
  try{
    const picture={uri:'file:///draft-image.png',mime:'image/png',width:32,height:24,base64:'AQID'};
    require('../remote/attachments').pickRemoteImages.mockResolvedValue([picture]);
    const view=await render(<Harness/>);await act(async()=>{});mockDraftSave.mockClear();
    await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'just typed before locking');
    await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('添加图片'));
    expect(mockDraftSave).not.toHaveBeenCalled();
    await act(async()=>{listeners.forEach(callback=>callback('background'));});
    expect(mockDraftSave).toHaveBeenCalledWith(expect.objectContaining({text:'just typed before locking',images:[picture]}));
    expect(send).not.toHaveBeenCalled();
    const count=mockDraftSave.mock.calls.length;await act(async()=>{jest.advanceTimersByTime(300);});
    expect(mockDraftSave).toHaveBeenCalledTimes(count);await view.unmount();
  }finally{profile.capabilities!.imageInput=imageInput;listener.mockRestore();jest.useRealTimers();}
});

test('background flush does not overwrite an accepted draft waiting for cleanup',async()=>{
  const listeners=new Set<(state:string)=>void>();
  const listener=jest.spyOn(AppState,'addEventListener').mockImplementation((_event,callback:any)=>{listeners.add(callback);return {remove:()=>listeners.delete(callback)};});
  try{
    mockDraftConsume.mockResolvedValue(false);
    const view=await render(<Harness/>);await fireEvent.press(view.getByLabelText('发送'));
    const count=mockDraftSave.mock.calls.length;
    await act(async()=>{listeners.forEach(callback=>callback('inactive'));listeners.forEach(callback=>callback('background'));});
    expect(mockDraftSave).toHaveBeenCalledTimes(count);expect(send).toHaveBeenCalledTimes(1);await view.unmount();
  }finally{listener.mockRestore();}
});

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
function DraftRaceHarness({source='a'}:{source?:string}){
  const [text,setText]=useState('update this');
  useEffect(()=>{if(source!=='a')setText(`new draft ${source}`);},[source]);
  return <View><Pressable accessibilityLabel="从正文追加引用" onPress={()=>setText(value=>`${value}\n\n> 新引用`)}><Text>引用</Text></Pressable>
    <Pressable accessibilityLabel="编辑下一条草稿" onPress={()=>setText('下一条尚未发送的消息')}><Text>编辑</Text></Pressable>
    <DirectComposer services={services} runtime={runtime} deviceId="pc" profile={{...profile,capabilities:{...profile.capabilities!,imageInput:true}}} session={session} timeline={{items:[],loading:false}} tablet text={text} onText={setText} sending={false} canSend uncertain={false} onSend={send} onStop={()=>{}} onReferenceConsumed={()=>{}}/>
  </View>;
}
const imageA={uri:'file:///a.png',base64:'YQ==',mime:'image/png',width:1,height:1};
const imageB={uri:'file:///b.png',base64:'Yg==',mime:'image/png',width:1,height:1};
function restoredImageDraft(){return {text:'update this',options:{},model:'',effort:'',permission:'',images:[imageA],imageCount:1,revision:1};}

test('a quote added while images upload survives acceptance and only the submitted text and image are consumed',async()=>{
  const upload=deferred<string[]>();mockDraftRestore.mockResolvedValue(restoredImageDraft());services.uploadImages=jest.fn(()=>upload.promise);
  const view=await render(<DraftRaceHarness/>);await fireEvent.press(view.getByLabelText('发送'));
  expect(services.uploadImages).toHaveBeenCalledWith([imageA]);expect(send).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('从正文追加引用'));
  await act(async()=>upload.resolve(['att_11111111222243338444555555555555']));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('> 新引用');
  expect(view.queryAllByLabelText('移除待发送图片')).toHaveLength(0);
  expect(mockDraftConsume).toHaveBeenCalledWith(expect.objectContaining({text:'update this',revision:1,identity:'snapshot'}));
  expect(mockDraftSave).toHaveBeenLastCalledWith(expect.objectContaining({text:'> 新引用',images:[]}));await view.unmount();
});

test('a late accepted receipt preserves replacement text and edits that arrive during draft consumption',async()=>{
  const receipt=deferred<boolean>(),consume=deferred<boolean>();send.mockImplementation(()=>receipt.promise);mockDraftConsume.mockImplementation(()=>consume.promise);
  const view=await render(<DraftRaceHarness/>);await fireEvent.press(view.getByLabelText('发送'));
  await fireEvent.press(view.getByLabelText('编辑下一条草稿'));await act(async()=>receipt.resolve(true));
  await fireEvent.press(view.getByLabelText('从正文追加引用'));await act(async()=>consume.resolve(true));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('下一条尚未发送的消息\n\n> 新引用');
  expect(mockDraftSave).toHaveBeenLastCalledWith(expect.objectContaining({text:'下一条尚未发送的消息\n\n> 新引用'}));await view.unmount();
});

test('a late image picker result stays in the next draft after the earlier attachment is acknowledged',async()=>{
  const picker=deferred<any[]>(),receipt=deferred<boolean>();mockDraftRestore.mockResolvedValue(restoredImageDraft());services.uploadImages=jest.fn(async()=>['att_11111111222243338444555555555555']);send.mockImplementation(()=>receipt.promise);
  require('../remote/attachments').pickRemoteImages.mockImplementation(()=>picker.promise);
  const view=await render(<DraftRaceHarness/>);await fireEvent.press(view.getByLabelText('添加到对话'));await fireEvent.press(view.getByLabelText('添加图片'));await fireEvent.press(view.getByLabelText('发送'));
  await act(async()=>picker.resolve([imageB]));await act(async()=>receipt.resolve(true));
  expect(view.getAllByLabelText(/^移除待发送图片 /)).toHaveLength(1);
  expect(mockDraftSave).toHaveBeenLastCalledWith(expect.objectContaining({images:[imageB],imageCount:1}));await view.unmount();
});

test('an accepted receipt from the old Direct scope never clears or unlocks the new scope draft',async()=>{
  const receipt=deferred<boolean>();send.mockImplementation(()=>receipt.promise);
  const view=await render(<DraftRaceHarness/>);await fireEvent.press(view.getByLabelText('发送'));
  services={...services,scope:'binding/pc/codex:other/b'};
  await view.rerender(<DraftRaceHarness source="b"/>);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('new draft b');
  await act(async()=>receipt.resolve(true));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('new draft b');
  expect(mockDraftSave.mock.calls.some(([value])=>value.text==='')).toBe(false);await view.unmount();
});

test('a failed draft revision comparison keeps visible text and requires reading the newer saved draft',async()=>{
  mockDraftConsume.mockResolvedValue(false);
  const view=await render(<DraftRaceHarness/>);await fireEvent.press(view.getByLabelText('发送'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('update this');
  expect(view.getByText('消息已发送，但草稿版本已变化，请重新读取草稿后核对')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('发送'));expect(send).toHaveBeenCalledTimes(1);await view.unmount();
});

test.each(['send','queue'] as const)('an accepted %s with failed draft consumption blocks repeats and autosave until cleanup is verified',async(action)=>{
  mockDraftConsume.mockRejectedValueOnce(new Error('Disk write failed'));
  const onQueue=jest.fn().mockResolvedValue(true),dispatch=action==='queue'?onQueue:send;
  const view=await render(<Harness status={action==='queue'?'running':'idle'} onQueue={action==='queue'?onQueue:undefined}/>);
  const actionLabel=action==='queue'?'加入消息队列':'发送';
  await fireEvent.press(view.getByLabelText(actionLabel));
  expect(dispatch).toHaveBeenCalledTimes(1);expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(false);
  expect(view.getByText('消息已提交，草稿清理失败，请重新读取并核对；不会再次发送。 Disk write failed')).toBeTruthy();
  const savedCalls=mockDraftSave.mock.calls.length;
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350));});
  expect(mockDraftSave).toHaveBeenCalledTimes(savedCalls);
  await fireEvent.press(view.getByLabelText(actionLabel));expect(dispatch).toHaveBeenCalledTimes(1);
  const original={...mockDraftSave.mock.calls[0][0],revision:1,identity:'snapshot'};
  mockDraftRestore.mockResolvedValue(original);
  await act(async()=>view.getByLabelText('给电脑上的 Agent 发消息').props.onChangeText('update this\n\nnext unsent draft'));
  await fireEvent.press(view.getByLabelText('重新读取草稿'));
  expect(dispatch).toHaveBeenCalledTimes(1);expect(mockDraftConsume).toHaveBeenCalledTimes(2);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('next unsent draft');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(true);
  expect(view.queryByLabelText('重新读取草稿')).toBeNull();await view.unmount();
});

test('rereading a changed draft after an accepted send stays blocked until the remaining content is explicitly selected',async()=>{
  mockDraftConsume.mockRejectedValueOnce(new Error('Disk write failed'));
  const view=await render(<Harness/>);await fireEvent.press(view.getByLabelText('发送'));
  const changed={...mockDraftSave.mock.calls[0][0],text:'update this\n\nanother saved draft',revision:2,identity:'newer-snapshot'};
  mockDraftRestore.mockResolvedValue(changed);
  await fireEvent.press(view.getByLabelText('重新读取草稿'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(false);
  await fireEvent.press(view.getByLabelText('发送'));expect(send).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('恢复已保存的剩余草稿'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('another saved draft');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.editable).toBe(true);expect(send).toHaveBeenCalledTimes(1);await view.unmount();
});

test('selecting a saved remainder removes the accepted image using its persisted private identity',async()=>{
  mockDraftRestore.mockResolvedValue(restoredImageDraft());
  mockDraftSave.mockImplementation(async(value:any)=>({...value,images:value.images.map((image:any)=>({...image,uri:`file:///private/${image.uri.split('/').pop()}`,base64:''})),revision:1,identity:'snapshot'}));
  mockDraftConsume.mockRejectedValueOnce(new Error('Disk write failed'));services.uploadImages=jest.fn(async()=>['att_11111111222243338444555555555555']);
  const view=await render(<DraftRaceHarness/>);await fireEvent.press(view.getByLabelText('发送'));
  const saved=await mockDraftSave.mock.results[0].value;
  mockDraftRestore.mockResolvedValue({...saved,text:'update this\n\nremaining',images:[...saved.images,imageB],imageCount:2,revision:2,identity:'newer'});
  await fireEvent.press(view.getByLabelText('重新读取草稿'));await fireEvent.press(view.getByLabelText('恢复已保存的剩余草稿'));
  expect(mockDraftSave).toHaveBeenLastCalledWith(expect.objectContaining({text:'remaining',images:[imageB]}));
  expect(view.getAllByLabelText(/^移除待发送图片 /)).toHaveLength(1);expect(send).toHaveBeenCalledTimes(1);await view.unmount();
});

test('slash send selects plan at the caret and leaves the task for a separate send',async()=>{
  const view=await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/plan 检查同步');
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'),'selectionChange',{nativeEvent:{selection:{start:5,end:5}}});
  await fireEvent.press(view.getByLabelText('发送'));
  expect(send).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe(' 检查同步');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.selection).toEqual({start:0,end:0});
  expect(view.getByLabelText('切换计划模式').props.accessibilityState.selected).toBe(true);
  await fireEvent.press(view.getByLabelText('发送'));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({inputText:' 检查同步',collaborationMode:'plan'}));await view.unmount();
});

test.each(['Enter','Tab'])('slash keyboard navigation browses skills and selects with %s without sending',async(key)=>{
  const view=await render(<Harness/>);
  const press=async(value:string,extra={})=>fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'),'keyPress',{nativeEvent:{key:value,...extra},preventDefault:jest.fn()});
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/');
  await press('ArrowDown');await press('ArrowUp');
  expect(view.getByLabelText('选择模型，/model').props.accessibilityState.selected).toBe(true);
  const skillsIndex=mockSlashMenu.entries.findIndex(entry=>entry.kind==='skills');expect(skillsIndex).toBeGreaterThan(0);
  for(let index=0;index<skillsIndex;index++)await press('ArrowDown');await press(key);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/skills ');
  await press(key,{isComposing:true});
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/skills ');
  await press(key);
  expect(view.getByLabelText('移除技能 review')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');expect(send).not.toHaveBeenCalled();
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'检查变更');await fireEvent.press(view.getByLabelText('发送'));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({inputText:'检查变更',skills:[expect.objectContaining({name:'review',path:'C:/skills/review/SKILL.md'})]}));await view.unmount();
});

test('slash selection changes only the command before the caret and ignores a text selection',async()=>{
  const view=await render(<Harness/>),text='先检查 /rev 再修复',caret='先检查 /rev'.length;
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),text);
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'),'selectionChange',{nativeEvent:{selection:{start:4,end:caret}}});
  expect(view.queryByTestId('remote-slash-menu')).toBeNull();
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'),'selectionChange',{nativeEvent:{selection:{start:caret,end:caret}}});
  await fireEvent.press(view.getByLabelText('选择技能 review，/review'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('先检查  再修复');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.selection).toEqual({start:4,end:4});expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('escape dismisses an unknown slash command without changing its literal text',async()=>{
  const view=await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/unknown');
  await fireEvent.press(view.getByLabelText('发送'));expect(send).not.toHaveBeenCalled();
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'),'keyPress',{nativeEvent:{key:'Escape'},preventDefault:jest.fn()});
  expect(view.queryByTestId('remote-slash-menu')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/unknown');
  await fireEvent.press(view.getByLabelText('发送'));expect(send).toHaveBeenCalledWith(expect.objectContaining({inputText:'/unknown'}));await view.unmount();
});

test('a pending slash catalog cannot dispatch text or select until its current response arrives',async()=>{
  const loading=deferred<typeof featureCatalog>();features.mockImplementation(()=>loading.promise);
  const view=await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/plan');
  expect(view.getByLabelText('正在读取快捷命令')).toBeTruthy();expect(view.queryByLabelText('选择计划模式，/plan')).toBeNull();
  await fireEvent.press(view.getByLabelText('发送'));
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'),'keyPress',{nativeEvent:{key:'Enter'},preventDefault:jest.fn()});
  expect(send).not.toHaveBeenCalled();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/plan');
  await act(async()=>loading.resolve(featureCatalog));await fireEvent.press(view.getByLabelText('发送'));
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('refresh retires captured slash rows immediately and a failure cannot reuse the old catalog',async()=>{
  const view=await render(<Harness/>);await choosePlan(view);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/');
  const menu=mockSlashMenu,choose=()=>menu.onSelect(menu.entries.find(entry=>entry.kind==='skill')!);
  let reject!:(reason:Error)=>void;features.mockImplementation(()=>new Promise((_,fail)=>{reject=fail;}));
  const reload=menu.onReload;
  await act(async()=>{reload();choose();});
  expect(view.queryByLabelText('移除技能 review')).toBeNull();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/');
  await act(async()=>reject(new Error('技能目录暂不可用')));
  expect(view.getByText('技能目录暂不可用')).toBeTruthy();expect(view.queryByLabelText('选择技能 review，/review')).toBeNull();
  await act(async()=>choose());expect(view.queryByLabelText('移除技能 review')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'保留计划任务');
  await fireEvent.press(view.getByLabelText('发送'));
  expect(send).not.toHaveBeenCalled();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('保留计划任务');await view.unmount();
});

test('late catalogs and captured slash callbacks cannot mutate a different Direct source',async()=>{
  const view=await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/');
  const menu=mockSlashMenu,choose=()=>menu.onSelect(menu.entries.find(entry=>entry.kind==='skill')!);
  const old=deferred<typeof featureCatalog>(),next=deferred<typeof featureCatalog>();
  features.mockImplementation(()=>old.promise);await fireEvent.press(view.getByLabelText('重新读取快捷命令'));
  services={...services,scope:'binding/pc/codex:other/b',features:jest.fn(()=>next.promise) as DirectSessionServices['features']};
  await view.rerender(<Harness/>);
  await act(async()=>{choose();old.resolve(featureCatalog);});
  expect(view.queryByLabelText('移除技能 review')).toBeNull();expect(view.queryByLabelText('选择技能 review，/review')).toBeNull();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/');
  await act(async()=>next.resolve({...featureCatalog,skills:[{name:'current',path:'C:/other/SKILL.md',description:'Current source'}]}));
  expect(view.getByLabelText('选择技能 current，/current')).toBeTruthy();expect(view.queryByLabelText('选择技能 review，/review')).toBeNull();expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('slash model selection remains available when only the skill catalog fails',async()=>{
  features.mockRejectedValue(new Error('技能目录暂不可用'));
  const view=await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/model');
  expect(view.getByText('技能目录暂不可用')).toBeTruthy();
  expect(view.getByLabelText('选择模型，/model').props.accessibilityState.disabled).toBe(false);
  await fireEvent.press(view.getByLabelText('选择模型，/model'));
  expect(view.getByTestId('remote-model-popover')).toBeTruthy();expect(view.getByLabelText('model-b')).toBeTruthy();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');
  expect(send).not.toHaveBeenCalled();expect(mockDraftConsume).not.toHaveBeenCalled();await view.unmount();
});

test('slash reasoning opens the dedicated control without a feature catalog or sending',async()=>{
  models.mockResolvedValue({models:['model-a'],modelCapabilities:{'model-a':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['high']}}});
  const agentProfile={...profile,capabilities:{...profile.capabilities!,features:false}};
  const view=await render(<Harness agentProfile={agentProfile}/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/reasoning');
  await fireEvent.press(view.getByLabelText('选择推理强度，/reasoning'));
  expect(view.queryByTestId('remote-model-popover')).toBeNull();
  await fireEvent(view.getByTestId('main-effort-slider'),'slidingComplete',1);
  await fireEvent.press(view.getByLabelText('关闭推理强度选择'));
  expect(view.getByTestId('remote-effort-chip').props.accessibilityLabel).toBe('High');
  expect(features).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('slash permissions keeps the anchored menu and computer approval policy',async()=>{
  const agentProfile={...profile,capabilities:{...profile.capabilities!,features:false}};
  const view=await render(<Harness agentProfile={agentProfile}/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/permissions');
  await fireEvent.press(view.getByLabelText('选择权限，/permissions'));
  expect(view.getByTestId('composer-permission-menu')).toBeTruthy();
  expect(view.getByRole('radio',{name:'完全访问权限'}).props.accessibilityState.disabled).toBe(true);
  await fireEvent.press(view.getByLabelText('帮我批准'));
  expect(view.getByText('帮我批准')).toBeTruthy();expect(view.queryByTestId('composer-permission-menu')).toBeNull();
  expect(features).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('slash init prepares a reviewable draft preserving both sides of the caret',async()=>{
  const view=await render(<Harness/>),draft='已有要求\n/init\n保留这行',caret=draft.indexOf('/init')+5;
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),draft);
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'),'selectionChange',{nativeEvent:{selection:{start:caret,end:caret}}});
  await fireEvent.press(view.getByLabelText('选择初始化，/init'));
  const input=view.getByLabelText('给电脑上的 Agent 发消息'),value=input.props.value as string;
  expect(value.startsWith('已有要求\n')).toBe(true);expect(value.endsWith('\n保留这行')).toBe(true);
  expect(value).toContain('AGENTS.md');expect(value).toContain('保留仍然有效的内容');expect(value).not.toContain('/init');
  expect(input.props.selection).toEqual({start:value.indexOf('\n保留这行'),end:value.indexOf('\n保留这行')});
  expect(send).not.toHaveBeenCalled();expect(mockDraftConsume).not.toHaveBeenCalled();await view.unmount();
});

test.each(['/side','/fork','/mcp'])('unsupported slash action %s cannot send or execute a forged row',async(command)=>{
  const view=await render(<Harness/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),command);
  expect(mockSlashMenu.entries).toHaveLength(0);
  const menu=mockSlashMenu;
  await act(async()=>menu.onSelect({id:`action:${command.slice(1)}`,kind:'action',action:command.slice(1) as 'side'|'fork'|'mcp',label:'不可用',command,description:''}));
  await fireEvent.press(view.getByLabelText('发送'));
  await fireEvent(view.getByLabelText('给电脑上的 Agent 发消息'),'keyPress',{nativeEvent:{key:'Enter'},preventDefault:jest.fn()});
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe(command);
  expect(send).not.toHaveBeenCalled();expect(mockDraftConsume).not.toHaveBeenCalled();await view.unmount();
});

test('captured navigation actions cannot edit later text or navigate after a source change',async()=>{
  const onNew=jest.fn(),nextOnNew=jest.fn(),view=await render(<Harness onNew={onNew}/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/new');
  const first=mockSlashMenu,firstEntry=first.entries.find(entry=>entry.action==='new')!;
  expect(firstEntry).toBeDefined();
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'后来输入的草稿');
  await act(async()=>first.onSelect(firstEntry));
  expect(onNew).not.toHaveBeenCalled();expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('后来输入的草稿');
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/new');
  const previous=mockSlashMenu,previousEntry=previous.entries.find(entry=>entry.action==='new')!;
  services={...services,scope:'binding/other-device/other-session/b'};
  await view.rerender(<Harness onNew={nextOnNew}/>);
  await act(async()=>previous.onSelect(previousEntry));
  expect(onNew).not.toHaveBeenCalled();expect(nextOnNew).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/new');
  await fireEvent.press(view.getByLabelText('选择新聊天，/new'));
  expect(nextOnNew).toHaveBeenCalledTimes(1);expect(onNew).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('');expect(send).not.toHaveBeenCalled();await view.unmount();
});

test('removing a navigation route retires its captured slash callback even with unchanged text',async()=>{
  const onNew=jest.fn(),view=await render(<Harness onNew={onNew}/>);
  await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'/new');
  const menu=mockSlashMenu,entry=menu.entries.find(value=>value.action==='new')!;
  await view.rerender(<Harness/>);await act(async()=>menu.onSelect(entry));
  expect(view.queryByLabelText('选择新聊天，/new')).toBeNull();expect(onNew).not.toHaveBeenCalled();
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('/new');expect(send).not.toHaveBeenCalled();await view.unmount();
});

test.each([
  ['send button','canSend'],['send button','sending'],['keyboard','canSend'],['keyboard','sending'],
] as const)('captured slash %s cannot navigate after the %s gate locks, even if it later unlocks',async(path,gate)=>{
  const onNew=jest.fn(),view=await render(<Harness onNew={onNew}/>);
  const input=()=>view.getByLabelText('给电脑上的 Agent 发消息');
  await fireEvent.changeText(input(),'/new');
  const captured=path==='send button'?mockComposerSend:input().props.onKeyPress;
  const invoke=()=>captured(path==='keyboard'?{nativeEvent:{key:'Enter'},preventDefault:jest.fn()}:undefined);
  await view.rerender(<Harness onNew={onNew} canSend={gate!=='canSend'} sending={gate==='sending'}/>);
  await act(async()=>{await invoke();});
  expect(onNew).not.toHaveBeenCalled();expect(input().props.value).toBe('/new');expect(send).not.toHaveBeenCalled();
  await view.rerender(<Harness onNew={onNew}/>);
  await act(async()=>{await invoke();});
  expect(onNew).not.toHaveBeenCalled();expect(input().props.value).toBe('/new');
  await fireEvent.press(view.getByLabelText('选择新聊天，/new'));
  expect(onNew).toHaveBeenCalledTimes(1);expect(input().props.value).toBe('');
  expect(send).not.toHaveBeenCalled();expect(mockDraftConsume).not.toHaveBeenCalled();await view.unmount();
});

test.each(['send button','keyboard'] as const)('captured slash %s cannot navigate or consume its token while backgrounded',async(path)=>{
  const originalState=AppState.currentState,onNew=jest.fn(),view=await render(<Harness onNew={onNew}/>);
  const input=()=>view.getByLabelText('给电脑上的 Agent 发消息');
  try{
    await fireEvent.changeText(input(),'/new');
    const captured=path==='send button'?mockComposerSend:input().props.onKeyPress;
    AppState.currentState='background';
    await act(async()=>{await captured(path==='keyboard'?{nativeEvent:{key:'Enter'},preventDefault:jest.fn()}:undefined);});
    expect(onNew).not.toHaveBeenCalled();expect(input().props.value).toBe('/new');
    expect(send).not.toHaveBeenCalled();expect(mockDraftConsume).not.toHaveBeenCalled();
    AppState.currentState='active';
    await fireEvent.press(view.getByLabelText('选择新聊天，/new'));
    expect(onNew).toHaveBeenCalledTimes(1);expect(input().props.value).toBe('');
  }finally{AppState.currentState=originalState;await view.unmount();}
});


test('projectless new composer saves a scoped draft and sends before directory-dependent features exist',async()=>{
 const view=await render(<Harness currentSettings={{sessionKey:undefined,cwd:'',projectless:true}}/>);
 await act(async()=>{});expect(features).not.toHaveBeenCalled();
 await fireEvent.changeText(view.getByLabelText('给电脑上的 Agent 发消息'),'a new independent task');
 await fireEvent.press(view.getByLabelText('发送'));
 expect(send).toHaveBeenCalled();expect(mockDraftSave).toHaveBeenCalledWith(expect.objectContaining({origin:expect.objectContaining({projectless:true,cwd:''})}));await view.unmount();
});
