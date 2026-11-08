import React,{useEffect,useRef,useState} from 'react';
import {ActivityIndicator,Pressable,ScrollView,StyleSheet,Text,TextInput,View} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {Icon,type IconName} from '../components/Icon';
import {AppDialog} from '../components/ui';
import {themed,useDesk} from '../theme';
import {captureWorkspaceGit,type GitInput,type GitRepository,type GitReview,type GitReviewFile,type GitReviewInput,type GitSelection,type ReviewScope,type WorkspaceGit} from './workspace-git';
import {useWorkspaceRuntime} from './WorkspaceRuntimeContext';
import {DiffAnnotationEditor} from './DiffAnnotationEditor';
import {parseDiffForAnnotations} from './diff-annotations';
import {RemoteGitPage} from './RemoteGitPage';
import type {ContextReference} from './context-references';
import type {FileEdit} from './blocks';
import {ToolbarButton} from './WorkbenchToolbar';

export interface RemoteReviewPageProps {
  selection:GitSelection;active:boolean;initialScope?:ReviewScope;initialRef?:string;lastTurn?:FileEdit[];
  readOnlyLastTurn?:boolean;
  onReference?:(reference:ContextReference)=>boolean|void;onCompose?:(text:string)=>boolean|void;
  onOpenFile?:(path:string)=>void;
  factory?:(selection:GitSelection,onInvalidated:()=>void)=>WorkspaceGit;
}
const scopes:Record<ReviewScope,string>={unstaged:'未暂存',staged:'已暂存',branch:'分支',commit:'提交','last-turn':'上一轮'};
const emptyEdits:FileEdit[]=[];
type RepositoryReview={repository?:GitRepository;review?:GitReview;error?:string};
const workspacePath=(repository:GitRepository|undefined,path:string)=>repository?.path?`${repository.path}/${path}`:path;
const repositoryLabel=(repository:GitRepository)=>repository.path||`${repository.name}（项目根目录）`;
// Only path metadata is rebased; hunk content remains the exact saved snapshot.
function repositoryLastTurn(file:FileEdit|undefined,repository?:GitRepository):Pick<GitReviewInput,'path'|'sourceDiff'> {
  const original=file?.path??'',path=repository?.path?original.slice(repository.path.length+1):original;
  let inHunk=false;
  const sourceDiff=(file?.diff??'').split('\n').map(line=>{if(line.startsWith('@@ '))inHunk=true;if(inHunk)return line;return line===`diff --git a/${original} b/${original}`?`diff --git a/${path} b/${path}`:line===`--- a/${original}`?`--- a/${path}`:line===`+++ b/${original}`?`+++ b/${path}`:line;}).join('\n');
  return {path,sourceDiff};
}
function scopedGit(git:WorkspaceGit,repositoryPath:string):WorkspaceGit {
  return {status:()=>git.status(repositoryPath),review:input=>git.review({...input,repositoryPath}),diff:(path,staged)=>git.diff(path,staged,repositoryPath),mutate:(action,revision,input)=>git.mutate(action,revision,{...input,repositoryPath}),dispose:()=>git.dispose()};
}
export function reviewCommentText(reference:ContextReference,review:GitReview):string {
  return ['请处理这条审查批注：',`文件：${reference.path}`,`审查范围：${scopes[review.scope]}${review.ref?` · ${review.ref}`:''}`,
    ...(review.state.repository?[`仓库：${review.state.repository.path||review.state.repository.name}`]:[]),`仓库版本：${review.state.revision}`,`差异快照：${reference.sourceRevision}`,`${reference.side==='old'?'旧':'新'}版本第 ${reference.startLine}–${reference.endLine} 行`,
    '所选代码（保存的审查快照，修改前请核对当前文件）：',JSON.stringify(reference.text),`评论：${reference.annotation?.trim()||'请检查这段改动。'}`].join('\n');
}

