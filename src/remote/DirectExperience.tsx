import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardSafeView } from '../components/KeyboardSafeView';
import { randomUUID } from 'expo-crypto';

import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import type { AgentProfile, Decision, HubEvent, Project, QuestionAnswers, RemoteApiOption, SessionInfo, WorkspaceMode } from './client';
import { isDirectEvent, readDirectHistoryWithRevertGuard, normalizeDirectEvent, parseDirectHistoryPage, parseDirectProjects, parseDirectWorkspaceCapabilities, parseDirectSessionPage, parseDirectStartReceipt } from './direct-history';
import { directConnectionGeneration, directDeliveryScope, getDirectConnectionState, subscribeDirectConnection, disconnectDirect, forgetDirectPairing, reconnectDirect } from './direct-pairing';
import { requestDirect, subscribeDirectEvents, type DirectEventEnvelope } from './direct-api';
import { approvalDecisions } from './approvals';
import {directQuestionDraftSource,finishDirectQuestionDraft} from './direct-question-drafts';
import { applyEvent, EMPTY_TIMELINE, timelineKey, type RemoteState, type Timeline } from './store';
import { agentSessions, agentSupports, parseAgentStatus, sessionWorkspaceMode } from './projection';
import { claudeApiAdmissionReady } from './api-admission';
import { createDirectWorkspaceRuntime } from './direct-workspace';
import { DirectConversation } from './DirectConversation';
import { DirectComputerManagement } from './DirectComputerManagement';
import { CONTINUE_PROMPT, turnControlTarget } from './turn-control';
import { directActionUncertain, directRetryTarget } from './direct-turn-actions';
import type { DirectComposerSubmission, DirectSendOutcome } from './DirectComposer';
import { DirectNewComposer } from './DirectNewComposer';
import { DirectProjectDirectory } from './DirectProjectDirectory';
import { NewConversationFlow, type NewConversationSelection } from './NewConversationFlow';
import {conversationReadScope} from './conversation-unread';
import { AgentDirectoryHeading } from './AgentDirectoryHeading';
import { createDirectPendingOperation, type DirectPendingOperation } from './direct-pending-operation';
import { useDirectHistoryRecovery } from './useDirectHistoryRecovery';
import { consumeAcceptedComposerDraft, type ComposerDraftRecoveryReceipt } from './composer-drafts';
import { directDraftKey } from './direct-composer-drafts';
import { createDirectHistoryRepairTracker } from './direct-history-recovery';
import { missingSessionReadCode } from './missing-session-error';
import { useDirectApiSelection } from './useDirectApiSelection';
import { hasActiveAgentWork } from './work-activity';
import {latestEditableTurn,parseSessionRevertResult} from './session-revert';
import type {SentUserMessage} from './sent-message-revision';
import { useBackAction, useChildBackAction, type RegisterBackAction } from './useBackAction';

const PAGE_SIZE = 20;
const INITIAL_MESSAGES = 2;
const MAX_EVENTS = 800;
const HISTORY_PAGE_MESSAGES = 10;

