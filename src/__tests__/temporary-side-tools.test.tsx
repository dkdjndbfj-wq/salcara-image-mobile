import React from 'react';
import {AppState} from 'react-native';
import {act,fireEvent,render,waitFor} from '@testing-library/react-native';
import {TemporarySideChat} from '../remote/TemporarySideChat';
import {resetTemporarySideChatsForTests,temporarySideChatSession,type TemporarySideChatTransport} from '../remote/temporary-side-chat';
import {SideQuestionNotDispatchedError,type SideQuestionReading} from '../remote/side-question';
import {parseSideToolOptions,parseSideToolState,type SideToolRequest,type SideToolState} from '../remote/side-question-tools';

jest.mock('expo-crypto',()=>({randomUUID:()=>jest.requireActual('node:crypto').randomUUID()}));
jest.mock('../components/MessageContent',()=>({MessageContent:({text}:{text:string})=>{const {Text}=require('react-native');return <Text>{text}</Text>;}}));
jest.mock('../remote/attachments',()=>({pickRemoteImages:jest.fn(async()=>[])}));
const key='codex:parent',chain='00000000-0000-4000-8000-000000000001';
const reading:SideQuestionReading={scope:'private-scope',value:{sessionKey:key,revision:'snapshot-1',available:true,contextScope:'loadedSnapshot',contextMessages:2,contextTruncated:false,inputOptions:{version:1,model:true,effort:true,images:true,readOnly:true,defaultModel:'model-a',tools:{version:1,permissions:['workspace-write']}}}};
const state=(request:SideToolRequest,patch:Partial<SideToolState>={}):SideToolState=>({sessionKey:key,chainId:request.chainId,revision:request.expectedRevision,permission:'workspace-write',state:'idle',canSend:true,sequence:1,expiresAt:Date.now()+45000,answer:'',events:[],approvals:[],...patch});
const event={type:'tool',sessionKey:key,tool:'codex',ts:1,id:'command-1',kind:'command',title:'检查项目',status:'done',output:'project ready'};
function deferred<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(done=>{resolve=done;}),resolve:(value:T)=>resolve(value)};}
let transport:TemporarySideChatTransport,requests:SideToolRequest[],sequence:number;
beforeEach(()=>{
  resetTemporarySideChatsForTests();jest.useRealTimers();AppState.currentState='active';requests=[];sequence=0;
  transport={isCurrent:()=>true,read:jest.fn(async()=>reading),ask:jest.fn(),tools:jest.fn(async(_reading,request)=>{requests.push(request);return state(request,{sequence:++sequence,...(request.action==='send'?{state:'running',canSend:false,turnId:'private-turn',lastOperationId:request.operationId}:request.action==='close'?{state:'closed',canSend:false}:{})});})};
});
afterEach(()=>{resetTemporarySideChatsForTests();jest.useRealTimers();});
async function sessionReady(){const session=temporarySideChatSession('test',key);await session.read(transport);expect(session.setPermission('workspace-write',transport)).toBe(true);session.observeTools(transport);session.update({draft:'检查当前项目'});return session;}

test('tools require explicitly reported support and preserve unsupported input',async()=>{
 const session=temporarySideChatSession('test',key);await session.read(transport);
 session.update({images:[{uri:'data:image/png;base64,YQ==',base64:'YQ==',mime:'image/png',width:1,height:1}]});
 expect(session.setPermission('workspace-write',transport)).toBe(false);expect(session.snapshot().images).toHaveLength(1);expect(requests).toHaveLength(0);
 session.update({images:[],reading:{...reading,value:{...reading.value,inputOptions:{...reading.value.inputOptions!,tools:undefined}}}});
 expect(session.setPermission('workspace-write',transport)).toBe(false);expect(session.snapshot().permission).toBe('read-only');
});

test('private open precedes one send and a later draft survives accepted execution',async()=>{
 const session=await sessionReady(),pending=deferred<SideToolState>();let send:SideToolRequest|undefined;
 transport.tools=jest.fn(async(_reading,request)=>{requests.push(request);if(request.action==='open')return state(request);send=request;return pending.promise;});
 const first=session.send(transport),second=session.send(transport);expect(first).toBe(second);await Promise.resolve();
 session.update({draft:'继续编辑'});pending.resolve(state(send!,{state:'running',canSend:false,sequence:2,turnId:'private-turn',lastOperationId:send!.operationId}));await first;
 expect(requests.map(value=>value.action)).toEqual(['open','send']);expect(session.snapshot()).toMatchObject({phase:'sending',draft:'继续编辑'});expect(transport.ask).not.toHaveBeenCalled();
});

