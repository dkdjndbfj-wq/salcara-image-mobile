import { captureDirectProjectServices, captureDirectSessionServices, parseDirectModelCatalog } from '../remote/direct-session-services';
import { requestDirect } from '../remote/direct-api';
import type { AgentProfile,SessionInfo } from '../remote/client';
jest.mock('../remote/direct-api',()=>({requestDirect:jest.fn()}));
jest.mock('expo-crypto',()=>({randomUUID:()=> '11111111-2222-4333-8444-555555555555'}));
let mockGeneration=1,mockScope='pairing-1',mockCurrent=true;
jest.mock('../remote/direct-pairing',()=>({directDeliveryScope:()=>mockScope,directConnectionGeneration:()=>mockGeneration,getDirectConnectionState:()=>({status:'connected',deviceId:'pc'})}));
const request=requestDirect as jest.Mock;
const session:SessionInfo={sessionKey:'codex:session',tool:'codex',client:'Codex',title:'Task',cwd:'C:/project',status:'idle',updatedAt:1,controllable:true,controlSurface:'cli'};
const agent:AgentProfile={id:'codex',tool:'codex',name:'Codex',available:true,remoteSendSupported:true,api:{accountId:'account-1'} as any,capabilities:{features:true,modelOverride:true,context:true,compact:true,sideQuestion:true,imageInput:true} as any};
const services=()=>captureDirectSessionServices('pc',session,agent,()=>mockCurrent);
const chainId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',operationId='11111111-2222-4333-8444-555555555555';
const attachmentId='att_11111111222243338444555555555555';
const conversation={sessionKey:session.sessionKey,revision:'revision-1',available:true,contextScope:'loadedSnapshot',contextMessages:2,contextTruncated:false,chainId,turns:[]};
beforeEach(()=>{jest.clearAllMocks();mockGeneration=1;mockScope='pairing-1';mockCurrent=true;});
test('create-only model selection cannot become an existing-session override',async()=>{
  const hermes:AgentProfile={...agent,id:'hermes',tool:'hermes',capabilities:{...agent.capabilities!,modelOverride:false,startModelOverride:true}};
  request.mockResolvedValue({models:['model-a']});
  await expect(captureDirectProjectServices('pc','C:/project',hermes,()=>mockCurrent).models()).resolves.toMatchObject({models:['model-a']});
  expect(request).toHaveBeenCalledWith(expect.objectContaining({type:'models.list',tool:'hermes',accountId:'account-1'}));
  request.mockClear();
  await expect(captureDirectSessionServices('pc',{...session,sessionKey:'hermes:s',tool:'hermes'},hermes,()=>mockCurrent).models()).rejects.toThrow('尚未开放');
  expect(request).not.toHaveBeenCalled();
});

test('model selection uses only host IDs and reported effort capabilities',async()=>{
  const raw={models:['test-model'],modelCapabilities:{'test-model':{source:'codex-model-list',reasoningKnown:true,reasoningEfforts:['low','ultra','made-up'],inputModalities:['text']}}};
  expect(parseDirectModelCatalog(raw).modelCapabilities?.['test-model'].reasoningEfforts).toEqual(['low','ultra']);
  expect(()=>parseDirectModelCatalog({models:['bad\nmodel']})).toThrow();
  request.mockResolvedValue(raw);await services().models(true);
  expect(request).toHaveBeenCalledWith({type:'models.list',tool:'codex',controlSurface:'cli',accountId:'account-1',refresh:true},undefined);
});
test('skills use the shared immutable snapshot reader over direct transport',async()=>{
  request.mockResolvedValue({collaborationModes:['default','plan'],skillsSupported:true,skills:[{name:'review',path:'C:/skills/review',description:'Review code'}]});
  const value=await services().features();expect(value.skills[0].name).toBe('review');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({type:'features.list',sessionKey:session.sessionKey,cwd:session.cwd,accountId:'account-1',controlSurface:'cli',syncVersion:1}),undefined);
});
test('context compact requires the exact owner and freshly confirmed revision',async()=>{
  const owner=services(),context={sessionKey:session.sessionKey,revision:'ctx-revision',canCompact:true};request.mockResolvedValue(context);
  const reading=await owner.context.read();request.mockResolvedValue({...context,canCompact:false,compaction:{operationId,state:'requested',blocking:true,startedAt:1,updatedAt:1}});
  await owner.context.compact(reading);expect(request).toHaveBeenLastCalledWith(expect.objectContaining({type:'session.compact',expectedRevision:'ctx-revision',operationId}),{timeoutMs:110000});
  await expect(owner.context.compact({...reading,scope:'other-pairing'})).rejects.toThrow('确认');
});
test('late model or skill responses cannot follow an API or connection change',async()=>{
  let resolve!:(value:any)=>void;request.mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const reading=services().models();mockGeneration++;resolve({models:['test-model']});await expect(reading).rejects.toThrow('已变化');
});
test('persistent side question validates each reply without touching parent history',async()=>{
  const owner=services();request.mockResolvedValue(conversation);
  const reading=await owner.sideQuestions.read(chainId,new AbortController().signal);
  request.mockResolvedValue({...conversation,lastOperationId:operationId,turns:[{operationId,question:'Explain this',answer:'A real response',state:'completed',createdAt:2}]});
  const result=await owner.sideQuestions.ask(reading,{question:'Explain this'},operationId);
  expect(result.state).toBe('completed');expect(request).toHaveBeenLastCalledWith(expect.objectContaining({type:'session.side-question.send',chainId,expectedRevision:'revision-1',question:'Explain this',operationId}),{timeoutMs:110000});
  expect(request.mock.calls.some(call=>call[0].type==='session.send')).toBe(false);
});
test('an ambiguous side question blocks later sends until explicit reconciliation',async()=>{
  const owner=services();request.mockResolvedValue(conversation);const reading=await owner.sideQuestions.read(chainId,new AbortController().signal);
  request.mockRejectedValue(new Error('lost acknowledgement'));await expect(owner.sideQuestions.ask(reading,{question:'Explain this'},operationId)).rejects.toThrow('lost');
  await expect(owner.sideQuestions.ask(reading,{question:'Try again'},operationId)).rejects.toMatchObject({name:'SideQuestionNotDispatchedError'});
  expect(request.mock.calls.filter(call=>call[0].type==='session.side-question.send')).toHaveLength(1);
});
test('attachment upload remains explicitly scoped to the actual agent account',async()=>{
  request.mockResolvedValue({ok:true});const ids=await services().uploadImages([{uri:'data:image/png;base64,YQ==',base64:'YQ==',mime:'image/png',width:1,height:1}]);
  expect(ids).toEqual([attachmentId]);expect(request).toHaveBeenCalledWith(expect.objectContaining({type:'attachment.put',agent:'codex',accountId:'account-1',controlSurface:'cli',id:attachmentId}),undefined);
});

