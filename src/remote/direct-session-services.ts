import { randomUUID } from 'expo-crypto';
import type { AgentProfile, Command, ModelCapability, ModelCatalog, SessionInfo } from './client';
import { requestDirect } from './direct-api';
import { directConnectionGeneration, directDeliveryScope, getDirectConnectionState } from './direct-pairing';
import { AgentFeatureCache } from './agent-feature-cache';
import { CODEX_EFFORTS, isEffort } from './effort';
import { parseSessionContext } from './session-context';
import type { SessionContextReading } from './store';
import { parseSideQuestionConversation, sameSideQuestionSelection, SideQuestionNotDispatchedError, validSideQuestionInput, type SideQuestionReading, type SideQuestionResult } from './side-question';
import type { SideQuestionTransport } from './SideQuestionPanel';
import type { TemporarySideChatTransport } from './temporary-side-chat';
import { parseSideQuestionCatalog, parseSideQuestionResult, validTemporarySideQuestionInput } from './side-question';
import { attachmentChunks, type RemoteImage } from './attachment-chunks';
import {parseSideToolState} from './side-question-tools';
import { createDirectSessionCommands } from './direct-session-commands';
import type { SessionCommandTransport } from './session-commands';

export function parseDirectModelCatalog(value:unknown):ModelCatalog {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('电脑返回的模型目录无效');
  const raw=value as Record<string,unknown>;
  if(!Array.isArray(raw.models)||raw.models.length>1000||raw.models.some(item=>typeof item!=='string'||!item||item.length>200||item.trim()!==item||/[\r\n\u0000]/.test(item)))throw new Error('电脑返回的模型目录无效');
  const models=[...new Set(raw.models as string[])],capabilities=raw.modelCapabilities&&typeof raw.modelCapabilities==='object'&&!Array.isArray(raw.modelCapabilities)?raw.modelCapabilities as Record<string,unknown>:{};
  const modelCapabilities=Object.fromEntries(models.map(id=>{
    const entry=capabilities[id]&&typeof capabilities[id]==='object'?capabilities[id] as Record<string,unknown>:{};
    const source:ModelCapability['source']=entry.source==='codex-model-list'||entry.source==='relay-model-list'?entry.source:'unknown';
    const known=source==='codex-model-list'&&entry.reasoningKnown===true&&Array.isArray(entry.reasoningEfforts);
    const levels=Array.isArray(entry.reasoningEfforts)?entry.reasoningEfforts.filter(isEffort):[];
    const modalities=Array.isArray(entry.inputModalities)?entry.inputModalities:[];
    const capability:ModelCapability={source,reasoningKnown:known,...(known?{reasoningEfforts:CODEX_EFFORTS.filter(level=>levels.includes(level))}:{}),
      ...(source==='codex-model-list'&&Array.isArray(entry.inputModalities)?{inputModalities:['text','image'].filter(item=>modalities.includes(item)) as Array<'text'|'image'>}:{})};
    return [id,capability];
  }));
  return {models,modelCapabilities,...(typeof raw.api==='string'?{api:raw.api}:{})};
}