test('unknown delivery only reads its original chain and recovers without sending twice',async()=>{
 const session=await sessionReady();let sent:SideToolRequest|undefined;
 transport.tools=jest.fn(async(_reading,request)=>{requests.push(request);if(request.action==='open')return state(request);if(request.action==='send'){sent=request;throw new Error('socket closed');}return state(request,{sequence:3,state:'completed',lastOperationId:sent!.operationId,turnId:'private-turn',answer:'检查完成'});});
 await session.send(transport);await session.send(transport);expect(session.snapshot()).toMatchObject({phase:'unconfirmed',draft:'检查当前项目'});
 await session.refreshTools();expect(requests.map(value=>value.action)).toEqual(['open','send','read']);expect(session.snapshot()).toMatchObject({phase:'ready',draft:'',turns:[{state:'completed',answer:'检查完成'}]});
});

test('a definite open refusal releases local chain and leaves its draft editable',async()=>{
 const session=await sessionReady();transport.tools=jest.fn(async()=>{throw new SideQuestionNotDispatchedError('项目授权已变化');});await session.send(transport);
 expect(session.snapshot()).toMatchObject({phase:'ready',draft:'检查当前项目',turns:[]});expect(session.hasToolExecution()).toBe(false);expect(session.restart()).toBe(true);
});

test('an ambiguous open never sends a question, and explicit close permits a new chat',async()=>{
 const session=await sessionReady();transport.tools=jest.fn(async(_reading,request)=>{requests.push(request);if(request.action==='open')throw new Error('reply lost');return state(request,{state:'closed',canSend:false,sequence:2});});
 await session.send(transport);expect(session.snapshot()).toMatchObject({phase:'unconfirmed',draft:'检查当前项目',turns:[]});expect(session.restart()).toBe(false);
 expect(await session.controlTools('close')).toBe(true);expect(session.restart()).toBe(true);expect(requests.map(value=>value.action)).toEqual(['open','close']);
});

test('close retires an unconfirmed optimistic turn even if send was never accepted',async()=>{
 const session=await sessionReady();transport.tools=jest.fn(async(_reading,request)=>{requests.push(request);if(request.action==='open')return state(request);if(request.action==='send')throw new Error('unknown');return state(request,{state:'closed',canSend:false,sequence:2});});
 await session.send(transport);await session.controlTools('close');expect(session.snapshot().turns[0].state).toBe('interrupted');expect(session.snapshot().draft).toBe('检查当前项目');expect(session.restart()).toBe(true);
});

test('late reads cannot downgrade newer control results or revive an old tool approval',async()=>{
 const session=await sessionReady();await session.send(transport);const delayed=deferred<SideToolState>();let read:SideToolRequest|undefined;
 transport.tools=jest.fn(async(_reading,request)=>{if(request.action==='read'){read=request;return delayed.promise;}return state(request,{state:'interrupted',canSend:true,sequence:5,turnId:'private-turn',lastOperationId:session.snapshot().turns[0].operationId});});
 const refresh=session.refreshTools();await session.controlTools('stop');delayed.resolve(state(read!,{state:'running',canSend:false,sequence:3,turnId:'private-turn'}));await refresh;
 expect(session.snapshot().toolState?.state).toBe('interrupted');expect(session.snapshot().phase).toBe('ready');
});

test('a send failure arriving after explicit close cannot revive its retired chain',async()=>{
 const session=await sessionReady();let fail!:(error:Error)=>void;
 transport.tools=jest.fn(async(_reading,request)=>{if(request.action==='open')return state(request);if(request.action==='send')return new Promise<SideToolState>((_resolve,reject)=>{fail=reject;});return state(request,{state:'closed',canSend:false,sequence:5});});
 const flight=session.send(transport);await Promise.resolve();await session.controlTools('close');fail(new Error('private process closed'));await flight;
 expect(session.snapshot()).toMatchObject({phase:'unavailable',toolState:{state:'closed'},turns:[{state:'interrupted'}]});expect(session.restart()).toBe(true);
});

test('polling does not renew private execution in background or without a subscriber',async()=>{
 jest.useFakeTimers();const session=await sessionReady();const unsubscribe=session.subscribe(()=>{});await session.send(transport);const calls=requests.length;
 const original=AppState.currentState;AppState.currentState='background';await act(async()=>{jest.advanceTimersByTime(3000);await Promise.resolve();});expect(requests).toHaveLength(calls);
 AppState.currentState=original;unsubscribe();await act(async()=>{jest.advanceTimersByTime(30000);await Promise.resolve();});expect(requests).toHaveLength(calls);
});

