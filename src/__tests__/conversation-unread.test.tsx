import React from 'react';
import {act,render,renderHook,waitFor} from '@testing-library/react-native';
import {AppState,type ViewToken} from 'react-native';
import {conversationReadKey,conversationReadScope,conversationUnread,observeConversationResult,readConversationResult,sessionResultStamp} from '../remote/conversation-unread';
import {UnreadResultDot,useConversationResultIndex,useConversationResultReader,type ConversationResultSource} from '../remote/ConversationUnread';
import type {AgentProfile,SessionInfo} from '../remote/client';
import type {Timeline} from '../remote/store';
import type {ConversationBlock} from '../remote/blocks';

const mockData=new Map<string,string>(),mockRead=jest.fn(async(key:string):Promise<string|null>=>mockData.get(key)??null),mockWrite=jest.fn(async(key:string,value:string)=>{mockData.set(key,value);});
jest.mock('../storage/database',()=>({getSetting:(key:string)=>mockRead(key),setSetting:(key:string,value:string)=>mockWrite(key,value)}));
jest.mock('../theme',()=>({useDesk:()=>({muted:'#777'})}));
const session=(extra:Partial<SessionInfo>={}):SessionInfo=>({sessionKey:'codex:main',tool:'codex',client:'Codex',title:'Main task',cwd:'/project',status:'idle',updatedAt:100,controllable:true,...extra});
const completed=(id:string,at:number)=>{
 const current=session({lastTerminalTurnId:id,updatedAt:at});
 const answer={kind:'message' as const,id:`answer-${id}`,role:'assistant' as const,text:'Finished',final:true,ts:at,turnId:id};
 const turn={kind:'turn' as const,id:`terminal-${id}`,turnId:id,status:'completed' as const,ts:at};
 const timeline:Timeline={session:current,items:[answer,turn],loading:false,snapshotAt:at};
 const blocks:ConversationBlock[]=[{type:'assistant',id:answer.id,item:answer},{type:'turn',id:turn.id,item:turn}];
 return {session:current,timeline,blocks,stamp:sessionResultStamp(current,timeline)!};
};
const viewable=(block:ConversationBlock)=>({viewableItems:[{item:block,key:block.id,index:0,isViewable:true} as ViewToken],changed:[]});
beforeEach(()=>{mockRead.mockClear();mockWrite.mockClear();});

test('first observation is a baseline; only a later completed turn becomes unread',async()=>{
 const key=conversationReadKey('baseline',session()),old=completed('first',100),next=completed('second',200);
 await observeConversationResult(key,old.stamp);expect(conversationUnread(key)).toBe(false);
 await observeConversationResult(key,next.stamp);expect(conversationUnread(key)).toBe(true);
 await observeConversationResult(key,old.stamp);await readConversationResult(key,old.stamp);expect(conversationUnread(key)).toBe(true);
 await readConversationResult(key,next.stamp);expect(conversationUnread(key)).toBe(false);
});

test('running then completed creates a dot without fabricating results for errors or child tasks',async()=>{
 const key=conversationReadKey('running',session()),done=completed('done',200);
 await observeConversationResult(key);await observeConversationResult(key,done.stamp);expect(conversationUnread(key)).toBe(true);
 expect(sessionResultStamp({...done.session,status:'running'},undefined)).toBeUndefined();
 expect(sessionResultStamp({...done.session,parentSessionKey:'codex:parent'},done.timeline)).toBeUndefined();
 expect(sessionResultStamp(done.session,{...done.timeline,items:[{kind:'turn',id:'stop',turnId:'done',status:'interrupted',ts:200}]})).toBeUndefined();
 expect(sessionResultStamp({...done.session,activeTurnId:'later'},undefined)).toBeUndefined();
});

test('pairing, device, Agent, API, Code/Work and native source have separate read records',()=>{
 const agent={id:'codex',api:{accountId:'api-a',name:'API',source:'computer'}} as AgentProfile;
 const base=conversationReadScope('pair','pc',agent,'code');
 const scopes=[base,conversationReadScope('other-pair','pc',agent,'code'),conversationReadScope('pair','other-pc',agent,'code'),conversationReadScope('pair','pc',{...agent,id:'other'},'code'),conversationReadScope('pair','pc',{...agent,api:{...agent.api,accountId:'api-b'}},'code'),conversationReadScope('pair','pc',agent,'work')];
 const keys=scopes.map(scope=>conversationReadKey(scope,session()));keys.push(conversationReadKey(base,session({controlSurface:'desktop'})),conversationReadKey(base,session({controlSurface:'read-only',sessionScope:'desktop-chat'})));
 expect(new Set(keys).size).toBe(keys.length);expect(keys.every(key=>/^[a-f0-9]{64}$/.test(key))).toBe(true);
});

