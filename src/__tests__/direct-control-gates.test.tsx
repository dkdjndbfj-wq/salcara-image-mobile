import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { DirectConversation } from '../remote/DirectConversation';

let mockApproval:any,mockQuestion:any,mockComposer:any;
const mockSettings=new Map<string,string>();
jest.mock('../storage/database',()=>({getSetting:async(key:string)=>mockSettings.get(key)??null,setSetting:async(key:string,value:string)=>{mockSettings.set(key,value);}}));
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID(),CryptoDigestAlgorithm:{SHA256:'SHA256'},digestStringAsync:async(_algorithm:string,value:string)=>require('node:crypto').createHash('sha256').update(value).digest('hex')}));
jest.mock('../remote/direct-pairing',()=>({directDeliveryScope:()=> 'pairing',directConnectionGeneration:()=>1,getDirectConnectionState:()=>({status:'connected',deviceId:'pc'})}));
jest.mock('../remote/direct-api',()=>({requestDirect:jest.fn()}));
jest.mock('../remote/direct-session-services',()=>({captureDirectSessionServices:()=>({scope:'session',isCurrent:()=>true,guard:jest.fn()})}));
jest.mock('../remote/RemoteSidebar',()=>({RemoteSidebar:()=>null}));
jest.mock('../remote/TabletThreadFrame',()=>({TabletThreadFrame:({children}:any)=>children}));
jest.mock('../remote/DirectComposer',()=>({DirectComposer:(props:any)=>{mockComposer=props;return null;}}));
jest.mock('../remote/QuestionDock',()=>({QuestionDock:(props:any)=>{mockQuestion=props;return props.children;}}));
jest.mock('../remote/thread-rows',()=>{
  const React=require('react');return {ThreadUi:React.createContext({}),BlockRow:()=>null,
    ApprovalCard:(props:any)=>{mockApproval=props;return null;},ThreadClockProvider:({children}:any)=>children,ThreadClockLabel:()=>null};
});
const base:any={runtime:{scope:'pairing',remote:{devices:[{deviceId:'pc',capabilities:[]}]}},deviceId:'pc',
  profile:{id:'codex',name:'Codex',tool:'codex',api:{accountId:'api'},capabilities:{approval:true,questions:true}},
  session:{sessionKey:'codex:main',title:'Task',cwd:'C:/project',status:'waiting_approval',controlSurface:'cli'},
  workspaceMode:'code',text:'',onText:jest.fn(),loading:false,loadingMore:false,sending:false,canSend:true,uncertain:false,error:'',
  onSend:jest.fn(),onStop:jest.fn(),onRespond:jest.fn(),onEarlier:jest.fn(),onRefresh:jest.fn(),onBack:jest.fn(),onOpenSession:jest.fn(),onNew:jest.fn(),
};
const approval={kind:'approval',id:'approval-1',approval:'tool',title:'Confirm',state:'pending',ts:1};
function screen(kind:'tool'|'question',capabilities:Record<string,boolean>,props:Record<string,unknown>={}){
  return <DirectConversation {...base} profile={{...base.profile,capabilities}} timeline={{items:[{...approval,approval:kind}],loading:false}} {...props}/>;
}
beforeEach(()=>{jest.clearAllMocks();mockSettings.clear();mockApproval=undefined;mockQuestion=undefined;mockComposer=undefined;});

test('unsupported approval remains visible with a disabled action and a computer handoff explanation',async()=>{
  const view=await render(screen('tool',{approval:false,questions:true}));
  expect(mockApproval.approval.id).toBe('approval-1');expect(mockApproval.disabled).toBe(true);
  expect(view.getByText('当前 Agent 不支持手机审批，请在电脑处理')).toBeTruthy();
  await view.rerender(screen('tool',{approval:true,questions:true}));expect(mockApproval.disabled).toBe(false);await view.unmount();
});

test.each([{approval:false,questions:true},{approval:true,questions:false}])('question capability mismatch blocks both answering and cancelling: %j',async caps=>{
  const view=await render(screen('question',caps));await waitFor(()=>expect(mockQuestion.question?.id).toBe('approval-1'));expect(mockQuestion.blocked).toBe('请在电脑回答');expect(mockQuestion.canCancel).toBe(false);
  await view.rerender(screen('question',{approval:true,questions:true}));expect(mockQuestion.blocked).toBeUndefined();expect(mockQuestion.canCancel).toBe(true);await view.unmount();
});

test('pending stop has a distinct refresh control and blocks approval, answer cancellation and composer actions',async()=>{
  const view=await render(screen('tool',{approval:true,questions:true},{stopPending:true,canSend:false}));
  expect(mockApproval.disabled).toBe(true);expect(mockComposer.uncertain).toBe(true);
  expect(view.queryByLabelText('核对未确认消息')).toBeNull();await fireEvent.press(view.getByRole('button',{name:'核对停止结果'}));expect(base.onRefresh).toHaveBeenCalledTimes(1);
  await view.rerender(screen('question',{approval:true,questions:true},{stopPending:true,canSend:false}));
  expect(mockQuestion.blocked).toBe('请刷新后核对问题状态');expect(mockQuestion.cancelBlocked).toBe(true);await view.unmount();
});

test('the actual Direct conversation wires unfinished question drafts through an unmount and reconnect',async()=>{
  const timeline={items:[{...approval,approval:'question',questions:[{id:'q',question:'Notes',allowCustom:true}]}],loading:false};
  let view=await render(screen('question',{approval:true,questions:true},{timeline}));await waitFor(()=>expect(mockQuestion.question?.id).toBe('approval-1'));
  const draft={answers:{},custom:{q:'keep this answer'},customPresent:{q:true},customOpen:{},page:0};
  await act(async()=>mockQuestion.onDraftChange('approval-1',draft));await view.unmount();mockQuestion=undefined;
  view=await render(screen('question',{approval:true,questions:true},{timeline}));
  await waitFor(()=>expect(mockQuestion.initialDraft).toEqual(draft));expect(mockQuestion.draftIdentity).toBeTruthy();await view.unmount();
});

test('an expired first question releases the next pending request without waiting for another host event',async()=>{
  jest.useFakeTimers();
  const timeline={items:[{...approval,approval:'question',expiresAt:Date.now()+5000},{...approval,id:'next-question',approval:'question'}],loading:false};
  const view=await render(screen('question',{approval:true,questions:true},{timeline}));await waitFor(()=>expect(mockQuestion.question?.id).toBe('approval-1'));
  await act(async()=>{jest.advanceTimersByTime(5001);});await waitFor(()=>expect(mockQuestion.question?.id).toBe('next-question'));
  await view.unmount();jest.useRealTimers();
});
