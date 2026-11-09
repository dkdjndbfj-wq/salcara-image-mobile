import {ConversationDropZone,type ConversationFilesHandle} from './ConversationDropZone';
import type {ComposerFilesAppender} from './composer-files';
import type {ExecutionRecoveryAction} from './execution-recovery';
import {TaskProgressDock} from './TaskProgressDock';
import {LimitRetryNotice} from './LimitRetryNotice';
import {ArtifactAnnotationProvider} from './ArtifactAnnotationContext';
import {useConversationOutputs} from './ConversationOutputLibrary';
import {useModelChangeNotices} from './ModelChangeNotice';
import {withModelChanges} from './model-change-notices';
import {ToolbarButton,ToolbarMenu} from './WorkbenchToolbar';
import {useConversationPosition} from './useConversationPosition';
import {conversationReadScope} from './conversation-unread';
import {useConversationResultReader} from './ConversationUnread';
import {WORKBENCH_SPACING,WorkbenchPresentationProvider} from './workbench-presentation';
import type {ImageAnnotationAppender} from './image-annotation-draft';
import {validConversationArtifact,type ConversationArtifactTarget} from './conversation-artifact-target';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { KeyboardSafeView } from '../components/KeyboardSafeView';
import { useBackAction, useChildBackAction, type RegisterBackAction } from './useBackAction';
import { Icon } from '../components/Icon';
import { AppDialog, showToast } from '../components/ui';
import { useDesk } from '../theme';
import type { AgentProfile, AttachmentRef, Decision, QuestionAnswers, SessionInfo, WorkspaceMode } from './client';
import type { Timeline, TimelineItem } from './store';
import { buildBlocks, conversationBlocks, type ConversationBlock, type FileEdit } from './blocks';
import { ApprovalCard, BlockRow, ThreadClockLabel, ThreadClockProvider, ThreadUi, type ApprovalItem } from './thread-rows';
import { useThreadStyles } from './thread-styles';
import { QuestionDock } from './QuestionDock';
import { approvalDecisions } from './approvals';
import { TabletThreadFrame } from './TabletThreadFrame';
import { RemoteSidebar } from './RemoteSidebar';
import { WorkspaceRuntimeContext, type WorkspaceRuntime } from './WorkspaceRuntimeContext';
import { resolveRemoteLink } from './remote-links';
import type { RemoteFileTarget } from './RemoteFiles';
import type { RemoteToolPreviewTarget } from './RemoteToolPreview';
import { ImageViewer, JumpToLatest, SearchBar } from './thread-extras';
import { quoteFor, runningSince, runningTurnHeading, turnStats, searchBlocks } from './thread-stats';
import { cachedAttachment, parseAttachmentPage } from './attachment-cache';
import { attachmentContentKey } from './attachment-ref';
import { requestDirect } from './direct-api';
import { directConnectionGeneration, directDeliveryScope, getDirectConnectionState } from './direct-pairing';
import { captureDirectSessionServices } from './direct-session-services';
import { DirectComposer, type DirectComposerSubmission, type ComposerRecoveryHandle, type DirectSendOutcome } from './DirectComposer';
import { SideQuestionPanel } from './SideQuestionPanel';
import { TemporarySideChat } from './TemporarySideChat';
import { lastTurnFiles } from './last-turn-files';
import { validContextReferences } from './context-references';
import type { ReferencePreview } from './ContextReferencePicker';
import { undoWorkspaceChanges } from './workspace-change-undo';
import { directRetryTarget } from './direct-turn-actions';
import { turnControlTarget } from './turn-control';
import { useDirectMessageQueue } from './useDirectMessageQueue';
import {useDirectQuestionDraft} from './useDirectQuestionDraft';
import { directQueueEditable } from './direct-message-queue';
import { QueuedMessages } from './QueuedMessages';
import { recoverDirectMessageDraft, type DirectDraftRestoreRequest } from './direct-retry-draft';
import { hasActiveAgentWork } from './work-activity';
import type {ComposerDraftRecoveryReceipt} from './composer-drafts';
import {randomUUID} from 'expo-crypto';
import {useSentEditBackup,type EditBackupBody} from './SentEditBackup';
import type {SentEditRestorer} from './sent-edit-recovery';
import {useConversationSyncNotice} from './useConversationSyncNotice';
import {latestEditableTurn} from './session-revert';
import {copyTurnFeatures} from './agent-features';
import { latestRevisableMessage, sentMessageRevisionIdentity, type SentMessageRevisionHandler } from './sent-message-revision';

