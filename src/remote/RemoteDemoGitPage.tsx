import React,{useMemo} from 'react';
import {View} from 'react-native';
import {sha256} from '@noble/hashes/sha2.js';
import {RemoteReviewPage} from './RemoteReviewPage';
import {createWorkspaceGit,type GitState,type GitReviewFile,type ReviewScope} from './workspace-git';
import {parseDiffForAnnotations} from './diff-annotations';
import type {FileEdit} from './blocks';
import type {ContextReference} from './context-references';

const digest=(value:string)=>Array.from(sha256(new TextEncoder().encode(value)),byte=>byte.toString(16).padStart(2,'0')).join('');
const fallback:FileEdit[]=[{id:'demo-css',path:'src/auth/login.css',status:'done',add:1,del:1,diff:'@@ -1 +1 @@\n-gap: 8px;\n+gap: 16px;\n'},
  {id:'demo-component',path:'src/auth/LoginScreen.tsx',status:'done',add:1,del:1,diff:'@@ -1 +1 @@\n-const compact = true;\n+const compact = width < 720;\n'}];
function reviewFile(path:string,diff:string):GitReviewFile{
  const parsed=parseDiffForAnnotations(path,diff),parts=diff.split(/(?=^@@ )/m),prefix=parts[0].startsWith('@@ ')?'':parts.shift()??'';
  const hunks=parts.filter(part=>part.startsWith('@@ ')).map(part=>{const header=part.split('\n')[0],match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)!;return{id:digest(path+'\0'+prefix+part),header,oldStart:Number(match?.[1]??0),oldCount:Number(match?.[2]??1),newStart:Number(match?.[3]??0),newCount:Number(match?.[4]??1)};});
  return{path,diff,patchRevision:digest(path+'\0'+diff),hunks,additions:parsed.lines.filter(line=>line.raw.startsWith('+')&&line.newLine!==undefined).length,deletions:parsed.lines.filter(line=>line.raw.startsWith('-')&&line.oldLine!==undefined).length,binary:false,added:!parsed.oldPath,deleted:!parsed.newPath,...(parsed.error?{reason:parsed.error}:{})};
}
export function createDemoGitFactory(edits:FileEdit[]=fallback){
  let version=1;
  const working=new Map(edits.filter(file=>file.diff&&file.status==='done').map(file=>[file.path,file.diff!])),staged=new Map<string,string>(),committed=new Map<string,string>();
  let state:GitState={revision:'1'.padStart(64,'0'),branch:'feature/tablet',head:'a'.repeat(40),upstream:'',files:[],branches:['main','feature/tablet'],worktrees:[{path:'/example/project',branch:'feature/tablet',managed:false}],githubCLI:false};
  const snapshot=()=>({...state,files:[...new Set([...working.keys(),...staged.keys()])].map(path=>({path,index:staged.has(path)?'M':' ',worktree:working.has(path)?'M':' '}))});
  const partial=(patch:string,hunk:string)=>{const parts=patch.split(/(?=^@@ )/m),header=parts[0].startsWith('@@ ')?'':parts.shift()??'';return{header,parts:parts.filter(part=>part.startsWith('@@ ')),hunk};};
  const merge=(old:string|undefined,next:string)=>{if(!old)return next;const a=partial(old,''),b=partial(next,'');return(a.header||b.header)+[...a.parts,...b.parts].sort((left,right)=>Number(/^@@ -(\d+)/.exec(left)?.[1])-Number(/^@@ -(\d+)/.exec(right)?.[1])).join('');};
  const transfer=(path:string,source:Map<string,string>,target:Map<string,string>|undefined,hunk?:string)=>{
    const patch=source.get(path);if(!patch)throw new Error('示例差异已变化，请刷新');
    if(!hunk){source.delete(path);if(target)target.set(path,merge(target.get(path),patch));return;}
    const parsed=partial(patch,hunk),index=reviewFile(path,patch).hunks.findIndex(item=>item.id===hunk);if(index<0)throw new Error('示例差异段已变化');
    const selected=parsed.parts.splice(index,1)[0];if(parsed.parts.length)source.set(path,parsed.header+parsed.parts.join(''));else source.delete(path);
    if(target)target.set(path,merge(target.get(path),parsed.header+selected));
  };
  return()=>{
    let alive=true;
    return createWorkspaceGit(async(type,input)=>{
      if(type==='workspace.git.read'){
        if(input.action==='status')return snapshot();
        if(input.action==='diff'||input.action==='staged-diff')return{path:input.path,revision:state.revision,diff:(input.action==='diff'?working:staged).get(input.path)??''};
        const scope=input.reviewScope as ReviewScope;
        const files=scope==='last-turn'?[reviewFile(input.path,input.sourceDiff)]:[...(scope==='unstaged'?working:scope==='staged'?staged:committed)].map(([path,diff])=>reviewFile(path,diff));
        return{scope,ref:scope==='commit'||scope==='branch'?state.head:'',base:scope==='branch'?'a'.repeat(40):'',state:snapshot(),files,commits:[{id:state.head,title:version>1?'示例提交':'初始提交'}]};
      }
      if(input.expectedRevision!==state.revision)throw new Error('示例状态已变化，请刷新');
      switch(input.action){
        case 'review-apply':{
          if(!['unstaged','staged','last-turn'].includes(input.reviewScope))throw new Error('历史比较为只读');
          const source=input.reviewScope==='staged'?staged:input.reviewScope==='last-turn'&&input.operation==='unstage'?staged:working;
          const patch=input.reviewScope==='last-turn'?input.sourceDiff:source.get(input.path)??'';
          if(reviewFile(input.path,patch).patchRevision!==input.patchRevision)throw new Error('示例差异已变化');
          if(input.reviewScope==='last-turn'&&source.get(input.path)!==patch)throw new Error('最近一轮快照与当前示例状态不一致，请查看未暂存或已暂存范围');
          transfer(input.path,source,input.operation==='stage'?staged:input.operation==='unstage'?working:undefined,input.hunk);break;
        }
        case 'stage':transfer(input.path,working,staged);break;
        case 'unstage':transfer(input.path,staged,working);break;
        case 'commit':for(const [path,diff] of staged)committed.set(path,diff);staged.clear();state={...state,head:'b'.repeat(40)};break;
        case 'branch':if(state.branches.includes(input.branch))throw new Error('分支已存在');state={...state,branches:[...state.branches,input.branch]};break;
        case 'checkout':if(working.size||staged.size)throw new Error('请先处理未提交的改动');state={...state,branch:input.branch};break;
        case 'worktree-create':state={...state,branches:[...state.branches,input.branch],worktrees:[...state.worktrees,{path:`/example/project/.salcara-worktrees/${input.name}`,branch:input.branch,managed:true}]};break;
        case 'worktree-remove':state={...state,worktrees:state.worktrees.filter(tree=>tree.path!==input.path)};break;
        default:throw new Error('示例工作区不连接远程仓库');
      }
      state={...state,revision:(++version).toString(16).padStart(64,'0')};return{action:input.action,state:snapshot()};
    },()=>{if(!alive)throw new Error('示例已关闭');},()=>{alive=false;});
  };
}
export function RemoteDemoReviewPage({active=true,lastTurn,onReference,onCompose,onOpenFile,initialScope='unstaged'}:{active?:boolean;lastTurn?:FileEdit[];onReference?:(reference:ContextReference)=>boolean|void;onCompose?:(text:string)=>boolean|void;initialScope?:ReviewScope;onOpenFile?:(path:string)=>void}){
  const factory=useMemo(()=>createDemoGitFactory(lastTurn?.length?lastTurn:fallback),[]);
  return <View style={{flex:1,minHeight:0}}><RemoteReviewPage active={active} initialScope={initialScope} lastTurn={lastTurn} onReference={onReference} onCompose={onCompose} onOpenFile={onOpenFile} selection={{deviceId:'demo',agentId:'codex',sessionKey:'demo:git',surface:'cli',cwd:'/example/project'}} factory={factory}/></View>;
}
export const RemoteDemoGitPage=RemoteDemoReviewPage;
