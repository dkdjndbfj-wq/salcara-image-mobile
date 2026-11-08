import { randomUUID } from 'expo-crypto';
import type { AgentProfile, SessionInfo } from './client';
import { continueSession, getRemoteState, interruptSession, openSession, remoteDeliveryScope, timelineKey, watchCredentials, type Timeline } from './store';
import { requestDirect } from './direct-api';
import { directConnectionGeneration, directDeliveryScope, getDirectConnectionState } from './direct-pairing';
import { mergeDirectHistoryPage, parseDirectHistoryPage } from './direct-history';
import { EMPTY_TIMELINE } from './store';
import { CONTINUE_PROMPT, turnControlTarget } from './turn-control';

export interface SubagentSelection { deviceId: string; parentSessionKey: string; agent: AgentProfile; surface: 'cli'|'desktop'|'read-only'; children: string[] }
export interface SubagentSnapshot { session: SessionInfo; timeline: Timeline }
export interface SubagentTransport {
  isCurrent(): boolean;
  read(sessionKey: string): Promise<SubagentSnapshot>;
  stop(snapshot: SubagentSnapshot): Promise<'requested'|'stopped'|'already_finished'|'unconfirmed'>;
  continue(snapshot: SubagentSnapshot): Promise<void>;
}

export function subagentControlReason(selection: SubagentSelection, snapshot: SubagentSnapshot | undefined, action: 'stop'|'continue'): string | undefined {
  if (selection.surface !== 'cli') return '桌面宿主尚未开放子智能体控制，请在电脑处理';
  if (!snapshot) return '先刷新子智能体状态';
  const info=snapshot.session;
  if (!selection.children.includes(info.sessionKey) || info.sessionKey===selection.parentSessionKey
    || info.parentSessionKey && info.parentSessionKey!==selection.parentSessionKey) return '子智能体与当前主任务的关系已变化';
  if (info.tool!==selection.agent.tool || info.controlSurface==='desktop' || info.controlSurface==='read-only' || !info.controllable || info.archived) return '这个子会话当前只支持查看';
  if(action==='stop' && (!selection.agent.capabilities?.interrupt || !selection.agent.capabilities?.preciseInterrupt)) return '当前 Agent 不支持精确停止子任务';
  if(action==='continue' && !selection.agent.capabilities?.continue) return '当前 Agent 不支持继续子任务';
  if(!turnControlTarget(snapshot.timeline,action)) return action==='stop'?'没有已确认的运行轮次':'当前轮次尚未确认结束';
  return undefined;
}

function assertChild(selection:SubagentSelection,session:SessionInfo) {
  if(!selection.children.includes(session.sessionKey)||session.sessionKey===selection.parentSessionKey||session.tool!==selection.agent.tool
    || session.parentSessionKey && session.parentSessionKey!==selection.parentSessionKey) throw new Error('返回的子智能体不属于当前主任务');
}

export function captureHubSubagents(selection:SubagentSelection):SubagentTransport {
  const scope=remoteDeliveryScope(),credentials=watchCredentials(),account=selection.agent.api.accountId;
  const current=()=>{
    const state=getRemoteState(),now=watchCredentials(),profile=state.agents[selection.deviceId]?.list.find(item=>item.id===selection.agent.id);
    return Boolean(scope&&scope===remoteDeliveryScope()&&credentials?.pairToken&&now?.url===credentials.url&&now?.pairToken===credentials.pairToken
      &&state.connection==='open'&&state.devices.some(item=>item.deviceId===selection.deviceId&&item.online)&&profile?.api.accountId===account);
  };
  const guard=()=>{if(!current())throw new Error('电脑或 API 已变化，请回原主任务刷新');};
  const allowed=(snapshot:SubagentSnapshot,action:'stop'|'continue')=>{guard();assertChild(selection,snapshot.session);const reason=subagentControlReason(selection,snapshot,action);if(reason)throw new Error(reason);
    const actual=getRemoteState().timelines[timelineKey(selection.deviceId,snapshot.session.sessionKey)];
    if(turnControlTarget(actual,action)!==turnControlTarget(snapshot.timeline,action))throw new Error('子任务轮次已变化，请刷新后确认');};
  return {isCurrent:current,
    read:async sessionKey=>{guard();if(selection.surface==='read-only'||!selection.children.includes(sessionKey))throw new Error('当前控制方式不支持读取这个子任务');
      await openSession(selection.deviceId,sessionKey,selection.surface==='desktop'?{controlSurface:'desktop'}:undefined);guard();
      const timeline=getRemoteState().timelines[timelineKey(selection.deviceId,sessionKey)];if(!timeline?.session||timeline.error||!timeline.snapshotAt)throw new Error('子任务状态未确认');
      assertChild(selection,timeline.session);return {session:timeline.session,timeline};},
    stop:async snapshot=>{allowed(snapshot,'stop');const result=await interruptSession(selection.deviceId,snapshot.session.sessionKey,turnControlTarget(snapshot.timeline,'stop'));guard();return result.status;},
    continue:async snapshot=>{allowed(snapshot,'continue');await continueSession(selection.deviceId,snapshot.session.sessionKey,{accountId:account});guard();},
  };
}