export function DirectConversation(props:Parameters<typeof DirectConversationContent>[0]) {
  const tablet=useWindowDimensions().width>=1000;
  return <WorkbenchPresentationProvider presentation={tablet?'tablet':'phone'}><DirectConversationContent {...props}/></WorkbenchPresentationProvider>;
}
function DirectConversationContent({ runtime, deviceId, profile, session, timeline, workspaceMode, text, onText, loading, loadingMore,
  sending, canSend, uncertain, stopPending=false, error, onSend, onRevert, onStop, onRespond, onEarlier, onRefresh, onBack, onOpenSession, onNew, onMobileWorkspaceVisibilityChange,onContinue,onRetry,onRecoverDelivery,onRecoverMissingDraft,apiControl,onResolveApi,onRegisterBack }: {
  runtime: WorkspaceRuntime; deviceId: string; profile: AgentProfile; session: SessionInfo; timeline: Timeline; workspaceMode: WorkspaceMode;
  text: string; onText: (value: string) => void; loading: boolean; loadingMore: boolean; sending: boolean; canSend: boolean; uncertain: boolean; stopPending?:boolean; error: string;
  onSend: (options:DirectComposerSubmission,observe?:(outcome:DirectSendOutcome)=>void) => Promise<boolean|undefined>; onStop: () => void; onRespond: (id: string, decision: Decision, answers?: QuestionAnswers) => void;
  onRevert?:(message:import('./sent-message-revision').SentUserMessage,operationId:string)=>Promise<void>;
  onEarlier: () => void; onRefresh: () => void; onBack: () => void; onOpenSession: (key: string) => void; onNew: (mode?: WorkspaceMode, cwd?: string) => void;
  onMobileWorkspaceVisibilityChange?: (visible: boolean) => void;
  onRegisterBack?: RegisterBackAction;
  onContinue?:(options:DirectComposerSubmission)=>Promise<boolean|undefined>;onRetry?:()=>void;
  onRecoverDelivery?:()=>Promise<boolean>;
  onRecoverMissingDraft?:(receipt:ComposerDraftRecoveryReceipt)=>void;
  apiControl?: React.ReactNode;
  onResolveApi?:()=>void;
}) {
  const d = useDesk(), styles = useThreadStyles(), tablet = useWindowDimensions().width >= 1000;
  const [workspaceVisible, setWorkspaceVisible] = useState(false), [workspaceOpen, setWorkspaceOpen] = useState(false), [nonce, setNonce] = useState(0);
  const [sideChatRequest, setSideChatRequest] = useState<{scope:string;nonce:number}>();
  const reportWorkspaceVisibility = useCallback((visible: boolean) => {
    setWorkspaceVisible(visible);
    if (!tablet) setWorkspaceOpen(visible);
  }, [tablet]);
  useEffect(() => {
    onMobileWorkspaceVisibilityChange?.(!tablet && workspaceVisible);
    return () => onMobileWorkspaceVisibilityChange?.(false);
  }, [tablet, workspaceVisible, onMobileWorkspaceVisibilityChange]);
  const [fileTarget, setFileTarget] = useState<RemoteFileTarget | null>(null), [diff, setDiff] = useState<FileEdit | null>(null);
  const [preview, setPreview] = useState<RemoteToolPreviewTarget | null>(null), [review, setReview] = useState<{files: FileEdit[]; nonce: number} | null>(null);
  const [image, setImage] = useState<string | null>(null), [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState('');
  const [searchPos,setSearchPos]=useState(0);
  const workspaceBack = useChildBackAction();
  const composerBack = useChildBackAction();
  useBackAction(() => {
    if (workspaceBack.handle()) return true;
    if (searchOpen) { setSearchOpen(false); setQuery(''); setSearchPos(0); return true; }
    if (composerBack.handle()) return true;
    onBack();
    return true;
  }, onRegisterBack);
  const [menu,setMenu]=useState(false),menuAnchor=useRef<View>(null);
  const [reference,setReference]=useState<ReferencePreview>();
  const [restoreRequest,setRestoreRequest]=useState<DirectDraftRestoreRequest>();
  const [deliveryRecovery,setDeliveryRecovery]=useState<{source:string;recover:()=>Promise<boolean>}>(),[recoveringDelivery,setRecoveringDelivery]=useState(false);
  const [attachmentUris, setAttachmentUris] = useState<Record<string, string>>({});
  const list = useRef<FlatList<ConversationBlock>>(null), atBottom = useRef(true), downloads = useRef(new Map<string,object>());
  const dragging = useRef(false), contentHeight = useRef(0);
  const [jump, setJump] = useState({ visible: false, unseen: false });
  const connectionGeneration = directConnectionGeneration();
  const source = JSON.stringify([runtime.scope,deviceId,profile.id,workspaceMode,session.sessionKey,connectionGeneration,profile.api,profile.execution,session.cwd]);
  const sourceRef = useRef(source); sourceRef.current = source;
  const sourceVersion=useRef({source,epoch:0});if(sourceVersion.current.source!==source)sourceVersion.current={source,epoch:sourceVersion.current.epoch+1};
  const sourceEpoch=sourceVersion.current.epoch;
  useEffect(()=>{setSideChatRequest(undefined);},[source]);
  useEffect(()=>{setRestoreRequest(undefined);setDeliveryRecovery(undefined);setRecoveringDelivery(false);setMenu(false);},[source]);
  useEffect(() => { atBottom.current = true; dragging.current = false; contentHeight.current = 0; setJump({ visible: false, unseen: false }); }, [runtime.scope, deviceId, session.sessionKey]);
  const textRef=useRef(text);textRef.current=text;
  const composerReady = useRef(false);
  const filePicker=useRef<ConversationFilesHandle|undefined>(undefined),filesAppender=useRef<ComposerFilesAppender|undefined>(undefined),recoveryRef=useRef<ComposerRecoveryHandle|undefined>(undefined);
  const editRestoreRef=useRef<SentEditRestorer|undefined>(undefined);
  const [editBusy,setEditBusy]=useState(false),editFlight=useRef(false);
  useEffect(()=>{editFlight.current=false;setEditBusy(false);},[sourceEpoch]);
  const [composerDraftSignature,setComposerDraftSignature]=useState('');
  const imageAnnotationAppender=useRef<ImageAnnotationAppender|undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const services=useMemo(()=>captureDirectSessionServices(deviceId,session,profile,()=>mounted.current&&sourceRef.current===source&&sourceVersion.current.epoch===sourceEpoch),[source,sourceEpoch]);
  const queue=useDirectMessageQueue({pairing:runtime.scope,deviceId,workspaceMode,services,profile,session,timeline,canSend,sending,uncertain,
    autoAll:runtime.remote.agents?.[deviceId]?.autoAll===true,onRefresh});
  const pendingDelivery=uncertain||stopPending||queue.unconfirmed;
  const actionBusy=sending||queue.dispatching||editBusy;
  const queueAction=(action:()=>Promise<unknown>)=>{void action().catch(reason=>showToast(reason instanceof Error?reason.message:'排队操作失败','alert'));};
  const stopTask=()=>queueAction(async()=>{await queue.pause();onStop();});
  const appendToComposer=(value:string)=>{if(!services.isCurrent()||!composerReady.current)return false;const next=textRef.current?`${textRef.current}\n\n${value}`:value;textRef.current=next;onText(next);if(!tablet)setWorkspaceOpen(false);return true;};
  const controller = useMemo(() => new AbortController(), [source]);
  useEffect(() => () => controller.abort(), [controller]);
  const requestAttachment = useCallback((ref: AttachmentRef) => {
    const key = `${source}|${attachmentContentKey(ref)}`;
    const current = () => mounted.current && sourceRef.current === source && !controller.signal.aborted
      && directDeliveryScope() === runtime.scope && directConnectionGeneration() === connectionGeneration
      && getDirectConnectionState().status === 'connected' && getDirectConnectionState().deviceId === deviceId;
    if (!current() || downloads.current.has(key)) return;
    const token = {}; downloads.current.set(key,token);
    void cachedAttachment(`${runtime.scope}\0${JSON.stringify([deviceId, session.sessionKey])}`, ref, async offset => {
      if (!current()) throw new Error('图片来源已变化');
      const raw = await requestDirect({ type: 'attachment.read', sessionKey: session.sessionKey, id: ref.id, offset, length: 80_000 });
      if (!current()) throw new Error('图片来源已变化'); return parseAttachmentPage(raw);
    }, controller.signal).then(uri => { if (current()) setAttachmentUris(value => ({ ...value, [key]: uri })); })
      .catch(reason => {
        if (downloads.current.get(key) === token) downloads.current.delete(key);
        if (current()) showToast(reason instanceof Error ? reason.message : '图片读取失败', 'alert');
      });
  }, [source, deviceId, session.sessionKey, runtime.scope, controller]);
  const items = useMemo<TimelineItem[]>(() => timeline.items.map(item => item.kind === 'message' || item.kind === 'tool'
    ? { ...item, attachments: item.attachments?.map(ref => ({ ...ref, uri: attachmentUris[`${source}|${attachmentContentKey(ref)}`] ?? ref.uri })) } : item), [timeline.items, source, attachmentUris]);
  const running = session.status === 'running';
  const syncScope=JSON.stringify([runtime.scope,deviceId,profile.id,workspaceMode,session.sessionKey,profile.api,profile.execution,session.cwd]);
  const syncNotice=useConversationSyncNotice(syncScope,getDirectConnectionState().status==='connected',timeline.snapshotAt,loading||timeline.loading,timeline.error);
  const editBackup=useSentEditBackup(runtime.scope,deviceId,JSON.stringify([services.scope,workspaceMode]),{restore:(value,id)=>services.isCurrent()&&editRestoreRef.current?editRestoreRef.current(value,id):Promise.resolve(false),verify:async()=>{if(services.isCurrent())await onRefresh();},revertOperations:timeline.revertOperations,disabled:actionBusy||pendingDelivery||loading});
  const latestEditable=latestRevisableMessage(items);
  const editAdmitted=Boolean(canSend&&!sending&&!pendingDelivery&&queue.ready&&!queue.error&&!queue.dispatching&&!queue.entries.length
    &&session.controllable&&!session.archived&&session.controlSurface!=='desktop'&&session.controlSurface!=='read-only'
    &&(session.status==='idle'||session.status==='failed')&&!session.activeTurnId&&!loading&&!timeline.loading&&!timeline.error&&!timeline.readErrorCode&&!timeline.cachedAt
    &&!hasActiveAgentWork(session,items,items.filter(item=>item.kind==='approval'&&item.state==='pending').length,timeline.sessionSeq));
  const revisionState=useRef({timeline,admitted:editAdmitted,onSend,onRevert});revisionState.current={timeline,admitted:editAdmitted,onSend,onRevert};
  const editLatest:SentMessageRevisionHandler=async(message,revisedText,signal)=>{
    const turnId=latestEditableTurn(revisionState.current.timeline,message);
    if(!turnId||!revisionState.current.onRevert||!services.isCurrent()||!revisionState.current.admitted||actionBusy||editBackup.blocked||signal.aborted||editFlight.current)return false;
    const current=()=>mounted.current&&sourceVersion.current.epoch===sourceEpoch&&services.isCurrent();
    const before=()=>current()&&!signal.aborted&&revisionState.current.admitted&&latestEditableTurn(revisionState.current.timeline,message)===turnId;
    editFlight.current=true;setEditBusy(true);
    let body:EditBackupBody={version:1,text:revisedText,features:copyTurnFeatures(message),phase:'prepared',messageId:message.id,turnId,operationId:randomUUID()};
    try{
      const recovered=await recoverDirectMessageDraft({pairing:runtime.scope,deviceId,sessionKey:session.sessionKey,message,services,signal});
      if(!before())return false;
      await editBackup.begin(body,recovered.images);
      // Upload every original image before removing its native transcript.
      const attachments=recovered.images.length?await services.uploadImages(recovered.images):undefined;
      if(!before())throw new Error('会话已变化，编辑未提交');
      body={...body,phase:'reverting'};await editBackup.save(body,recovered.images);
      if(!before())throw new Error('会话已变化，编辑未提交');
      await revisionState.current.onRevert!(message,body.operationId);
      if(!current())return false;
      body={...body,phase:'reverted'};await editBackup.save(body,recovered.images);
      if(!current())return false;
      if(!revisionState.current.admitted)throw new Error('会话发送状态已变化，修正版已保留，尚未发送');
      body={...body,phase:'sending'};await editBackup.save(body,recovered.images);
      if(!current())return false;
      if(!revisionState.current.admitted){body={...body,phase:'reverted'};await editBackup.save(body,recovered.images);throw new Error('会话发送状态已变化，修正版已保留，尚未发送');}
      let definitelyRejected=false;
      const accepted=await revisionState.current.onSend({owner:JSON.stringify([runtime.scope,deviceId,session.sessionKey,profile.id,profile.api.accountId??'',session.cwd]),inputText:revisedText,...copyTurnFeatures(message),...(attachments?.length?{attachments}:{})},outcome=>{definitelyRejected=outcome==='not-sent';});
      if(!accepted&&definitelyRejected&&current()){body={...body,phase:'reverted'};await editBackup.save(body,recovered.images);}
      if(!accepted)throw new Error(definitelyRejected?'电脑未接收修正版，完整内容已保留，可恢复到输入框':'修正版尚未确认送达，内容已保留，请先核对会话');
      await editBackup.clear();return true;
    }catch(reason){if(current())showToast(reason instanceof Error?reason.message:'编辑未完成，修改内容已保留','alert');throw reason;}
    finally{if(current()){editFlight.current=false;setEditBusy(false);}editBackup.settle();}
  };
  const hostWorkActive = hasActiveAgentWork(session, items, items.filter(item => item.kind === 'approval' && item.state === 'pending').length, timeline.sessionSeq);
  const nativeBlocks = useMemo(() => conversationBlocks(buildBlocks(items, running), profile.tool, hostWorkActive), [items, running, profile.tool, hostWorkActive]);
  const modelChanges = useModelChangeNotices(JSON.stringify(['direct', services.scope, profile.api]), source, true, nativeBlocks);
  const blocks = useMemo(() => withModelChanges(nativeBlocks, modelChanges.records), [nativeBlocks, modelChanges.records]);
  const last = nativeBlocks[nativeBlocks.length - 1];
  const thinking = running && !loading && !(last?.type === 'activity' && last.live) && !(last?.type === 'assistant' && !last.item.final);
  const startedAt = running ? runningSince(items) : undefined;
  const runningHeading = useMemo(()=>running?runningTurnHeading(items):undefined,[running,items]);
  const retryTarget=useMemo(()=>directRetryTarget(timeline),[timeline]);
  const retryRef=useRef(retryTarget);retryRef.current=retryTarget;
  const retryHasImages=Boolean(retryTarget&&(retryTarget.message.attachments?.length||retryTarget.message.images?.length));
  const recoverFailed=()=>{
    const target=retryRef.current;if(!target||!canSend||pendingDelivery||actionBusy||queue.entries.length||!services.isCurrent())return;
    const same=()=>services.isCurrent()&&retryRef.current?.failed.id===target.failed.id&&retryRef.current?.message.id===target.message.id&&retryRef.current?.turnId===target.turnId;
    setRestoreRequest({id:JSON.stringify([source,target.failed.id,target.message.id]),text:target.message.text,attachments:target.message.attachments??[],load:async signal=>{
      if(!same())throw new Error('会话已变化，请重新选择原消息');
      const input=await recoverDirectMessageDraft({pairing:runtime.scope,deviceId,sessionKey:session.sessionKey,message:target.message,services,signal});
      if(!same())throw new Error('会话已变化，恢复内容未覆盖当前输入');return input;
    }});
  };
  const canContinue=Boolean(profile.capabilities?.continue&&canSend&&!pendingDelivery&&!queue.entries.length&&!queue.dispatching&&turnControlTarget(timeline,'continue'));
  const stats = useMemo(() => turnStats(items), [items]);
  const tools = useMemo(() => items.filter((item): item is Extract<TimelineItem, {kind:'tool'}> => item.kind === 'tool'), [items]);
  const edits = useMemo(() => lastTurnFiles(blocks), [blocks]);
  const childKeys = useMemo(() => [...new Set(tools.flatMap(item => item.childSessionKeys ?? []))], [tools]);
  const pending = items.filter((item): item is ApprovalItem => item.kind === 'approval' && item.state === 'pending' && (!item.expiresAt||item.expiresAt>Date.now()));
  const approval = pending[0], question = approval?.approval === 'question' ? approval : null;
  const questionDraft=useDirectQuestionDraft({scope:runtime.scope,deviceId,sessionKey:session.sessionKey,question,items:timeline.items,isCurrent:services.isCurrent});
  const reveal = () => { setNonce(value => value + 1); setWorkspaceOpen(true); };
  const outputScope=JSON.stringify([runtime.scope,deviceId,profile.id,workspaceMode,session.sessionKey,profile.api,profile.execution,session.cwd]);
  const readingScope=JSON.stringify([runtime.scope,deviceId,profile.id,workspaceMode,session.sessionKey,profile.api.accountId??`${profile.api.source}:${profile.api.name}`,session.cwd]);
  const readingPosition=useConversationPosition({scope:readingScope,active:true,blocks,list,earlierCursor:timeline.nextCursor,earlierLoading:loadingMore,earlierError:Boolean(timeline.earlierError),loadEarlier:onEarlier,
    onFollow:follow=>{atBottom.current=follow;setJump({visible:!follow,unseen:false});}});
  const resultViewability=useConversationResultReader({scope:conversationReadScope(runtime.scope,deviceId,profile,workspaceMode),session,timeline,
    active:!loading&&!timeline.loading&&!timeline.error&&!syncNotice&&(tablet||!workspaceOpen&&!workspaceVisible)},blocks,readingPosition.onViewableItemsChanged);
  const hits=useMemo(()=>searchOpen?searchBlocks(blocks,query):[],[searchOpen,blocks,query]);
  const hitIndex=hits.length?hits[Math.min(searchPos,hits.length-1)]:-1;
  const goToBlock=(index:number)=>{if(index<0)return;readingPosition.interact();atBottom.current=false;setJump({visible:true,unseen:false});try{list.current?.scrollToIndex({index,viewPosition:.25,animated:true});}catch{/* Retried after native measurement. */}};
  useEffect(()=>{setSearchOpen(false);setQuery('');setSearchPos(0);},[readingScope]);
  useEffect(()=>{if(searchOpen&&hitIndex>=0)goToBlock(hitIndex);},[searchOpen,hitIndex]);
  const [artifactRequest,setArtifactRequest]=useState<{target:ConversationArtifactTarget;nonce:number;owner:string}|null>(null);
  const artifactSequence=useRef(0);
  const currentArtifactRequest=artifactRequest?.owner===source&&artifactRequest.target.scopeKey===outputScope?artifactRequest:null;
  const openArtifact=(target:ConversationArtifactTarget)=>{
    if(!services.isCurrent()||!validConversationArtifact(target,outputScope))return;
    setPreview(null);setDiff(null);setFileTarget(null);setArtifactRequest({target,nonce:++artifactSequence.current,owner:source});reveal();
  };
  const outputDevice=runtime.remote.devices.find(item=>item.deviceId===deviceId);
  const outputs=useConversationOutputs({scopeKey:outputScope,generationKey:source,active:true,items,selection:{deviceId,sessionKey:session.sessionKey,agentId:profile.id,surface:'cli',expectedCwd:session.cwd},runtime,
    available:outputDevice?.capabilities?.includes('workspace.artifacts.v1')===true,writable:outputDevice?.capabilities?.includes('workspace.artifacts.write.v1')===true,
    requestAttachment,onCompose:appendToComposer,onComposeImages:(value,attached)=>{if(!services.isCurrent()||!imageAnnotationAppender.current)return Promise.resolve(false);return imageAnnotationAppender.current(value,attached);},isCurrent:()=>services.isCurrent()});
  const openLink = (target: string, exact: boolean, pageId?: string) => {
    const link = resolveRemoteLink(target, exact ? session.cwd : undefined);
    if (link.kind === 'web' || link.kind === 'local-service') { setPreview({kind:link.kind,url:target,pageId}); setDiff(null); setFileTarget(null); reveal(); }
    else if (link.kind === 'file' && exact) { if(outputs.openFile(link.path))return; setFileTarget({...link,expectedCwd:session.cwd,sessionKey:session.sessionKey,surface:'cli',nonce:Date.now()}); setDiff(null); reveal(); }
    else if (link.kind === 'task' && !link.connectionId && (!link.deviceId || link.deviceId === deviceId)) onOpenSession(link.sessionKey);
    else showToast('请从此内容所属的电脑会话打开', 'alert');
  };
  const header = <View style={[local.header,{borderColor:d.line}]}>
    {!tablet?<ToolbarButton icon="arrowLeft" label="返回会话目录" onPress={onBack}/>:null}
    <View style={{flex:1,minWidth:0}}><Text numberOfLines={1} style={{fontSize:14,fontWeight:'600',color:d.text}}>{session.title || '新对话'}</Text><Text numberOfLines={1} style={{fontSize:11,color:d.muted}}>{syncNotice ?? `${profile.name} · ${session.cwd}`}</Text></View>
    {!tablet?<ToolbarButton icon="panelRight" label="打开工作区" onPress={reveal}/>:null}
    <ToolbarButton icon="more" label="更多" anchorRef={menuAnchor} onPress={()=>setMenu(true)}/>
  </View>;
  const navigation = <View style={{flex:1}}><View style={local.header}><ToolbarButton icon="arrowLeft" label="返回会话目录" onPress={onBack}/><Text style={{color:d.text,fontWeight:'600'}}>对话</Text><View style={{flex:1}}/><ToolbarButton icon="compose" label="新建对话" onPress={() => onNew(workspaceMode, session.cwd)}/></View>
    <RemoteSidebar visible docked side="left" mode="navigation" deviceId={deviceId} agent={profile} activeSessionKey={session.sessionKey} controlSurface="cli" workspaceMode={workspaceMode} onClose={()=>{}} onOpenSession={onOpenSession} onNew={onNew}/></View>;
  const workspace = <ArtifactAnnotationProvider value={(value,images)=>services.isCurrent()&&imageAnnotationAppender.current?imageAnnotationAppender.current(value,images):Promise.resolve(false)}><RemoteSidebar visible={workspaceVisible} docked dockedWidth="100%" mode="tools" deviceId={deviceId} agent={profile} activeSessionKey={session.sessionKey} controlSurface="cli" workspaceMode={workspaceMode}
    artifactScope={outputScope} artifactTarget={currentArtifactRequest}
    onComputerUseStop={profile.capabilities?.preciseInterrupt&&!pendingDelivery&&!actionBusy&&turnControlTarget(timeline,'stop')?stopTask:undefined} computerUseStopPending={actionBusy}
    onComputerUseImage={setImage} onComputerUseAttachment={requestAttachment}
    fileEdits={edits} toolActivities={tools} childSessionKeys={childKeys} parentSessionKey={session.parentSessionKey} fileTarget={fileTarget} diffTarget={diff} diffOpenNonce={nonce} reviewTarget={review} previewTarget={preview} previewOpenNonce={nonce}
    onClose={()=>setWorkspaceOpen(false)} onOpenSession={onOpenSession} onNew={onNew} onReference={profile.capabilities?.contextReferences?value=>{setReference(value);if(!tablet)setWorkspaceOpen(false);}:undefined}
    onCompose={appendToComposer}
    onReviewReference={reference=>{if(reference.kind!=='diff'||reference.sessionKey!==session.sessionKey||!validContextReferences([reference]))return false;return appendToComposer(`请查看这段差异批注：${reference.path} · ${reference.side==='old'?'旧':'新'}版本第 ${reference.startLine}–${reference.endLine} 行\n版本：${reference.sourceRevision}\n\n${reference.text}\n\n${reference.annotation??''}`);}}
    sideChatOpenNonce={sideChatRequest?.scope===source?sideChatRequest.nonce:undefined}
    sideChat={(visible,tabId='side-chat')=><TemporarySideChat visible={visible} scopeKey={JSON.stringify([source,tabId])} sessionKey={session.sessionKey} transport={profile.capabilities?.sideQuestion?services.temporarySideChat:undefined} unavailableReason="当前电脑尚未提供临时侧边聊天能力"/>}
    sideChatHistory={profile.capabilities?.sideQuestion?visible=><SideQuestionPanel visible={visible} scopeKey={services.scope} authorizationScope={services.scope} sessionKey={session.sessionKey} transport={services.sideQuestions} compactComposer showHistory/>:undefined}/></ArtifactAnnotationProvider>;
  const resolveFailure=(action:ExecutionRecoveryAction)=>{
    if(!services.isCurrent())return;
    if(action==='connection'){onRefresh();showToast('正在读取电脑连接与会话状态，不会重发消息','code');return;}
    if(actionBusy||pendingDelivery||hostWorkActive){showToast('请先等待当前任务结束或核对待确认消息','alert');return;}
    if(action==='api'){if(onResolveApi)onResolveApi();else showToast('当前连接未提供 API 切换，请在电脑检查','alert');}
    if(action==='model'){if(profile.capabilities?.modelOverride)recoveryRef.current?.model();else showToast('当前 Agent 尚未提供远程模型切换，请在电脑检查','alert');}
    if(action==='new')onNew();
  };
  return <WorkspaceRuntimeContext.Provider value={runtime}><ThreadUi.Provider value={{onResolveFailure:resolveFailure,presentation:tablet?'tablet':'mobile',currentSessionKey:session.sessionKey,
    editDraftScope:runtime.scope,editDraftDeviceId:deviceId,latestEditableMessageId:onRevert&&profile.capabilities?.latestTurnRevert===true&&session.latestTurnRevert===true?latestEditable?.id:undefined,onEditMessage:editLatest,editMessageDisabledReason:running?'请先停止当前任务，再编辑最新消息':actionBusy||pendingDelivery||!canSend?'请先等待操作完成并核对连接':queue.entries.length?'请先处理排队消息':editBackup.blocked?'请先核对上次编辑保留的内容':undefined,
    openDiff:file=>{setDiff(file);setFileTarget(null);reveal();},openChanges:files=>{setReview({files,nonce:Date.now()});reveal();},
    undoUnavailable:hostWorkActive?'任务仍在运行，结束后可撤销':!runtime.remote.devices.find(item=>item.deviceId===deviceId)?.capabilities?.includes('workspace.files.write.v1')?'电脑尚未开放文件撤销':undefined,
    undoChanges:async files=>{services.guard();if(hostWorkActive)throw new Error('任务运行中不能撤销文件');return undoWorkspaceChanges({deviceId,sessionKey:session.sessionKey,agentId:profile.id,surface:'cli',expectedCwd:session.cwd},files,runtime.captureFiles);},openBrowser:navigation=>openLink(navigation.url,true,navigation.pageId),openDiffInToolPanel:true,
    openLink,artifactScope:outputScope,onOpenArtifact:openArtifact,onArtifactCompose:appendToComposer,openImage:uri=>{if(!outputs.openImage(uri))setImage(uri);},requestAttachment}}><ThreadClockProvider visible={tablet || !workspaceVisible} startedAt={startedAt}>
    <ToolbarMenu visible={menu} anchorRef={menuAnchor} onClose={()=>setMenu(false)} label="对话菜单" testID="conversation-actions-menu" actions={[
      {label:'搜索对话',icon:'search',onPress:()=>setSearchOpen(true)},
      {label:'刷新会话',icon:'regenerate',onPress:onRefresh},
    ]}/>
    <KeyboardSafeView testID="direct-keyboard-safe" style={{flex:1,minHeight:0}}><TabletThreadFrame onRegisterBack={workspaceBack.register} workspaceHasTabBar enabled={tablet} header={header} navigation={navigation} workspace={workspace} workspaceOpenNonce={nonce} mobileWorkspaceOpen={workspaceOpen} onCloseWorkspace={()=>setWorkspaceOpen(false)} onWorkspaceVisibilityChange={reportWorkspaceVisibility}>
      <ConversationDropZone scopeKey={source} enabled={canSend&&!actionBusy&&!pendingDelivery} importRef={filePicker} onFiles={files=>services.isCurrent()&&filesAppender.current?filesAppender.current(files):Promise.resolve(false)}>
      <View style={{flex:1,minHeight:0}}>
        {!tablet ? header : null}
        {apiControl}
        {syncNotice?<Text accessibilityRole="alert" style={[local.notice,{color:d.muted}]}>{syncNotice}</Text>:null}
        {searchOpen?<><SearchBar query={query} onChange={value=>{setQuery(value);setSearchPos(0);}} position={Math.min(searchPos,Math.max(0,hits.length-1))} total={hits.length}
          onPrev={()=>{if(hits.length)setSearchPos(value=>(value-1+hits.length)%hits.length);}} onNext={()=>{if(hits.length)setSearchPos(value=>(value+1)%hits.length);}} onClose={()=>{setSearchOpen(false);setQuery('');setSearchPos(0);}}/>
          <Text style={[local.notice,{color:d.muted}]}>搜索已加载的消息{timeline.nextCursor?' · 加载更早记录可继续查找':''}</Text></>:null}
        <View style={{flex:1,minHeight:0}}><FlatList key={readingScope} ref={list} testID="direct-conversation" data={blocks} keyExtractor={item=>item.id} style={{flex:1}} contentContainerStyle={[styles.list,tablet&&styles.tabletList]} keyboardShouldPersistTaps="handled"
          onLayout={readingPosition.onLayout} onViewableItemsChanged={resultViewability}
          maintainVisibleContentPosition={{minIndexForVisible:0}}
          onScroll={event=>{if(!readingPosition.onScroll(event))return;const {contentOffset,contentSize,layoutMeasurement}=event.nativeEvent;const away=contentSize.height-layoutMeasurement.height-contentOffset.y;
            if(!dragging.current)atBottom.current=away<120;
            setJump(current=>away>320?{visible:true,unseen:current.unseen}:{visible:false,unseen:false});}} scrollEventThrottle={80}
          onScrollBeginDrag={()=>{readingPosition.interact();dragging.current=true;atBottom.current=false;}}
          onScrollEndDrag={event=>{dragging.current=false;const {contentOffset,contentSize,layoutMeasurement}=event.nativeEvent;atBottom.current=contentSize.height-layoutMeasurement.height-contentOffset.y<40;}}
          onContentSizeChange={(_width,height)=>{const restoring=readingPosition.onContentSizeChange(_width,height);const grew=height>contentHeight.current+1;contentHeight.current=height;if(restoring)return;
            if(atBottom.current&&!dragging.current&&!loadingMore)list.current?.scrollToEnd({animated:false});
            else if(grew&&!loadingMore)setJump(current=>current.visible?{visible:true,unseen:true}:current);}}
          ListHeaderComponent={timeline.nextCursor?<Pressable accessibilityRole="button" accessibilityLabel="加载更早记录" disabled={loadingMore} onPress={()=>{readingPosition.interact();atBottom.current=false;onEarlier();}} style={local.more}>{loadingMore?<ActivityIndicator color={d.muted}/>:<Text style={{color:d.muted}}>更早的记录</Text>}</Pressable>:null}
          ListEmptyComponent={loading?<ActivityIndicator style={{margin:24}} color={d.muted}/>:<Text style={[local.more,{color:d.muted}]}>还没有消息</Text>}
          ListFooterComponent={thinking?<View style={styles.thinking} accessible accessibilityRole="progressbar" accessibilityLabel="正在处理" accessibilityState={{busy:true}}><ActivityIndicator size="small" color={d.muted}/><Text style={styles.thinkingText}><ThreadClockLabel prefix="正在处理"/></Text></View>:null}
          onScrollToIndexFailed={info=>{if(readingPosition.onScrollToIndexFailed(info))return;const navigationCurrent=readingPosition.captureInteraction();list.current?.scrollToOffset({offset:Math.max(0,info.averageItemLength*info.index-100),animated:false});setTimeout(()=>{if(!navigationCurrent()||!mounted.current||sourceRef.current!==source)return;try{list.current?.scrollToIndex({index:info.index,viewPosition:.25,animated:true});}catch{ /* A later navigation can retry an unmeasured row. */ }},120);}}
          renderItem={({item,index})=>{const previous=index>0?blocks[index-1]:undefined;const gap=index===0?0:item.type==='assistant'||previous?.type==='assistant'?WORKBENCH_SPACING.turn:4;
            return <View style={tablet?{marginTop:gap}:undefined}><BlockRow block={item} tool={profile.tool} onOpenChild={onOpenSession} stat={item.type==='assistant'?stats.get(item.item.id):undefined} runningTurnStartedAt={item.type==='assistant'&&item.item.id===runningHeading?.messageId?runningHeading.startedAt:undefined} searchQuery={query} selectionScope={source}
              onRetry={canContinue&&!actionBusy&&!retryHasImages&&retryTarget&&item.type==='turn'&&item.item.id===retryTarget.failed.id?onRetry:undefined}
              onQuote={value=>{appendToComposer(`${quoteFor(value)}\n\n`);}}/>
              {retryHasImages&&retryTarget&&item.type==='turn'&&item.item.id===retryTarget.failed.id?<Pressable accessibilityRole="button" accessibilityLabel="恢复原图片消息后重发" disabled={!canSend||pendingDelivery||actionBusy||Boolean(queue.entries.length)} onPress={recoverFailed} style={{alignSelf:'flex-start',paddingVertical:6}}><Text style={{color:d.muted,fontSize:12}}>恢复后重发</Text></Pressable>:null}
            </View>;}}/>
          <JumpToLatest visible={jump.visible&&!searchOpen} unseen={jump.unseen} onPress={()=>{readingPosition.interact();atBottom.current=true;dragging.current=false;setJump({visible:false,unseen:false});list.current?.scrollToEnd({animated:true});}}/>
        </View>
        {approval && !question ? <ApprovalCard approval={approval} more={pending.length-1} tool={profile.tool} busy={actionBusy} disabled={pendingDelivery||!profile.capabilities?.approval} onDecide={decision=>onRespond(approval.id,decision)} onDeny={()=>onRespond(approval.id,'deny')}/> : null}
        {approval&&!question&&!profile.capabilities?.approval?<Text style={[local.notice,{color:d.muted}]}>当前 Agent 不支持手机审批，请在电脑处理</Text>:null}
        {error ? <Text accessibilityRole="alert" style={[local.notice,{color:d.bad}]}>{error}</Text> : null}
        {questionDraft.error?<Pressable accessibilityRole="button" accessibilityLabel="重新读取问答草稿" onPress={questionDraft.retry} style={local.notice}><Text style={{color:d.bad}}>{questionDraft.error} · 重试</Text></Pressable>:null}
        {question&&!questionDraft.ready&&!questionDraft.error?<Text style={[local.notice,{color:d.muted}]}>正在恢复问答草稿…</Text>:null}
        {stopPending?<Pressable accessibilityRole="button" accessibilityLabel="核对停止结果" onPress={onRefresh} style={local.notice}><Text style={{color:d.warn}}>停止结果待确认，正在核对当前轮次；点击刷新。</Text></Pressable>:null}
        {uncertain ? <View style={[local.notice,{gap:8}]}><Pressable accessibilityLabel="核对未确认消息" onPress={onRefresh}><Text style={{color:d.warn}}>送达状态未确认，点击刷新核对；不会自动重发。</Text></Pressable>
          {onRecoverDelivery?<Pressable accessibilityRole="button" accessibilityLabel="已在电脑核对送达状态" onPress={()=>setDeliveryRecovery({source,recover:onRecoverDelivery})}><Text style={{color:d.muted,fontSize:12}}>已在电脑核对</Text></Pressable>:null}
        </View> : null}
        {queue.error?<Pressable accessibilityLabel="重新读取排队消息" onPress={()=>queueAction(queue.reload)} style={local.notice}><Text style={{color:d.warn}}>{queue.error} · 重试</Text></Pressable>:null}
        <QueuedMessages draftScope={runtime.scope} draftDeviceId={deviceId} scopeKey={JSON.stringify([services.scope,workspaceMode])} disabled={actionBusy||queue.dispatching||!canSend||pendingDelivery} entries={queue.entries.map((entry,index)=>({
          id:entry.id,text:entry.input.text,images:entry.input.images,imageCount:entry.input.imageCount,missingImages:entry.input.missingImages,
          detail:entry.reason||(entry.state==='attempting'?'正在发送…':'本轮结束后发送'),options:[entry.input.model,entry.input.effort,entry.input.permission,entry.input.options.collaborationMode,...(entry.input.options.skills??[]).map(skill=>skill.name)].filter(Boolean).join(' · '),
          editable:directQueueEditable(entry),removable:directQueueEditable(entry),resumable:index===0&&entry.state==='blocked'&&!entry.input.missingImages,
          uncertain:entry.state==='unconfirmed',
        }))} onPause={queue.pause} onReview={onRefresh}
          onEdit={async(id,text,originalText)=>{const row=queue.entries.find(entry=>entry.id===id);if(!row||row.input.text!==originalText)throw new Error('排队内容已变化，请重新查看');await queue.editText(row,text);}}
          onMove={async(id,offset)=>{const row=queue.entries.find(entry=>entry.id===id);if(!row)throw new Error('排队消息已改变');await queue.move(row,offset);}}
          onRemove={async id=>{const row=queue.entries.find(entry=>entry.id===id);if(!row||!directQueueEditable(row))throw new Error('请先核对消息送达状态');await queue.remove(row);}}
          onResume={async id=>{const row=queue.entries.find(entry=>entry.id===id);if(!row)throw new Error('排队消息已改变');await queue.resume(row);}} />
        <TaskProgressDock items={timeline.items} activeTurnId={session.activeTurnId} running={running} scopeKey={services.scope}/>
        <LimitRetryNotice failure={retryTarget?.failed} scopeKey={JSON.stringify([source, profile.api])} cancelKey={text + composerDraftSignature}
          enabled={canContinue && !actionBusy && !retryHasImages && Boolean(onRetry) && !hostWorkActive} onRetry={() => onRetry?.()} />
        <QuestionDock question={questionDraft.ready?question:null} busy={actionBusy||!questionDraft.ready} initialDraft={questionDraft.draft} draftIdentity={questionDraft.identity} onDraftChange={questionDraft.save}
          blocked={question&&(!profile.capabilities?.approval||!profile.capabilities.questions||!approvalDecisions(question).includes('allow'))?'请在电脑回答':pendingDelivery?'请刷新后核对问题状态':questionDraft.error}
          canCancel={Boolean(question&&profile.capabilities?.approval&&profile.capabilities.questions&&approvalDecisions(question).includes('deny'))} cancelBlocked={pendingDelivery} onAnswer={answers=>{if(question)onRespond(question.id,'allow',answers);}} onCancel={()=>{if(question)onRespond(question.id,'deny');}}>
          <DirectComposer onRegisterBack={composerBack.register} key={services.scope} onNew={onNew} onOpenSession={onOpenSession} onArchive={onBack} onReviewStarted={onRefresh} onSideChat={()=>{if(services.isCurrent()){setSideChatRequest(value=>({scope:source,nonce:(value?.nonce??0)+1}));reveal();}}} filesAppenderRef={filesAppender} onPickFiles={()=>filePicker.current?.pick()} recoveryRef={recoveryRef} editRestoreRef={editRestoreRef} workspaceMode={workspaceMode} onRecoverMissingDraft={onRecoverMissingDraft} onDraftSignatureChange={setComposerDraftSignature} onModelChange={modelChanges.record} imageAnnotationRef={imageAnnotationAppender} services={services} runtime={runtime} deviceId={deviceId} profile={profile} session={session} timeline={timeline} tablet={tablet} text={text} getLatestText={()=>textRef.current} onText={value=>{if(services.isCurrent()){textRef.current=value;onText(value);}}} sending={actionBusy} canSend={canSend&&!editBackup.blocked&&queue.ready&&!queue.error&&(running||!queue.entries.length)} uncertain={pendingDelivery} onSend={onSend} onContinue={canContinue?onContinue:undefined} onQueue={queue.ready?queue.enqueue:undefined} onStop={stopTask} restoreRequest={restoreRequest} onRestoreConsumed={()=>setRestoreRequest(undefined)} reference={reference} onReferenceConsumed={()=>setReference(undefined)} onDraftReadyChange={ready=>{composerReady.current=ready;}}/>
        </QuestionDock>
      </View></ConversationDropZone>
    </TabletThreadFrame></KeyboardSafeView>{outputs.panel}<ImageViewer uri={image} onClose={()=>setImage(null)}/>
    {editBackup.panel}
    <AppDialog visible={Boolean(deliveryRecovery)} title="已在电脑核对？" message="解除本机等待并保留草稿，不会重新发送消息。请先在电脑确认原消息是否已经执行，再决定如何处理草稿。" icon="check" dismissible={!recoveringDelivery} onClose={()=>setDeliveryRecovery(undefined)} actions={[
      {label:'继续等待',disabled:recoveringDelivery,onPress:()=>setDeliveryRecovery(undefined)},
      {label:recoveringDelivery?'正在恢复…':'解除本机等待',tone:'primary',disabled:recoveringDelivery,onPress:()=>{const recovery=deliveryRecovery;if(!recovery||recovery.source!==source||!services.isCurrent())return;setRecoveringDelivery(true);
        void recovery.recover().then(cleared=>{if(sourceRef.current===recovery.source){setDeliveryRecovery(undefined);if(!cleared)showToast('送达状态已变化，请重新核对','alert');}}).catch(reason=>{if(sourceRef.current===recovery.source)showToast(reason instanceof Error?reason.message:'送达记录恢复失败','alert');}).finally(()=>{if(sourceRef.current===recovery.source)setRecoveringDelivery(false);});}},
    ]}/>
  </ThreadClockProvider></ThreadUi.Provider></WorkspaceRuntimeContext.Provider>;
}

const local = StyleSheet.create({header:{height:54,paddingHorizontal:12,flexDirection:'row',alignItems:'center',gap:8,borderBottomWidth:StyleSheet.hairlineWidth},icon:{width:32,height:32,alignItems:'center',justifyContent:'center'},more:{padding:14,textAlign:'center',alignItems:'center'},notice:{paddingHorizontal:20,paddingVertical:8,fontSize:12},send:{width:32,height:32,borderRadius:16,alignItems:'center',justifyContent:'center'},search:{marginHorizontal:20,marginVertical:8,padding:10,borderWidth:StyleSheet.hairlineWidth,borderRadius:8}});