test('first-turn features use the saved project without inventing a session identity',async()=>{
  request.mockResolvedValue({collaborationModes:['default','plan'],skillsSupported:true,skills:[]});
  const project=captureDirectProjectServices('pc','C:/project',agent,()=>mockCurrent,'work');await project.features();
  expect(request.mock.calls[0][0]).toMatchObject({type:'features.list',cwd:'C:/project',tool:'codex',accountId:'account-1'});
  expect(request.mock.calls[0][0]).not.toHaveProperty('sessionKey');
  expect(project.scope).not.toBe(captureDirectProjectServices('pc','C:/project',agent,()=>mockCurrent,'code').scope);
  await expect(project.context.read()).rejects.toThrow('创建会话后');expect(project.sideQuestions.isCurrent()).toBe(false);
});

test('temporary Direct questions use catalog/ask with negotiated options and never create persistent chains',async()=>{
  const owner=services();request.mockResolvedValue({...conversation,inputOptions:{version:1,model:true,effort:true,images:true,readOnly:true,defaultModel:'model-a'}});
  const reading=await owner.temporarySideChat.read(new AbortController().signal);
  request.mockResolvedValue({sessionKey:session.sessionKey,operationId,state:'completed',answer:'Temporary answer',contextScope:'loadedSnapshot',contextMessages:2,contextTruncated:false});
  await owner.temporarySideChat.ask(reading,{question:'Explain',model:'model-b',effort:'high',attachments:[attachmentId]},operationId);
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({type:'session.side-question.ask',expectedRevision:'revision-1',model:'model-b',effort:'high',attachments:[attachmentId],accountId:'account-1',controlSurface:'cli'}),{timeoutMs:60000});
  expect(request.mock.calls.some(call=>['session.send','session.start','session.side-question.open','session.side-question.send'].includes(call[0].type))).toBe(false);
  mockGeneration++;await expect(owner.temporarySideChat.ask(reading,{question:'Stale'},operationId)).rejects.toMatchObject({name:'SideQuestionNotDispatchedError'});
});

test('native Direct Work never falls back to the CLI temporary chat contract',async()=>{
  const owner=captureDirectSessionServices('pc',{...session,controlSurface:'desktop'},agent,()=>mockCurrent);
  expect(owner.temporarySideChat.isCurrent()).toBe(false);await expect(owner.temporarySideChat.read(new AbortController().signal)).rejects.toThrow('不支持');expect(request).not.toHaveBeenCalled();
});

test('Direct tool-sidechat validates private state and rejects changed connection ownership',async()=>{
  const owner=services();request.mockResolvedValue({...conversation,inputOptions:{version:1,model:true,effort:true,images:false,readOnly:true,defaultModel:'model-a',tools:{version:1,permissions:['workspace-write']}}});
  const reading=await owner.temporarySideChat.read(new AbortController().signal);
  const command={action:'open' as const,chainId,expectedRevision:'revision-1',operationId,permission:'workspace-write' as const};
  request.mockResolvedValue({sessionKey:session.sessionKey,chainId,revision:'revision-1',permission:'workspace-write',state:'idle',canSend:true,sequence:1,expiresAt:1000,answer:'',events:[],approvals:[]});
  await expect(owner.temporarySideChat.tools!(reading,command)).resolves.toMatchObject({state:'idle',sequence:1});
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({type:'session.side-question.tools',...command,accountId:'account-1',controlSurface:'cli'}),{timeoutMs:30000});
  request.mockResolvedValue({sessionKey:'codex:foreign'});await expect(owner.temporarySideChat.tools!(reading,command)).rejects.toThrow('未确认');
  const calls=request.mock.calls.length;mockGeneration++;await expect(owner.temporarySideChat.tools!(reading,command)).rejects.toMatchObject({name:'SideQuestionNotDispatchedError'});expect(request).toHaveBeenCalledTimes(calls);
});


test('explicit projectless services have a distinct owner and never request cwd-dependent features before a session exists',async()=>{
 const explicit=captureDirectProjectServices('pc','',agent,()=>mockCurrent,'work',true),missing=captureDirectProjectServices('pc','',agent,()=>mockCurrent,'work');
 expect(explicit.scope).not.toBe(missing.scope);expect(explicit.isCurrent()).toBe(true);expect(missing.isCurrent()).toBe(false);
 await expect(explicit.features()).rejects.toThrow('创建会话后');expect(request).not.toHaveBeenCalled();
 request.mockResolvedValue({models:['model-a']});await expect(explicit.models()).resolves.toMatchObject({models:['model-a']});
 mockGeneration++;expect(explicit.isCurrent()).toBe(false);
});