test('opening a conversation or seeing only its terminal row does not read an unseen final answer',async()=>{
 const done=completed('visible-result',200),source:ConversationResultSource={scope:'visible',session:done.session,timeline:done.timeline,active:true};
 const key=conversationReadKey(source.scope,done.session);await observeConversationResult(key);
 const follow=jest.fn(),hook=await renderHook(()=>useConversationResultReader(source,done.blocks,follow));
 await waitFor(()=>expect(conversationUnread(key)).toBe(true));
 await act(async()=>hook.result.current(viewable(done.blocks[1])));expect(conversationUnread(key)).toBe(true);
 await act(async()=>hook.result.current(viewable(done.blocks[0])));expect(conversationUnread(key)).toBe(false);expect(follow).toHaveBeenCalledTimes(2);
 await hook.unmount();
});

test('background and covered views retain the dot until the result is visible in the foreground',async()=>{
 const done=completed('foreground-result',300),source:ConversationResultSource={scope:'foreground',session:done.session,timeline:done.timeline,active:false};
 const key=conversationReadKey(source.scope,done.session);await observeConversationResult(key);await observeConversationResult(key,done.stamp);
 const hook=await renderHook((value:ConversationResultSource)=>useConversationResultReader(value,done.blocks,()=>{}),{initialProps:source});
 await act(async()=>hook.result.current(viewable(done.blocks[0])));expect(conversationUnread(key)).toBe(true);
 const previous=AppState.currentState;Object.defineProperty(AppState,'currentState',{configurable:true,writable:true,value:'background'});
 await hook.rerender({...source,active:true});expect(conversationUnread(key)).toBe(true);
 Object.defineProperty(AppState,'currentState',{configurable:true,writable:true,value:previous??'active'});
 await act(async()=>hook.result.current(viewable(done.blocks[0])));expect(conversationUnread(key)).toBe(false);await hook.unmount();
});

test('late viewability tokens from another computer cannot clear the new computer result',async()=>{
 const first=completed('same-turn',300),second=completed('same-turn',300),source:ConversationResultSource={scope:'computer-a',session:first.session,timeline:first.timeline,active:true};
 const next={...source,scope:'computer-b',session:second.session,timeline:second.timeline},key=conversationReadKey(next.scope,second.session);
 await observeConversationResult(key);await observeConversationResult(key,second.stamp);
 const hook=await renderHook(({value,blocks}:{value:ConversationResultSource;blocks:ConversationBlock[]})=>useConversationResultReader(value,blocks,()=>{}),{initialProps:{value:source,blocks:first.blocks}});
 await hook.rerender({value:next,blocks:second.blocks});await act(async()=>hook.result.current(viewable(first.blocks[0])));expect(conversationUnread(key)).toBe(true);
 await act(async()=>hook.result.current(viewable(second.blocks[0])));expect(conversationUnread(key)).toBe(false);await hook.unmount();
});

test('offscreen loaded directory rows are observed and the dot stays compact',async()=>{
 const done=completed('offscreen-done',400),scope='offscreen';
 const hook=await renderHook((value:ConversationResultSource[])=>useConversationResultIndex(value),{initialProps:[{scope,session:session({status:'running'}),active:true}]});
 await act(async()=>{});await hook.rerender([{scope,session:done.session,timeline:done.timeline,active:true}]);
 const view=await render(<UnreadResultDot source={{scope,session:done.session,active:true}} title="Task" status="idle"/>);
 await waitFor(()=>expect(view.getByLabelText('Task有未读结果')).toBeTruthy());
 expect(view.getByLabelText('Task有未读结果').props.style).toMatchObject({width:6,height:6});await view.unmount();await hook.unmount();
});

test('read state survives module reload and a failed storage read cannot overwrite it',async()=>{
 const done=completed('persisted-result',500),key=conversationReadKey('persisted',done.session);await observeConversationResult(key);await observeConversationResult(key,done.stamp);
 await waitFor(()=>expect(mockData.get('remote_conversation_reads_v1')).toContain(key));
 await jest.isolateModulesAsync(async()=>{const store=require('../remote/conversation-unread');await store.loadConversationReads();expect(store.conversationUnread(key)).toBe(true);});
 mockRead.mockRejectedValueOnce(new Error('Disk temporarily unavailable'));const count=mockWrite.mock.calls.length;
 await jest.isolateModulesAsync(async()=>{const store=require('../remote/conversation-unread');await expect(store.observeConversationResult(key)).rejects.toThrow('Disk');expect(mockWrite).toHaveBeenCalledTimes(count);await store.loadConversationReads();expect(store.conversationUnread(key)).toBe(true);});
});
