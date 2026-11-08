import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useBackAction, type RegisterBackAction } from './useBackAction';
import {appendImageAnnotation,type ImageAnnotationAppender} from './image-annotation-draft';
import { AppState, Image, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { showToast } from '../components/ui';
import { useDesk } from '../theme';
import type { AgentProfile, ApprovalMode, Effort, ModelCatalog, PermissionMode, SessionInfo, WorkspaceMode } from './client';
import type { Timeline } from './store';
import { copyTurnFeatures, skillKey, type AgentFeatures, type TurnFeatures } from './agent-features';
import { effortLabel, reportedEfforts, reportsTextOnly } from './effort';
import { applySlashCommand, buildSlashCommands, parseSlashQuery, slashCommandDisabled, type SlashCommandEntry } from './slash-commands';
import { composerSlashActions, initializationDraft } from './composer-slash-actions';
import { SessionCommandPopover, type SessionCommand } from './SessionCommandPopover';
import { SlashCommandMenu } from './SlashCommandMenu';
import { ContextReferencePicker, type ReferencePreview } from './ContextReferencePicker';
import { appendContextReference, parseContextQuery, type ContextReference } from './context-references';
import { ContextReferenceChips } from './ContextReferenceChips';
import { ContextBar, type ContextBarHandle } from './ContextBar';
import { ContextIndicator } from './ContextIndicator';
import { SkillReferenceLabel } from './SkillReferenceLabel';
import {AttachmentComposerInput} from './AttachmentComposerInput';
import {DraftImageStrip} from './DraftImageStrip';
import { CompactActionMenu } from './CompactActionMenu';
import { ComposerOptionMenu } from './ComposerPopover';
import { ModelPopover } from './ModelPopover';
import { MainComposerAction, MainComposerModelButton, MainComposerModelGroup, MainComposerPermission, MainComposerSurface, MainComposerToolbar, MainEffortControl } from './MainComposer';
import { useThreadStyles } from './thread-styles';
import type { DirectSessionServices } from './direct-session-services';
import type { WorkspaceRuntime } from './WorkspaceRuntimeContext';
import { pickRemoteImages, type RemoteImage } from './attachments';
import { isApprovalMode, isPermissionMode, PERMISSION_LABEL } from './permission-mode';
import { copyMissingDirectComposerDraft, createDirectComposerDraft, directDraftKey, type DirectComposerDraft, type DirectDraftInput, type DirectSavedDraft } from './direct-composer-drafts';
import { appendRecoveredDirectDraft, recoverDirectMessageDraft, type DirectDraftRestoreRequest } from './direct-retry-draft';
import { undoMissingComposerDraft, type ComposerDraftOrigin, type ComposerDraftRecoveryReceipt } from './composer-drafts';
import { MissingSessionDraftRecovery } from './MissingSessionDraftRecovery';
import { promptHistory,promptHistoryIdentity,type PromptHistoryEntry } from './prompt-history';
import {randomUUID} from 'expo-crypto';
import type { PromptHistoryHandle } from './PromptHistorySheet';
import { appendComposerFiles, type ComposerFilesAppender } from './composer-files';
import {mergeSentEditRecovery,type SentEditRestorer} from './sent-edit-recovery';
import {requireHistoryCapabilities} from './history-input';

export interface ComposerRecoveryHandle { model:()=>void }
export type DirectSendOutcome='sent'|'not-sent'|'unknown';

export interface DirectComposerSubmission extends TurnFeatures { owner:string; inputText?:string; draftReceipt?:{revision:number;identity:string}; model?:string; effort?:Effort; attachments?:string[]; permissionMode?:PermissionMode; approval?:ApprovalMode }
const draftSignature=(value:DirectDraftInput)=>JSON.stringify(value);
function remainingDraft(current:DirectDraftInput,sent:DirectDraftInput):DirectDraftInput {
  const subtract=<T,>(values:T[]|undefined,removed:T[]|undefined,key:(value:T)=>string):T[]|undefined=>{
    const counts=new Map<string,number>();for(const value of removed??[]){const id=key(value);counts.set(id,(counts.get(id)??0)+1);}
    const result=(values??[]).filter(value=>{const id=key(value),count=counts.get(id)??0;if(count){counts.set(id,count-1);return false;}return true;});return result.length?result:undefined;
  };
  const images=subtract(current.images,sent.images,image=>JSON.stringify([image.uri,image.mime,image.width,image.height,image.base64]))??[];
  const text=current.text===sent.text?'':sent.text&&current.text.startsWith(sent.text)?current.text.slice(sent.text.length).replace(/^\n{1,2}/,''):current.text;
  return {...current,text,images,imageCount:images.length,missingImages:false,options:{...current.options,
    skills:subtract(current.options.skills,sent.options.skills,skillKey),
    contextReferences:subtract(current.options.contextReferences,sent.options.contextReferences,value=>JSON.stringify(value))}};
}
export function DirectComposer({services,runtime,deviceId,profile,session,timeline,tablet,text,onText,sending,canSend,uncertain,onSend,onStop,reference,onReferenceConsumed,onDraftReadyChange,getLatestText,onContinue,onQueue,restoreRequest,onRestoreConsumed,imageAnnotationRef,filesAppenderRef,onPickFiles,recoveryRef,editRestoreRef,onModelChange,onDraftSignatureChange,workspaceMode='code',onRecoverMissingDraft,recoveryReceipt,onRecoveryUndone,onNew,onSideChat,onOpenSession,onArchive,onReviewStarted,onRegisterBack}: {
  services:DirectSessionServices;runtime:WorkspaceRuntime;deviceId:string;profile:AgentProfile;session:Pick<SessionInfo,'cwd'>&Partial<SessionInfo>;timeline:Timeline;tablet:boolean;text:string;onText:(value:string)=>void;
  sending:boolean;canSend:boolean;uncertain:boolean;onSend:(options:DirectComposerSubmission,observe?:(outcome:DirectSendOutcome)=>void)=>Promise<boolean|undefined>;onStop:()=>void;reference?:ReferencePreview;onReferenceConsumed:()=>void;
  onDraftReadyChange?:(ready:boolean)=>void;
  onRegisterBack?:RegisterBackAction;
  onDraftSignatureChange?:(signature:string)=>void;
  onModelChange?:(from:string,to:string)=>void;
  getLatestText?:()=>string;
  onContinue?:(options:DirectComposerSubmission)=>Promise<boolean|undefined>;
  onQueue?:(input:DirectDraftInput)=>Promise<boolean>;
  restoreRequest?:DirectDraftRestoreRequest;onRestoreConsumed?:()=>void;
  imageAnnotationRef?:React.MutableRefObject<ImageAnnotationAppender|undefined>;
  filesAppenderRef?:React.MutableRefObject<ComposerFilesAppender|undefined>;
  onPickFiles?:()=>void;
  recoveryRef?:React.MutableRefObject<ComposerRecoveryHandle|undefined>;
  editRestoreRef?:React.MutableRefObject<SentEditRestorer|undefined>;
  workspaceMode?:WorkspaceMode;
  onRecoverMissingDraft?:(receipt:ComposerDraftRecoveryReceipt)=>void;
  recoveryReceipt?:ComposerDraftRecoveryReceipt;
  onRecoveryUndone?:()=>void;
  onNew?:()=>void; onSideChat?:()=>void; onOpenSession?:(key:string)=>void; onArchive?:()=>void; onReviewStarted?:()=>void;
}) {
  const d=useDesk(),styles=useThreadStyles(),running=session.status==='running';
  const canChooseModel = profile.capabilities?.modelOverride === true || !session.sessionKey && profile.capabilities?.startModelOverride === true;
  const [catalog,setCatalog]=useState<ModelCatalog>(),[model,setModel]=useState(''),[effort,setEffort]=useState<Effort|''>('');
  const [featureState,setFeatureState]=useState<{source:string;owner:DirectSessionServices;request:number;value?:AgentFeatures;loading:boolean;error:string}>(),[featureRevision,setFeatureRevision]=useState(0);
  const forceFeatureRefresh=useRef(false);
  const [options,setOptions]=useState<TurnFeatures>({}),[picker,setPicker]=useState<'model'|'permission'|'add'|'effort'|null>(null),[modelLoading,setModelLoading]=useState(false),[modelError,setModelError]=useState('');
  const [slashSessionCommand,setSlashSessionCommand]=useState<{scope:string;command:SessionCommand}>();
  const optionsRef=useRef(options);optionsRef.current=options;
  const [permission,setPermission]=useState<PermissionMode|ApprovalMode|''>('');
  const modelAnchor=useRef<View>(null),permissionAnchor=useRef<View>(null),addAnchor=useRef<View>(null);
  const [dismissed,setDismissed]=useState(''),[referenceOpen,setReferenceOpen]=useState(false),[contextBusy,setContextBusy]=useState(false),[uploading,setUploading]=useState(false),[images,setImages]=useState<RemoteImage[]>([]);
  const contextBar=useRef<ContextBarHandle>(null),generation=useRef(0),mounted=useRef(true),submitFlight=useRef(false);
  const annotationFlight=useRef<{source:string}|undefined>(undefined);
  const editRestoreFlight=useRef<{source:string;previousMarker:string}|undefined>(undefined);
  const modelFlight=useRef<{source:string;owner:DirectSessionServices;request:number}|undefined>(undefined),modelSequence=useRef(0);
  const source=JSON.stringify([runtime.scope,deviceId,services.scope]);
  useEffect(()=>{setSlashSessionCommand(undefined);setPicker(null);},[source,services]);
  useEffect(()=>{if(annotationFlight.current&&annotationFlight.current.source!==source){annotationFlight.current=undefined;submitFlight.current=false;setUploading(false);}},[source]);
  const sourceEpoch=useRef({source,epoch:0});if(sourceEpoch.current.source!==source)sourceEpoch.current={source,epoch:sourceEpoch.current.epoch+1};
  const epoch=sourceEpoch.current.epoch;
  const composerInput=useRef<TextInput>(null);
  const historyRef=useRef<PromptHistoryHandle|undefined>(undefined);
  const historyRestorer=useRef<SentEditRestorer|undefined>(undefined);
  const history=useMemo(()=>promptHistory(timeline.items),[timeline.items]);
  const [inputSelection,setInputSelection]=useState<{source:string;text:string;start:number;end:number}>(),[forcedSelection,setForcedSelection]=useState<{source:string;text:string;start:number;end:number}>();
  const [slashDismissed,setSlashDismissed]=useState<string>(),[slashFocus,setSlashFocus]=useState({key:'',index:0});
  const activeSubmission=useRef<{epoch:number;owner:DirectComposerDraft;input:DirectDraftInput}|undefined>(undefined);
  const [draftReady,setDraftReady]=useState(false),[draftError,setDraftError]=useState(''),[draftRetry,setDraftRetry]=useState(0),[recovered,setRecovered]=useState<DirectSavedDraft>();
  const [cleanupPending,setCleanupPending]=useState(false);
  const acceptedDraft=useRef<{source:string;input:DirectDraftInput;saved:DirectSavedDraft}|undefined>(undefined);
  const [missingImages,setMissingImages]=useState(false),[imageCount,setImageCount]=useState<number>();
  const [restoreBusy,setRestoreBusy]=useState(false),[restoreError,setRestoreError]=useState('');
  const [missingRecoveryBusy,setMissingRecoveryBusy]=useState(false),[recoveryEdited,setRecoveryEdited]=useState(false);
  const recoveryBaseline=useRef<{receipt:ComposerDraftRecoveryReceipt;signature:string}|undefined>(undefined);
  const restoreController=useRef<AbortController|undefined>(undefined),restoreRef=useRef(restoreRequest);restoreRef.current=restoreRequest;
  useEffect(()=>{setRestoreBusy(false);setRestoreError('');return()=>{if(restoreController.current){restoreController.current.abort();restoreController.current=undefined;submitFlight.current=false;}};},[restoreRequest?.id,source]);
  useEffect(()=>{onDraftReadyChange?.(draftReady);return()=>onDraftReadyChange?.(false);},[draftReady,onDraftReadyChange]);
  const draftSession=useRef<DirectComposerDraft|undefined>(undefined),readyRef=useRef(false),textRef=useRef(text);textRef.current=text;
  const draftSaveTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),latestText=useRef(getLatestText);latestText.current=getLatestText;
  const draftSource=useRef<string|undefined>(undefined);
  const draftOrigin:ComposerDraftOrigin|undefined=session.cwd?{transport:'direct',deviceId,agentId:profile.id,cwd:session.cwd,mode:workspaceMode,apiIdentity:profile.api.accountId??'',...(session.sessionKey?{sessionKey:session.sessionKey}:{})}:undefined;
  const draftValue=useRef<DirectDraftInput>({text,options,model,effort,permission,images});draftValue.current={text,options,model,effort,permission,images,missingImages,imageCount:imageCount??images.length,...(draftOrigin?{origin:draftOrigin}:{})};
  const currentRecovery=recoveryReceipt?.scope===runtime.scope&&recoveryReceipt.targetKey===directDraftKey(runtime.scope,deviceId,services.scope)?recoveryReceipt:undefined;
  const recoverySignature=draftSignature(draftValue.current);
  const unchangedRecovery=Boolean(currentRecovery&&recoveryBaseline.current?.receipt===currentRecovery&&recoveryBaseline.current.signature===recoverySignature&&!recoveryEdited);
  const draftNoticeSignature=JSON.stringify([source,text,options,model,effort,permission,images.map(image=>image.uri),draftReady,missingImages]);
  useEffect(()=>{onDraftSignatureChange?.(draftNoticeSignature);},[draftNoticeSignature,onDraftSignatureChange]);
  const sourceDrafts=useRef(new Map<string,DirectDraftInput>());sourceDrafts.current.set(source,draftValue.current);
  const applyDraft=(value:DirectSavedDraft)=>{onText(value.text);setOptions(value.options);setModel(value.model);setEffort(value.effort);setPermission(value.permission);setImages(value.images);setMissingImages(Boolean(value.missingImages));setImageCount(value.imageCount);setRecovered(undefined);setDraftError('');readyRef.current=true;setDraftReady(true);if(value.model)void loadModels();};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;generation.current++;};},[]);
  useEffect(()=>{
    let active=true;readyRef.current=false;setDraftReady(false);setDraftError('');
    if(draftSource.current!==source){
      draftSource.current=source;
      setOptions({});setModel('');setEffort('');setPermission('');setImages([]);setMissingImages(false);setImageCount(undefined);setRecovered(undefined);
      draftValue.current={text:textRef.current,options:{},model:'',effort:'',permission:'',images:[]};
    }
    if(acceptedDraft.current?.source!==source){acceptedDraft.current=undefined;setCleanupPending(false);}
    if(activeSubmission.current&&activeSubmission.current.epoch!==sourceEpoch.current.epoch){activeSubmission.current=undefined;submitFlight.current=false;setUploading(false);}
    const initial=textRef.current,owner=createDirectComposerDraft(runtime.scope,deviceId,services.scope);draftSession.current=owner;
    void owner.restore().then(value=>{if(!active)return;if(acceptedDraft.current?.source===source){setCleanupPending(true);setDraftError('消息已提交，草稿清理尚未确认，请重新读取并核对；不会再次发送。');return;}if(value&&textRef.current!==initial){setRecovered(value);setDraftError('恢复期间输入已变化，请选择要保留的内容');return;}
      if(value){if(currentRecovery&&value.revision===currentRecovery.targetRevision&&value.identity===currentRecovery.targetIdentity){recoveryBaseline.current={receipt:currentRecovery,signature:draftSignature({text:value.text,options:value.options,model:value.model,effort:value.effort,permission:value.permission,images:value.images,missingImages:Boolean(value.missingImages),imageCount:value.imageCount??value.images.length,...(draftOrigin?{origin:draftOrigin}:{})})};setRecoveryEdited(false);}applyDraft(value);}else{readyRef.current=true;setDraftReady(true);}},reason=>{if(active)setDraftError(reason instanceof Error?reason.message:'草稿恢复失败，原内容未覆盖');});
    return()=>{active=false;const flight=activeSubmission.current,value=sourceDrafts.current.get(source);
      const restoring=editRestoreFlight.current?.source===source?editRestoreFlight.current:undefined;
      if(readyRef.current&&value&&restoring)void owner.save({...value,lastRestoredEdit:restoring.previousMarker}).catch(()=>undefined);
      else if(readyRef.current&&value&&!(recoveryBaseline.current&&draftSignature(value)===recoveryBaseline.current.signature)&&(!submitFlight.current||flight?.owner===owner&&draftSignature(value)!==draftSignature(flight.input)))void owner.save(value).catch(()=>undefined);
      owner.close();if(draftSession.current===owner)draftSession.current=undefined;};
  },[runtime.scope,deviceId,services.scope,draftRetry]);
  useEffect(()=>{
    if(!draftReady||submitFlight.current||acceptedDraft.current||unchangedRecovery)return;
    if(currentRecovery&&recoveryBaseline.current?.receipt===currentRecovery&&recoverySignature!==recoveryBaseline.current.signature)setRecoveryEdited(true);
    const owner=draftSession.current,value=draftValue.current;
    const timer=setTimeout(()=>{if(!submitFlight.current&&!acceptedDraft.current)void owner?.save(value).then(()=>{if(mounted.current&&!acceptedDraft.current)setDraftError('');},reason=>{if(mounted.current&&!acceptedDraft.current)setDraftError(reason instanceof Error?reason.message:'草稿保存失败');});},300);
    draftSaveTimer.current=timer;
    return()=>{clearTimeout(timer);if(draftSaveTimer.current===timer)draftSaveTimer.current=undefined;};
  },[draftReady,text,options,model,effort,permission,images,missingImages,imageCount,uploading,restoreBusy,missingRecoveryBusy,cleanupPending,unchangedRecovery,recoverySignature]);
  useEffect(()=>{
    const subscription=AppState.addEventListener('change',state=>{
      if(state!=='inactive'&&state!=='background')return;
      if(draftSaveTimer.current){clearTimeout(draftSaveTimer.current);draftSaveTimer.current=undefined;}
      const owner=draftSession.current;
      const current=()=>mounted.current&&sourceEpoch.current.source===source&&sourceEpoch.current.epoch===epoch&&draftSession.current===owner;
      if(!owner||!current()||!readyRef.current||acceptedDraft.current)return;
      const value={...draftValue.current,text:latestText.current?.()??draftValue.current.text};
      if(recoveryBaseline.current&&draftSignature(value)===recoveryBaseline.current.signature)return;
      const flight=activeSubmission.current;
      // The submission already persisted its own input. Only newer edits may
      // be flushed while it is in flight; the original receipt still uses CAS.
      if(submitFlight.current&&(!flight||flight.owner!==owner||draftSignature(value)===draftSignature(flight.input)))return;
      void owner.save(value).then(()=>{if(current()&&!acceptedDraft.current)setDraftError('');},reason=>{
        if(current()&&!acceptedDraft.current)setDraftError(reason instanceof Error?reason.message:'草稿保存失败');
      });
    });
    return()=>subscription.remove();
  },[source,epoch]);
  const loadModels=async(refresh=false)=>{
    if(modelFlight.current?.source===source&&modelFlight.current.owner===services||!canChooseModel)return;
    const request=++modelSequence.current;modelFlight.current={source,owner:services,request};setModelLoading(true);setModelError('');
    const current=()=>mounted.current&&sourceEpoch.current.source===source&&sourceEpoch.current.epoch===epoch&&request===modelSequence.current&&services.isCurrent();
    try{const value=await services.models(refresh);if(current())setCatalog(value);}catch(reason){if(current())setModelError(reason instanceof Error?reason.message:'模型读取失败');}
    finally{if(current())setModelLoading(false);if(modelFlight.current?.request===request)modelFlight.current=undefined;}
  };
  useEffect(()=>{setCatalog(undefined);setModelError('');setModelLoading(false);void loadModels();return()=>{++modelSequence.current;if(modelFlight.current?.source===source&&modelFlight.current.owner===services)modelFlight.current=undefined;};},[source,services,canChooseModel]);
  const effectiveModel=model||session.model||profile.api.model,levels=profile.capabilities?.modelOverride?reportedEfforts(catalog?.modelCapabilities?.[effectiveModel]):[];
  const modelRuntime=useRef({catalog,effectiveModel});modelRuntime.current={catalog,effectiveModel};
  const retainModelEffort=(next:string)=>{const same=next===modelRuntime.current.effectiveModel,supported=reportedEfforts(modelRuntime.current.catalog?.modelCapabilities?.[next]);setEffort(current=>same||!current||supported.includes(current)?current:'');};
  const locked=sending||uploading||uncertain||contextBusy||missingRecoveryBusy||!draftReady||Boolean(restoreRequest),controlsLocked=locked||running&&!onQueue;
  useEffect(()=>{
    const handle={model:()=>{if(!sourceCurrent()||controlsLocked||!canChooseModel)return;setPicker('model');void loadModels(true);}};
    if(recoveryRef)recoveryRef.current=handle;
    return()=>{if(recoveryRef?.current===handle)recoveryRef.current=undefined;};
  },[recoveryRef,source,services,controlsLocked,canChooseModel]);
  const autoAll=runtime.remote.agents[deviceId]?.autoAll===true;
  const permissions:Array<PermissionMode|ApprovalMode>=profile.tool==='codex'?(profile.capabilities?.permissionModes??[]).filter(isPermissionMode):(profile.capabilities?.approvalModes??[]).filter(isApprovalMode);
  const permissionLabel=(value:string)=>isPermissionMode(value)?PERMISSION_LABEL[value]:value==='auto_edits'?'自动批准编辑':value==='auto_all'?'全部自动':'权限';
  const invalidPermission=Boolean(permission&&(!permissions.includes(permission)||!autoAll&&(permission==='full_access'||permission==='auto_all')));
  // These values are deliberate next-turn overrides. Profile/session defaults
  // describe the current run and must not disable a plain-text steer.
  const pendingTurnOverrides=Boolean(options.collaborationMode!==undefined||model||effort||permission);
  const pendingTurnInputs=Boolean(images.length||options.skills?.length||options.contextReferences?.length||pendingTurnOverrides);
  const selection=inputSelection?.source===source&&inputSelection.text===text?inputSelection:undefined;
  const inputCaret=selection?Math.min(selection.end,text.length):text.length;
  const slashKey=JSON.stringify([source,text,inputCaret]);
  const slash=slashDismissed!==slashKey&&(!selection||selection.start===selection.end)?parseSlashQuery(text,inputCaret):undefined;
  const slashOwner=useRef(slashKey);slashOwner.current=slashKey;
  const sourceCurrent=()=>mounted.current&&sourceEpoch.current.source===source&&sourceEpoch.current.epoch===epoch&&services.isCurrent();
  const featureStateCurrent=featureState?.source===source&&featureState.owner===services&&featureState.request===generation.current;
  const featureLoading=profile.capabilities?.features===true&&(!featureStateCurrent||featureState.loading);
  const featureError=featureStateCurrent?featureState.error:'';
  const features=featureStateCurrent&&!featureState.loading&&!featureState.error?featureState.value:undefined;
  const featureCatalogCurrent=()=>sourceCurrent()&&profile.capabilities?.features===true&&featureStateCurrent&&featureState.request===generation.current&&!featureState.loading&&!featureState.error&&Boolean(featureState.value);
  const contextQuery=profile.capabilities?.contextReferences&&text!==dismissed?parseContextQuery(text,inputCaret):undefined;
  const slashActions=composerSlashActions({model:canChooseModel,reasoning:levels.length>0,reasoningLabel:effort?effortLabel(effort):'默认',permissions:permissions.length>0,
    newChat:Boolean(onNew),sideChat:Boolean(session.sessionKey&&profile.capabilities?.sideQuestion&&onSideChat),initialize:Boolean(session.cwd),
    fork:Boolean(session.sessionKey&&services.sessionCommands&&profile.capabilities?.sessionActions&&onOpenSession),archive:Boolean(session.sessionKey&&services.sessionCommands&&profile.capabilities?.sessionActions&&onArchive),
    review:Boolean(session.sessionKey&&services.sessionCommands&&profile.capabilities?.sessionWorkflows)});
  const slashActionSignature=JSON.stringify(slashActions);
  const slashEntries=useMemo(()=>slash?buildSlashCommands(features,slash,options.collaborationMode??session.collaborationMode,Boolean(session.sessionKey&&profile.capabilities?.compact),slashActions):[],[features,slash?.source,inputCaret,options.collaborationMode,session.sessionKey,session.collaborationMode,profile.capabilities?.compact,slashActionSignature]);
  const slashIndex=slashFocus.key===slashKey?Math.min(slashFocus.index,Math.max(0,slashEntries.length-1)):0;
  const slashSelectionKey=JSON.stringify([slashKey,slashActionSignature,controlsLocked,canSend]),slashSelectionOwner=useRef({key:slashSelectionKey});
  if(slashSelectionOwner.current.key!==slashSelectionKey)slashSelectionOwner.current={key:slashSelectionKey};
  const renderedSlashOwner=slashSelectionOwner.current;
  useEffect(()=>{
    const request=++generation.current;
    if(!profile.capabilities?.features){setFeatureState(undefined);return;}
    let active=true;
    const force=forceFeatureRefresh.current;forceFeatureRefresh.current=false;
    const current=()=>active&&sourceCurrent()&&request===generation.current;
    setFeatureState({source,owner:services,request,loading:true,error:''});
    void services.features(force).then(value=>{
      if(current())setFeatureState({source,owner:services,request,value,loading:false,error:''});
    },reason=>{
      if(current())setFeatureState({source,owner:services,request,loading:false,error:reason instanceof Error?reason.message:'技能目录读取失败'});
    });
    return()=>{active=false;};
  },[source,services,featureRevision,profile.capabilities?.features,Boolean(slash)]);
  const invalidFeatures=Boolean((options.skills?.length||options.collaborationMode)&&!featureCatalogCurrent()||options.skills?.some(skill=>!features?.skills.some(entry=>skillKey(entry)===skillKey(skill)))
    ||options.collaborationMode&&!features?.collaborationModes.includes(options.collaborationMode));
  const reloadFeatures=()=>{
    if(!sourceCurrent()||controlsLocked)return;
    ++generation.current;forceFeatureRefresh.current=true;setFeatureRevision(value=>value+1);
  };
  const editText=(value:string)=>{
    if(!sourceCurrent())return;
    slashOwner.current='';textRef.current=value;setInputSelection(undefined);setForcedSelection(undefined);setSlashDismissed(undefined);onText(value);
  };
  const replaceComposerText=(value:string,caret:number)=>{
    const next={source,text:value,start:caret,end:caret};
    slashOwner.current='';textRef.current=value;setInputSelection(next);setForcedSelection(next);setSlashDismissed(undefined);onText(value);composerInput.current?.focus();
  };
  const closeSlash=()=>{if(sourceCurrent()&&slashOwner.current===slashKey)setSlashDismissed(slashKey);};
  useBackAction(() => {
    if (!sourceCurrent() || !slash) return false;
    closeSlash();
    return true;
  }, onRegisterBack);
  const selectSlashCommand=(entry:SlashCommandEntry)=>{
    const selected=slashEntries.find(value=>value.id===entry.id);
    if(!slash||!selected||!sourceCurrent()||AppState.currentState==='background'||AppState.currentState==='inactive'||controlsLocked||!canSend||submitFlight.current||slashOwner.current!==slashKey||slashSelectionOwner.current!==renderedSlashOwner
      ||textRef.current!==text||(getLatestText&&getLatestText()!==text)||slashCommandDisabled(selected,{loading:featureLoading,error:featureError}))return;
    entry=selected;
    if(entry.kind!=='action'&&entry.kind!=='compact'&&!featureCatalogCurrent())return;
    if(entry.kind==='action'){
      if(!entry.action)return;
      const edit=entry.action==='init'?initializationDraft(text,slash):{text:applySlashCommand(text,slash,entry),caret:slash.replaceStart};
      replaceComposerText(edit.text,edit.caret);setSlashFocus({key:'',index:0});
      if(entry.action==='model'){setPicker('model');void loadModels();}
      else if(entry.action==='reasoning')setPicker('effort');
      else if(entry.action==='permissions')setPicker('permission');
      else if(entry.action==='new')onNew?.();
      else if(entry.action==='side')onSideChat?.();
      else if(entry.action==='fork'||entry.action==='archive'||entry.action==='review')setSlashSessionCommand({scope:source,command:entry.action});
      return;
    }
    if(entry.kind==='compact'){
      if(!session.sessionKey||!profile.capabilities?.compact||!contextBar.current?.compact()){showToast('当前上下文不能压缩','code');return;}
    }else if(entry.kind==='mode'){
      if(!entry.mode||!features?.collaborationModes.includes(entry.mode))return;
      const next={...optionsRef.current,collaborationMode:entry.mode};optionsRef.current=next;setOptions(next);
    }else if(entry.kind==='skill'){
      const skill=entry.skill;
      if(!skill||!features?.skills.some(value=>skillKey(value)===skillKey(skill)))return;
      const skills=[...(optionsRef.current.skills??[]).filter(value=>skillKey(value)!==skillKey(skill)),skill];
      if(skills.length>8){showToast('最多选择 8 个技能','alert');return;}
      const next={...optionsRef.current,skills};optionsRef.current=next;setOptions(next);
    }
    replaceComposerText(applySlashCommand(text,slash,entry),slash.replaceStart+(entry.kind==='skills'?'/skills '.length:0));
    setSlashFocus({key:'',index:0});
  };
  const selectReference=(value:ContextReference)=>{
    try{const next={...optionsRef.current,contextReferences:appendContextReference(optionsRef.current.contextReferences??[],value)};optionsRef.current=next;setOptions(next);if(contextQuery)onText(text.slice(0,contextQuery.start)+text.slice(contextQuery.end));setReferenceOpen(false);setDismissed(text);onReferenceConsumed();}
    catch(reason){showToast(reason instanceof Error?reason.message:'引用不可用','alert');}
  };
  const togglePlan=()=>{
    const mode=(optionsRef.current.collaborationMode??session.collaborationMode)==='plan'?'default':'plan';
    if(!controlsLocked&&featureCatalogCurrent()&&features?.collaborationModes.includes(mode)){const next:TurnFeatures={...optionsRef.current,collaborationMode:mode};optionsRef.current=next;setOptions(next);}
  };
  const addToComposer=(value:string)=>{
    if(controlsLocked||!sourceCurrent())return;setPicker(null);
    if(value==='reference'&&profile.capabilities?.contextReferences)setReferenceOpen(true);
    if(value==='plan')togglePlan();
    if(value==='skills'&&featureCatalogCurrent()&&features?.skillsSupported){setDismissed('');const next=`${text}${text&&!/\s$/.test(text)?' ':''}/skills `;replaceComposerText(next,next.length);}
    if(value==='image'&&profile.capabilities?.imageInput&&!missingImages&&!reportsTextOnly(catalog?.modelCapabilities?.[effectiveModel]))void pickRemoteImages('gallery',4-images.length).then(next=>{services.guard();if(sourceCurrent()){setImages(current=>[...current,...next].slice(0,4));setImageCount(undefined);}}).catch(error=>showToast(error.message,'alert'));
  };
  const continueAvailable=Boolean(onContinue&&!running&&!text.trim()&&!images.length);
  const recoverSubmittedDraft=async(choice:'check'|'saved'|'current'='check')=>{
    const acknowledged=acceptedDraft.current,owner=draftSession.current,epoch=sourceEpoch.current.epoch;
    if(!acknowledged||acknowledged.source!==source||!owner||submitFlight.current||!services.isCurrent())return;
    submitFlight.current=true;setUploading(true);
    const current=()=>mounted.current&&sourceEpoch.current.epoch===epoch&&draftSession.current===owner&&services.isCurrent();
    try{
      const stored=await owner.restore();if(!current())return;
      const exact=stored?.revision===acknowledged.saved.revision&&stored?.identity===acknowledged.saved.identity;
      if(choice==='check'&&stored&&!exact){setRecovered(stored);setDraftError('消息已提交，但保存的草稿版本已变化。请选择剩余内容；已提交的部分会移除，不会重发。');return;}
      if(exact&&!await owner.consume(stored!))throw new Error('草稿版本再次变化，请重新读取并核对');
      if(!current())return;
      const visible={...draftValue.current,text:getLatestText?.()??draftValue.current.text};
      const remaining=remainingDraft(choice==='saved'&&stored?stored:visible,choice==='saved'?{...acknowledged.input,images:acknowledged.saved.images}:acknowledged.input);
      const saved=await owner.save(remaining);if(!current())return;
      acceptedDraft.current=undefined;setCleanupPending(false);applyDraft(saved);
    }catch(reason){if(current()){readyRef.current=false;setDraftReady(false);setDraftError(`消息已提交，草稿清理仍未完成：${reason instanceof Error?reason.message:'请重新读取并核对'}`);}}
    finally{if(sourceEpoch.current.epoch===epoch){submitFlight.current=false;if(mounted.current)setUploading(false);}}
  };
  useEffect(()=>{
    if(!imageAnnotationRef)return;
    const append:ImageAnnotationAppender=async(value,attached)=>{
      const owner=draftSession.current;
      const current=()=>sourceCurrent()&&services.isCurrent()&&draftSession.current===owner;
      if(!owner||!current()||!readyRef.current||submitFlight.current||locked)return false;
      if(!profile.capabilities?.imageInput||reportsTextOnly(catalog?.modelCapabilities?.[effectiveModel]))throw new Error('当前 Agent 或模型不支持图片输入，请切换后再添加批注');
      const before={...draftValue.current,text:getLatestText?.()??draftValue.current.text},next=appendImageAnnotation(before,value,attached);
      const operation={source};annotationFlight.current=operation;submitFlight.current=true;setUploading(true);
      try {
        const saved=await owner.save(next);if(!current())return false;
        const latest={...draftValue.current,text:getLatestText?.()??draftValue.current.text};
        if(draftSignature(before)!==draftSignature(latest)){await owner.save(latest);throw new Error('添加期间草稿已变化，请重试；原内容已保留');}
        applyDraft(saved);return true;
      } finally {if(annotationFlight.current===operation){annotationFlight.current=undefined;submitFlight.current=false;if(mounted.current)setUploading(false);}}
    };
    imageAnnotationRef.current=append;
    return()=>{if(imageAnnotationRef.current===append)imageAnnotationRef.current=undefined;};
  },[imageAnnotationRef,source,services,locked,effectiveModel,catalog,profile.capabilities?.imageInput]);
  useEffect(()=>{
    if(!filesAppenderRef)return;
    const append:ComposerFilesAppender=async(files)=>{
      const owner=draftSession.current;
      const current=()=>sourceCurrent()&&draftSession.current===owner;
      if(!owner||!current()||!readyRef.current||submitFlight.current||controlsLocked)return false;
      if(files.images.length&&(!profile.capabilities?.imageInput||reportsTextOnly(catalog?.modelCapabilities?.[effectiveModel])))throw new Error('当前 Agent 或模型不支持图片输入，请切换后再添加图片');
      const before={...draftValue.current,text:latestText.current?.()??draftValue.current.text},next=appendComposerFiles(before,files);
      const operation={source};annotationFlight.current=operation;submitFlight.current=true;setUploading(true);
      if(draftSaveTimer.current){clearTimeout(draftSaveTimer.current);draftSaveTimer.current=undefined;}
      try{
        const saved=await owner.save(next);if(!current())return false;
        const latest={...draftValue.current,text:latestText.current?.()??draftValue.current.text};
        if(draftSignature(before)!==draftSignature(latest)){await owner.save(latest);throw new Error('添加期间草稿已变化，请重试；原内容已保留');}
        applyDraft(saved);return true;
      }finally{if(annotationFlight.current===operation){annotationFlight.current=undefined;submitFlight.current=false;if(mounted.current)setUploading(false);}}
    };
    filesAppenderRef.current=append;
    return()=>{if(filesAppenderRef.current===append)filesAppenderRef.current=undefined;};
  },[filesAppenderRef,source,services,controlsLocked,effectiveModel,catalog,profile.capabilities?.imageInput]);
  useEffect(()=>{
    const restore:SentEditRestorer=async(value,operationId,policy)=>{
      const owner=draftSession.current,current=()=>sourceCurrent()&&draftSession.current===owner&&(!policy?.isCurrent||policy.isCurrent());
      if(!owner||!current()||!readyRef.current||submitFlight.current||locked||running&&!policy?.allowRunning)return false;
      const before={...draftValue.current,text:latestText.current?.()??draftValue.current.text};
      if(before.missingImages)throw new Error('请先处理当前草稿缺失的图片，修改备份仍保留');
      const operation={source};annotationFlight.current=operation;submitFlight.current=true;setUploading(true);
      if(draftSaveTimer.current){clearTimeout(draftSaveTimer.current);draftSaveTimer.current=undefined;}
      const restoring={source,previousMarker:''};
      try{
        const stored=await owner.restore();if(!current())return false;
        if(stored?.lastRestoredEdit===operationId)return true;
        const latest=()=>({...draftValue.current,text:latestText.current?.()??draftValue.current.text});
        if(draftSignature(before)!==draftSignature(latest()))throw new Error('恢复期间草稿已变化，原输入已保留，请重试');
        const merged=mergeSentEditRecovery({text:before.text,images:before.images,features:before.options},value,40000);
        const next={...before,text:merged.text,images:merged.images,imageCount:merged.images.length,missingImages:false,options:merged.features,lastRestoredEdit:operationId};
        restoring.previousMarker=stored?.lastRestoredEdit??'';editRestoreFlight.current=restoring;
        const saved=await owner.save(next);
        if(!current()){
          if(draftSession.current===owner&&mounted.current)await owner.save({...latest(),lastRestoredEdit:restoring.previousMarker});
          return false;
        }
        if(draftSignature(before)!==draftSignature(latest())){await owner.save({...latest(),lastRestoredEdit:stored?.lastRestoredEdit??''});throw new Error('恢复期间草稿已变化，原输入已保留，请重试');}
        draftValue.current={...next,images:saved.images};applyDraft(saved);return true;
      }finally{if(editRestoreFlight.current===restoring)editRestoreFlight.current=undefined;if(annotationFlight.current===operation){annotationFlight.current=undefined;submitFlight.current=false;if(mounted.current)setUploading(false);}}
    };
    if(editRestoreRef)editRestoreRef.current=restore;historyRestorer.current=restore;
    return()=>{if(editRestoreRef?.current===restore)editRestoreRef.current=undefined;if(historyRestorer.current===restore)historyRestorer.current=undefined;};
  },[editRestoreRef,source,services,locked,running]);
  const historyCurrent=useRef(history);historyCurrent.current=history;
  const restoreHistory=async(entry:PromptHistoryEntry,signal:AbortSignal)=>{
    const identity=promptHistoryIdentity(entry),restore=historyRestorer.current;
    const current=()=>!signal.aborted&&sourceCurrent()&&historyCurrent.current.some(item=>promptHistoryIdentity(item)===identity);
    if(!entry.message||!session.sessionKey||!restore||!current()||!canSend||locked)return false;
    requireHistoryCapabilities(entry,profile.capabilities);
    const value=await recoverDirectMessageDraft({pairing:runtime.scope,deviceId,sessionKey:session.sessionKey,message:entry.message,services,signal});
    if(!current())return false;
    return restore({text:value.text,images:value.images,features:value.options},randomUUID(),{allowRunning:true,isCurrent:current});
  };
  const recoverMessage=async()=>{
    const request=restoreRequest,owner=draftSession.current,epoch=sourceEpoch.current.epoch;
    if(!request||!owner||!draftReady||submitFlight.current||running||sending||uncertain||!canSend||!services.isCurrent())return;
    submitFlight.current=true;setRestoreBusy(true);setRestoreError('');
    const controller=new AbortController();restoreController.current=controller;
    const current=()=>mounted.current&&!controller.signal.aborted&&sourceEpoch.current.epoch===epoch&&draftSession.current===owner&&restoreRef.current?.id===request.id&&services.isCurrent();
    try{
      const recovered=await request.load(controller.signal);if(!current())return;
      const before={...draftValue.current,text:getLatestText?.()??draftValue.current.text};
      const next=appendRecoveredDirectDraft(before,recovered);
      const saved=await owner.save(next);if(!current())return;
      const latest={...draftValue.current,text:getLatestText?.()??draftValue.current.text};
      if(draftSignature(before)!==draftSignature(latest)){await owner.save(latest);throw new Error('恢复期间草稿已变化，原输入已保留，请重新恢复');}
      applyDraft(saved);onRestoreConsumed?.();
    }catch(reason){if(current())setRestoreError(reason instanceof Error?reason.message:'原消息恢复失败，图片引用已保留');}
    finally{if(restoreController.current===controller){restoreController.current=undefined;submitFlight.current=false;if(mounted.current)setRestoreBusy(false);}}
  };
  const submit=async(action:'send'|'continue'|'queue'='send')=>{
    if(!sourceCurrent()||textRef.current!==text||(getLatestText&&getLatestText()!==text))return;
    if(slash){if(slashEntries[slashIndex])selectSlashCommand(slashEntries[slashIndex]);return;}
    if(submitFlight.current||locked||!canSend||invalidFeatures||invalidPermission||missingImages)return;
    if(action==='continue'? !continueAvailable : !text.trim()&&!images.length)return;
    if(action==='queue'&&!onQueue||action==='send'&&running&&(!profile.capabilities?.steer||pendingTurnInputs))return;
    submitFlight.current=true;
    setUploading(true);
    const epoch=sourceEpoch.current.epoch,owner=draftSession.current;
    const input:DirectDraftInput={...draftValue.current,text:getLatestText?.()??draftValue.current.text,options:copyTurnFeatures(draftValue.current.options),images:draftValue.current.images.map(image=>({...image}))};
    const current=()=>mounted.current&&sourceEpoch.current.epoch===epoch&&draftSession.current===owner&&services.isCurrent();
    if(owner)activeSubmission.current={epoch,owner,input};
    try{
      services.guard();if(model&&(!catalog?.models.includes(model)||!canChooseModel))throw new Error('所选模型已不可用，请重新选择');
      if(effort&&!levels.includes(effort))throw new Error('所选推理级别已不可用');
      if(!owner)throw new Error('草稿尚未恢复');
      const saved=await owner.save(input);
      const attachments=action!=='queue'&&input.images.length?await services.uploadImages(await owner.hydrate(saved)):undefined;
      services.guard();
      const submission={owner:services.scope,inputText:input.text,...(!session.sessionKey&&saved.identity?{draftReceipt:{revision:saved.revision,identity:saved.identity}}:{}),...copyTurnFeatures(input.options),...(input.model?{model:input.model}:{}),...(input.effort?{effort:input.effort}:{}),...(attachments?.length?{attachments}:{}),...(input.permission?(profile.tool==='codex'?{permissionMode:input.permission as PermissionMode}:{approval:input.permission as ApprovalMode}):{})};
      const accepted=action==='queue'?await onQueue!(input):await (action==='continue'?onContinue!:onSend)(submission);
      if(accepted){
        if(current())acceptedDraft.current={source,input,saved};
        const consumed=await owner.consume(saved);
        if(!current())return;
        if(!consumed){readyRef.current=false;setDraftReady(false);setCleanupPending(true);setDraftError('消息已发送，但草稿版本已变化，请重新读取草稿后核对');return;}
        const remaining=remainingDraft({...draftValue.current,text:getLatestText?.()??draftValue.current.text},input);
        draftValue.current=remaining;textRef.current=remaining.text;onText(remaining.text);setImages(remaining.images);setImageCount(remaining.imageCount);setMissingImages(false);setOptions(remaining.options);
        await owner.save(remaining);
        if(!current())return;
        acceptedDraft.current=undefined;setCleanupPending(false);
      }
    }catch(reason){if(current()){
      if(acceptedDraft.current?.source===source){readyRef.current=false;setDraftReady(false);setCleanupPending(true);setRecovered(undefined);setDraftError(`消息已提交，草稿清理失败，请重新读取并核对；不会再次发送。${reason instanceof Error?` ${reason.message}`:''}`);}
      else showToast(reason instanceof Error?reason.message:'发送失败','alert');
    }}
    finally{if(sourceEpoch.current.epoch===epoch){activeSubmission.current=undefined;submitFlight.current=false;if(mounted.current)setUploading(false);}}
  };
  const recoverMissing=async()=>{
    const owner=draftSession.current,origin=draftOrigin,code=timeline.readErrorCode;
    if(!owner||!origin?.sessionKey||!code||!onRecoverMissingDraft||locked||submitFlight.current||!services.isCurrent()||!runtime.remote.devices.some(device=>device.deviceId===deviceId&&device.projects.some(project=>project.path===origin.cwd)))return false;
    const current=()=>mounted.current&&sourceEpoch.current.epoch===epoch&&sourceEpoch.current.source===source&&draftSession.current===owner&&services.isCurrent();
    submitFlight.current=true;setMissingRecoveryBusy(true);if(draftSaveTimer.current){clearTimeout(draftSaveTimer.current);draftSaveTimer.current=undefined;}
    const value={...draftValue.current,text:latestText.current?.()??draftValue.current.text},signature=draftSignature(value);
    const transferCurrent=()=>current()&&draftSignature({...draftValue.current,text:latestText.current?.()??draftValue.current.text})===signature;
    try{
      const saved=await owner.save(value);
      if(!transferCurrent())throw new Error('输入已变化，原草稿已保留，请重新恢复');
      const result=await copyMissingDirectComposerDraft({pairing:runtime.scope,deviceId,sourceOwner:services.scope,targetOwner:JSON.stringify([runtime.scope,deviceId,null,profile.id,profile.api.accountId??'',origin.cwd,workspaceMode]),
        origin,evidence:{kind:code,deviceId,sessionKey:origin.sessionKey},expectedRevision:saved.revision,expectedIdentity:saved.identity,
        isCurrent:transferCurrent});
      if(!transferCurrent()){await undoMissingComposerDraft(result.receipt).catch(()=>false);return false;}
      onRecoverMissingDraft(result.receipt);return true;
    }finally{submitFlight.current=false;if(current())setMissingRecoveryBusy(false);}
  };
  const undoRecovery=async()=>{
    const owner=draftSession.current,receipt=currentRecovery;
    if(!owner||!receipt||!unchangedRecovery||locked||submitFlight.current)return false;
    const sameOwner=()=>mounted.current&&sourceEpoch.current.epoch===epoch&&draftSession.current===owner&&services.isCurrent();
    const current=()=>sameOwner()&&recoveryBaseline.current?.receipt===receipt&&draftSignature(draftValue.current)===recoveryBaseline.current.signature;
    submitFlight.current=true;setMissingRecoveryBusy(true);if(draftSaveTimer.current){clearTimeout(draftSaveTimer.current);draftSaveTimer.current=undefined;}
    try{
      const removed=await undoMissingComposerDraft(receipt,current);if(!removed||!sameOwner())return false;
      await owner.restore();if(!sameOwner())return false;
      // Native input events already queued before the lock can arrive while
      // the tombstone is being written. Retain those edits under its new
      // revision instead of clearing the UI or leaving an unpersisted draft.
      if(!current()){await owner.save({...draftValue.current,text:latestText.current?.()??draftValue.current.text});return false;}
      const cleared:DirectDraftInput={text:'',options:{},model:'',effort:'',permission:'',images:[],imageCount:0,missingImages:false,...(draftOrigin?{origin:draftOrigin}:{})};
      draftValue.current=cleared;sourceDrafts.current.set(source,cleared);textRef.current='';onText('');setOptions({});setModel('');setEffort('');setPermission('');setImages([]);setImageCount(0);setMissingImages(false);recoveryBaseline.current=undefined;onRecoveryUndone?.();return true;
    }finally{submitFlight.current=false;if(mounted.current&&sourceEpoch.current.epoch===epoch)setMissingRecoveryBusy(false);}
  };
  const missingEvidence=timeline.readErrorCode&&session.sessionKey?{kind:timeline.readErrorCode,deviceId,sessionKey:session.sessionKey}:undefined;
  return <View style={[styles.composerWrap,tablet&&styles.tabletComposerWrap]}><MainComposerSurface>
    <MissingSessionDraftRecovery scopeKey={source} evidence={missingEvidence} restored={Boolean(currentRecovery)} hasDraft={Boolean(text||images.length||imageCount||options.skills?.length||options.contextReferences?.length||options.collaborationMode||currentRecovery)}
      disabled={locked||!services.isCurrent()} undoDisabled={!unchangedRecovery} onRestore={onRecoverMissingDraft?recoverMissing:undefined} onUndo={currentRecovery?undoRecovery:undefined}/>
    {restoreRequest?<View style={{padding:12,gap:7}}><Text style={{fontSize:12,color:d.text,fontWeight:'500'}}>恢复原消息 · {restoreRequest.attachments.length} 张图片</Text>
      <Text numberOfLines={2} style={{fontSize:12,color:d.muted}}>{restoreRequest.text||'图片消息'}</Text>
      {restoreError?<Text accessibilityRole="alert" style={{fontSize:12,color:d.warn}}>{restoreError}</Text>:<Text style={{fontSize:11,color:d.muted}}>{text.trim()||images.length?'当前草稿会保留，原消息完整恢复后追加到输入框。':'图片全部恢复后，才能重新发送。'}</Text>}
      <View style={{flexDirection:'row',gap:18}}><Pressable accessibilityRole="button" accessibilityLabel={text.trim()||images.length?'将原消息追加到草稿':'恢复原消息到输入框'} disabled={restoreBusy||!draftReady||!canSend} onPress={()=>void recoverMessage()}><Text style={{fontSize:12,color:d.text}}>{restoreBusy?'正在恢复…':text.trim()||images.length?'追加到草稿':'恢复原消息'}</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="取消恢复并保留当前草稿" onPress={()=>{restoreController.current?.abort();onRestoreConsumed?.();}}><Text style={{fontSize:12,color:d.muted}}>取消</Text></Pressable></View>
    </View>:null}
    <View style={{position:'absolute',bottom:'100%',left:0,right:0,marginBottom:6,zIndex:20}}>
      {slash?<SlashCommandMenu entries={slashEntries} selectedId={slashEntries[slashIndex]?.id} loading={featureLoading} error={featureError} disabled={controlsLocked||!canSend} sourceLabel={profile.name} onClose={closeSlash} onReload={reloadFeatures} onSelect={selectSlashCommand}/>:null}
      {(referenceOpen||contextQuery||reference)&&profile.capabilities?.contextReferences?<ContextReferencePicker deviceId={deviceId} sessionKey={session.sessionKey} tool={profile.tool} agentId={profile.id} cwd={session.cwd} scope={runtime.scope}
        query={contextQuery?.query??''} messages={timeline.items} sessions={session.sessionKey?runtime.remote.sessions[deviceId]?.list??[]:[]} filesAllowed={runtime.remote.devices.find(item=>item.deviceId===deviceId)?.capabilities?.includes(session.sessionKey?'workspace.files.v1':'workspace.project.files.v1')===true}
        initial={reference} onSelect={selectReference} onClose={()=>{setReferenceOpen(false);setDismissed(text);onReferenceConsumed();}}/>:null}
    </View>
    {(options.collaborationMode??session.collaborationMode)==='plan'?<Pressable accessibilityRole="button" accessibilityLabel="切换计划模式" accessibilityState={{selected:true}} disabled={controlsLocked} onPress={togglePlan} style={{alignSelf:'flex-start',flexDirection:'row',alignItems:'center',gap:5,paddingHorizontal:8,paddingVertical:5,borderRadius:7,backgroundColor:d.surface2,marginBottom:5}}><Icon name="listCheck" size={13} color={d.text2}/><Text style={{fontSize:12,color:d.text2}}>计划</Text><Icon name="close" size={11} color={d.muted}/></Pressable>:null}
    {options.skills?.length?<View style={{flexDirection:'row',flexWrap:'wrap',gap:8,paddingHorizontal:12,paddingVertical:5}}>{options.skills.map(skill=><Pressable key={skillKey(skill)} accessibilityRole="button" accessibilityLabel={`移除技能 ${skill.name}`} disabled={locked} onPress={()=>setOptions(current=>({...current,skills:current.skills?.filter(item=>skillKey(item)!==skillKey(skill))}))}><SkillReferenceLabel skill={skill}/></Pressable>)}</View>:null}
    {options.contextReferences?.length?<ContextReferenceChips references={options.contextReferences} onRemove={index=>setOptions(current=>({...current,contextReferences:current.contextReferences?.filter((_,i)=>i!==index)}))}/>:null}
    <DraftImageStrip scopeKey={source} images={images} disabled={locked} onRemove={index=>{if(sourceCurrent()){setImages(current=>current.filter((_,i)=>i!==index));setImageCount(undefined);}}}/>
    {missingImages?<View style={{padding:8}}><Text style={{color:d.warn,fontSize:11}}>草稿图片不可用，请重新选择全部图片。</Text><Pressable accessibilityLabel="移除失效的草稿图片" onPress={()=>{setImages([]);setImageCount(undefined);setMissingImages(false);}}><Text style={{color:d.text,fontSize:12}}>移除失效图片</Text></Pressable></View>:null}
    {draftError?<View style={{padding:8,gap:6}}><Text accessibilityRole="alert" style={{color:d.warn,fontSize:11}}>{draftError}</Text>{recovered?<View style={{flexDirection:'row',gap:16}}>
      <Pressable accessibilityLabel={cleanupPending?'恢复已保存的剩余草稿':'恢复已保存的草稿'} disabled={uploading} onPress={()=>{if(cleanupPending)void recoverSubmittedDraft('saved');else applyDraft(recovered);}}><Text style={{color:d.text,fontSize:12}}>{cleanupPending?'使用保存的剩余草稿':'恢复草稿'}</Text></Pressable>
      <Pressable accessibilityLabel={cleanupPending?'保留当前剩余输入':'保留当前输入'} disabled={uploading} onPress={()=>{if(cleanupPending)void recoverSubmittedDraft('current');else{setRecovered(undefined);setDraftError('');readyRef.current=true;setDraftReady(true);}}}><Text style={{color:d.text,fontSize:12}}>{cleanupPending?'保留当前剩余输入':'保留当前输入'}</Text></Pressable></View>
      :<Pressable accessibilityLabel="重新读取草稿" disabled={uploading} onPress={()=>{if(cleanupPending)void recoverSubmittedDraft();else setDraftRetry(value=>value+1);}}><Text style={{color:d.text,fontSize:12}}>{cleanupPending?'重新读取并核对':'重试'}</Text></Pressable>}</View>:null}
    {invalidFeatures?<Text style={{color:d.warn,fontSize:11,padding:8}}>所选技能或计划模式已不可用，请移除或重新选择。</Text>:null}
    {invalidPermission?<Text style={{color:d.warn,fontSize:11,padding:8}}>所选批准权限已不可用，请重新选择。</Text>:null}
    {running&&pendingTurnInputs&&!onQueue?<Text style={{color:d.muted,fontSize:11,padding:8}}>{pendingTurnOverrides
      ?'当前任务进行中，已选择的计划、模型、推理或权限不能用于补充指令。草稿已保留，请在本轮结束后发送。'
      :'技能、引用和图片已保留，请在本轮结束后发送。'}</Text>:null}
    <AttachmentComposerInput scopeKey={source} history={history} historyRef={historyRef} onRestoreHistory={restoreHistory} mentions={[]} ref={composerInput} accessibilityLabel="给电脑上的 Agent 发消息" multiline maxLength={40_000} value={text} onChangeText={editText} editable={canSend&&!locked} placeholder={running?(onQueue?'发送下一条消息…':'补充指令…'):`和 ${profile.name} 一起工作`} placeholderTextColor={d.muted}
      selection={forcedSelection?.source===source&&forcedSelection.text===text?{start:forcedSelection.start,end:forcedSelection.end}:undefined}
      onSelectionChange={event=>{
        if(!sourceCurrent()||textRef.current!==text)return;
        const next=event.nativeEvent.selection;
        slashOwner.current='';setInputSelection({source,text,start:next.start,end:next.end});
        if(forcedSelection&&next.start===forcedSelection.start&&next.end===forcedSelection.end)setForcedSelection(undefined);
      }}
      style={[styles.input,tablet&&styles.tabletInput]} onKeyPress={event=>{
        const native=event.nativeEvent as typeof event.nativeEvent&{shiftKey?:boolean;isComposing?:boolean};
        if(native.isComposing)return;
        if(slash){
          if(native.key==='Escape'){event.preventDefault?.();closeSlash();return;}
          if(native.key==='ArrowDown'||native.key==='ArrowUp'){
            event.preventDefault?.();
            if(sourceCurrent())setSlashFocus({key:slashKey,index:(slashIndex+(native.key==='ArrowDown'?1:-1)+slashEntries.length)%Math.max(1,slashEntries.length)});
            return;
          }
          if((native.key==='Enter'&&!native.shiftKey)||native.key==='Tab'){
            event.preventDefault?.();if(slashEntries[slashIndex])selectSlashCommand(slashEntries[slashIndex]);return;
          }
        }
        if(Platform.OS==='web'&&native.key==='Enter'&&!native.shiftKey&&!contextQuery){event.preventDefault?.();void submit(running&&onQueue?'queue':'send');}
      }}/>
    <MainComposerToolbar features={<>
      <Pressable ref={addAnchor} collapsable={false} accessibilityRole="button" accessibilityLabel="添加到对话" accessibilityState={{expanded:picker==='add'}} aria-expanded={picker==='add'} disabled={controlsLocked} onPress={()=>setPicker('add')} style={{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center'}}><Icon name="plus" size={18} color={d.muted}/></Pressable>
      {permissions.length?<MainComposerPermission anchorRef={permissionAnchor} label={permissionLabel(permission||session.permissionMode||session.approvalMode||'')} accessibilityLabel="选择批准权限" disabled={controlsLocked}
        danger={['full_access','auto_all'].includes(permission||session.permissionMode||session.approvalMode||'')} onPress={()=>setPicker('permission')}/>:null}
    </>} actions={<>
      <MainComposerModelGroup>
      {session.sessionKey&&profile.capabilities?.context?<ContextBar key={services.scope} ref={contextBar} deviceId={deviceId} sessionKey={session.sessionKey} scopeKey={services.scope} active={services.isCurrent()}
        signalVersion={`${timeline.contextSignal??0}|${session.status}|${session.activeTurnId??''}`} canCompact={profile.capabilities.compact===true} busy={sending||uploading||running||uncertain} transport={services.context} onBusyChange={setContextBusy}/>
        :<ContextIndicator key={source} scopeKey={source} active={services.isCurrent()} unavailableReason={session.sessionKey?'当前会话暂未提供上下文用量':'开始对话后显示上下文用量'}/>}
      <MainComposerModelButton anchorRef={modelAnchor} label={effectiveModel||'默认'} accessibilityLabel="选择模型" disabled={controlsLocked||!canChooseModel} onPress={()=>{setPicker('model');void loadModels();}}/>
      </MainComposerModelGroup>
      {levels.length?<MainEffortControl levels={['',...levels]} value={effort&&levels.includes(effort)?effort:''} scopeKey={`${source}|${effectiveModel}`} disabled={controlsLocked}
        open={picker==='effort'} onClose={()=>setPicker(current=>current==='effort'?null:current)}
        onSelect={value=>{if(!controlsLocked&&sourceCurrent()&&(!value||levels.includes(value)))setEffort(value);}}/>:null}
      {running&&profile.capabilities?.preciseInterrupt?(text.trim()||images.length
        ?<Pressable accessibilityRole="button" accessibilityLabel="停止当前任务" disabled={locked} onPress={onStop} style={{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center',opacity:locked?.4:1}}><Icon name="stop" size={16} color={d.muted}/></Pressable>
        :<MainComposerAction icon="stop" label="停止当前任务" disabled={locked} onPress={onStop}/>):null}
      {running&&onQueue&&profile.capabilities?.steer&&text.trim()&&!pendingTurnInputs?<Pressable accessibilityRole="button" accessibilityLabel="立即补充当前任务" disabled={locked||!canSend} onPress={()=>void submit('send')} style={{width:44,height:44,flexShrink:0,alignItems:'center',justifyContent:'center'}}><Icon name="chevronRight" size={17} color={d.muted}/></Pressable>:null}
      {running&&profile.capabilities?.preciseInterrupt&&!text.trim()&&!images.length?null:<MainComposerAction label={continueAvailable?'继续任务':running?(onQueue?'加入消息队列':'补充指令'):'发送'} disabled={slash?controlsLocked||!canSend||!slashEntries[slashIndex]||slashCommandDisabled(slashEntries[slashIndex],{loading:featureLoading,error:featureError}):locked||!canSend||missingImages||!continueAvailable&&!text.trim()&&!images.length||invalidFeatures||invalidPermission||running&&!onQueue&&(!profile.capabilities?.steer||pendingTurnInputs)} onPress={()=>void submit(continueAvailable?'continue':running&&onQueue?'queue':'send')}
        busy={uploading||sending} icon={continueAvailable?'chevronRight':running&&onQueue?'hourglass':'arrowUp'}/>}
    </>}/>
    <CompactActionMenu visible={picker==='add'} anchorRef={addAnchor} scopeKey={`${source}|${epoch}|${controlsLocked}`} label="添加到对话" testID="direct-add-menu" onClose={()=>setPicker(null)} actions={[
      ...(onPickFiles?[{id:'local-files',label:'添加本地文件',icon:'file' as const,disabled:controlsLocked,onPress:()=>{if(sourceCurrent()&&!controlsLocked){setPicker(null);onPickFiles();}}}]:[]),
      {id:'history',label:'最近输入',icon:'history' as const,disabled:controlsLocked||!history.length,onPress:()=>{if(sourceCurrent()&&!controlsLocked){setPicker(null);historyRef.current?.open();}}},
      ...(profile.capabilities?.imageInput?[{id:'image',label:'添加图片',icon:'image' as const,disabled:controlsLocked||missingImages||reportsTextOnly(catalog?.modelCapabilities?.[effectiveModel]),onPress:()=>addToComposer('image')}]:[]),
      ...(profile.capabilities?.contextReferences?[{id:'reference',label:'添加上下文引用',icon:'paperclip' as const,disabled:controlsLocked,onPress:()=>addToComposer('reference')}]:[]),
      ...(features?.collaborationModes.includes('plan')?[{id:'plan',label:'计划模式',icon:'listCheck' as const,disabled:controlsLocked,onPress:()=>addToComposer('plan')}]:[]),
      ...(features?.skillsSupported?[{id:'skills',label:'选择技能',icon:'sparkle' as const,disabled:controlsLocked,onPress:()=>addToComposer('skills')}]:[]),
    ]}/>
    {slashSessionCommand?.scope===source&&session.sessionKey&&services.sessionCommands?<SessionCommandPopover key={`${source}|${slashSessionCommand.command}`} visible={services.isCurrent()}
      anchorRef={modelAnchor} scopeKey={source} deviceId={deviceId} sessionKey={session.sessionKey} command={slashSessionCommand.command} transport={services.sessionCommands}
      onClose={()=>setSlashSessionCommand(undefined)} onFork={key=>{if(sourceCurrent())onOpenSession?.(key);}} onArchive={()=>{if(sourceCurrent())onArchive?.();}} onReviewStarted={()=>{if(sourceCurrent())onReviewStarted?.();}}/>:null}
    <ModelPopover visible={picker==='model'} anchor={null} anchorRef={modelAnchor} value={model} fallback={session.model||profile.api.model||''} models={catalog?.models??[]} loading={modelLoading} error={modelError}
      scopeKey={source} catalogOnly catalogReady={Boolean(catalog)&&!modelError} selectionEnabled={canChooseModel} interactionBlocked={controlsLocked}
      onRefresh={()=>void loadModels(true)} onClose={()=>setPicker(null)} onFollowComputer={()=>{if(sourceCurrent()&&!controlsLocked){const next=session.model||profile.api.model||'';onModelChange?.(modelRuntime.current.effectiveModel||'',next);retainModelEffort(next);setModel('');setPicker(null);}}}
      onSelect={value=>{if(sourceCurrent()&&!controlsLocked&&canChooseModel&&modelRuntime.current.catalog?.models.includes(value)){onModelChange?.(modelRuntime.current.effectiveModel||'',value);retainModelEffort(value);setModel(value);setPicker(null);}}}/>
    <ComposerOptionMenu visible={picker==='permission'} anchorRef={permissionAnchor} scopeKey={source} accessibilityLabel="批准权限" value={permission||session.permissionMode||session.approvalMode||''} onClose={()=>setPicker(null)}
      options={permissions.map(value=>({value,label:permissionLabel(value),icon:value==='auto_review'?'review':value==='full_access'||value==='auto_all'?'shield':'hand',danger:value==='full_access'||value==='auto_all',disabled:controlsLocked||!autoAll&&(value==='full_access'||value==='auto_all')}))}
      onSelect={value=>{if(sourceCurrent()&&!controlsLocked&&permissions.includes(value as PermissionMode|ApprovalMode)&&(autoAll||value!=='full_access'&&value!=='auto_all')){setPermission(value as typeof permission);setPicker(null);}}}/>
  </MainComposerSurface></View>;
}
