import {ConversationDropZone,type ConversationFilesHandle} from './ConversationDropZone';
import type {ComposerFilesAppender} from './composer-files';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {useWindowDimensions} from 'react-native';
import type {AgentProfile,WorkspaceMode} from './client';
import {EMPTY_TIMELINE} from './store';
import {directConnectionGeneration} from './direct-pairing';
import {captureDirectProjectServices} from './direct-session-services';
import {DirectComposer,type DirectComposerSubmission} from './DirectComposer';
import {claudeApiAdmissionReady} from './api-admission';
import {agentSupports} from './projection';
import {WorkspaceRuntimeContext,type WorkspaceRuntime} from './WorkspaceRuntimeContext';
import type {ComposerDraftRecoveryReceipt} from './composer-drafts';
import type {RegisterBackAction} from './useBackAction';

export function DirectNewComposer({deviceId,profile,cwd,projectless=false,workspaceMode,runtime,sending,uncertain,onSend,recoveryReceipt,onRecoveryUndone,onRegisterBack}:{
  deviceId:string;profile:AgentProfile;cwd:string;projectless?:boolean;workspaceMode:WorkspaceMode;runtime:WorkspaceRuntime;sending:boolean;uncertain:boolean;
  onSend:(text:string,options:DirectComposerSubmission)=>Promise<boolean|undefined>;
  recoveryReceipt?:ComposerDraftRecoveryReceipt;onRecoveryUndone?:()=>void;
  onRegisterBack?:RegisterBackAction;
}){
  const filePicker=useRef<ConversationFilesHandle|undefined>(undefined),filesAppender=useRef<ComposerFilesAppender|undefined>(undefined);
  const [text,setText]=useState(''),mounted=useRef(true),remote=useRef(runtime.remote);remote.current=runtime.remote;
  const tablet=useWindowDimensions().width>=900;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const source=JSON.stringify([runtime.scope,directConnectionGeneration(),deviceId,profile.id,profile.api.accountId,cwd,workspaceMode,...(projectless?['projectless']:[])]);
  const sourceRef=useRef(source);sourceRef.current=source;
  const services=useMemo(()=>captureDirectProjectServices(deviceId,cwd,profile,()=>mounted.current&&sourceRef.current===source
    &&remote.current.devices.some(device=>device.deviceId===deviceId&&(projectless?device.capabilities?.includes('session.projectless.v1'):device.projects.some(project=>project.path===cwd))),workspaceMode,projectless),[source]);
  return <WorkspaceRuntimeContext.Provider value={runtime}><ConversationDropZone scopeKey={source} enabled={!sending&&!uncertain&&services.isCurrent()} importRef={filePicker} onFiles={files=>services.isCurrent()&&filesAppender.current?filesAppender.current(files):Promise.resolve(false)}><DirectComposer onRegisterBack={onRegisterBack} filesAppenderRef={filesAppender} onPickFiles={()=>filePicker.current?.pick()} key={services.scope} services={services} runtime={runtime} deviceId={deviceId} profile={profile} session={{cwd,...(projectless?{projectless:true as const}:{})}} workspaceMode={workspaceMode} recoveryReceipt={recoveryReceipt} onRecoveryUndone={onRecoveryUndone}
    timeline={EMPTY_TIMELINE} tablet={tablet} text={text} onText={setText} sending={sending} canSend={profile.available&&profile.remoteSendSupported&&agentSupports(profile,profile.id,'send')&&claudeApiAdmissionReady(profile)&&services.isCurrent()}
    uncertain={uncertain} onSend={options=>onSend(text,options)} onStop={()=>{}} onReferenceConsumed={()=>{}}/></ConversationDropZone></WorkspaceRuntimeContext.Provider>;
}