/** Live Hub, Direct and explicit demo factories share this review surface. */
export function RemoteReviewPage({selection,active,initialScope='unstaged',initialRef='',lastTurn=emptyEdits,readOnlyLastTurn=false,onReference,onCompose,onOpenFile,factory}:RemoteReviewPageProps){
  const [panelWidth,setPanelWidth]=useState(0),wide=panelWidth>=600;
  const styles=useStyles()[wide?'wide':'compact'],dk=useDesk(),runtime=useWorkspaceRuntime();
  const identity=JSON.stringify([selection,runtime?.scope,readOnlyLastTurn]);
  const [scope,setScope]=useState<ReviewScope>(readOnlyLastTurn?'last-turn':initialScope),[ref,setRef]=useState(initialRef),[refDraft,setRefDraft]=useState(initialRef),[menu,setMenu]=useState(false);
  const [groups,setGroups]=useState<RepositoryReview[]>([]),[repositories,setRepositories]=useState<GitRepository[]|null>(null),[truncated,setTruncated]=useState(false);
  const [review,setReview]=useState<GitReview|null>(null),[selectedPath,setSelectedPath]=useState(''),[selectedEdit,setSelectedEdit]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[valid,setValid]=useState(false),[reload,setReload]=useState(0),[manage,setManage]=useState(false);
  const [confirmation,setConfirmation]=useState<{input:GitInput;revision:string;path:string}|null>(null);
  const [expandedKey,setExpandedKey]=useState<string|null>(null),[more,setMore]=useState(false),[find,setFind]=useState(false),[query,setQuery]=useState('');
  const [actionMenu,setActionMenu]=useState<{key:string;hunk?:string}|null>(null);
  const owner=useRef<WorkspaceGit|null>(null),epoch=useRef(0),queue=useRef(Promise.resolve()),viewKey=useRef(''),activeRef=useRef(active);
  const editRows=lastTurn.map((file,index)=>({file,key:`${file.id}:${index}`}));
  const lastRow=editRows.find(row=>row.key===selectedEdit)??editRows[editRows.length-1];
  const lastFile=lastRow?.file,lastPath=lastFile?.path??'';
  const requestKey=JSON.stringify([identity,scope,ref,scope==='last-turn'?[lastFile?.path,lastFile?.diff,lastFile?.status]:null]);
  viewKey.current=requestKey;activeRef.current=active;
  useEffect(()=>{setScope(readOnlyLastTurn?'last-turn':initialScope);setRef(initialRef);setRefDraft(initialRef);setSelectedPath('');setSelectedEdit('');setReview(null);setGroups([]);setRepositories(null);setTruncated(false);setConfirmation(null);setValid(false);setManage(false);setExpandedKey(null);setActionMenu(null);setMore(false);setMenu(false);setFind(false);setQuery('');},[identity,initialScope,initialRef]);
  useEffect(()=>{
    const current=++epoch.current;
    if(readOnlyLastTurn)return()=>{epoch.current++;};
    const invalidate=()=>{if(epoch.current===current){setValid(false);setError('电脑或会话授权已变化，请重新打开审查。');setConfirmation(null);}};
    owner.current=factory?factory(selection,invalidate):runtime?runtime.captureGit?.(selection,invalidate)??null:captureWorkspaceGit(selection,invalidate);
    if(!owner.current)setError('当前连接尚未开放审查操作');
    return()=>{epoch.current++;owner.current?.dispose();owner.current=null;};
  },[identity]);
  const readInput=(repository=review?.state.repository):GitReviewInput=>({reviewScope:scope,...(repository?{repositoryPath:repository.path}:{}),...((scope==='branch'||scope==='commit')&&ref?{reviewRef:ref}:{}),...(scope==='last-turn'?repositoryLastTurn(lastFile,repository):{})});
  const schedule=(job:(git:WorkspaceGit)=>Promise<void>,mutating=false)=>{
    const git=owner.current,token=epoch.current,key=requestKey;if(!git||mutating&&busy)return;
    setBusy(true);setError('');
    queue.current=queue.current.catch(()=>{}).then(async()=>{
      if(token!==epoch.current||key!==viewKey.current||!activeRef.current)return;
      try{await job(git);}catch(reason){if(token===epoch.current&&key===viewKey.current){setValid(false);setError(reason instanceof Error?reason.message:'操作未完成，请刷新核对实际状态。');}}
      finally{if(token===epoch.current&&key===viewKey.current)setBusy(false);}
    });
  };
  const accept=(value:GitReview,key=requestKey,token=epoch.current)=>{if(key!==viewKey.current||token!==epoch.current)return;setReview(value);setGroups(current=>current.map(group=>group.repository?.path===value.state.repository?.path?{...group,review:value,error:undefined}:group));setValid(true);setError('');setSelectedPath(path=>value.files.some(file=>file.path===path)?path:value.files[0]?.path??'');};
  useEffect(()=>{
    if(!active||manage)return;setValid(false);setConfirmation(null);setNotice('');
    if(readOnlyLastTurn){setBusy(false);setError('');setValid(lastFile?.status==='done'&&Boolean(lastFile.diff));return;}
    const key=requestKey,token=epoch.current;
    schedule(async git=>{
      const discovery=git.repositories?await git.repositories():null;
      if(token!==epoch.current||key!==viewKey.current)return;
      setRepositories(discovery?.repositories??null);setTruncated(discovery?.truncated??false);
      if(scope==='last-turn'){
        if(!lastFile){if(!discovery)await git.status();setReview(null);setGroups([]);setValid(true);return;}
        if(lastFile.status!=='done'||!lastFile.diff)throw new Error('这项改动尚未完成或没有完整差异，请等待电脑返回结果。');
        const repository=discovery?.repositories.filter(repo=>repo.path===''||lastPath.startsWith(repo.path+'/')).sort((a,b)=>b.path.length-a.path.length)[0];
        if(discovery&&!repository){setReview(null);setGroups([]);setValid(true);setNotice('这项改动不在已发现的仓库内，保留原始快照供批注。');return;}
        const value=await git.review(readInput(repository));if(repository&&value.state.repository?.id!==repository.id)throw new Error('仓库身份已变化，请刷新');accept(value,key,token);return;
      }
      const result:RepositoryReview[]=[];
      for(const repository of discovery?.repositories??[undefined]){
        if(token!==epoch.current||key!==viewKey.current||!activeRef.current)return;
        try{const value=await git.review(readInput(repository));if(repository&&value.state.repository?.id!==repository.id)throw new Error('仓库身份已变化，请刷新');result.push({repository,review:value});}
        catch(reason){result.push({repository,error:reason instanceof Error?reason.message:'仓库审查读取失败'});}
      }
      if(token!==epoch.current||key!==viewKey.current)return;
      setGroups(result);const preferred=result.find(group=>group.repository?.path===review?.state.repository?.path&&group.review)??result.find(group=>group.review);
      if(preferred?.review)accept(preferred.review,key,token);else{setReview(null);setValid(true);}
      if(!discovery&&result[0]?.error)throw new Error(result[0].error);
    });
  },[active,requestKey,reload,manage]);
  const localSelected:GitReviewFile|undefined=scope==='last-turn'&&lastFile&&(readOnlyLastTurn||review?.scope!=='last-turn'||review.files[0]?.diff!==repositoryLastTurn(lastFile,review.state.repository).sourceDiff)?{path:lastFile.path,diff:lastFile.diff??'',patchRevision:parseDiffForAnnotations(lastFile.path,lastFile.diff??'').revision,additions:lastFile.add,deletions:lastFile.del,binary:false,added:false,deleted:false,hunks:[]}:undefined;
  const selected=localSelected??(review?.scope===scope?review.files.find(file=>file.path===selectedPath)??review.files[0]:undefined);
  const canWrite=!readOnlyLastTurn&&active&&valid&&!busy&&!manage&&Boolean(review),historical=scope==='branch'||scope==='commit';
  const execute=(input:GitInput,revision=review?.state.revision)=>{
    if(!canWrite||!revision)return;const key=requestKey,token=epoch.current;
    schedule(async git=>{
      await git.mutate('review-apply',revision,input);
      if(token!==epoch.current||key!==viewKey.current)return;
      setNotice(input.operation==='stage'?'所选改动已暂存':input.operation==='unstage'?'所选改动已取消暂存':'所选改动已撤销');
      accept(await git.review({reviewScope:input.reviewScope??scope,...(input.repositoryPath!==undefined?{repositoryPath:input.repositoryPath}:{}),...(scope==='last-turn'?{path:input.path,sourceDiff:input.sourceDiff}:{})}),key,token);
    },true);
  };
  const change=(operation:'stage'|'unstage'|'discard',file:GitReviewFile,hunk?:string,source=review)=>{
    if(!canWrite||historical||!source)return;
    const input:GitInput={reviewScope:scope,...(source.state.repository?{repositoryPath:source.state.repository.path}:{}),path:file.path,patchRevision:file.patchRevision,operation,...(hunk?{hunk}:{}),...(scope==='last-turn'?{sourceDiff:file.diff}:{})};
    if(operation==='discard')setConfirmation({input,revision:source.state.revision,path:workspacePath(source.state.repository,file.path)});else execute(input,source.state.revision);
  };
  const button=(label:string,onPress:()=>void,disabled=false)=><Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled||busy||!active} style={[styles.menuItem,(disabled||busy||!active)&&styles.disabled]}><Text style={styles.menuText}>{label}</Text></Pressable>;
  const iconButton=(label:string,icon:IconName,onPress:()=>void,disabled=false)=><ToolbarButton label={label} icon={icon} disabled={disabled||!active} onPress={onPress} color={dk.muted}/>;
  const mutationButtons=(file:GitReviewFile,hunk?:string,source=review)=>historical||readOnlyLastTurn?null:<>
    {scope!=='staged'?button(hunk?'暂存此段':'暂存文件',()=>{setActionMenu(null);change('stage',file,hunk,source);},!canWrite||Boolean(hunk&&file.reason)):null}
    {scope!=='unstaged'?button(hunk?'取消暂存此段':'取消暂存文件',()=>{setActionMenu(null);change('unstage',file,hunk,source);},!canWrite||Boolean(hunk&&file.reason)):null}
    {button(hunk?'撤销此段':'撤销文件',()=>{setActionMenu(null);change('discard',file,hunk,source);},!canWrite||Boolean(file.reason)||!file.hunks.length)}
  </>;
  const addReference=(reference:ContextReference,source=review)=>{
    if(!active||!valid)return false;
    if(scope==='last-turn'){if(!onReference)return false;return onReference(reference)!==false;}
    if(!onCompose||!source)return false;return onCompose(reviewCommentText(reference,source))!==false;
  };
  const rows=scope==='last-turn'?editRows.map(({file,key},index)=>({key,path:file.path,relativePath:file.path,repository:undefined as GitRepository|undefined,review:undefined as GitReview|undefined,title:lastTurn.filter(item=>item.path===file.path).length>1?`${file.path} · 改动 ${index+1}`:file.path,additions:file.add,deletions:file.del}))
    :groups.flatMap(group=>group.review?.scope===scope?group.review.files.map(file=>({...file,key:JSON.stringify([group.repository?.path,file.path]),path:workspacePath(group.repository,file.path),relativePath:file.path,title:workspacePath(group.repository,file.path),repository:group.repository,review:group.review})):[]);
  const groupTotals=(group:RepositoryReview)=>({additions:group.review?.files.reduce((sum,file)=>sum+file.additions,0)??0,deletions:group.review?.files.reduce((sum,file)=>sum+file.deletions,0)??0});
  const additions=rows.reduce((sum,file)=>sum+file.additions,0),deletions=rows.reduce((sum,file)=>sum+file.deletions,0);
  const copy=(value:string)=>{void Clipboard.setStringAsync(value).then(()=>setNotice('已复制')).catch(()=>setError('复制失败，请重试。'));};
  const selectRow=(file:typeof rows[number])=>{if(scope==='last-turn')setSelectedEdit(file.key);else {setSelectedPath(file.relativePath);if(file.review)setReview(file.review);}};
  const managementFactory=(next:GitSelection,invalidate:()=>void)=>{const git=factory?factory(next,invalidate):runtime?.captureGit?runtime.captureGit(next,invalidate):captureWorkspaceGit(next,invalidate);return review?.state.repository?scopedGit(git,review.state.repository.path):git;};
  const scopeOptions=<View style={styles.scopeMenu}>{(Object.keys(scopes) as ReviewScope[]).map(value=><Pressable key={value} accessibilityRole="button" accessibilityLabel={`审查${scopes[value]}`} accessibilityState={{selected:scope===value}} onPress={()=>{setScope(value);setSelectedPath('');setExpandedKey(null);setActionMenu(null);setMenu(false);setManage(false);}} style={[styles.scopeOption,scope===value&&styles.chosen]}><Text style={styles.scopeText}>{scopes[value]}</Text>{scope===value?<Icon name="check" size={14} color={dk.text} accent={dk.text}/>:null}</Pressable>)}</View>;
  return <View style={styles.root} testID="workspace-review" onLayout={event=>setPanelWidth(event.nativeEvent.layout.width)}>
    <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel="选择审查范围" disabled={readOnlyLastTurn||!active} accessibilityState={{expanded:menu,disabled:readOnlyLastTurn||!active}} onPress={()=>{setMenu(value=>!value);setMore(false);setActionMenu(null);}} style={styles.scope}>
      <Text numberOfLines={1} style={[styles.scopeText,styles.scopeLabel]}>{scopes[scope]}</Text>{!readOnlyLastTurn?<Icon name="chevronDown" size={wide?16:14} color={dk.text} accent={dk.text}/>:null}<Text numberOfLines={1} style={[styles.additions,styles.scopeCount]}>+{additions}</Text><Text numberOfLines={1} style={[styles.deletions,styles.scopeCount]}>-{deletions}</Text>
    </Pressable><View style={styles.grow}/>{busy?<ActivityIndicator size="small" color={dk.muted}/>:null}<View style={styles.tools}>
      {iconButton('审查更多操作','more',()=>{setMore(value=>!value);setMenu(false);setActionMenu(null);})}
      {iconButton('查找审查文件','search',()=>setFind(value=>!value))}
      {iconButton('复制全部差异','copy',()=>copy(scope==='last-turn'?lastTurn.map(file=>`${file.path}\n${file.diff??''}`).join('\n\n'):groups.flatMap(group=>group.review?.files.map(file=>`${workspacePath(group.repository,file.path)}\n${file.diff}`)??[]).join('\n\n')),!rows.length)}
    </View></View>
    {menu?scopeOptions:null}
    {more?<View style={styles.topMenu}>
      {button('刷新审查',()=>{setMore(false);setReload(value=>value+1);})}
      {button('折叠全部文件',()=>{setMore(false);setExpandedKey(null);setActionMenu(null);})}
      {!readOnlyLastTurn?button(manage?'返回差异':'提交与仓库',()=>{setMore(false);setManage(value=>!value);setConfirmation(null);},!review||busy):<Text style={styles.menuHint}>当前电脑仅支持上一轮快照，批注能力以会话授权为准。</Text>}
    </View>:null}
    {find?<View style={styles.find}><Icon name="search" size={15} color={dk.muted} accent={dk.muted}/><TextInput accessibilityLabel="查找变更文件" value={query} onChangeText={setQuery} placeholder="查找文件" placeholderTextColor={dk.muted} autoCapitalize="none" style={[styles.input,styles.grow]}/>{iconButton('关闭文件查找','close',()=>{setFind(false);setQuery('');})}</View>:null}
    {scope==='branch'||scope==='commit'?<View style={styles.refArea}><View style={styles.row}><TextInput accessibilityLabel={scope==='branch'?'比较分支':'查看提交'} value={refDraft} onChangeText={setRefDraft} placeholder={scope==='branch'?'比较分支，如 main':'提交哈希或 HEAD'} placeholderTextColor={dk.muted} style={[styles.input,styles.grow]}/>{button('查看比较',()=>{setRef(refDraft.trim());setReload(value=>value+1);})}</View><ScrollView horizontal contentContainerStyle={styles.row}>{(scope==='branch'?review?.state.branches.map(value=>({id:value,title:value})):review?.commits)?.map(item=><Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`比较 ${item.id}`} onPress={()=>{setRef(item.id);setRefDraft(item.id);}} style={styles.refChip}><Text numberOfLines={1} style={styles.muted}>{scope==='commit'?`${item.id.slice(0,7)} ${item.title}`:item.title}</Text></Pressable>)}</ScrollView></View>:null}
    {error?<Text accessibilityRole="alert" style={styles.error}>{error}{'\n'}原审查内容仍保留，请刷新后再操作。</Text>:notice?<Text style={styles.notice}>{notice}</Text>:null}
    {truncated?<Text style={styles.notice}>已显示扫描范围内的仓库；部分目录未能扫描，请在电脑检查。</Text>:null}
    {repositories&&scope!=='last-turn'?<ScrollView horizontal style={styles.repositoryStrip} contentContainerStyle={styles.repositoryChoices}>{repositories.map(repository=><Pressable key={repository.id} accessibilityRole="button" accessibilityLabel={`选择仓库 ${repositoryLabel(repository)}`} accessibilityState={{selected:review?.state.repository?.path===repository.path}} onPress={()=>{const group=groups.find(item=>item.repository?.id===repository.id);if(group?.review){setReview(group.review);setSelectedPath(group.review.files[0]?.path??'');setExpandedKey(null);setActionMenu(null);setConfirmation(null);}}} disabled={busy||!active} style={[styles.repositoryChip,review?.state.repository?.path===repository.path&&styles.chosen]}><Text style={styles.muted}>{repositoryLabel(repository)}</Text></Pressable>)}</ScrollView>:null}
    {manage&&review?<View style={styles.grow}><Text style={styles.notice}>仓库：{review.state.repository?.path||review.state.repository?.name||selection.cwd}</Text><RemoteGitPage key={review.state.repository?.id??'legacy'} selection={selection} active={active} factory={managementFactory}/></View>:<ScrollView style={styles.files} contentContainerStyle={styles.fileList} keyboardShouldPersistTaps="handled">
      {groups.filter(group=>scope!=='last-turn'&&(group.error||group.review?.scope===scope&&!group.review.files.length)).map(group=><View key={group.repository?.id??'legacy'} style={styles.repositoryHeader}><Text numberOfLines={2} ellipsizeMode="middle" style={[styles.scopeText,styles.repositoryTitle]}>{group.repository?repositoryLabel(group.repository):'当前仓库'}</Text><Text accessibilityRole={group.error?'alert':undefined} style={group.error?styles.error:styles.muted}>{group.error||'此范围没有改动'}</Text></View>)}
      {rows.filter(file=>file.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((file,index,visibleRows)=>{
        const opened=expandedKey===file.key;
        const currentFile=scope==='last-turn'?lastRow?.key===file.key?selected:undefined:file.review?.files.find(item=>item.path===file.relativePath);
        const actions=actionMenu?.key===file.key,ext=file.path.split('.').pop()?.toLowerCase()??'';
        const badge=['js','jsx'].includes(ext)?'JS':['ts','tsx'].includes(ext)?'TS':ext==='md'?'M↓':null;
        const group=groups.find(item=>item.repository?.id===file.repository?.id),totals=group?groupTotals(group):null;
        return <View key={file.key}>
          {file.repository&&(index===0||visibleRows[index-1].repository?.id!==file.repository.id)?<View style={styles.repositoryHeader}><Text numberOfLines={2} ellipsizeMode="middle" style={[styles.scopeText,styles.repositoryTitle]}>{repositoryLabel(file.repository)}</Text><View style={styles.stats}><Text style={styles.additions}>+{totals?.additions??0}</Text><Text style={styles.deletions}>-{totals?.deletions??0}</Text></View></View>:null}
          <View style={styles.fileRow}>
            <Pressable accessibilityRole="button" accessibilityLabel={`审查文件 ${file.title}`} accessibilityState={{expanded:opened}} onPress={()=>{selectRow(file);setExpandedKey(opened?null:file.key);setActionMenu(null);}} style={styles.fileSelect}>
              {badge?<Text style={[styles.badge,ext==='md'?styles.markdownBadge:['js','jsx'].includes(ext)?styles.javascriptBadge:styles.typescriptBadge]}>{badge}</Text>:<Icon name="file" size={16} color={dk.muted} accent={dk.muted}/>}<Text numberOfLines={1} ellipsizeMode="middle" style={styles.fileName}>{file.title}</Text>
            </Pressable>
            <View style={styles.stats}><Text style={styles.additions}>+{file.additions}</Text><Text style={styles.deletions}>-{file.deletions}</Text></View>
            {iconButton(`打开文件 ${file.path}`,'newTab',()=>onOpenFile?.(file.path),!onOpenFile)}
            {iconButton(`文件操作 ${file.title}`,'more',()=>{selectRow(file);setActionMenu(actions?null:{key:file.key});setMore(false);})}
          </View>
          {actions?<View style={styles.fileMenu}>
            {!actionMenu?.hunk?button('复制文件路径',()=>{setActionMenu(null);copy(file.path);}):null}
            {currentFile?<>{!actionMenu?.hunk?button('复制文件差异',()=>{setActionMenu(null);copy(scope==='last-turn'?lastFile?.diff??currentFile.diff:currentFile.diff);}):null}{mutationButtons(currentFile,actionMenu?.hunk,file.review??review)}{currentFile.reason?<Text style={styles.menuHint}>{currentFile.reason}</Text>:null}</>:null}
            {button('关闭操作菜单',()=>setActionMenu(null))}
          </View>:null}
          {opened&&currentFile?<DiffAnnotationEditor presentation="inline" key={`${scope}:${file.key}:${currentFile.patchRevision}`} path={file.path} diff={scope==='last-turn'?lastFile?.diff??currentFile.diff:currentFile.diff} sessionKey={selection.sessionKey} onAdd={reference=>addReference(reference,file.review??review)}
            renderHunkMenu={index=>!historical&&!readOnlyLastTurn&&currentFile.hunks[index]?iconButton(`差异段操作 ${index+1}`,'more',()=>{selectRow(file);setActionMenu({key:file.key,hunk:currentFile.hunks[index].id});}):null}
            unavailableReason={!valid?'审查版本待重新核对':scope==='last-turn'?!onReference?'当前任务暂不支持添加批注':undefined:!onCompose?'当前任务暂不支持添加批注':undefined}/>:null}
        </View>;
      })}
      {!rows.length?<View style={styles.empty}><Text style={styles.muted}>{busy?'正在加载审查…':scope==='last-turn'?'上一轮没有文件改动':repositories?.length===0?'此项目内未发现可访问的 Git 仓库':groups.some(group=>group.error)?'部分仓库读取失败，请刷新重试':groups.length?'':'此范围没有改动'}</Text></View>:query&&!rows.some(file=>file.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))?<View style={styles.empty}><Text style={styles.muted}>没有匹配的文件</Text></View>:null}
    </ScrollView>}
    {confirmation?<AppDialog visible title={confirmation.input.hunk?'撤销这段改动？':'撤销这个文件的改动？'} message={`${confirmation.path}\n仅按当前审查版本撤销所选改动。文件或暂存区发生变化时会停止，未保存的编辑器草稿保持原样。`} onClose={()=>setConfirmation(null)} actions={[{label:'取消',onPress:()=>setConfirmation(null)},{label:'确认',onPress:()=>{const pending=confirmation;setConfirmation(null);execute(pending.input,pending.revision);}}]}/>:null}
  </View>;
}
const useStyles=themed((_c,d)=>{
  const create=(wide:boolean)=>StyleSheet.create({
    root:{flex:1,minHeight:0,backgroundColor:d.surface},grow:{flex:1,minWidth:0},
    header:{flexDirection:'row',alignItems:'center',gap:wide?10:4,paddingHorizontal:wide?12:8,minHeight:wide?70:58,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line},
    scope:{flexDirection:'row',flexShrink:1,minWidth:0,alignItems:'center',gap:wide?8:4,paddingHorizontal:wide?18:8,minHeight:wide?48:44,borderRadius:26,borderWidth:StyleSheet.hairlineWidth,borderColor:d.line,backgroundColor:d.surface},
    scopeText:{fontSize:wide?20:15,color:d.text},scopeLabel:{flexShrink:1,minWidth:0},scopeCount:{flexShrink:1,minWidth:0},tools:{flexDirection:'row',flexShrink:0,alignItems:'center',paddingHorizontal:wide?6:2,borderRadius:26,borderWidth:StyleSheet.hairlineWidth,borderColor:d.line},
    additions:{fontSize:wide?18:14,color:d.ok},deletions:{fontSize:wide?18:14,color:d.bad},
    scopeMenu:{padding:6,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line},
    scopeOption:{minHeight:wide?46:44,paddingHorizontal:12,flexDirection:'row',alignItems:'center',justifyContent:'space-between',borderRadius:6},chosen:{backgroundColor:d.surface2},
    topMenu:{padding:6,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line},menuItem:{minHeight:44,paddingHorizontal:12,paddingVertical:7,justifyContent:'center'},
    menuText:{fontSize:wide?17:14,color:d.text2},menuHint:{padding:10,fontSize:wide?15:12,lineHeight:wide?22:18,color:d.muted},
    refArea:{padding:10,gap:6},refChip:{minHeight:44,justifyContent:'center',padding:7,maxWidth:wide?300:230},row:{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:6},disabled:{opacity:.35},
    muted:{fontSize:wide?16:13,lineHeight:wide?23:19,color:d.muted},notice:{paddingHorizontal:12,paddingVertical:6,fontSize:wide?15:12,color:d.muted},error:{padding:12,fontSize:wide?16:13,lineHeight:wide?23:19,color:d.bad},
    repositoryTitle:{flexShrink:1,minWidth:0},repositoryStrip:{flexGrow:0,flexShrink:0,maxHeight:58,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line},repositoryChoices:{padding:6,gap:4},repositoryChip:{minHeight:44,justifyContent:'center',paddingHorizontal:10,paddingVertical:8,borderRadius:6},repositoryHeader:{paddingHorizontal:12,paddingVertical:10,flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap',backgroundColor:d.surface2},
    files:{flex:1,minHeight:0},fileList:{flexGrow:1},
    fileRow:{minHeight:wide?56:48,flexDirection:'row',alignItems:'center',gap:wide?5:3,paddingLeft:wide?20:12,paddingRight:wide?6:4,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line},
    fileSelect:{flex:1,minWidth:0,minHeight:wide?56:48,flexDirection:'row',alignItems:'center',gap:wide?12:9},fileName:{flex:1,minWidth:0,fontSize:wide?20:15,lineHeight:wide?26:21,color:d.text},
    stats:{flexDirection:'row',gap:wide?5:3,paddingLeft:5},badge:{minWidth:wide?22:18,textAlign:'center',fontSize:wide?12:10,fontWeight:'700',borderRadius:4,paddingVertical:2},
    javascriptBadge:{color:'#A77500',backgroundColor:'#FFF3CD'},typescriptBadge:{color:'#2274A5',backgroundColor:'#E9F4FB'},markdownBadge:{color:d.ok},
    fileMenu:{padding:6,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line,backgroundColor:d.surface},empty:{flex:1,minHeight:120,alignItems:'center',justifyContent:'center'},
    find:{flexDirection:'row',alignItems:'center',gap:5,paddingHorizontal:12,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line},input:{minHeight:wide?46:40,paddingHorizontal:8,fontSize:wide?17:14,color:d.text},
  });
  return{compact:create(false),wide:create(true)};
});
