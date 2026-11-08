import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {AppDialog} from '../components/ui';
import {themed, useDesk} from '../theme';
import {captureWorkspaceGit, type GitAction, type GitInput, type GitSelection, type GitState, type WorkspaceGit} from './workspace-git';
import {useWorkspaceRuntime} from './WorkspaceRuntimeContext';
export {RemoteReviewPage} from './RemoteReviewPage';
export type {RemoteReviewPageProps} from './RemoteReviewPage';

type RemoteGitPageProps = {selection:GitSelection;active:boolean;factory?:(selection:GitSelection,onInvalidated:()=>void)=>WorkspaceGit};

export function RemoteGitPage(props: RemoteGitPageProps) {
  const runtime=useWorkspaceRuntime();
  // A confirmation and its draft belong to exactly one project connection.
  // Remounting retires both the visible dialog and callbacks captured by it.
  return <ScopedRemoteGitPage key={JSON.stringify([props.selection,runtime?.scope])} {...props}/>;
}

function ScopedRemoteGitPage({selection,active,factory}:RemoteGitPageProps) {
  const styles=useStyles(),dk=useDesk(),runtime=useWorkspaceRuntime();
  const owner=useRef<WorkspaceGit|null>(null),generation=useRef(0);
  const [state,setState]=useState<GitState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [diff,setDiff]=useState<{path:string;text:string;staged:boolean}|null>(null),[message,setMessage]=useState(''),[branch,setBranch]=useState(''),[name,setName]=useState('');
  const [title,setTitle]=useState(''),[body,setBody]=useState(''),[url,setUrl]=useState(''),[manage,setManage]=useState(false);
  const [confirmation,setConfirmation]=useState<{action:GitAction;input:GitInput;title:string;message:string;revision:string}|null>(null);
  const scope=JSON.stringify([selection,runtime?.scope]);
  const execute=async<T,>(task:(git:WorkspaceGit)=>Promise<T>,accept:(value:T)=>void)=>{
    const git=owner.current,current=generation.current;if(!git||busy)return;
    setBusy(true);setError('');setNotice('');
    try{const result=await task(git);if(generation.current===current)accept(result);}
    catch(reason){if(generation.current===current){setError(reason instanceof Error?reason.message:'操作未完成，请刷新核对');setState(null);}}
    finally{if(generation.current===current)setBusy(false);}
  };
  const refresh=()=>execute(git=>git.status(),value=>{setState(value);setDiff(null);});
  useEffect(()=>{
    if(!active)return;
    if(owner.current){void refresh();return;}
    const current=++generation.current;
    const invalidate=()=>{if(generation.current===current){setState(null);setError('电脑或会话已变化，请重新打开此标签');}};
    const git=factory?factory(selection,invalidate):runtime?runtime.captureGit?.(selection,invalidate):captureWorkspaceGit(selection,invalidate);
    if(!git){setError('当前连接尚未开放 Git 操作');return;}
    owner.current=git;setBusy(true);
    void git.status().then(value=>{if(generation.current===current){setState(value);setError('');}}).catch(reason=>{if(generation.current===current)setError(reason instanceof Error?reason.message:'Git 状态读取失败');}).finally(()=>{if(generation.current===current)setBusy(false);});
  },[active,scope]);
  useEffect(()=>()=>{generation.current++;owner.current?.dispose();owner.current=null;},[scope]);
  const mutate=(action:GitAction,input:GitInput={},expected=state?.revision)=>{
    if(!expected)return;
    void execute(git=>git.mutate(action,expected,input),result=>{
      setState(result.state);setDiff(null);setNotice(action==='commit'?'已提交暂存的改动':action==='push'?'推送已完成':action==='pr'?'草稿 PR 已就绪':'操作已完成');
      if(action==='commit')setMessage('');if(result.url)setUrl(result.url);if(result.path)setNotice(`已创建工作树：${result.path}`);
    });
  };
  const confirm=(action:GitAction,input:GitInput,titleText:string,detail:string)=>{if(state)setConfirmation({action,input,title:titleText,message:detail,revision:state.revision});};
  const button=(label:string,press:()=>void,disabled=false)=> <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy||disabled} onPress={press} style={[styles.button,(busy||disabled)&&styles.disabled]}><Text style={styles.buttonText}>{label.startsWith('取消暂存 ') ? '取消暂存' : label.startsWith('暂存 ') ? '暂存' : label.startsWith('移除工作树 ') ? '移除' : label.startsWith('切换到 ') ? '切换' : label}</Text></Pressable>;
  const staged=state?.files.filter(file=>file.index!==' '&&file.index!=='?')??[];
  const showDiff=(path:string,isStaged:boolean)=>{void execute(git=>git.diff(path,isStaged),result=>setDiff({path:result.path,staged:isStaged,text:result.diff||'此文件暂无文本差异；新文件或二进制文件请在文件标签中查看。'}));};
  const diffFile=state?.files.find(file=>file.path===diff?.path);
  return <View style={styles.root} testID="workspace-git">
    <View style={styles.header}><View style={styles.grow}><Text style={styles.heading}>Git</Text><Text style={styles.muted} numberOfLines={1}>{state?.branch||'未选择分支'}{state?.upstream?` → ${state.upstream}`:''}</Text></View>{busy?<ActivityIndicator size="small" color={dk.muted}/>:button('刷新 Git',()=>{void refresh();})}</View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {error?<Text accessibilityRole="alert" selectable style={styles.error}>{error}{'\n'}请刷新核对实际状态后再操作。</Text>:null}
      {notice?<Text selectable style={styles.muted}>{notice}</Text>:null}
      {state?<>
        <Text style={styles.section}>改动 · {state.files.length}</Text>
        {state.files.map(file=><View key={file.path} style={styles.file}>
          <Pressable accessibilityRole="button" accessibilityLabel={`查看 Git 差异 ${file.path}`} onPress={()=>showDiff(file.path,file.worktree===' ')} style={styles.grow}><Text style={styles.fileName} numberOfLines={2}>{file.path}</Text><Text style={styles.muted}>{file.index==='?'?'未跟踪':file.index==='U'||file.worktree==='U'?'有冲突':file.index!==' '?'已暂存':''}{file.worktree!==' '&&file.worktree!=='?'?' · 未暂存改动':''}</Text></Pressable>
          {file.index!==' '&&file.index!=='?'?button(`取消暂存 ${file.path}`,()=>mutate('unstage',{path:file.path})):null}
          {file.worktree!==' '?button(`暂存 ${file.path}`,()=>mutate('stage',{path:file.path})):null}
        </View>)}
        {!state.files.length?<Text style={styles.muted}>工作区干净</Text>:null}
        {diff?<View style={styles.diff}><View style={styles.header}><View style={styles.grow}><Text style={styles.fileName}>{diff.path}</Text><Text style={styles.muted}>{diff.staged?'已暂存 · 将包含在下次提交中':'未暂存 · 尚未加入下次提交'}</Text></View>{button('关闭差异',()=>setDiff(null))}</View>
          {diffFile&&diffFile.index!==' '&&diffFile.index!=='?'&&diffFile.worktree!==' '?<View style={styles.header}>{button('查看未暂存差异',()=>showDiff(diff.path,false),!diff.staged)}{button('查看已暂存差异',()=>showDiff(diff.path,true),diff.staged)}</View>:null}
          <ScrollView horizontal><Text selectable style={styles.code}>{diff.text}</Text></ScrollView></View>:null}
        <TextInput accessibilityLabel="提交说明" value={message} onChangeText={setMessage} placeholder="提交说明" placeholderTextColor={dk.muted} multiline style={styles.input}/>
        <View style={styles.row}>{button(`提交 ${staged.length} 个已暂存文件`,()=>confirm('commit',{message},'提交暂存改动？',`仅提交暂存区中的 ${staged.length} 个文件。`),!staged.length||!message.trim())}{button('推送',()=>confirm('push',{},'推送当前分支？',`推送 ${state.branch} 到 ${state.upstream}。`),!state.upstream)}</View>
        {!state.upstream?<Text style={styles.muted}>请在电脑为此分支设置远程跟踪分支后推送。</Text>:null}
        {button(manage?'收起分支和工作树':'分支和工作树',()=>setManage(value=>!value))}
        {manage?<>
          <Text style={styles.section}>本地分支</Text>
          {state.branches.map(value=><View key={value} style={styles.row}><Text style={[styles.fileName,styles.grow]}>{value}{value===state.branch?' · 当前':''}</Text>{value!==state.branch?button(`切换到 ${value}`,()=>confirm('checkout',{branch:value},'切换分支？',`切换到 ${value}；存在未提交改动时会拒绝切换。`)):null}</View>)}
          <TextInput accessibilityLabel="新分支名称" value={branch} onChangeText={setBranch} placeholder="新分支名称" placeholderTextColor={dk.muted} style={styles.input}/>
          {button('创建分支',()=>mutate('branch',{branch}),!branch.trim())}
          <Text style={styles.section}>工作树</Text>
          {state.worktrees.map(tree=><View key={tree.path} style={styles.file}><View style={styles.grow}><Text selectable style={styles.fileName}>{tree.branch||'分离 HEAD'}</Text><Text selectable style={styles.muted}>{tree.path}</Text></View>{tree.managed?button(`移除工作树 ${tree.branch}`,()=>confirm('worktree-remove',{path:tree.path},'移除此工作树？','只移除由此页面创建且干净的工作树；未提交改动、锁定或子模块会阻止移除。')):null}</View>)}
          <TextInput accessibilityLabel="工作树名称" value={name} onChangeText={setName} placeholder="工作树名称（字母、数字、短横线）" placeholderTextColor={dk.muted} style={styles.input}/>
          {button('创建工作树',()=>confirm('worktree-create',{name,branch},'创建工作树？',`从当前 HEAD 创建 ${branch}，保存到项目内的 .salcara-worktrees/${name}。`),!name.trim()||!branch.trim())}
          <Text style={styles.muted}>新工作树保留独立文件；在电脑授权该目录后，可从主页进入它的会话。</Text>
          <Text style={styles.section}>Pull request</Text>
          <TextInput accessibilityLabel="PR 标题" value={title} onChangeText={setTitle} placeholder="PR 标题" placeholderTextColor={dk.muted} style={styles.input}/>
          <TextInput accessibilityLabel="PR 描述" value={body} onChangeText={setBody} placeholder="描述改动和验证结果" placeholderTextColor={dk.muted} multiline style={styles.input}/>
          {button('创建草稿 PR',()=>confirm('pr',{title,body},'创建草稿 PR？','使用电脑已登录的 GitHub CLI；当前分支已有 PR 时返回现有链接。'),!state.githubCLI||!state.upstream||!title.trim())}
          {!state.githubCLI?<Text style={styles.muted}>电脑尚未安装 GitHub CLI（gh）。</Text>:null}
          {url?button('打开 PR',()=>{void Linking.openURL(url);}):null}
        </>:null}
      </>:null}
    </ScrollView>
    {confirmation?<AppDialog visible title={confirmation.title} message={confirmation.message} onClose={()=>setConfirmation(null)} actions={[{label:'取消',onPress:()=>setConfirmation(null)},{label:'确认',onPress:()=>{const value=confirmation;setConfirmation(null);mutate(value.action,value.input,value.revision);}}]}/>:null}
  </View>;
}
const useStyles=themed((_c,d)=>StyleSheet.create({
  root:{flex:1,minHeight:0,backgroundColor:d.surface},header:{flexDirection:'row',gap:8,alignItems:'center',padding:12,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line},content:{padding:14,gap:12},grow:{flex:1,minWidth:0},heading:{fontSize:14,fontWeight:'600',color:d.text},muted:{fontSize:11,lineHeight:17,color:d.muted},section:{fontSize:12,fontWeight:'600',color:d.text2,marginTop:8},file:{flexDirection:'row',alignItems:'center',gap:6,paddingVertical:8,borderBottomWidth:StyleSheet.hairlineWidth,borderBottomColor:d.line},fileName:{fontSize:12,lineHeight:18,color:d.text},row:{flexDirection:'row',flexWrap:'wrap',alignItems:'center',gap:8},button:{paddingHorizontal:10,paddingVertical:8,borderRadius:7,backgroundColor:d.surface2,alignSelf:'flex-start',maxWidth:'100%'},buttonText:{fontSize:11,color:d.text2},disabled:{opacity:.4},input:{borderWidth:StyleSheet.hairlineWidth,borderColor:d.line,borderRadius:8,padding:10,fontSize:13,color:d.text,minHeight:38},error:{fontSize:12,lineHeight:19,color:d.bad},diff:{borderWidth:StyleSheet.hairlineWidth,borderColor:d.line,borderRadius:8,overflow:'hidden'},code:{fontFamily:'monospace',fontSize:11,lineHeight:18,padding:10,color:d.text2},
}));
