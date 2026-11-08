jest.mock('../remote/store',()=>({}));
import {createWorkspaceGit,parseGitState,parseGitReview,parseGitRepositories,type GitState} from '../remote/workspace-git';

const state:GitState={revision:'a'.repeat(64),branch:'main',head:'f'.repeat(40),upstream:'origin/main',files:[{path:'main.ts',index:' ',worktree:'M'}],branches:['main'],worktrees:[],githubCLI:false};
test('Git response validation rejects malformed state and unsafe PR receipts',async()=>{
  expect(parseGitState(state)).toEqual(state);
  expect(()=>parseGitState({...state,revision:'stale'})).toThrow();
  expect(()=>parseGitState({...state,files:[{path:'line\nbreak',index:' ',worktree:'M'}]})).toThrow();
  const send=jest.fn(async()=>({state,action:'pr',url:'javascript:alert(1)'}));
  await expect(createWorkspaceGit(send,()=>{},()=>{}).mutate('pr',state.revision,{title:'title'})).rejects.toThrow();
});
test('mutation sends the exact reviewed revision and is never retried after uncertainty',async()=>{
  const send=jest.fn(async()=>{throw new Error('transport timeout');});
  const git=createWorkspaceGit(send,()=>{},()=>{});
  await expect(git.mutate('commit',state.revision,{message:'reviewed changes'})).rejects.toThrow('transport timeout');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('workspace.git.mutate',{action:'commit',expectedRevision:state.revision,message:'reviewed changes'});
});
test('a late result cannot cross into a replacement computer and operations cannot overlap',async()=>{
  let resolve!:(value:unknown)=>void,valid=true;
  const send=jest.fn(()=>new Promise<unknown>(done=>{resolve=done;}));
  const git=createWorkspaceGit(send,()=>{if(!valid)throw new Error('computer changed');},()=>{});
  const loading=git.status();await expect(git.mutate('stage',state.revision,{path:'main.ts'})).rejects.toThrow('正在进行');
  valid=false;resolve(state);await expect(loading).rejects.toThrow('computer changed');expect(send).toHaveBeenCalledTimes(1);
});
test('both index and working-tree differences use explicit read operations',async()=>{
  const send=jest.fn(async(_type:string,payload:Record<string,string>)=>({path:payload.path,diff:'+new',revision:state.revision}));
  const git=createWorkspaceGit(send,()=>{},()=>{});
  expect((await git.diff('main.ts',true)).diff).toBe('+new');await git.diff('main.ts',false);
  expect(send.mock.calls.map(call=>call[1].action)).toEqual(['staged-diff','diff']);
});
test('review replies retain exact scope and reject mismatched last-turn sources and malformed hunks',()=>{
  const file={path:'main.ts',diff:'@@ -1 +1 @@\n-old\n+new\n',patchRevision:'b'.repeat(64),additions:1,deletions:1,binary:false,added:false,deleted:false,hunks:[{id:'c'.repeat(64),header:'@@ -1 +1 @@',oldStart:1,oldCount:1,newStart:1,newCount:1}]};
  const review={scope:'last-turn',ref:'',base:'',state,files:[file],commits:[]};const input={reviewScope:'last-turn' as const,path:file.path,sourceDiff:file.diff};
  expect(parseGitReview(review,input)).toEqual(review);
  expect(()=>parseGitReview({...review,scope:'staged'},input)).toThrow();
  expect(()=>parseGitReview({...review,files:[{...file,path:'other.ts'}]},input)).toThrow();
  expect(()=>parseGitReview({...review,files:[{...file,hunks:[{...file.hunks[0],id:'arbitrary'}]}]},input)).toThrow();
});

const repositories=[{path:'desktop',name:'desktop',id:'d'.repeat(64)},{path:'mobile',name:'mobile',id:'e'.repeat(64)}];
test('repository discovery is capability gated and rejects escapes, duplicate identities and malformed bounds',async()=>{
  const send=jest.fn(async()=>({repositories,truncated:false}));
  expect(createWorkspaceGit(send,()=>{},()=>{}).repositories).toBeUndefined();
  await expect(createWorkspaceGit(send,()=>{},()=>{}).status('mobile')).rejects.toThrow('多仓库');expect(send).not.toHaveBeenCalled();
  const git=createWorkspaceGit(send,()=>{},()=>{},{repositories:true});
  expect(await git.repositories!()).toEqual({repositories,truncated:false});expect(send).toHaveBeenLastCalledWith('workspace.git.read',{action:'repositories'});
  for(const path of ['../outside','/outside','desktop/../mobile','desktop/.git','desktop\\child','C:/outside']){
    expect(()=>parseGitRepositories({repositories:[{...repositories[0],path}],truncated:false})).toThrow();
    await expect(git.status(path)).rejects.toThrow('仓库范围');
  }
  expect(()=>parseGitRepositories({repositories:[repositories[0],repositories[0]],truncated:false})).toThrow();
  expect(()=>parseGitRepositories({repositories,truncated:'false'})).toThrow();
});
test('scoped operations retain the exact repository and reject replies from a different repository',async()=>{
  const scopedState={...state,repository:repositories[1]};
  const send=jest.fn(async(_type:string,payload:Record<string,string>)=>payload.action==='status'?scopedState:payload.action==='diff'?{path:payload.path,diff:'+new',revision:state.revision,repository:repositories[1]}:{action:payload.action,state:scopedState});
  const git=createWorkspaceGit(send,()=>{},()=>{},{repositories:true});
  await git.status('mobile');await git.diff('main.ts',false,'mobile');await git.mutate('stage',state.revision,{path:'main.ts',repositoryPath:'mobile'});
  expect(send.mock.calls.every(call=>call[1].repositoryPath==='mobile')).toBe(true);
  expect(send).toHaveBeenLastCalledWith('workspace.git.mutate',{action:'stage',expectedRevision:state.revision,path:'main.ts',repositoryPath:'mobile'});
  await expect(git.status('desktop')).rejects.toThrow('来源不匹配');await expect(git.diff('main.ts',false,'desktop')).rejects.toThrow('来源不匹配');
  await expect(git.mutate('stage',state.revision,{path:'main.ts',repositoryPath:'desktop'})).rejects.toThrow('来源不匹配');
});