test('source changes discard late private replies and never approve the new source',async()=>{
 const session=await sessionReady(),pending=deferred<SideToolState>();let sent:SideToolRequest|undefined;
 transport.tools=jest.fn(async(_reading,request)=>{if(request.action==='open')return state(request);sent=request;return pending.promise;});const flight=session.send(transport);await Promise.resolve();transport.isCurrent=()=>false;
 pending.resolve(state(sent!,{state:'completed',sequence:2,lastOperationId:sent!.operationId,answer:'old answer'}));await flight;
 expect(session.snapshot().phase).toBe('unconfirmed');expect(session.snapshot().turns[0].answer).toBe('');expect(await session.controlTools('close')).toBe(false);
});

test('private tools and approvals render with independent action controls',async()=>{
 const session=await sessionReady();await session.send(transport);const operation=session.snapshot().turns[0].operationId;
 const approval={type:'approval.request' as const,deviceId:'private',sessionKey:key,tool:'codex' as const,ts:2,turnId:'private-turn',approvalId:'private-approval',kind:'command' as const,title:'允许项目检查',detail:'npm run check',approvalOptions:{version:1,decisions:['allow','deny'] as Array<'allow'|'deny'>}};
 session.update({toolState:state(requests[0],{state:'waiting_approval',canSend:false,sequence:3,turnId:'private-turn',lastOperationId:operation,events:[event as never],approvals:[approval]})});
 transport.tools=jest.fn(async(_reading,request)=>{requests.push(request);return state(request,{state:request.action==='approve'?'running':'interrupted',canSend:request.action!=='approve',sequence:++sequence+5,turnId:'private-turn',lastOperationId:operation});});
 const view=await render(<TemporarySideChat visible scopeKey="test" sessionKey={key} transport={transport}/>);
 await fireEvent.press(view.getByLabelText('临时工具记录 command-1'));expect(view.getByText('project ready')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('允许临时操作 private-approval'));expect(requests.at(-1)).toMatchObject({action:'approve',expectedTurnId:'private-turn',approvalId:'private-approval',decision:'allow'});
 await fireEvent.press(view.getByLabelText('停止临时执行'));expect(requests.at(-1)).toMatchObject({action:'stop',expectedTurnId:'private-turn'});await view.unmount();
},15000);

test('private protocol strips attachments and rejects wrong scope, stale approvals and malformed output',()=>{
 const request:SideToolRequest={action:'read',chainId:chain,expectedRevision:'snapshot-1'};
 const raw=state(request,{events:[{...event,attachments:[{id:'private-frame'}],childSessionKeys:['private-native-id']} as never]});
 const parsed=parseSideToolState(raw,key,request);expect(parsed?.events).toHaveLength(1);expect(parsed?.events[0]).not.toHaveProperty('attachments');expect(parsed?.events[0]).not.toHaveProperty('childSessionKeys');
 const streaming={...event,type:'message',id:'answer-1',role:'assistant',text:'partial answer'};expect(parseSideToolState({...raw,events:[streaming]},key,request)?.events[0]).toMatchObject({type:'message',final:false});
 expect(parseSideToolState({...raw,sessionKey:'codex:foreign'},key,request)).toBeUndefined();expect(parseSideToolState({...raw,answer:'x'.repeat(65537)},key,request)).toBeUndefined();
 expect(parseSideToolState({...raw,events:[{...event,status:42}]},key,request)).toBeUndefined();
 expect(parseSideToolState({...raw,approvals:[{...event,type:'approval.request',approvalId:'bad',kind:'command',turnId:'old-turn',approvalOptions:{version:1,decisions:['allow']}}]},key,request)).toBeUndefined();
 expect(parseSideToolOptions({version:1,permissions:['danger-full-access']})).toBeUndefined();
});