export function DirectExperience({ workspaceMode = 'code', newConversationRequest = 0, onMobileWorkspaceVisibilityChange, onRegisterBack }: {
  workspaceMode?: WorkspaceMode;
  newConversationRequest?: number;
  onMobileWorkspaceVisibilityChange?: (visible: boolean) => void;
  onRegisterBack?: RegisterBackAction;
}) {
  const connection = useSyncExternalStore(subscribeDirectConnection, getDirectConnectionState, getDirectConnectionState);
  const styles = useStyles();
  const d = useDesk();
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [apis, setApis] = useState<RemoteApiOption[]>([]);
  const [autoAll, setAutoAll] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  const [projectless, setProjectless] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<SessionInfo | null>(null);
  const [timeline, setTimeline] = useState<Timeline>(EMPTY_TIMELINE);
  const revertedHistory=useRef(new Map<string,Pick<Timeline,'revertedTurns'|'revertedItems'|'revertOperations'>>());
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [uncertainSend, setUncertainSend] = useState(false);
  const [pendingStop, setPendingStop] = useState<{identity:string;turnId:string;operationId:string}>();
  const [pendingRevision,setPendingRevision]=useState(0);
  const [newSession, setNewSession] = useState(false);
  const [globalNew, setGlobalNew] = useState(false);
  const [globalSelection, setGlobalSelection] = useState<(NewConversationSelection & { scope: string }) | undefined>();
  const seenNewRequest = useRef(0);
  useEffect(() => { if (seenNewRequest.current !== newConversationRequest) { seenNewRequest.current = newConversationRequest; if (newConversationRequest) setGlobalNew(true); } }, [newConversationRequest]);
  const [managementOpen, setManagementOpen] = useState(false);
  const [draftRecovery,setDraftRecovery]=useState<ComposerDraftRecoveryReceipt>();
  const [uncertainStart, setUncertainStart] = useState(false);
  const [recoveryRevision,setRecoveryRevision]=useState(0);
  const owner = useRef(0);
  const pendingEvents = useRef<HubEvent[]>([]);
  const selectedKey = useRef<string | null>(null);
  const snapshotLoading = useRef(false);
  const busy = useRef(false);
  const drafts = useRef(new Map<string, string>());
  const scope = directDeliveryScope(), connectionGeneration = directConnectionGeneration();
  useEffect(() => { setManagementOpen(false); }, [scope, connectionGeneration, connection.status]);
  const selectionRef=useRef(selected);selectionRef.current=selected;
  const connectedOwner=useRef('');
  const connectionOwner=JSON.stringify([scope,connection.deviceId,workspaceMode]);
  useEffect(() => {
    onMobileWorkspaceVisibilityChange?.(globalNew);
    return () => onMobileWorkspaceVisibilityChange?.(false);
  }, [scope, connectionGeneration, connection.status, selected?.sessionKey, workspaceMode, globalNew, onMobileWorkspaceVisibilityChange]);
  const remote: RemoteState = useMemo(() => {
    const deviceId = connection.deviceId;
    return { phase:'ready',serviceId:null,connections:[],connectionId:scope,selectedHubUrl:null,probes:{},connection:connection.status==='connected'?'open':'idle',
      devices:deviceId?[{deviceId,name:connection.deviceName||'电脑',os:'unknown',tools:[],projects,capabilities,online:connection.status==='connected',lastSeen:0}]:[],devicesLoaded:true,
      sessions:deviceId?{[deviceId]:{list:sessions,loading:loading&&!selected,loaded:directoryLoaded,pages:agentId?{[agentId]:{loading:false}}:{}}}:{},
      agents:deviceId?{[deviceId]:{list:agents,apis,autoAll,loading:false,loaded:true}}:{},timelines:deviceId&&selected?{[timelineKey(deviceId,selected.sessionKey)]:timeline}:{},approvals:{},signingIn:null,focus:null };
  }, [scope,connection.deviceId,connection.deviceName,connection.status,projects,capabilities,sessions,loading,selected,directoryLoaded,agentId,agents,apis,autoAll,timeline]);
  const remoteRef = useRef(remote); remoteRef.current = remote;
  const runtime = useMemo(() => createDirectWorkspaceRuntime(() => remoteRef.current, () => selectedKey.current), [scope,connectionGeneration,selected?.sessionKey]);
  const workspaceRuntime = useMemo(() => ({...runtime,remote}), [runtime,remote]);
  useEffect(() => () => { owner.current++; selectedKey.current=null; }, []);
  useEffect(() => { if(selected)drafts.current.set(`${scope}|${selected.sessionKey}`,text); }, [scope,selected?.sessionKey,text]);

  const loadProfiles = useCallback(async () => {
    const deviceId = connection.deviceId;
    if (!deviceId || connection.status !== 'connected') return;
    const revision = ++owner.current;
    const restore=connectedOwner.current===connectionOwner?selectionRef.current:null;
    connectedOwner.current=connectionOwner;
    busy.current = false; selectedKey.current = null; snapshotLoading.current = false; pendingEvents.current = [];
    if(!restore){setAgents([]);setApis([]);setAutoAll(false);setAgentId(null);setSessions([]);setNextCursor(undefined);setSelected(null);setTimeline(EMPTY_TIMELINE);setDirectoryLoaded(false);setText('');}
    else selectedKey.current=restore.sessionKey;
    setCapabilities([]);setProjects([]);setProjectPath('');setProjectless(false);setNewSession(false);setDraftRecovery(undefined);setSending(false);setLoadingMore(false);
    setError(''); setLoading(true);
    try {
      const raw = await requestDirect({ type: 'agents.status' });
      if (revision !== owner.current || getDirectConnectionState().deviceId !== deviceId) return;
      const parsed = parseAgentStatus(raw);
      const available = parsed.agents.filter(profile => profile.available && agentSupports(profile, profile.id, 'list'));
      setAgents(available);
      setApis(parsed.apis);
      setAutoAll(parsed.autoAll);
      setAgentId(current => available.some(profile => profile.id === current) ? current : available[0]?.id ?? null);
      if(restore&&!available.some(item=>agentSessions([restore],item).length)){
        selectedKey.current=null;setSelected(null);setTimeline(EMPTY_TIMELINE);setDirectoryLoaded(false);
      }
      try {
        const projectReply = await requestDirect({ type: 'projects.list' });
        const directory = parseDirectProjects(projectReply), advertised = parseDirectWorkspaceCapabilities(projectReply);
        if (revision !== owner.current || getDirectConnectionState().deviceId !== deviceId) return;
        setProjects(directory);
        setCapabilities(advertised);
        // Selecting a computer must never silently choose its first project.
      } catch (reason) {
        if (revision === owner.current) { setProjects([]); setProjectPath('');setProjectless(false); setError(reason instanceof Error ? reason.message : '读取电脑项目失败'); }
      }
    } catch (reason) {
      if (revision === owner.current) setError(reason instanceof Error ? reason.message : '读取电脑 Agent 失败');
    } finally { if (revision === owner.current) {setLoading(false);if(restore)setRecoveryRevision(value=>value+1);} }
  }, [connection.deviceId, connection.status, scope, connectionGeneration, workspaceMode]);

  const readDirectory = useCallback(async (more = false) => {
    const deviceId = connection.deviceId, profile = agents.find(item => item.id === agentId);
    if (!deviceId || connection.status !== 'connected' || !profile || busy.current) return;
    const cursor = more ? nextCursor : undefined;
    if (more && !cursor) return;
    busy.current = true;
    const revision = ++owner.current;
    setError(''); more ? setLoadingMore(true) : setLoading(true);
    try {
      const result = await requestDirect({ type: 'sessions.list', tool: profile.tool, client: profile.id === 'claude' ? 'code' : undefined,
        controlSurface: 'cli', cursor, limit: PAGE_SIZE });
      if (revision !== owner.current || getDirectConnectionState().deviceId !== deviceId) return;
      const page = parseDirectSessionPage(result, profile.tool, cursor);
      const matching = agentSessions(page.sessions, profile).filter(item => sessionWorkspaceMode(item) === workspaceMode);
      setSessions(current => more ? [...new Map([...current, ...matching].map(item => [item.sessionKey, item])).values()] : matching);
      setNextCursor(page.nextCursor);
      setDirectoryLoaded(true);
    } catch (reason) { if (revision === owner.current) { setDirectoryLoaded(true); setError(reason instanceof Error ? reason.message : '读取会话失败'); } }
    finally { if (revision === owner.current) { busy.current = false; setLoading(false); setLoadingMore(false); } }
  }, [connection.deviceId, connection.status, agents, agentId, nextCursor, workspaceMode]);

  const openConversation = useCallback(async (session: SessionInfo, preserveDraft = false) => {
    const deviceId = connection.deviceId;
    if (!deviceId || connection.status !== 'connected' || busy.current) return;
    busy.current = true;
    const revision = ++owner.current;
    const original = selectedKey.current === session.sessionKey ? currentAction.current.timeline : EMPTY_TIMELINE;
    const current = () => revision === owner.current && getDirectConnectionState().deviceId === deviceId && directDeliveryScope() === scope;
    selectedKey.current = session.sessionKey;
    snapshotLoading.current = true;
    pendingEvents.current = [];
    selectionRef.current=session;currentAction.current.timeline={ ...EMPTY_TIMELINE, loading: true };
    setSelected(session); setTimeline(currentAction.current.timeline); setError('');
    if(!preserveDraft)setText(drafts.current.get(`${scope}|${session.sessionKey}`) ?? '');
    setLoading(true); setLoadingMore(false);
    try {
      const retain = (value: Timeline) => { currentAction.current.timeline=value;setTimeline(value);revertedHistory.current.set(JSON.stringify([scope,deviceId,session.sessionKey]),{revertedTurns:value.revertedTurns,revertedItems:value.revertedItems,revertOperations:value.revertOperations}); };
      const result = await readDirectHistoryWithRevertGuard({ ...original, ...revertedHistory.current.get(JSON.stringify([scope,deviceId,session.sessionKey])) },
        async () => parseDirectHistoryPage(await requestDirect({ type: 'session.open', sessionKey: session.sessionKey, controlSurface: 'cli', limit: 400, messageLimit: INITIAL_MESSAGES }), deviceId, session),
        () => { const queued = pendingEvents.current;pendingEvents.current = [];return queued; }, current, retain);
      if (!result || !current()) return;
      snapshotLoading.current = false;
      const merged = result.timeline;retain(merged);
      currentAction.current.timeline={ ...merged, loading: false, readErrorCode: undefined, snapshotAt: Date.now(), nextCursor: result.nextCursor, historyExpanded: false };
      setTimeline(currentAction.current.timeline);
      selectionRef.current=merged.session ?? session;setSelected(selectionRef.current);
    } catch (reason) {
      if (revision === owner.current) {
        const queued = pendingEvents.current;
        pendingEvents.current = [];
        snapshotLoading.current = false;
        currentAction.current.timeline={ ...queued.reduce(applyEvent, currentAction.current.timeline), loading: false, error: (reason as Error).message, readErrorCode: missingSessionReadCode(reason) };
        setTimeline(currentAction.current.timeline); setError((reason as Error).message);
      }
    } finally { if (revision === owner.current) { busy.current = false; setLoading(false); } }
  }, [connection.deviceId, connection.status, scope]);

  const loadEarlier = useCallback(async () => {
    const deviceId = connection.deviceId, session = selected, cursor = timeline.nextCursor;
    if (!deviceId || connection.status !== 'connected' || !session || !cursor || busy.current) return;
    busy.current = true;
    const revision = ++owner.current;
    snapshotLoading.current = true;
    pendingEvents.current = [];
    setLoadingMore(true); setError('');
    try {
      const current = () => revision === owner.current && getDirectConnectionState().deviceId === deviceId && selectedKey.current === session.sessionKey;
      const retain = (value: Timeline) => { currentAction.current.timeline=value;setTimeline(value);revertedHistory.current.set(JSON.stringify([scope,deviceId,session.sessionKey]),{revertedTurns:value.revertedTurns,revertedItems:value.revertedItems,revertOperations:value.revertOperations}); };
      const result = await readDirectHistoryWithRevertGuard(timeline, async freshHead => {
        const raw = await requestDirect({ type: 'session.open', sessionKey: session.sessionKey, ...(!freshHead ? { cursor } : {}), controlSurface: 'cli', limit: 400, messageLimit: HISTORY_PAGE_MESSAGES });
        return parseDirectHistoryPage(raw, deviceId, session, freshHead ? undefined : cursor);
      }, () => { const queued = pendingEvents.current;pendingEvents.current = [];return queued; }, current, retain);
      if (!result || !current()) return;
      snapshotLoading.current = false;
      const merged = result.timeline;retain(merged);
      currentAction.current.timeline={ ...merged, loading: false, readErrorCode: undefined, snapshotAt: timeline.snapshotAt ?? Date.now(), nextCursor: result.nextCursor, historyExpanded: !result.reread, loadingEarlier: false, earlierError: undefined };
      setTimeline(currentAction.current.timeline);
      selectionRef.current=merged.session ?? session;setSelected(selectionRef.current);
    } catch (reason) {
      if (revision === owner.current) {
        const queued = pendingEvents.current;
        pendingEvents.current = [];
        snapshotLoading.current = false;
        currentAction.current.timeline={ ...queued.reduce(applyEvent, currentAction.current.timeline), loading: false, loadingEarlier: false, earlierError: (reason as Error).message, readErrorCode: missingSessionReadCode(reason) };
        setTimeline(currentAction.current.timeline);
        setError((reason as Error).message);
      }
    } finally { if (revision === owner.current) { busy.current = false; setLoadingMore(false); } }
  }, [connection.deviceId, connection.status, selected, timeline]);

  const refreshConversation = useCallback(async () => {
    const session=selected,deviceId=connection.deviceId;
    if(!session||!deviceId||busy.current||connection.status!=='connected')return;
    const revision=++owner.current;busy.current=true;setLoading(true);setPendingRevision(value=>value+1);
    try {
      const raw=await requestDirect({type:'agents.status'});
      if(revision!==owner.current||getDirectConnectionState().deviceId!==deviceId)return;
      const parsed=parseAgentStatus(raw),available=parsed.agents.filter(item=>item.available&&agentSupports(item,item.id,'list'));
      setAgents(available);setApis(parsed.apis);setAutoAll(parsed.autoAll);
      if(!available.some(item=>item.id===agentId)){selectedKey.current=null;setSelected(null);setTimeline(EMPTY_TIMELINE);setDirectoryLoaded(false);setAgentId(available[0]?.id??null);setError('当前 Agent 已不可用，请从目录重新选择');return;}
      busy.current=false;setLoading(false);await openConversation(session);
    } catch(reason){if(revision===owner.current)setError(reason instanceof Error?reason.message:'刷新电脑配置失败');}
    finally{if(revision===owner.current){busy.current=false;setLoading(false);}}
  }, [selected,openConversation,connection.deviceId,connection.status,agentId]);

  useEffect(() => {
    if (connection.status !== 'connected') {
      owner.current += 1; busy.current = false; snapshotLoading.current = false; pendingEvents.current = [];
      setLoading(false); setLoadingMore(false); setSending(false); setError(connection.error ?? '直连已断开'); return;
    }
    void loadProfiles();
  }, [connection.status, connection.deviceId, loadProfiles]);

  useEffect(() => subscribeDirectEvents((envelope: DirectEventEnvelope) => {
    const deviceId = connection.deviceId, sessionKey = selectedKey.current;
    if (!deviceId || !sessionKey || connection.status !== 'connected' || !isDirectEvent(envelope.data, deviceId, sessionKey)) return;
    const event = normalizeDirectEvent(envelope.data, deviceId);
    if (snapshotLoading.current) {
      pendingEvents.current = [...pendingEvents.current, event].slice(-MAX_EVENTS);
      return;
    }
    setTimeline(current => {
      const next=applyEvent(current,event);
      if(event.type==='session.reverted')revertedHistory.current.set(JSON.stringify([scope,deviceId,sessionKey]),{revertedTurns:next.revertedTurns,revertedItems:next.revertedItems,revertOperations:next.revertOperations});
      return next;
    });
    if (event.type === 'session.updated') setSelected(event.session);
  }), [connection.deviceId, connection.status,scope]);

  useEffect(() => {
    if (connection.status === 'connected' && agentId && !selected && !directoryLoaded && !loading) void readDirectory();
  }, [connection.status, agentId, selected, directoryLoaded, loading, readDirectory]);

  const profile = agents.find(item => item.id === agentId);
  const projectIdentity = JSON.stringify([scope, connectionGeneration, connection.deviceId, agentId, workspaceMode]);
  const projectOwner = useMemo(() => ({ identity: projectIdentity }), [projectIdentity]);
  const projectOwnerRef = useRef(projectOwner); projectOwnerRef.current = projectOwner;
  const globalScope = JSON.stringify([scope, connectionGeneration, connection.deviceId, workspaceMode]);
  useEffect(() => { setNewSession(false); setProjectPath('');setProjectless(false); }, [projectIdentity]);
  useEffect(() => {
    if (!globalSelection) return;
    if (globalSelection.scope !== globalScope) { setGlobalSelection(undefined); return; }
    if (profile?.id !== globalSelection.agent.id) return;
    setProjectPath(globalSelection.cwd); setProjectless(globalSelection.projectless === true); setNewSession(true); setError(''); setGlobalSelection(undefined);
  }, [globalSelection, globalScope, projectIdentity, profile?.id]);
  const apiReady = claudeApiAdmissionReady(profile);
  const canCreate = Boolean(profile?.available && profile.id !== 'claude-desktop' && profile.remoteSendSupported
    && agentSupports(profile, profile.id, 'send') && apiReady);
  const projectlessAllowed = capabilities.includes('session.projectless.v1');
  const startAdmission = useRef({ canCreate, apiReady, projectlessAllowed }); startAdmission.current = { canCreate, apiReady, projectlessAllowed };
  const startIdentity=JSON.stringify([scope,connectionGeneration,connection.deviceId,profile?.id,profile?.api.accountId,projectPath,workspaceMode,...(projectless?['projectless']:[])]);
  const currentStart=useRef(startIdentity);currentStart.current=startIdentity;
  const startStore=useMemo(()=>connection.deviceId&&profile&&(projectPath||projectless)?createDirectPendingOperation({pairing:scope,deviceId:connection.deviceId,
    owner:JSON.stringify([scope,connection.deviceId,null,profile.id,profile.api.accountId??'',projectPath,workspaceMode,...(projectless?['projectless']:[])]),
    isCurrent:()=>currentStart.current===startIdentity&&directDeliveryScope()===scope&&directConnectionGeneration()===connectionGeneration}):undefined,[startIdentity]);
  const [startReady,setStartReady]=useState(''),[pendingStart,setPendingStart]=useState<DirectPendingOperation>();
  useEffect(()=>{
    let active=true;setStartReady('');setPendingStart(undefined);
    if(!startStore)return;
    void startStore.read().then(value=>{if(active){setPendingStart(value);setUncertainStart(Boolean(value));setStartReady(startIdentity);}},reason=>{if(active){setUncertainStart(true);setError(reason instanceof Error?reason.message:'创建记录读取失败');}});
    return()=>{active=false;};
  },[startStore]);
  const actionIdentity=JSON.stringify([scope,connectionGeneration,connection.deviceId,selected?.sessionKey,profile?.id,profile?.api,profile?.execution,selected?.cwd,workspaceMode]);
  const currentAction=useRef({identity:actionIdentity,timeline});currentAction.current={identity:actionIdentity,timeline};
  // A stop owns the exact connection/session/turn, independent of mutable
  // API display metadata returned by the next agents.status refresh.
  const stopIdentity=JSON.stringify([scope,connectionGeneration,connection.deviceId,selected?.sessionKey]);
  const stopping=pendingStop?.identity===stopIdentity?pendingStop:undefined;
  useEffect(()=>{
    if(!pendingStop)return;
    if(pendingStop.identity!==stopIdentity||connection.status!=='connected'){setPendingStop(undefined);return;}
    // Only an observed terminal for the stopped parent turn settles a lost
    // receipt. An idle status or a child's completion is not confirmation.
    if(!timeline.loading&&!timeline.cachedAt&&timeline.items.some(item=>item.kind==='turn'&&!item.parentId&&item.turnId===pendingStop.turnId
      &&['completed','interrupted','failed'].includes(item.status))){setPendingStop(undefined);setError('');}
  },[pendingStop,stopIdentity,connection.status,timeline]);
  const pendingStore=useMemo(()=>connection.deviceId&&selected&&profile?createDirectPendingOperation({pairing:scope,deviceId:connection.deviceId,
    owner:JSON.stringify([scope,connection.deviceId,selected.sessionKey,profile.id,profile.api.accountId??'',selected.cwd,workspaceMode]),
    isCurrent:()=>currentAction.current.identity===actionIdentity&&directDeliveryScope()===scope&&directConnectionGeneration()===connectionGeneration}):undefined,[actionIdentity]);
  const [pendingReady,setPendingReady]=useState(''),[pendingAction,setPendingAction]=useState<DirectPendingOperation>();
  const apiSelection = useDirectApiSelection({ pairing: scope, generation: connectionGeneration, deviceId: connection.deviceId,
    connected: connection.status === 'connected', profile, agents, apis, sessionKey: selected?.sessionKey, lock: busy,
    blocked: loading || sending ? '请等待当前操作完成' : stopping ? '正在核对停止结果，请稍后切换 API' : uncertainSend || pendingAction || uncertainStart || pendingStart ? '请先核对上次任务的送达结果'
      : selected && hasActiveAgentWork(selected, timeline.items, timeline.items.filter(item => item.kind === 'approval' && item.state === 'pending').length, timeline.sessionSeq) ? '当前任务仍在运行，请结束后切换 API' : '',
    onStatus: parsed => { setAgents(parsed.agents.filter(item => item.available && agentSupports(item, item.id, 'list'))); setApis(parsed.apis); setAutoAll(parsed.autoAll); },
  });
  const reconcileFlight=useRef<string|undefined>(undefined);
  useEffect(()=>{
    let current=true;setPendingReady('');setPendingAction(undefined);
    if(!pendingStore)return;
    void pendingStore.read().then(value=>{if(current){setPendingAction(value);setUncertainSend(Boolean(value));setPendingReady(actionIdentity);}},reason=>{if(current){setUncertainSend(true);setError(reason instanceof Error?reason.message:'送达记录读取失败');}});
    return()=>{current=false;};
  },[pendingStore,pendingRevision]);
  useEffect(()=>{
    if(!pendingStore||!pendingAction||reconcileFlight.current===pendingAction.id||pendingReady!==actionIdentity||sending||!timeline.snapshotAt||timeline.loading||timeline.cachedAt||timeline.error)return;
    if(pendingAction.kind==='revert'?!timeline.revertOperations?.includes(pendingAction.id):!timeline.items.some(item=>item.kind==='message'&&item.role==='user'&&!item.local&&!item.messageOrigin&&item.clientId===pendingAction.id))return;
    const id=pendingAction.id;reconcileFlight.current=id;
    void pendingStore.clear(id).then(cleared=>{if(cleared&&currentAction.current.identity===actionIdentity){setPendingAction(undefined);setUncertainSend(false);setError('');}})
      .catch(reason=>{if(currentAction.current.identity===actionIdentity)setError(reason instanceof Error?reason.message:'送达记录核对失败');})
      .finally(()=>{if(reconcileFlight.current===id)reconcileFlight.current=undefined;});
  },[pendingStore,pendingAction,pendingReady,actionIdentity,timeline,sending]);
  const recoveryFlight=useRef<object|undefined>(undefined);
  const historyRepair=useMemo(()=>createDirectHistoryRepairTracker(),[actionIdentity]);
  const recoverHistory=async()=>{
    const session=selected,deviceId=connection.deviceId;
    if(!session||!deviceId||connection.status!=='connected'||loading||sending||busy.current||snapshotLoading.current||recoveryFlight.current)return;
    const token={},revision=owner.current;
    const current=()=>revision===owner.current&&selectedKey.current===session.sessionKey&&scope===directDeliveryScope()
      &&connectionGeneration===directConnectionGeneration()&&getDirectConnectionState().status==='connected'&&getDirectConnectionState().deviceId===deviceId;
    recoveryFlight.current=token;snapshotLoading.current=true;pendingEvents.current=[];
    try{
      const retain=(value:Timeline)=>{currentAction.current.timeline=value;setTimeline(value);revertedHistory.current.set(JSON.stringify([scope,deviceId,session.sessionKey]),{revertedTurns:value.revertedTurns,revertedItems:value.revertedItems,revertOperations:value.revertOperations});};
      const result=await readDirectHistoryWithRevertGuard(currentAction.current.timeline,
        async()=>parseDirectHistoryPage(await requestDirect({type:'session.open',sessionKey:session.sessionKey,controlSurface:'cli',limit:400,messageLimit:HISTORY_PAGE_MESSAGES}),deviceId,session),
        ()=>{const queued=pendingEvents.current;pendingEvents.current=[];return queued;},current,retain);
      if(!result||!current())return;
      snapshotLoading.current=false;retain(result.timeline);
      const merged={...result.timeline,loading:false,snapshotAt:Date.now(),nextCursor:result.nextCursor,error:result.invalidated?result.timeline.error:undefined,readErrorCode:undefined};
      const foreground=AppState.currentState==null||AppState.currentState==='active';
      const repaired=foreground?historyRepair.observe(merged):merged;
      currentAction.current.timeline=repaired;setTimeline(repaired);
      selectionRef.current=merged.session??session;setSelected(selectionRef.current);
      return result.invalidated?'failure' as const:'success' as const;
    }catch(reason){
      if(current()){
        const queued=pendingEvents.current;pendingEvents.current=[];snapshotLoading.current=false;
        const foreground=AppState.currentState==null||AppState.currentState==='active';
        const showRecovery=foreground&&historyRepair.failed();
        currentAction.current.timeline={...queued.reduce(applyEvent,currentAction.current.timeline),readErrorCode:missingSessionReadCode(reason),...(showRecovery?{error:'正在重新同步会话记录，请稍后重试'}:{})};
        setTimeline(currentAction.current.timeline);
        return 'failure' as const;
      }
    }finally{
      if(recoveryFlight.current===token)recoveryFlight.current=undefined;
      if(current())snapshotLoading.current=false;
    }
  };
  useDirectHistoryRecovery({enabled:connection.status==='connected'&&Boolean(selected)&&!loading&&!timeline.readErrorCode,source:actionIdentity,revision:recoveryRevision,
    needed:Boolean(uncertainSend||stopping||historyRepair.needed(timeline)),recover:recoverHistory,onSuspend:historyRepair.suspend});
  const canSend = Boolean(profile?.available && profile.remoteSendSupported && agentSupports(profile, profile.id, 'send')
    && apiReady
    && selected?.controllable && selected.controlSurface !== 'desktop' && selected.controlSurface !== 'read-only' && !selected.archived
    && connection.status === 'connected' && !apiSelection.locked && !uncertainSend && !stopping && !loading && !timeline.readErrorCode && pendingReady===actionIdentity && !pendingAction);
  const sendAdmission=useRef({canSend,sending});sendAdmission.current={canSend,sending};
  const send = async (submission:DirectComposerSubmission,observe?:(outcome:DirectSendOutcome)=>void) => {
    const deviceId = connection.deviceId, session = selected, value = submission.inputText ?? text;
    if (!deviceId || !session || !value.trim()&&!submission.attachments?.length || !sendAdmission.current.canSend || sendAdmission.current.sending || busy.current) {observe?.('not-sent');return;}
    // A revert refresh can finish before React commits its next render. The
    // synchronized selection/history refs also fence callbacks from that render.
    const admitted=()=>{
      const latest=selectionRef.current,history=currentAction.current.timeline;
      return currentAction.current.identity===actionIdentity&&selectedKey.current===session.sessionKey
        &&directDeliveryScope()===scope&&directConnectionGeneration()===connectionGeneration
        &&getDirectConnectionState().deviceId===deviceId&&getDirectConnectionState().status==='connected'
        &&sendAdmission.current.canSend&&latest?.sessionKey===session.sessionKey&&latest.cwd===session.cwd&&latest.status===session.status&&latest.activeTurnId===session.activeTurnId
        &&latest.controllable&&!latest.archived&&latest.controlSurface!=='desktop'&&latest.controlSurface!=='read-only'
        &&!snapshotLoading.current&&!history.loading&&!history.error&&!history.readErrorCode&&!history.cachedAt;
    };
    if(!admitted()){observe?.('not-sent');return false;}
    const expectedOwner=JSON.stringify([scope,deviceId,session.sessionKey,profile!.id,profile!.api.accountId??'',session.cwd]);
    if(submission.owner!==expectedOwner){observe?.('not-sent');setError('电脑、会话或 API 已变化，请重新确认发送内容');return false;}
    const {owner:_,inputText:__,draftReceipt:___,...options}=submission;
    busy.current = true;
    const revision = ++owner.current,operationId=randomUUID();
    let marker=false,dispatched=false,accepted=false;
    setSending(true); setError('');
    try {
      const targetTurn = turnControlTarget(currentAction.current.timeline,'stop');
      if (session.status === 'running' && (!profile?.capabilities?.steer || !targetTurn || submission.attachments?.length)) throw new Error('当前任务正在运行，请等待完成后发送');
      if(!pendingStore)throw new Error('送达记录尚未准备好');
      await pendingStore.begin({id:operationId,kind:session.status==='running'?'steer':'send',...(targetTurn?{expectedTurnId:targetTurn}:{})});marker=true;
      if(revision!==owner.current||!admitted()||turnControlTarget(currentAction.current.timeline,'stop')!==targetTurn){
        // Nothing reached the computer. Clear only this exact operation, even
        // after navigation invalidated the UI-bound pending store.
        const unsent=createDirectPendingOperation({pairing:scope,deviceId,owner:JSON.stringify([scope,deviceId,session.sessionKey,profile!.id,profile!.api.accountId??'',session.cwd,workspaceMode])});
        if(await unsent.clear(operationId))marker=false;
        throw new Error('电脑、会话或发送状态已变化，消息未发送');
      }
      dispatched=true;
      const receipt=await requestDirect(session.status === 'running'
        ? { type:'session.steer',sessionKey:session.sessionKey,text:value,expectedTurnId:targetTurn!,operationId,controlSurface:'cli',...(profile?.api.accountId?{accountId:profile.api.accountId}:{}) }
        : { type: 'session.send', sessionKey: session.sessionKey, text: value, operationId, controlSurface: 'cli',...options,...(profile?.api.accountId?{accountId:profile.api.accountId}:{}) }, { timeoutMs: 100_000 }) as {accepted?:boolean;sessionKey?:string;turnId?:string;operationId?:string;via?:string};
      if(session.status==='running'
        ? receipt?.accepted!==true||receipt.sessionKey!==session.sessionKey||receipt.turnId!==targetTurn||receipt.operationId!==operationId
        : receipt?.via!=='background')throw Object.assign(new Error('消息送达结果未确认'),{code:'protocol'});
      accepted=true;
      observe?.('sent');
      if(!await pendingStore.clear(operationId))throw Object.assign(new Error('消息已发送，送达记录核对失败'),{code:'protocol'});
      if (revision !== owner.current || getDirectConnectionState().deviceId !== deviceId||directDeliveryScope()!==scope||directConnectionGeneration()!==connectionGeneration) return true;
      // The composer consumes the acknowledged snapshot with its revision.
      // A history refresh must not replace text added during upload/delivery.
      setUncertainSend(false); busy.current = false; setSending(false);
      try { await openConversation(session,true); }
      catch { setError('消息已交给电脑，刷新会话记录失败'); }
      return true;
    } catch (reason) {
      observe?.(accepted?'sent':dispatched&&directActionUncertain(reason)?'unknown':'not-sent');
      if (revision === owner.current) {
        let unknown=accepted||dispatched&&directActionUncertain(reason);
        let existing:DirectPendingOperation|undefined;
        if(!marker)try{existing=await pendingStore?.read();if(existing)unknown=true;}catch{setPendingReady('');}
        if(marker&&!unknown)try{if(!await pendingStore!.clear(operationId))unknown=true;}catch{unknown=true;}
        if(unknown)setPendingAction(existing??{id:operationId,kind:session.status==='running'?'steer':'send'});
        setUncertainSend(unknown);
        setError(unknown ? '送达状态未确认，请核对会话；只有电脑确认收到原消息后才会解锁，不会自动重发。' : reason instanceof Error ? reason.message : '消息发送失败');
      }
      return accepted;
    } finally { if (revision === owner.current) { busy.current = false; setSending(false); } }
  };

  const continueTask=async(submission:DirectComposerSubmission,retry?:{turnId:string;messageId:string;failedId:string}):Promise<boolean>=>{
    const deviceId=connection.deviceId,session=selected,identity=actionIdentity;
    const expected=turnControlTarget(timeline,'continue');
    const current=()=>currentAction.current.identity===identity&&directDeliveryScope()===scope&&directConnectionGeneration()===connectionGeneration
      &&getDirectConnectionState().status==='connected'&&getDirectConnectionState().deviceId===deviceId;
    if(!deviceId||!session||!profile?.capabilities?.continue||!canSend||sending||busy.current||!expected||!current())return false;
    if(turnControlTarget(currentAction.current.timeline,'continue')!==expected)return false;
    const expectedOwner=JSON.stringify([scope,deviceId,session.sessionKey,profile.id,profile.api.accountId??'',session.cwd]);
    if(submission.owner!==expectedOwner||submission.attachments?.length){setError('会话来源已变化，或需要先处理输入框图片');return false;}
    const target=retry?directRetryTarget(currentAction.current.timeline):undefined;
    if(retry&&(!target||target.turnId!==retry.turnId||target.message.id!==retry.messageId||target.failed.id!==retry.failedId))return false;
    if(target&&(target.message.attachments?.length||target.message.images?.length)){setError('原消息包含图片，请完整恢复图片后从输入框重新发送；不会丢弃图片重试。');return false;}
    const {owner:_,attachments:__,inputText:___,draftReceipt:____,...options}=submission;
    const operationId=randomUUID(),revision=++owner.current;
    let marker=false,dispatched=false,accepted=false;
    busy.current=true;setSending(true);setError('');
    try{
      if(!pendingStore)throw new Error('送达记录尚未准备好');
      await pendingStore.begin({id:operationId,kind:'continue',expectedTurnId:expected});marker=true;
      if(!current()||turnControlTarget(currentAction.current.timeline,'continue')!==expected)throw new Error('会话回合已变化，请刷新');
      dispatched=true;
      const raw=await requestDirect({type:'session.continue',sessionKey:session.sessionKey,text:target?.message.text||CONTINUE_PROMPT,
        expectedTurnId:expected,operationId,controlSurface:'cli',...options,...(profile.api.accountId?{accountId:profile.api.accountId}:{}),
        ...(target?{skills:target.message.skills,contextReferences:target.message.contextReferences}:{})},{timeoutMs:100000}) as {accepted?:boolean;sessionKey?:string;previousTurnId?:string;operationId?:string};
      if(raw?.accepted!==true||raw.sessionKey!==session.sessionKey||raw.previousTurnId!==expected||raw.operationId!==operationId)
        throw Object.assign(new Error('继续操作的送达结果未确认'),{code:'protocol'});
      accepted=true;
      if(!await pendingStore.clear(operationId))throw Object.assign(new Error('任务已继续，送达记录核对失败'),{code:'protocol'});
      if(!current()||revision!==owner.current)return true;
      setUncertainSend(false);busy.current=false;setSending(false);await openConversation(session,true);return true;
    }catch(reason){if(current()&&revision===owner.current){let unknown=accepted||dispatched&&directActionUncertain(reason);
      let existing:DirectPendingOperation|undefined;
      if(!marker)try{existing=await pendingStore?.read();if(existing)unknown=true;}catch{setPendingReady('');}
      if(marker&&!unknown)try{if(!await pendingStore!.clear(operationId))unknown=true;}catch{unknown=true;}
      if(unknown)setPendingAction(existing??{id:operationId,kind:'continue',expectedTurnId:expected});setUncertainSend(unknown);
      setError(unknown?'操作结果未确认，请核对电脑；不会自动重试。':reason instanceof Error?reason.message:'电脑未能继续此任务');}return accepted;}
    finally{if(current()&&revision===owner.current){busy.current=false;setSending(false);}}
  };
  const retryFailed=async()=>{
    const target=directRetryTarget(timeline);if(!target||!profile||!connection.deviceId||!selected)return;
    await continueTask({owner:JSON.stringify([scope,connection.deviceId,selected.sessionKey,profile.id,profile.api.accountId??'',selected.cwd])},
      {turnId:target.turnId,messageId:target.message.id,failedId:target.failed.id});
  };
  const acknowledgeDelivery=async()=>{
    if(!pendingAction||!pendingStore||!uncertainSend||busy.current||currentAction.current.identity!==actionIdentity)return false;
    const cleared=await pendingStore.clear(pendingAction.id);
    if(currentAction.current.identity!==actionIdentity)return false;
    if(!cleared){setPendingRevision(value=>value+1);return false;}
    setPendingAction(undefined);setUncertainSend(false);setError('');return true;
  };

  const createSession = async (promptText:string,submission:DirectComposerSubmission) => {
    const deviceId = connection.deviceId, profile = agents.find(item => item.id === agentId);
    const project = projects.find(item => item.path === projectPath), prompt = promptText.trim();
    if (!deviceId || connection.status !== 'connected' || !profile || (!project && !projectless) || !prompt&&!submission.attachments?.length || busy.current || apiSelection.locked || uncertainStart || pendingStart || startReady!==startIdentity) return false;
    if (projectless && !startAdmission.current.projectlessAllowed) { setError('电脑端尚不支持不关联文件夹，请更新或选择项目文件夹'); return false; }
    if (!startAdmission.current.canCreate) {
      if (!startAdmission.current.apiReady) setError('请先选择并确认 Claude API，草稿已保留');
      return false;
    }
    if(submission.owner!==JSON.stringify([scope,deviceId,null,profile.id,profile.api.accountId??'',projectPath,workspaceMode,...(projectless?['projectless']:[])])){setError('电脑、项目或 API 已变化，请重新确认任务');return false;}
    const {owner:_,inputText:__,draftReceipt,...options}=submission;
    busy.current = true;
    const revision = ++owner.current, operationId = randomUUID();
    let startAccepted = false,startReturned=false,marker=false,dispatched=false;
    setSending(true); setError(''); setUncertainStart(false);
    try {
      let receipt: unknown;
      if(!startStore)throw new Error('创建记录尚未准备好');
      await startStore.begin({id:operationId,kind:'start',...(draftReceipt?{draftReceipt}: {})});marker=true;
      if(currentStart.current!==startIdentity||!startAdmission.current.canCreate||projectless&&!startAdmission.current.projectlessAllowed)throw new Error('电脑、项目或 API 已变化');
      try {
        dispatched=true;
        receipt = await requestDirect({ type: 'session.start', tool: profile.tool, cwd: projectless ? '' : project!.path, ...(projectless ? { projectless: true as const } : {}), prompt,
          controlSurface: 'cli', workspaceMode, operationId,...options,...(profile.api.accountId?{accountId:profile.api.accountId}:{}) }, { timeoutMs: 105_000 });
      } catch (reason) {
        if (directActionUncertain(reason)) throw Object.assign(reason instanceof Error ? reason : new Error('电脑直连断开'), { deliveryUnknown: true });
        throw reason;
      }
      startReturned=true;
      const sessionKey = parseDirectStartReceipt(receipt, profile.tool);
      startAccepted = true;
      if(!await startStore.clear(operationId))throw Object.assign(new Error('会话已创建，送达记录核对失败'),{deliveryUnknown:true});
      setPendingStart(undefined);
      if(revision!==owner.current||getDirectConnectionState().deviceId!==deviceId||directDeliveryScope()!==scope||directConnectionGeneration()!==connectionGeneration)return true;
      const raw = await requestDirect({ type: 'sessions.list', tool: profile.tool, client: profile.id === 'claude' ? 'code' : undefined,
        controlSurface: 'cli', limit: PAGE_SIZE });
      if (revision !== owner.current || getDirectConnectionState().deviceId !== deviceId||directDeliveryScope()!==scope||directConnectionGeneration()!==connectionGeneration) return true;
      const page = parseDirectSessionPage(raw, profile.tool);
      const created = page.sessions.find(item => item.sessionKey === sessionKey&&sessionWorkspaceMode(item)===workspaceMode);
      setSessions(agentSessions(page.sessions, profile).filter(item=>sessionWorkspaceMode(item)===workspaceMode)); setNextCursor(page.nextCursor); setNewSession(false);
      if (!created) {
        setUncertainStart(true);
        setError('会话已创建，但电脑目录暂未返回它；刷新列表后再打开，不会重复创建。');
        return true;
      }
      setUncertainStart(false);
      // The initial output can arrive before the phone knows the generated key.
      // Opening a history snapshot recovers it without replaying session.start.
      busy.current = false; setSending(false);
      await openConversation(created);
      return true;
    } catch (reason) {
      if (revision === owner.current) {
        let deliveryUnknown = startAccepted || startReturned || dispatched&&directActionUncertain(reason) || Boolean(reason && typeof reason === 'object' && 'deliveryUnknown' in reason);
        if(marker&&!deliveryUnknown)try{if(!await startStore!.clear(operationId))deliveryUnknown=true;}catch{deliveryUnknown=true;}
        if(!marker)try{const existing=await startStore?.read();if(existing){setPendingStart(existing);deliveryUnknown=true;}}catch{setStartReady('');}
        if(marker&&deliveryUnknown)setPendingStart({id:operationId,kind:'start',...(draftReceipt?{draftReceipt}: {})});
        setUncertainStart(deliveryUnknown);
        if (deliveryUnknown) setNewSession(false);
        setError(deliveryUnknown
          ? `新会话结果未确认；刷新列表核对，不会自动重发。${reason instanceof Error ? ` ${reason.message}` : ''}`
          : reason instanceof Error ? reason.message : '新建直连会话失败');
      }
      return startAccepted;
    } finally { if (revision === owner.current) { busy.current = false; setSending(false); } }
  };

  const recoverStart=async()=>{
    const deviceId=connection.deviceId,operation=pendingStart,store=startStore,identity=startIdentity;
    if(!deviceId||!profile||!operation||!store||busy.current||connection.status!=='connected')return;
    const current=()=>currentStart.current===identity&&directConnectionGeneration()===connectionGeneration&&getDirectConnectionState().status==='connected';
    busy.current=true;setLoading(true);setError('');
    try{
      const raw=await requestDirect({type:'sessions.list',tool:profile.tool,client:profile.id==='claude'?'code':undefined,controlSurface:'cli',limit:PAGE_SIZE});
      if(!current())return;
      const page=parseDirectSessionPage(raw,profile.tool);
      const candidates=agentSessions(page.sessions,profile).filter(item=>(projectless?item.projectless===true:item.cwd===projectPath&&!item.projectless)&&sessionWorkspaceMode(item)===workspaceMode);
      for(const candidate of candidates){
        const history=parseDirectHistoryPage(await requestDirect({type:'session.open',sessionKey:candidate.sessionKey,controlSurface:'cli',limit:400,messageLimit:HISTORY_PAGE_MESSAGES}),deviceId,candidate);
        if(!current())return;
        if(!history.events.some(event=>event.type==='message'&&event.role==='user'&&!event.messageOrigin&&event.clientId===operation.id))continue;
        if(operation.draftReceipt){
          const draftOwner=JSON.stringify([scope,deviceId,null,profile.id,profile.api.accountId??'',projectPath,workspaceMode,...(projectless?['projectless']:[])]);
          await consumeAcceptedComposerDraft(directDraftKey(scope,deviceId,draftOwner),scope,operation.draftReceipt.revision,operation.draftReceipt.identity);
          if(!current())return;
        }
        if(!await store.clear(operation.id))throw new Error('创建记录已变化，请重新核对');
        if(!current())return;
        setPendingStart(undefined);setUncertainStart(false);setNewSession(false);
        setSessions(items=>items.some(item=>item.sessionKey===candidate.sessionKey)?items:[candidate,...items]);
        busy.current=false;setLoading(false);await openConversation(candidate,true);return;
      }
      setError('最近会话尚未找到这次创建的确切回执；原输入和图片仍保留，不会重复创建。');
    }catch(reason){if(current())setError(reason instanceof Error?reason.message:'核对创建结果失败');}
    finally{if(current()){busy.current=false;setLoading(false);}}
  };

  const respond = async (approvalId: string, decision: Decision, answers?: QuestionAnswers) => {
    if (!selected || !connection.deviceId || connection.status !== 'connected' || busy.current || stopping) return;
    const pending = timeline.items.find(item=>item.kind==='approval'&&item.id===approvalId&&item.state==='pending');
    if (!pending || pending.kind!=='approval' || !approvalDecisions(pending).includes(decision) || pending.expiresAt!==undefined&&pending.expiresAt<=Date.now()) { setError('请求已变化或过期，请刷新会话'); return; }
    if(!profile?.capabilities?.approval||((pending.approval==='question'||answers!==undefined)&&!profile.capabilities.questions)){setError(pending.approval==='question'?'当前 Agent 不支持手机回答，请在电脑处理':'当前 Agent 不支持手机审批，请在电脑处理');return;}
    busy.current = true;
    const revision = ++owner.current;
    setSending(true); setError('');
    try {
      await requestDirect({ type: 'approval.respond', approvalId, sessionKey: selected.sessionKey, decision, ...(answers?{answers}:{}), ...(profile?.api.accountId ? { accountId: profile.api.accountId } : {}), controlSurface: 'cli' });
      if (revision !== owner.current) return;
      if(pending.approval==='question'){
        const draftSource=directQuestionDraftSource(scope,connection.deviceId,selected.sessionKey,pending);
        // Local cleanup must not turn an accepted answer into a failed remote
        // submission. The observed resolution also retries this cleanup.
        await finishDirectQuestionDraft(scope,connection.deviceId,selected.sessionKey,approvalId,Date.now(),draftSource.request).catch(()=>undefined);
        if(revision!==owner.current)return;
      }
      busy.current = false; setSending(false);
      await refreshConversation();
    } catch (reason) { if (revision === owner.current) setError(reason instanceof Error ? reason.message : '电脑未能处理批准请求'); }
    finally { if (revision === owner.current) { busy.current = false; setSending(false); } }
  };

  const revertLatest=async(message:SentUserMessage,operationId:string)=>{
    const session=selected,deviceId=connection.deviceId,turnId=latestEditableTurn(currentAction.current.timeline,message);
    if(!session||!deviceId||!turnId||!profile?.capabilities?.latestTurnRevert||!canSend||busy.current||!pendingStore)throw new Error('当前会话不能编辑最新消息');
    const current=()=>currentAction.current.identity===actionIdentity&&selectedKey.current===session.sessionKey&&getDirectConnectionState().deviceId===deviceId&&getDirectConnectionState().status==='connected'&&directDeliveryScope()===scope&&directConnectionGeneration()===connectionGeneration;
    const request={sessionKey:session.sessionKey,expectedTurnId:turnId,expectedMessageId:message.id,operationId};
    busy.current=true;setSending(true);let dispatched=false,marked=false,completed=false;
    try{
      await pendingStore.begin({id:operationId,kind:'revert',expectedTurnId:turnId});marked=true;
      if(!current())throw new Error('电脑或会话已切换');
      dispatched=true;
      const result=parseSessionRevertResult(await requestDirect({type:'session.revert',...request,controlSurface:'cli',...(profile.api.accountId?{accountId:profile.api.accountId}:{})},{timeoutMs:100000}),request);
      if(result.status!=='completed')throw new Error('编辑回退结果未确认，请先刷新原会话');
      completed=true;
      if(!await pendingStore.clear(operationId))throw new Error('编辑回退回执未能保存，请先核对原会话');
      if(!current())throw new Error('原电脑已回退会话，连接已切换');
      const reverted=applyEvent(currentAction.current.timeline,{type:'session.reverted',deviceId,sessionKey:session.sessionKey,tool:profile.tool,ts:Date.now(),id:message.id,turnId,operationId});
      revertedHistory.current.set(JSON.stringify([scope,deviceId,session.sessionKey]),{revertedTurns:reverted.revertedTurns,revertedItems:reverted.revertedItems,revertOperations:reverted.revertOperations});
      setTimeline(reverted);
      busy.current=false;setSending(false);await openConversation(session,true);
    }catch(reason){
      const unknown=completed||dispatched&&directActionUncertain(reason);
      if(marked&&!unknown)await pendingStore.clear(operationId).catch(()=>undefined);
      if(current()&&unknown){setPendingAction({id:operationId,kind:'revert',expectedTurnId:turnId});setUncertainSend(true);}
      throw reason;
    }finally{if(current()){busy.current=false;setSending(false);}}
  };
  const stop = async () => {
    const session = selected;
    const expectedTurnId=turnControlTarget(timeline,'stop');
    if (!session || !expectedTurnId || !profile?.capabilities?.preciseInterrupt || busy.current || uncertainSend || stopping || connection.status!=='connected') return;
    const operationId=randomUUID(),current=()=>selectedKey.current===session.sessionKey&&directConnectionGeneration()===connectionGeneration
      &&directDeliveryScope()===scope&&getDirectConnectionState().status==='connected'&&getDirectConnectionState().deviceId===connection.deviceId;
    busy.current=true; const revision=++owner.current; setSending(true); setError('');
    setPendingStop({identity:stopIdentity,turnId:expectedTurnId,operationId});
    try {
      const result=await requestDirect({type:'session.interrupt',sessionKey:session.sessionKey,expectedTurnId,operationId,controlSurface:'cli'}) as {turnId?:string;status?:string};
      if(result?.turnId!==expectedTurnId||!['requested','stopped','already_finished','unconfirmed'].includes(result.status??''))throw Object.assign(new Error('停止结果未确认，请刷新原会话'),{code:'protocol'});
      if(revision!==owner.current||!current())return;
      if(result.status==='stopped'||result.status==='already_finished')setPendingStop(value=>value?.operationId===operationId?undefined:value);
      busy.current=false; setSending(false); await openConversation(session,true);
    } catch(reason) { if(revision===owner.current&&current()) {
      setError(reason instanceof Error?reason.message:'停止任务失败');
      if(!directActionUncertain(reason))setPendingStop(value=>value?.operationId===operationId?undefined:value);
    } }
    finally { if(revision===owner.current) { busy.current=false;setSending(false); } }
  };

  const backToDirectory = () => {
    if (apiSelection.busy) return;
    owner.current++; busy.current=false; selectedKey.current=null; snapshotLoading.current=false; pendingEvents.current=[];
    setSelected(null);setTimeline(EMPTY_TIMELINE);setLoading(false);setLoadingMore(false);setSending(false);setError('');setUncertainSend(false);
  };
  const conversationBack = useChildBackAction();
  const globalNewBack = useChildBackAction();
  useBackAction(() => {
    if (connection.status !== 'connected') return false;
    if (managementOpen) { setManagementOpen(false); return true; }
    if (globalNew) { if (!globalNewBack.handle()) setGlobalNew(false); return true; }
    if (conversationBack.handle()) return true;
    if (selected) { backToDirectory(); return true; }
    if (newSession) {
      // Keep the pending creation and its draft intact until the receipt arrives.
      if (!sending) { setNewSession(false); setError(''); }
      return true;
    }
    return false;
  }, onRegisterBack);
  const openByKey = async (sessionKey:string) => {
    const known = sessions.find(item=>item.sessionKey===sessionKey);
    if(known){await openConversation(known);return;}
    const deviceId=connection.deviceId;
    if(!deviceId||!profile||busy.current||connection.status!=='connected')return;
    const revision=++owner.current;busy.current=true;setLoading(true);setError('');
    selectedKey.current=sessionKey;snapshotLoading.current=true;pendingEvents.current=[];
    try {
      const retain=(value:Timeline)=>{revertedHistory.current.set(JSON.stringify([scope,deviceId,sessionKey]),{revertedTurns:value.revertedTurns,revertedItems:value.revertedItems,revertOperations:value.revertOperations});};
      const result=await readDirectHistoryWithRevertGuard({...EMPTY_TIMELINE,...revertedHistory.current.get(JSON.stringify([scope,deviceId,sessionKey]))},async()=>{
        const page=parseDirectHistoryPage(await requestDirect({type:'session.open',sessionKey,controlSurface:'cli',limit:400,messageLimit:INITIAL_MESSAGES}),deviceId,{sessionKey,tool:profile.tool});
        if(sessionWorkspaceMode(page.session)!==workspaceMode)throw new Error('该对话属于另一个空间，请从首页对应入口打开');
        return page;
      },()=>{const queued=pendingEvents.current;pendingEvents.current=[];return queued;},()=>revision===owner.current&&getDirectConnectionState().deviceId===deviceId,retain);
      if(!result||revision!==owner.current)return;
      if(result.invalidated||!result.timeline.session)throw new Error('会话在读取期间再次回退，请刷新记录');
      const merged=result.timeline,opened=result.timeline.session;retain(merged);
      pendingEvents.current=[];snapshotLoading.current=false;
      selectionRef.current=opened;currentAction.current.timeline={...merged,loading:false,snapshotAt:Date.now(),nextCursor:result.nextCursor,historyExpanded:false};
      setSelected(opened);setTimeline(currentAction.current.timeline);
      setText(drafts.current.get(`${scope}|${sessionKey}`)??'');setUncertainSend(false);
      setSessions(current=>current.some(item=>item.sessionKey===sessionKey)?current:[...current,opened]);
    } catch(reason) {if(revision===owner.current){snapshotLoading.current=false;selectedKey.current=selected?.sessionKey??null;pendingEvents.current=[];setError(reason instanceof Error?reason.message:'读取会话失败');}}
    finally {if(revision===owner.current){busy.current=false;setLoading(false);}}
  };

  const disconnect = () => {
    owner.current += 1; busy.current = false; selectedKey.current = null; snapshotLoading.current = false; pendingEvents.current = [];
    disconnectDirect();
  };
  const forget = async () => {
    const deviceId = connection.deviceId;
    if (!deviceId) return;
    owner.current += 1; busy.current = false; selectedKey.current = null; snapshotLoading.current = false; pendingEvents.current = [];
    try { await forgetDirectPairing(deviceId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法解除直连绑定'); }
  };
  const reconnect = async () => {
    const deviceId = connection.deviceId;
    if (!deviceId || connection.status === 'connecting' || connection.status === 'authenticating') return;
    setError('');
    try { await reconnectDirect(deviceId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '电脑直连失败'); }
  };

  if (connection.status !== 'connected') return <View style={styles.panel}>
    <View style={styles.heading}><Text style={styles.title}>电脑直连</Text><Text style={styles.subtitle}>{connection.status === 'connecting' || connection.status === 'authenticating' ? '正在建立加密连接…' : connection.error || '直连已断开'}</Text></View>
    {connection.deviceId ? <Pressable disabled={connection.status === 'connecting' || connection.status === 'authenticating'} style={[styles.primaryButton, (connection.status === 'connecting' || connection.status === 'authenticating') && { opacity: 0.5 }]} onPress={() => void reconnect()}>
      {connection.status === 'connecting' || connection.status === 'authenticating' ? <ActivityIndicator size="small" color={d.onInk} /> : <Text style={styles.primaryText}>重新连接</Text>}
    </Pressable> : null}
    <View style={styles.actions}><Pressable style={styles.secondaryButton} onPress={disconnect}><Text style={styles.secondaryText}>关闭连接</Text></Pressable><Pressable style={styles.secondaryButton} onPress={() => void forget()}><Text style={styles.secondaryText}>解除绑定</Text></Pressable></View>
  </View>;

  const apiControl = <>{apiSelection.control}{profile && !apiReady ? <Pressable accessibilityRole="button" accessibilityLabel="选择并确认 Claude API" disabled={sending || apiSelection.busy} onPress={apiSelection.open}>
    <Text style={styles.notice}>Claude 远程需要已配置的 API，点此选择并确认</Text>
  </Pressable> : null}</>;
  if (!globalNew && selected && profile && connection.deviceId) return <DirectConversation key={`${scope}|${selected.sessionKey}`} runtime={workspaceRuntime} deviceId={connection.deviceId} profile={profile} session={selected} timeline={timeline} workspaceMode={workspaceMode}
    apiControl={apiControl}
    onResolveApi={() => { if (currentAction.current.identity === actionIdentity) apiSelection.open(); }}
    onMobileWorkspaceVisibilityChange={onMobileWorkspaceVisibilityChange} onRegisterBack={conversationBack.register}
    text={text} onText={setText} loading={loading} loadingMore={loadingMore} sending={sending} canSend={canSend} uncertain={uncertainSend} stopPending={Boolean(stopping)} error={error}
    onSend={send} onRevert={revertLatest} onStop={()=>void stop()} onRespond={(id,decision,answers)=>void respond(id,decision,answers)} onEarlier={()=>void loadEarlier()} onRefresh={()=>void refreshConversation()}
    onContinue={submission=>continueTask(submission)} onRetry={()=>void retryFailed()} onRecoverDelivery={pendingAction?acknowledgeDelivery:undefined}
    onRecoverMissingDraft={receipt=>{const origin=receipt.targetOrigin;if(receipt.scope!==scope||scope!==directDeliveryScope()||connection.deviceId!==origin.deviceId||profile.id!==origin.agentId||origin.mode!==workspaceMode||origin.apiIdentity!==(profile.api.accountId??'')||!(origin.projectless ? projectlessAllowed : projects.some(project=>project.path===origin.cwd)))return;backToDirectory();setDraftRecovery(receipt);setProjectless(origin.projectless===true);setProjectPath(origin.projectless?'':origin.cwd);setText('');setNewSession(true);}}
    onBack={backToDirectory} onOpenSession={key=>void openByKey(key)} onNew={(_mode, cwd, none)=>{if(!apiReady){apiSelection.open();return;}if(!canCreate)return;if(none||!cwd&&selected.projectless){if(!projectlessAllowed){setError('请更新电脑端，或返回选择项目文件夹');return;}backToDirectory();setProjectless(true);setProjectPath('');setNewSession(true);return;}const exact=cwd||selected.cwd;if(!exact){setError('请选择新会话的开始方式');return;}backToDirectory();setProjectless(false);setProjectPath(exact);setProjects(previous=>previous.some(item=>item.path===exact)?previous:[...previous,{path:exact,name:exact}]);setNewSession(true);}}/>;

  if (globalNew && connection.deviceId) return <NewConversationFlow key={globalScope} scopeKey={globalScope} deviceId={connection.deviceId} deviceName={connection.deviceName}
    transport="direct" agents={agents} mode={workspaceMode} loading={loading} error={error} online={connection.status === 'connected'}
    explorerAvailable={capabilities.includes('workspace.explorer.v1')} projectlessAvailable={projectlessAllowed} onRegisterBack={globalNewBack.register}
    onRefresh={() => { void loadProfiles(); }} onClose={() => setGlobalNew(false)} onComplete={selection => {
      if (directDeliveryScope() !== scope || directConnectionGeneration() !== connectionGeneration || getDirectConnectionState().deviceId !== connection.deviceId || getDirectConnectionState().status !== 'connected') return;
      backToDirectory(); setDraftRecovery(undefined); setAgentId(selection.agent.id);
      if (selection.project) setProjects(previous => [...previous.filter(item => item.path !== selection.cwd), selection.project!]);
      setGlobalSelection({ ...selection, scope: globalScope }); setGlobalNew(false);
    }} />;
  return <KeyboardSafeView testID="direct-new-keyboard-safe" style={styles.panel}>
    <View style={styles.heading}>
      {selected ? <Pressable accessibilityRole="button" accessibilityLabel="返回会话列表" onPress={() => {
        owner.current += 1; busy.current = false; selectedKey.current = null; snapshotLoading.current = false; pendingEvents.current = [];
        setSelected(null); setTimeline(EMPTY_TIMELINE); setLoading(false); setLoadingMore(false); setSending(false); setError(''); setUncertainSend(false);
      }} style={styles.back}><Icon name="chevronLeft" size={18} color={d.text2} /></Pressable> : null}
      <View style={styles.headingCopy}><AgentDirectoryHeading agentName={profile?.name || 'Agent'} deviceName={connection.deviceName || '电脑直连'} mode={workspaceMode}
        disabled={loading || apiSelection.busy || sending}/></View>
      {selected ? <Pressable accessibilityRole="button" accessibilityLabel="刷新会话" onPress={() => void refreshConversation()} style={styles.iconButton}><Icon name="regenerate" size={16} color={d.text2} /></Pressable>
        : <Pressable accessibilityRole="button" accessibilityLabel="关闭直连" onPress={disconnect} style={styles.iconButton}><Icon name="close" size={16} color={d.text2} /></Pressable>}
    </View>
    {!selected ? <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.agentPicker}>
        {agents.map(item => <Pressable key={item.id} disabled={sending || apiSelection.busy} accessibilityRole="button" accessibilityState={{ selected: item.id === agentId }} onPress={() => {
          if (sending || apiSelection.busy || item.id === agentId) return;
          owner.current += 1; busy.current = false; selectedKey.current = null; snapshotLoading.current = false; pendingEvents.current = [];
          setLoading(false); setLoadingMore(false); setSending(false); setAgentId(item.id); setSessions([]); setNextCursor(undefined); setDirectoryLoaded(false); setError('');
        }} style={[styles.agentChip, item.id === agentId && styles.agentChipSelected]}>
          <Text style={[styles.agentText, item.id === agentId && styles.agentTextSelected]}>{item.name}</Text></Pressable>)}
      </ScrollView>
      {apiControl}
      {newSession ? <View style={styles.newTask}>
        <View style={styles.newTaskHeader}><Text style={styles.newTaskTitle}>新建直连会话</Text><Pressable accessibilityRole="button" accessibilityLabel="取消新建会话" disabled={sending} onPress={() => { setNewSession(false); setError(''); }} style={styles.cancelNew}><Icon name="close" size={15} color={d.muted} /></Pressable></View>
        {uncertainStart?<Pressable accessibilityRole="button" accessibilityLabel="核对新建结果" disabled={loading||sending} onPress={()=>void recoverStart()} style={styles.uncertain}><Text style={styles.uncertainText}>原创建结果待确认，核对后打开已有会话</Text></Pressable>:null}
        <Text style={styles.projectLabel}>{projectless ? '开始方式' : '当前项目'}</Text><Text selectable style={styles.projectName}>{projectless ? '不关联文件夹' : projectPath || '请选择新会话的开始方式'}</Text>
        <View style={{flex:1}}/>
        {profile&&connection.deviceId&&(projectless||projects.some(item=>item.path===projectPath))?<DirectNewComposer onRegisterBack={conversationBack.register} key={JSON.stringify([scope,agentId,profile.api.accountId,projectPath,workspaceMode,...(projectless?['projectless']:[])])} deviceId={connection.deviceId} profile={profile} cwd={projectPath} projectless={projectless} workspaceMode={workspaceMode} runtime={workspaceRuntime}
          sending={sending || apiSelection.busy} uncertain={apiSelection.locked||uncertainStart||startReady!==startIdentity} onSend={createSession} recoveryReceipt={draftRecovery} onRecoveryUndone={()=>setDraftRecovery(undefined)}/>:null}
      </View> : <>
      {uncertainStart ? <Pressable accessibilityRole="button" accessibilityLabel="核对新建结果" disabled={loading||sending} onPress={() => void recoverStart()} style={styles.uncertain}><Text style={styles.uncertainText}>核对新建结果</Text></Pressable> : null}
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {loading && !sessions.length ? <ActivityIndicator color={d.accentText} style={styles.loader} /> : null}
        {!loading && !sessions.length ? <Text style={styles.empty}>{profile ? '还没有可用会话' : '没有可直连的 Agent'}</Text> : null}
        {profile ? <DirectProjectDirectory scopeKey={JSON.stringify([scope, connectionGeneration, connection.deviceId])} readScope={conversationReadScope(scope,connection.deviceId??'',profile,workspaceMode)}
          agent={profile} workspaceMode={workspaceMode} sessions={sessions} disabled={loading || sending || apiSelection.busy}
          onOpen={item => void openConversation(item)} onNew={canCreate ? (cwd, none) => { if(projectOwnerRef.current!==projectOwner)return;if(none){if(!projectlessAllowed){setError('请更新电脑端，或选择项目文件夹');return;}setProjectPath('');setProjectless(true);setNewSession(true);setError('');return;}setProjectless(false);setProjectPath(cwd);setProjects(previous=>previous.some(item=>item.path===cwd)?previous:[...previous,{path:cwd,name:cwd}]);setNewSession(true);setError(''); } : undefined}/> : null}
        {nextCursor ? <Pressable disabled={loadingMore} onPress={() => void readDirectory(true)} style={styles.more}>{loadingMore ? <ActivityIndicator size="small" color={d.accentText} /> : <Text style={styles.moreText}>加载更多</Text>}</Pressable> : null}
      </ScrollView>
      </>}
      <View style={styles.footer}>
        <Pressable accessibilityRole="button" accessibilityLabel="管理电脑 API 和 Agent" disabled={sending || apiSelection.busy} onPress={() => setManagementOpen(true)} style={styles.footerButton}><Text style={styles.footerText}>管理电脑</Text></Pressable>
        <Pressable onPress={disconnect} style={styles.footerButton}><Text style={styles.footerText}>断开</Text></Pressable><Pressable onPress={() => void forget()} style={styles.footerButton}><Text style={styles.footerText}>解除绑定</Text></Pressable></View>
    </> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <DirectComputerManagement visible={managementOpen} online={connection.status === 'connected'} scope={JSON.stringify([scope, connectionGeneration, connection.deviceId])}
      command={requestDirect} onClose={() => setManagementOpen(false)} onChanged={() => { void loadProfiles(); }} />
  </KeyboardSafeView>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  panel: { flex: 1, minHeight: 320, paddingHorizontal: 16, paddingBottom: 8, backgroundColor: d.bg },
  heading: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line },
  headingCopy: { flex: 1, minWidth: 0, gap: 2 }, title: { color: d.text, fontSize: 15, fontWeight: '600' }, subtitle: { color: d.muted, fontSize: 11.5 },
  back: { width: 34, height: 38, alignItems: 'center', justifyContent: 'center' }, iconButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: d.surface2, alignItems: 'center', justifyContent: 'center' },
  agentPicker: { gap: 8, paddingVertical: 10 }, agentChip: { paddingHorizontal: 12, height: 30, borderRadius: 15, justifyContent: 'center', backgroundColor: d.surface2 }, agentChipSelected: { backgroundColor: d.accentSoft }, agentText: { color: d.muted, fontSize: 12 }, agentTextSelected: { color: d.accentText, fontWeight: '600' },
  listToolbar: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, listLabel: { color: d.text2, fontSize: 12, fontWeight: '600' }, newButton: { height: 32, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 }, newButtonText: { color: d.accentText, fontSize: 12, fontWeight: '600' },
  newTask: { flex: 1, minHeight: 0, gap: 9, paddingVertical: 10 }, newTaskHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, newTaskTitle: { color: d.text, fontSize: 13, fontWeight: '600' }, cancelNew: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }, projectLabel: { color: d.muted, fontSize: 11 }, projectList: { flexGrow: 0, maxHeight: 170, borderRadius: 10, backgroundColor: d.surface2 }, projectRow: { minHeight: 46, justifyContent: 'center', gap: 2, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line }, projectSelected: { backgroundColor: d.accentSoft }, projectName: { color: d.text2, fontSize: 12, fontWeight: '500' }, projectNameSelected: { color: d.accentText }, projectPathText: { color: d.muted, fontSize: 10 }, newPrompt: { minHeight: 92, maxHeight: 160, color: d.text, fontSize: 13, lineHeight: 19, padding: 10, borderRadius: 10, backgroundColor: d.surface2, textAlignVertical: 'top' },
  list: { flex: 1 }, listContent: { paddingBottom: 12 }, sessionRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: d.line }, sessionCopy: { flex: 1, minWidth: 0, gap: 4 }, sessionTitle: { color: d.text, fontSize: 13.5, fontWeight: '500' }, sessionDetail: { color: d.muted, fontSize: 10.5 }, status: { color: d.muted, fontSize: 10.5 }, statusRunning: { color: d.accentText }, statusWaiting: { color: d.warn }, more: { alignItems: 'center', justifyContent: 'center', minHeight: 44 }, moreText: { color: d.accentText, fontSize: 12 }, loader: { marginVertical: 24 }, empty: { alignSelf: 'center', color: d.muted, paddingVertical: 24, fontSize: 12 },
  transcript: { flex: 1 }, transcriptContent: { paddingVertical: 14, gap: 12 }, message: { maxWidth: '90%', paddingHorizontal: 13, paddingVertical: 9, borderRadius: 16 }, userMessage: { alignSelf: 'flex-end', backgroundColor: d.userBubble }, assistantMessage: { alignSelf: 'flex-start', backgroundColor: d.surface2 }, userText: { color: d.text, fontSize: 14, lineHeight: 21 },
  approval: { padding: 12, borderRadius: 14, backgroundColor: d.warnSoft, gap: 8 }, approvalTitle: { color: d.text, fontSize: 13, fontWeight: '600' }, approvalDetail: { color: d.text2, fontSize: 12, lineHeight: 17 }, actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }, primaryButton: { minHeight: 36, paddingHorizontal: 14, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: d.ink }, primaryText: { color: d.onInk, fontSize: 12, fontWeight: '600' }, secondaryButton: { minHeight: 36, paddingHorizontal: 14, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface }, secondaryText: { color: d.text2, fontSize: 12, fontWeight: '500' },
  turn: { alignSelf: 'center', color: d.muted, fontSize: 11, paddingVertical: 4 }, activity: { padding: 10, borderRadius: 12, backgroundColor: d.surface2, gap: 4 }, activityTitle: { color: d.text2, fontSize: 12, fontWeight: '500' }, activityText: { color: d.muted, fontSize: 11, lineHeight: 16 }, reasoning: { color: d.muted, fontSize: 12, lineHeight: 18, fontStyle: 'italic' }, notice: { color: d.text2, fontSize: 12, lineHeight: 18 },
  composer: { minHeight: 52, maxHeight: 180, flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 7, borderRadius: 20, backgroundColor: d.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: d.lineStrong }, input: { flex: 1, maxHeight: 132, minHeight: 36, color: d.text, fontSize: 14, paddingHorizontal: 9, paddingTop: 8, paddingBottom: 6 }, sendButton: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: d.ink }, sendDisabled: { opacity: 0.45 }, uncertain: { position: 'absolute', right: 4, bottom: '100%', marginBottom: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: d.warnSoft }, uncertainText: { color: d.warn, fontSize: 11 }, readOnly: { color: d.muted, alignSelf: 'center', fontSize: 11, paddingVertical: 12 }, error: { color: d.bad, fontSize: 11.5, paddingVertical: 6 }, footer: { flexDirection: 'row', justifyContent: 'center', gap: 20, paddingTop: 6 }, footerButton: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 10 }, footerText: { color: d.muted, fontSize: 11 },
}));