/** Transport-specific services share UI contracts but never invoke Hub state. */
export function captureDirectSessionServices(deviceId:string,session:SessionInfo,agent:AgentProfile,isSelectionCurrent:()=>boolean) {
  const pairing=directDeliveryScope(),generation=directConnectionGeneration(),cache=new AgentFeatureCache();
  const scope=JSON.stringify([pairing,deviceId,session.sessionKey,agent.id,agent.api.accountId??'',session.cwd]);
  const current=()=>isSelectionCurrent()&&Boolean(pairing&&directDeliveryScope()===pairing&&directConnectionGeneration()===generation
    &&getDirectConnectionState().status==='connected'&&getDirectConnectionState().deviceId===deviceId);
  const guard=()=>{if(!current())throw new Error('电脑、会话或 API 已变化，请重新打开此操作');};
  const need=(name:keyof NonNullable<AgentProfile['capabilities']>)=>{guard();if(agent.capabilities?.[name]!==true)throw new Error('当前 Agent 尚未开放这个操作');};
  const base={tool:agent.tool,sessionKey:session.sessionKey,controlSurface:'cli' as const,...(agent.api.accountId?{accountId:agent.api.accountId}:{})};
  const send=async(command:Command,timeoutMs?:number)=>{guard();const raw=await requestDirect(command,timeoutMs?{timeoutMs}:undefined);guard();return raw;};
  const readContext=async(signal?:AbortSignal):Promise<SessionContextReading>=>{
    need('context');if(signal?.aborted)throw new Error('读取已取消');
    const raw=await send({...base,type:'session.context'});if(signal?.aborted)throw new Error('读取已取消');
    const value=parseSessionContext(raw,session.sessionKey);if(!value)throw new Error('上下文状态未确认');return {scope,value};
  };
  const heads=new Map<string,string|undefined>(),unconfirmed=new Set<string>(),flights=new Set<string>();
  const sideQuestions:SideQuestionTransport={isCurrent:()=>current()&&agent.capabilities?.sideQuestion===true,
    read:async(chainId,signal,options={})=>{
      need('sideQuestion');if(signal.aborted)throw new Error('读取已取消');
      if(options.create)await send({type:'session.open',sessionKey:session.sessionKey,controlSurface:'cli',limit:400});
      const previous=heads.get(chainId);
      const raw=await send({...base,type:options.create?'session.side-question.open':'session.side-question.read',chainId,...(options.cursor?{cursor:options.cursor}:{})});
      if(signal.aborted)throw new Error('读取已取消');const value=parseSideQuestionConversation(raw,session.sessionKey,chainId);if(!value)throw new Error('侧问记录无效');
      if(heads.get(chainId)!==previous&&heads.get(chainId)!==value.lastOperationId)throw new Error('侧问已有新回答，请刷新');
      if(!options.cursor){heads.set(chainId,value.lastOperationId);if(value.turns.some(turn=>turn.state!=='completed'))unconfirmed.add(chainId);else unconfirmed.delete(chainId);}
      return {scope,value,conversation:value};
    },
    ask:async(reading,input,operationId)=>{
      const chainId=reading.conversation?.chainId;
      try{need('sideQuestion');if(!chainId||reading.scope!==scope||reading.value.sessionKey!==session.sessionKey||!reading.value.available||!reading.value.revision
        ||!validSideQuestionInput(session.sessionKey,input)||input.previousOperationId!==heads.get(chainId)||unconfirmed.has(chainId)||flights.has(chainId))throw new Error('请刷新并确认侧问来源后再发送');}
      catch(reason){throw new SideQuestionNotDispatchedError(reason instanceof Error?reason.message:'侧问尚未发送');}
      const id=chainId!,frozen=JSON.parse(JSON.stringify(input)) as typeof input;flights.add(id);
      try{
        const raw=await send({...base,type:'session.side-question.send',chainId:id,expectedRevision:reading.value.revision,operationId,...frozen},110000);
        const conversation=parseSideQuestionConversation(raw,session.sessionKey,id),turn=conversation?.turns.find(item=>item.operationId===operationId);
        if(!conversation||!turn||turn.question!==frozen.question||!sameSideQuestionSelection(turn.selection,frozen.selection))throw new Error('侧问结果未确认');
        const result:SideQuestionResult={sessionKey:session.sessionKey,operationId,state:turn.state==='completed'?'completed':'unconfirmed',answer:turn.answer,contextScope:conversation.contextScope,contextMessages:conversation.contextMessages,contextTruncated:conversation.contextTruncated,createdAt:turn.createdAt,conversation,...(turn.error?{error:turn.error}:{})};
        if(result.state==='completed'){heads.set(id,operationId);unconfirmed.delete(id);}else unconfirmed.add(id);return result;
      }catch(error){unconfirmed.add(id);throw error;}finally{flights.delete(id);}
    },
    remove:async(chainId,operationId)=>{need('sideQuestion');const raw=await send({...base,type:'session.side-question.delete',chainId,operationId});if(parseSideQuestionConversation(raw,session.sessionKey,chainId)?.deleted!==true)throw new Error('删除结果未确认，请刷新');heads.delete(chainId);unconfirmed.delete(chainId);},
  };
  const temporaryScope=JSON.stringify([scope,generation,agent.api,agent.execution]);
  const temporarySideChat:TemporarySideChatTransport={isCurrent:()=>current()&&agent.capabilities?.sideQuestion===true&&session.controlSurface!=='desktop'&&session.controlSurface!=='read-only',
    tools:async(reading,request)=>{
      try{need('sideQuestion');if(!temporarySideChat.isCurrent()||agent.id!=='codex'||reading.scope!==temporaryScope||reading.value.sessionKey!==session.sessionKey||!reading.value.inputOptions?.tools||request.expectedRevision!==reading.value.revision)throw new Error('当前来源未开放工具型临时聊天');}
      catch(reason){throw new SideQuestionNotDispatchedError(reason instanceof Error?reason.message:'临时执行尚未发送');}
      const raw=await send({...base,type:'session.side-question.tools',...request},30000);
      const value=parseSideToolState(raw,session.sessionKey,request);if(!value)throw new Error('临时执行结果未确认，请核对状态');return value;
    },
    read:async signal=>{
      need('sideQuestion');if(!temporarySideChat.isCurrent()||signal.aborted)throw new Error('当前控制方式不支持临时聊天');
      await send({type:'session.open',sessionKey:session.sessionKey,controlSurface:'cli',limit:400});
      const raw=await send({...base,type:'session.side-question.catalog'});if(signal.aborted)throw new Error('读取已取消');
      const value=parseSideQuestionCatalog(raw,session.sessionKey);if(!value)throw new Error('电脑返回的临时聊天能力无效');return {scope:temporaryScope,value};
    },
    ask:async(reading,input,operationId)=>{
      try{need('sideQuestion');if(!temporarySideChat.isCurrent()||reading.scope!==temporaryScope||reading.value.sessionKey!==session.sessionKey||!reading.value.available||!validTemporarySideQuestionInput(reading,input))throw new Error('临时聊天来源或选项已变化，请新建侧聊');}
      catch(reason){throw new SideQuestionNotDispatchedError(reason instanceof Error?reason.message:'临时问题尚未发送');}
      const raw=await send({...base,type:'session.side-question.ask',expectedRevision:reading.value.revision,operationId,...input},60000);
      const value=parseSideQuestionResult(raw,reading,operationId);if(!value)throw new Error('临时聊天回答未确认');return value;
    },
    models:async(refresh=false)=>{need('modelOverride');return parseDirectModelCatalog(await send({type:'models.list',tool:agent.tool,controlSurface:'cli',refresh,...(agent.api.accountId?{accountId:agent.api.accountId}:{})}));},
    uploadImages:async images=>{
      need('imageInput');if(!temporarySideChat.isCurrent()||images.length>4)throw new Error('临时图片来源或数量无效');const ids:string[]=[];
      for(const image of images){const id=`att_${randomUUID().replace(/-/g,'')}`,chunks=attachmentChunks(image.base64);if(chunks.length>64)throw new Error('图片过大');for(let index=0;index<chunks.length;index++)await send({type:'attachment.put',id,mime:image.mime,index,total:chunks.length,data:chunks[index],agent:agent.id,controlSurface:'cli',...(agent.api.accountId?{accountId:agent.api.accountId}:{})});ids.push(id);}return ids;
    },
  };
  const sessionCommands = createDirectSessionCommands({scope,sessionKey:session.sessionKey,base,guard,need,send,
    isCurrent:()=>current()&&session.controlSurface!=='desktop'&&session.controlSurface!=='read-only'});
  return {scope,isCurrent:current,guard,sideQuestions,temporarySideChat,sessionCommands,
    models:async(refresh=false)=>{need('modelOverride');return parseDirectModelCatalog(await send({type:'models.list',tool:agent.tool,controlSurface:'cli',refresh,...(agent.api.accountId?{accountId:agent.api.accountId}:{})}));},
    features:async(force=false)=>{need('features');return cache.read({pairing,device:deviceId,agent:agent.id,source:'direct',account:agent.api.accountId??'',cwd:session.cwd,session:session.sessionKey},
      options=>send({...base,type:'features.list',cwd:session.cwd,...options}),force);},
    context:{scope:()=>scope,read:readContext,compact:async(reading:SessionContextReading)=>{
      need('compact');if(reading.scope!==scope||!reading.value.canCompact||reading.value.compaction?.blocking)throw new Error('请刷新并确认上下文状态');
      const raw=await send({...base,type:'session.compact',expectedRevision:reading.value.revision,operationId:randomUUID()},110000);
      const value=parseSessionContext(raw,session.sessionKey);if(!value)throw new Error('压缩结果未确认');return {scope,value};}},
    uploadImages:async(images:RemoteImage[])=>{
      need('imageInput');if(images.length>4)throw new Error('最多发送 4 张图片');const ids:string[]=[];
      for(const image of images){const id=`att_${randomUUID().replace(/-/g,'')}`,chunks=attachmentChunks(image.base64);if(chunks.length>64)throw new Error('图片过大');
        for(let index=0;index<chunks.length;index++)await send({type:'attachment.put',id,mime:image.mime,index,total:chunks.length,data:chunks[index],agent:agent.id,controlSurface:'cli',...(agent.api.accountId?{accountId:agent.api.accountId}:{})});ids.push(id);}
      return ids;
    },
  };
}
export type DirectSessionServices=Omit<ReturnType<typeof captureDirectSessionServices>,'sessionCommands'> & {sessionCommands?:SessionCommandTransport};