const catalog={collaborationModes:['default','plan'] as Array<'default'|'plan'>,skillsSupported:true,skills:[{name:'inspect',path:'C:/project/.agents/skills/inspect/SKILL.md',description:'Inspect project'}]};
function withFeatures(){
 const enabled={...reading,value:{...reading.value,inputOptions:{...reading.value.inputOptions!,tools:{...reading.value.inputOptions!.tools!,features:true as const}}}};
 transport.read=jest.fn(async()=>enabled);
 transport.tools=jest.fn(async(_reading,request)=>{requests.push(request);return state(request,{sequence:++sequence,...(request.action==='features'?{features:catalog}:request.action==='send'?{state:'completed',lastOperationId:request.operationId,answer:'Done'}:{})});});
}
test('slash discovers plan from read-only and requests the real permission before enabling execution',async()=>{
 withFeatures();const view=await render(<TemporarySideChat visible scopeKey="test" sessionKey={key} transport={transport}/>);
 await waitFor(()=>expect(temporarySideChatSession('test',key).snapshot().phase).toBe('ready'));
 await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'),'/');
 expect(view.getByTestId('remote-slash-menu')).toBeTruthy();await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
 expect(requests).toEqual([]);expect(temporarySideChatSession('test',key).snapshot().permission).toBe('read-only');
 await fireEvent.press(view.getByRole('radio',{name:/请求批准/}));
 await waitFor(()=>expect(requests.map(value=>value.action)).toEqual(['open','features']));
 await fireEvent.press(view.getByLabelText('选择计划模式，/plan'));
 expect(view.getByLabelText('关闭临时聊天计划模式')).toBeTruthy();expect(transport.ask).not.toHaveBeenCalled();expect(requests.some(value=>value.action==='send')).toBe(false);await view.unmount();
});
test('slash selection preserves the suffix and sends native skill and plan separately from command text',async()=>{
 withFeatures();const session=await sessionReady();await session.loadToolFeatures(transport);
 const view=await render(<TemporarySideChat visible scopeKey="test" sessionKey={key} transport={transport}/>);
 await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'),'/plan 检查');
 await fireEvent(view.getByLabelText('临时侧边聊天输入'),'selectionChange',{nativeEvent:{selection:{start:5,end:8}}});
 expect(view.queryByTestId('remote-slash-menu')).toBeNull();
 await fireEvent(view.getByLabelText('临时侧边聊天输入'),'selectionChange',{nativeEvent:{selection:{start:5,end:5}}});
 await fireEvent.press(view.getByLabelText('选择临时聊天命令'));
 expect(session.snapshot()).toMatchObject({draft:' 检查',collaborationMode:'plan'});expect(requests.some(value=>value.action==='send')).toBe(false);
 await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'),'/inspect');await fireEvent.press(view.getByLabelText('选择技能 inspect，/inspect'));
 expect(view.getByLabelText('移除临时聊天技能 inspect')).toBeTruthy();
 await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'),'检查项目');await fireEvent.press(view.getByLabelText('发送临时聊天'));
 expect(requests.at(-1)).toMatchObject({action:'send',question:'检查项目',collaborationMode:'plan',skills:catalog.skills.map(({description,...skill})=>skill)});
 expect(session.snapshot().skills).toBeUndefined();expect(session.snapshot().collaborationMode).toBe('plan');await view.unmount();
});
test('loading or failing private catalogs cannot send the slash string or reuse an earlier skill',async()=>{
 withFeatures();const session=await sessionReady(),pending=deferred<SideToolState>();let lookup:SideToolRequest|undefined;
 transport.tools=jest.fn(async(_reading,request)=>{requests.push(request);if(request.action==='features'){lookup=request;return pending.promise;}return state(request,{sequence:++sequence});});
 const view=await render(<TemporarySideChat visible scopeKey="test" sessionKey={key} transport={transport}/>);
 await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'),'/plan');
 await waitFor(()=>expect(lookup).toBeDefined());await fireEvent.press(view.getByLabelText('选择临时聊天命令'));
 expect(requests.some(value=>value.action==='send')).toBe(false);
 await act(async()=>pending.resolve(state(lookup!,{sequence:++sequence,features:catalog})));
 expect(view.getByLabelText('选择计划模式，/plan')).toBeTruthy();
 transport.tools=jest.fn(async()=>{throw new Error('目录不可用');});
 await fireEvent.press(view.getByLabelText('重新读取快捷命令'));
 expect(view.getByText('目录不可用')).toBeTruthy();expect(view.queryByLabelText('选择计划模式，/plan')).toBeNull();
 session.update({skills:[{name:'inspect',path:catalog.skills[0].path}],draft:'保留问题'});await session.send(transport);
 expect(session.snapshot().draft).toBe('保留问题');expect(transport.tools).toHaveBeenCalledTimes(1);await view.unmount();
});
test('private feature protocol preserves the advertised capability and rejects invalid catalogs',()=>{
 const request:SideToolRequest={action:'features',chainId:chain,expectedRevision:'snapshot-1',operationId:chain};
 expect(parseSideToolOptions({version:1,permissions:['workspace-write'],features:true})).toMatchObject({features:true});
 expect(parseSideToolState(state(request,{features:catalog}),key,request)?.features).toEqual(catalog);
 expect(parseSideToolState(state(request,{features:{...catalog,skills:[...catalog.skills,...catalog.skills]}}),key,request)).toBeUndefined();
});
test.each(['$inspect','/skills inspect'])('read-only %s can reach the permission control before browsing actual private skills',async draft=>{
 withFeatures();const view=await render(<TemporarySideChat visible scopeKey="test" sessionKey={key} transport={transport}/>);
 await waitFor(()=>expect(temporarySideChatSession('test',key).snapshot().phase).toBe('ready'));
 await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'),draft);
 await fireEvent.press(view.getByLabelText('选择技能，/skills'));
 expect(view.getByRole('radio',{name:/请求批准/})).toBeTruthy();expect(requests).toEqual([]);expect(transport.ask).not.toHaveBeenCalled();await view.unmount();
});
