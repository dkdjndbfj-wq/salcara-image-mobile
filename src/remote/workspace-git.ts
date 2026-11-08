import { command, HubError, type AgentId, type Command } from './client';
import { getRemoteState, onRemoteChange, remoteDeliveryScope, timelineKey, watchCredentials } from './store';

export interface GitFile { path: string; original?: string; index: string; worktree: string }
export interface GitRepository {path:string;name:string;id:string}
export interface GitRepositories {repositories:GitRepository[];truncated:boolean}
export interface GitState { repository?:GitRepository;revision: string; branch: string; head: string; upstream: string; files: GitFile[]; branches: string[]; worktrees: {path:string;branch:string;managed:boolean}[]; githubCLI: boolean }
export type ReviewScope = 'unstaged'|'staged'|'branch'|'commit'|'last-turn';
export type GitReviewInput = { repositoryPath?:string;reviewScope: ReviewScope; reviewRef?: string; path?: string; sourceDiff?: string };
export interface GitReviewHunk { id:string;header:string;oldStart:number;oldCount:number;newStart:number;newCount:number }
export interface GitReviewFile { path:string;diff:string;patchRevision:string;additions:number;deletions:number;binary:boolean;reason?:string;hunks:GitReviewHunk[];added:boolean;deleted:boolean }
export interface GitReview { scope:ReviewScope;ref:string;base:string;state:GitState;files:GitReviewFile[];commits:{id:string;title:string}[] }
export type GitAction = 'stage'|'unstage'|'commit'|'branch'|'checkout'|'push'|'pr'|'worktree-create'|'worktree-remove'|'review-apply';
export type GitInput = { repositoryPath?:string;path?: string; branch?: string; message?: string; name?: string; title?: string; body?: string; reviewScope?:ReviewScope;reviewRef?:string;sourceDiff?:string;patchRevision?:string;hunk?:string;operation?:'stage'|'unstage'|'discard' };
export interface GitSelection { deviceId: string; agentId: AgentId; sessionKey: string; surface: 'cli'|'desktop'; cwd: string }
export interface WorkspaceGit {
  repositories?():Promise<GitRepositories>;
  status(repositoryPath?:string):Promise<GitState>;
  review(input:GitReviewInput):Promise<GitReview>;
  diff(path:string, staged:boolean,repositoryPath?:string):Promise<{path:string;diff:string;revision:string;repository?:GitRepository}>;
  mutate(action:GitAction, expectedRevision:string, input?:GitInput):Promise<{state:GitState;url?:string;path?:string}>;
  dispose():void;
}
const record = (value:unknown):Record<string,unknown> => { if(!value || typeof value !== 'object' || Array.isArray(value)) throw new HubError('Git 响应无效'); return value as Record<string,unknown>; };
const text = (value:unknown, max=8192):value is string => typeof value==='string' && value.length<=max && !/[\u0000-\u001f]/.test(value);
const revision = (value:unknown):value is string => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
export function validRepositoryPath(value:unknown):value is string {
  return text(value,4096)&&!/[\\:\p{Cc}\p{Cf}]/u.test(value)&&(value===''||value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..'&&part.toLowerCase()!=='.git'));
}
function parseRepository(value:unknown):GitRepository {
  const data=record(value);if(!validRepositoryPath(data.path)||!text(data.name,4096)||!data.name||!revision(data.id))throw new HubError('仓库身份无效');return data as unknown as GitRepository;
}
export function parseGitRepositories(value:unknown):GitRepositories {
  const data=record(value);if(!Array.isArray(data.repositories)||data.repositories.length>32||typeof data.truncated!=='boolean')throw new HubError('仓库列表无效');
  const paths=new Set<string>(),ids=new Set<string>();for(const value of data.repositories){const repo=parseRepository(value);if(paths.has(repo.path)||ids.has(repo.id))throw new HubError('仓库列表重复');paths.add(repo.path);ids.add(repo.id);}
  return data as unknown as GitRepositories;
}
function checkRepository(value:unknown,expected?:string):void {
  if(value!==undefined)parseRepository(value);
  if(expected!==undefined&&(value===undefined||parseRepository(value).path!==expected))throw new HubError('仓库响应来源不匹配');
}
export function parseGitState(value:unknown,repositoryPath?:string):GitState {
  const data=record(value);checkRepository(data.repository,repositoryPath);
  if(!revision(data.revision)||!text(data.branch)||!text(data.head)||!text(data.upstream)||typeof data.githubCLI!=='boolean'
    ||!Array.isArray(data.files)||data.files.length>1000||!Array.isArray(data.branches)||data.branches.length>10000||data.branches.some(item=>!text(item))
    ||!Array.isArray(data.worktrees)||data.worktrees.length>1000) throw new HubError('Git 状态无效');
  for(const file of data.files){const f=record(file);if(!text(f.path)||!text(f.index,1)||!text(f.worktree,1)||f.original!==undefined&&!text(f.original))throw new HubError('Git 文件状态无效');}
  for(const tree of data.worktrees){const t=record(tree);if(!text(t.path)||!text(t.branch)||typeof t.managed!=='boolean')throw new HubError('Git 工作树状态无效');}
  return data as unknown as GitState;
}
export function parseGitReview(value:unknown,input:GitReviewInput):GitReview {
  const data=record(value);parseGitState(data.state,input.repositoryPath);
  if(data.scope!==input.reviewScope||!text(data.ref)||!text(data.base)||!Array.isArray(data.files)||data.files.length>1000||!Array.isArray(data.commits)||data.commits.length>30)throw new HubError('审查响应无效');
  let bytes=0;const paths=new Set<string>();
  for(const raw of data.files){const file=record(raw);if(!text(file.path,4096)||paths.has(file.path)||typeof file.diff!=='string'||!revision(file.patchRevision)||!Number.isSafeInteger(file.additions)||Number(file.additions)<0||!Number.isSafeInteger(file.deletions)||Number(file.deletions)<0||typeof file.binary!=='boolean'||typeof file.added!=='boolean'||typeof file.deleted!=='boolean'||file.reason!==undefined&&!text(file.reason)||!Array.isArray(file.hunks)||file.hunks.length>10000)throw new HubError('审查文件无效');
    paths.add(file.path);bytes+=new TextEncoder().encode(file.diff).length;if(bytes>192*1024)throw new HubError('审查差异过大');
    const ids=new Set<string>();for(const rawHunk of file.hunks){const h=record(rawHunk);if(!revision(h.id)||ids.has(h.id)||!text(h.header)||!['oldStart','oldCount','newStart','newCount'].every(key=>Number.isSafeInteger(h[key])&&Number(h[key])>=0))throw new HubError('审查差异段无效');ids.add(h.id);}
  }
  if(input.reviewScope==='last-turn'&&(data.files.length!==1||(data.files[0] as GitReviewFile).path!==input.path||(data.files[0] as GitReviewFile).diff!==input.sourceDiff))throw new HubError('最近一轮审查来源不匹配');
  for(const item of data.commits){const commit=record(item);if(typeof commit.id!=='string'||! /^[a-f0-9]{40,64}$/.test(commit.id)||!text(commit.title))throw new HubError('提交记录无效');}
  return data as unknown as GitReview;
}
/** One in-flight operation and no automatic mutation retry. An uncertain
 * result must be reconciled with a fresh status before the user acts again. */
export function createWorkspaceGit(send:(type:'workspace.git.read'|'workspace.git.mutate',payload:Record<string,string>)=>Promise<unknown>, guard:()=>void, dispose:()=>void,options:{repositories?:boolean}={}):WorkspaceGit {
  let busy=false;
  const run=async<T,>(fn:()=>Promise<T>)=>{guard();if(busy)throw new HubError('Git 操作正在进行');busy=true;try{const result=await fn();guard();return result;}finally{busy=false;}};
  const scoped=(repositoryPath?:string):Record<string,string>=>{
    if(repositoryPath===undefined)return {};
    if(!options.repositories||!validRepositoryPath(repositoryPath))throw new HubError('仓库范围无效或电脑尚未开放多仓库审查');
    return {repositoryPath};
  };
  return {
    ...(options.repositories?{repositories:()=>run(async()=>parseGitRepositories(await send('workspace.git.read',{action:'repositories'})))}:{}),
    status:repositoryPath=>run(async()=>parseGitState(await send('workspace.git.read',{action:'status',...scoped(repositoryPath)}),repositoryPath)),
    review:input=>run(async()=>parseGitReview(await send('workspace.git.read',{action:'review',...input,...scoped(input.repositoryPath)}),input)),
    diff:(path,staged,repositoryPath)=>run(async()=>{const data=record(await send('workspace.git.read',{action:staged?'staged-diff':'diff',path,...scoped(repositoryPath)}));if(data.path!==path||typeof data.diff!=='string'||data.diff.length>1024*1024||!revision(data.revision))throw new HubError('Git 差异响应无效');checkRepository(data.repository,repositoryPath);return data as {path:string;diff:string;revision:string};}),
    mutate:(action,expectedRevision,input={})=>run(async()=>{
      if(!revision(expectedRevision))throw new HubError('请先刷新 Git 状态');
      const data=record(await send('workspace.git.mutate',{action,expectedRevision,...input,...scoped(input.repositoryPath)}));if(data.action!==action)throw new HubError('Git 操作结果无法确认，请刷新');
      if(data.url!==undefined&&(!text(data.url)||!/^https:\/\/[^/?#]+\/[^?#]+\/pull\/\d+$/.test(data.url)))throw new HubError('PR 结果无法确认，请在电脑核对');
      if(data.path!==undefined&&!text(data.path))throw new HubError('工作树结果无法确认');
      return {state:parseGitState(data.state,input.repositoryPath),...(data.url?{url:data.url as string}:{}),...(data.path?{path:data.path as string}:{})};
    }),dispose,
  };
}
export function captureWorkspaceGit(selection:GitSelection,onInvalidated?:()=>void):WorkspaceGit {
  const credentials=watchCredentials(),scope=remoteDeliveryScope(),controller=new AbortController();
  const owner=credentials?.pairToken?{...credentials,deviceId:selection.deviceId}:undefined;
  let disposed=false,invalidated=false;
  const valid=()=>{
    const state=getRemoteState(),now=watchCredentials(),directory=state.sessions[selection.deviceId];
    const session=state.timelines[timelineKey(selection.deviceId,selection.sessionKey)]?.session??(selection.surface==='desktop'?directory?.native?.list:directory?.list)?.find(row=>row.sessionKey===selection.sessionKey);
    const device=state.devices.find(row=>row.deviceId===selection.deviceId);
    if(disposed||invalidated||!owner||scope!==remoteDeliveryScope()||now?.url!==owner.url||now?.pairToken!==owner.pairToken||!device?.online||!device.capabilities?.includes('workspace.git.v1')||session?.cwd!==selection.cwd||session.controlSurface==='read-only'||(session.controlSurface==='desktop'?'desktop':'cli')!==selection.surface)return false;
    if(selection.surface==='desktop'){const lease=state.agents[selection.deviceId]?.list.find(row=>row.id===selection.agentId)?.desktopLive;return Boolean(lease&&lease.expiresAt>Date.now()&&lease.capabilities?.read&&lease.sessionKeys.includes(selection.sessionKey));}
    return true;
  };
  const guard=()=>{if(!valid())throw new HubError('电脑或项目授权已变化，请重新打开 Git',499,'workspace_scope_changed');};
  const unsubscribe=onRemoteChange(()=>{if(!disposed&&!invalidated&&!valid()){invalidated=true;controller.abort();onInvalidated?.();}});
  return createWorkspaceGit(async(type,payload)=>{guard();const checkReview=()=>{if((payload.action==='repositories'||payload.repositoryPath!==undefined)&&!getRemoteState().devices.find(row=>row.deviceId===selection.deviceId)?.capabilities?.includes('workspace.git.repositories.v1'))throw new HubError('电脑尚未开放多仓库审查，请更新电脑端');if((payload.action==='review'||payload.action==='review-apply')&&!getRemoteState().devices.find(row=>row.deviceId===selection.deviceId)?.capabilities?.includes('workspace.git.review.v1'))throw new HubError('电脑尚未开放统一审查，请更新电脑端');};checkReview();const result=await command(owner!,selection.deviceId,{type,sessionKey:selection.sessionKey,controlSurface:selection.surface,expectedCwd:selection.cwd,...payload} as Command,undefined,controller.signal);guard();checkReview();return result;},guard,()=>{disposed=true;controller.abort();unsubscribe();},{repositories:getRemoteState().devices.find(row=>row.deviceId===selection.deviceId)?.capabilities?.includes('workspace.git.repositories.v1')});
}
