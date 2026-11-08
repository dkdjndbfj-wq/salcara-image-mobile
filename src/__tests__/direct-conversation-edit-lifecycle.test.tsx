import React from 'react';
import {act,render} from '@testing-library/react-native';
import {DirectConversation} from '../remote/DirectConversation';
import type {SentMessageRevisionHandler} from '../remote/sent-message-revision';

let mockEdit:SentMessageRevisionHandler;
const mockSave=jest.fn(),mockBegin=jest.fn(),mockClear=jest.fn(),mockSettle=jest.fn();
jest.mock('expo-crypto',()=>({randomUUID:()=>require('node:crypto').randomUUID()}));
jest.mock('react-native',()=>{
 const React=require('react'),actual=jest.requireActual('react-native'),replacement=Object.create(actual);
 Object.defineProperty(replacement,'useWindowDimensions',{value:()=>({width:1194,height:844,scale:1,fontScale:1})});
 Object.defineProperty(replacement,'FlatList',{value:React.forwardRef((props:any,ref:any)=>{
  React.useImperativeHandle(ref,()=>({scrollToEnd:jest.fn(),scrollToIndex:jest.fn(),scrollToOffset:jest.fn()}));
  return React.createElement(actual.View,null,props.data.map((item:any,index:number)=>React.createElement(React.Fragment,{key:item.id},props.renderItem({item,index}))));
 })});return replacement;
});
jest.mock('../remote/direct-pairing',()=>({directDeliveryScope:()=> 'pairing',directConnectionGeneration:()=>1,getDirectConnectionState:()=>({status:'connected',deviceId:'pc'})}));
jest.mock('../remote/direct-session-services',()=>({captureDirectSessionServices:()=>({scope:'paired-session',isCurrent:()=>true,guard:jest.fn()})}));
jest.mock('../remote/useDirectMessageQueue',()=>({useDirectMessageQueue:()=>({ready:true,entries:[],error:'',unconfirmed:false,dispatching:false})}));
jest.mock('../remote/SentEditBackup',()=>({useSentEditBackup:()=>({blocked:false,panel:null,begin:mockBegin,save:mockSave,clear:mockClear,settle:mockSettle})}));
jest.mock('../remote/direct-retry-draft',()=>({recoverDirectMessageDraft:async()=>({text:'Original task',images:[]})}));
jest.mock('../remote/RemoteSidebar',()=>({RemoteSidebar:()=>null}));
jest.mock('../remote/TabletThreadFrame',()=>({TabletThreadFrame:({children}:any)=>children}));
jest.mock('../remote/DirectComposer',()=>({DirectComposer:()=>null}));
jest.mock('../remote/QuestionDock',()=>({QuestionDock:({children}:any)=>children}));
jest.mock('../remote/thread-extras',()=>({ImageViewer:()=>null,JumpToLatest:()=>null,SearchBar:()=>null}));
jest.mock('../remote/thread-rows',()=>{
 const React=require('react'),{Text}=require('react-native'),ThreadUi=React.createContext({});
 return {ThreadUi,ApprovalCard:()=>null,ThreadClockProvider:({children}:any)=>children,ThreadClockLabel:()=>null,
  BlockRow:({block}:any)=>{mockEdit=React.useContext(ThreadUi).onEditMessage;return React.createElement(Text,null,block.item?.text||block.type);}};
});

const session:any={sessionKey:'codex:main',title:'Task',cwd:'/project',status:'idle',controllable:true,controlSurface:'cli',latestTurnRevert:true};
const message:any={kind:'message',id:'user',role:'user',text:'Original task',turnId:'turn-1',final:true,ts:1};
const timeline:any={session,snapshotAt:5,loading:false,items:[message,{kind:'turn',id:'done',turnId:'turn-1',status:'completed',ts:2}]};
const base:any={runtime:{scope:'pairing',remote:{devices:[{deviceId:'pc',capabilities:[]}]}},deviceId:'pc',profile:{id:'codex',name:'Codex',tool:'codex',api:{accountId:'api'},capabilities:{latestTurnRevert:true}},session,timeline,
 workspaceMode:'code',text:'',onText:jest.fn(),loading:false,loadingMore:false,sending:false,canSend:true,uncertain:false,error:'',
 onStop:jest.fn(),onRespond:jest.fn(),onEarlier:jest.fn(),onRefresh:jest.fn(),onBack:jest.fn(),onOpenSession:jest.fn(),onNew:jest.fn()};
beforeEach(()=>{jest.clearAllMocks();mockBegin.mockResolvedValue(undefined);mockSave.mockResolvedValue(undefined);mockClear.mockResolvedValue(undefined);});

test.each(['not-sent','unknown'] as const)('edit recovery distinguishes %s from a confirmed delivery',async outcome=>{
 const onSend=jest.fn(async(_options,observe)=>{observe(outcome);return false;});
 const view=await render(<DirectConversation {...base} onRevert={async()=>{}} onSend={onSend}/>);
 await act(async()=>{await expect(mockEdit(message,'Keep revised task',new AbortController().signal)).rejects.toThrow(outcome==='not-sent'?'电脑未接收修正版':'尚未确认送达');});
 expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({text:'Keep revised task',phase:outcome==='not-sent'?'reverted':'sending'}),[]);
 expect(mockClear).not.toHaveBeenCalled();await view.unmount();
});

test('editing uses the latest same-source send callback after a successful revert refresh',async()=>{
 let finish!:()=>void;const reverted=new Promise<void>(resolve=>{finish=resolve;}),onRevert=jest.fn(()=>reverted);
 const oldSend=jest.fn(async()=>true),freshSend=jest.fn(async()=>true);
 const view=await render(<DirectConversation {...base} onRevert={onRevert} onSend={oldSend}/>);
 let flight!:Promise<boolean>;
 await act(async()=>{flight=mockEdit(message,'Revised task',new AbortController().signal);});
 expect(onRevert).toHaveBeenCalledTimes(1);
 await view.rerender(<DirectConversation {...base} timeline={{...timeline,items:[]}} onRevert={onRevert} onSend={freshSend}/>);
 await act(async()=>{finish();expect(await flight).toBe(true);});
 expect(oldSend).not.toHaveBeenCalled();expect(freshSend).toHaveBeenCalledWith(expect.objectContaining({inputText:'Revised task'}),expect.any(Function));
 expect(mockClear).toHaveBeenCalledTimes(1);await view.unmount();
});

test.each(['running','read-only','archived'] as const)('editing retains its backup and never sends or steers after the same session becomes %s',async state=>{
 let finish!:()=>void;const reverted=new Promise<void>(resolve=>{finish=resolve;}),onRevert=jest.fn(()=>reverted),onSend=jest.fn(async()=>true);
 const view=await render(<DirectConversation {...base} onRevert={onRevert} onSend={onSend}/>);
 let flight!:Promise<boolean>;
 await act(async()=>{flight=mockEdit(message,'Keep this revision',new AbortController().signal);});
 expect(onRevert).toHaveBeenCalledTimes(1);
 const changed={...session,...(state==='running'?{status:'running',activeTurnId:'new-turn'}:state==='read-only'?{controllable:false,controlSurface:'read-only'}:{archived:true})};
 await view.rerender(<DirectConversation {...base} session={changed} timeline={{...timeline,session:changed,items:[]}} onRevert={onRevert} onSend={onSend}/>);
 await act(async()=>{finish();await expect(flight).rejects.toThrow('修正版已保留');});
 expect(onSend).not.toHaveBeenCalled();expect(mockClear).not.toHaveBeenCalled();
 expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({phase:'reverted',text:'Keep this revision'}),[]);
 await view.unmount();
});