export function captureDirectSubagents(selection:SubagentSelection,isParentCurrent:()=>boolean):SubagentTransport {
  const scope=directDeliveryScope(),generation=directConnectionGeneration();
  const current=()=>isParentCurrent()&&Boolean(scope&&scope===directDeliveryScope()&&generation===directConnectionGeneration()
    &&getDirectConnectionState().status==='connected'&&getDirectConnectionState().deviceId===selection.deviceId);
  const guard=()=>{if(!current())throw new Error('电脑或主任务已变化，请重新打开子智能体');};
  const allowed=(snapshot:SubagentSnapshot,action:'stop'|'continue')=>{guard();assertChild(selection,snapshot.session);const reason=subagentControlReason(selection,snapshot,action);if(reason)throw new Error(reason);};
  return {isCurrent:current,
    read:async sessionKey=>{guard();if(selection.surface!=='cli'||!selection.children.includes(sessionKey))throw new Error('当前直连不支持读取这个子智能体');
      const raw=await requestDirect({type:'session.open',sessionKey,controlSurface:'cli',limit:400,messageLimit:2});guard();
      const page=parseDirectHistoryPage(raw,selection.deviceId,{sessionKey,tool:selection.agent.tool});assertChild(selection,page.session);
      const timeline={...mergeDirectHistoryPage(EMPTY_TIMELINE,page,[]),snapshotAt:Date.now(),loading:false};return {session:page.session,timeline};},
    stop:async snapshot=>{allowed(snapshot,'stop');const expectedTurnId=turnControlTarget(snapshot.timeline,'stop')!;
      const raw=await requestDirect({type:'session.interrupt',sessionKey:snapshot.session.sessionKey,controlSurface:'cli',expectedTurnId,operationId:randomUUID()}) as {turnId?:string;status?:string};guard();
      if(raw?.turnId!==expectedTurnId||!['requested','stopped','already_finished','unconfirmed'].includes(raw.status??''))throw new Error('停止结果未确认，请刷新原子会话');
      return raw.status as 'requested'|'stopped'|'already_finished'|'unconfirmed';},
    continue:async snapshot=>{
      allowed(snapshot,'continue');
      const sessionKey=snapshot.session.sessionKey,expectedTurnId=turnControlTarget(snapshot.timeline,'continue')!,operationId=randomUUID();
      const raw=await requestDirect({type:'session.continue',sessionKey,controlSurface:'cli',expectedTurnId,operationId,text:CONTINUE_PROMPT,...(selection.agent.api.accountId?{accountId:selection.agent.api.accountId}:{})},{timeoutMs:100000}) as {accepted?:boolean;sessionKey?:string;previousTurnId?:string;operationId?:string};
      guard();
      if(raw?.accepted!==true||raw.sessionKey!==sessionKey||raw.previousTurnId!==expectedTurnId||raw.operationId!==operationId)throw new Error('继续结果未确认，请刷新原子会话；不会自动重发');
    },
  };
}