/** The first turn has a saved project, but no thread identity yet. */
export function captureDirectProjectServices(deviceId:string,cwd:string,agent:AgentProfile,isSelectionCurrent:()=>boolean,workspaceMode:'code'|'work'='code'):DirectSessionServices {
  const pairing=directDeliveryScope(),generation=directConnectionGeneration(),cache=new AgentFeatureCache();
  const scope=JSON.stringify([pairing,deviceId,null,agent.id,agent.api.accountId??'',cwd,workspaceMode]);
  const current=()=>isSelectionCurrent()&&Boolean(pairing&&directDeliveryScope()===pairing&&directConnectionGeneration()===generation
    &&getDirectConnectionState().status==='connected'&&getDirectConnectionState().deviceId===deviceId);
  const guard=()=>{if(!current())throw new Error('电脑、项目或 API 已变化，请重新选择');};
  const need=(name:keyof NonNullable<AgentProfile['capabilities']>)=>{guard();if(agent.capabilities?.[name]!==true)throw new Error('当前 Agent 尚未开放这个操作');};
  const send=async(command:Command)=>{guard();const raw=await requestDirect(command);guard();return raw;};
  const unavailable=async():Promise<never>=>{throw new Error('创建会话后才能使用此操作');};
  return {scope,isCurrent:current,guard,sideQuestions:{isCurrent:()=>false,read:unavailable,ask:unavailable,remove:unavailable},temporarySideChat:{isCurrent:()=>false,read:unavailable,ask:unavailable},context:{scope:()=>scope,read:unavailable,compact:unavailable},
    sessionCommands:{scope:()=>scope,isCurrent:()=>false,readActions:unavailable,applyAction:unavailable,readWorkflows:unavailable,applyReview:unavailable},
    models:async(refresh=false)=>{guard();if(!agent.capabilities?.modelOverride)need('startModelOverride');return parseDirectModelCatalog(await send({type:'models.list',tool:agent.tool,controlSurface:'cli',refresh,...(agent.api.accountId?{accountId:agent.api.accountId}:{})}));},
    features:async(force=false)=>{need('features');return cache.read({pairing,device:deviceId,agent:agent.id,source:'direct',account:agent.api.accountId??'',cwd,session:''},
      options=>send({type:'features.list',tool:agent.tool,cwd,controlSurface:'cli',...(agent.api.accountId?{accountId:agent.api.accountId}:{}),...options}),force);},
    uploadImages:async(images:RemoteImage[])=>{
      need('imageInput');if(images.length>4)throw new Error('最多发送 4 张图片');const ids:string[]=[];
      for(const image of images){const id=`att_${randomUUID().replace(/-/g,'')}`,chunks=attachmentChunks(image.base64);if(chunks.length>64)throw new Error('图片过大');
        for(let index=0;index<chunks.length;index++)await send({type:'attachment.put',id,mime:image.mime,index,total:chunks.length,data:chunks[index],agent:agent.id,controlSurface:'cli',...(agent.api.accountId?{accountId:agent.api.accountId}:{})});ids.push(id);}
      return ids;
    },
  };
}
