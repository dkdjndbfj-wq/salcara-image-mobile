import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import type { ReferencePreview } from './ContextReferencePicker';
import type { AgentId } from './client';
import { mono } from './parts';
import { captureWorkspaceFiles, type WorkspaceFileReader, type WorkspaceFileText } from './workspace-files';
import { SkeletonGroup, SkeletonRows } from '../components/Skeleton';
import { remoteDeliveryScope } from './store';
import { discardWorkspaceFileDraft, readWorkspaceFileDraft, saveWorkspaceFileDraft, hydrateWorkspaceFileDrafts, subscribeWorkspaceDraftPersistence, workspaceDraftPersistenceError, type WorkspaceFileDraftIdentity } from './workspace-file-drafts';
import { useWorkspaceRuntime } from './WorkspaceRuntimeContext';
import { WorkspaceFileBrowser, type WorkspaceFileDirectories } from './WorkspaceFileBrowser';
import { projectPreviewSource } from './project-preview-state';

export interface RemoteFileTarget { path: string; line?: number; column?: number; nonce: number; expectedCwd: string; sessionKey: string; surface: 'cli' | 'desktop' }
type Props = { deviceId: string; sessionKey: string; agentId: AgentId; surface: 'cli' | 'desktop'; target?: RemoteFileTarget | null; visible?: boolean; onReference?: (value: ReferencePreview) => void; onOpenFile?: (path: string) => void; onOpenProjectPreview?: (path: string) => void; onDirtyChange?: (dirty: boolean, file?: {path:string;cwd:string}) => void; onSaved?: (change: { before: WorkspaceFileText; after: WorkspaceFileText }) => void; canMutatePath?: (path: string) => boolean; onFileMutation?: (change: { action: 'create' | 'delete' | 'rename'; path: string; destination?: string }) => void };
const MAX_LINES = 4000, MAX_LINE_LENGTH = 2000;

/** Hidden tabs retain drafts in memory; only the visible tab owns a reader. */
export function RemoteFiles({ deviceId, sessionKey, agentId, surface, target, visible = true, onReference, onOpenFile, onOpenProjectPreview, onDirtyChange, onSaved, onFileMutation, canMutatePath }: Props) {
  const styles = useStyles(), dk = useDesk();
  const runtime = useWorkspaceRuntime();
  const deliveryScope = runtime?.scope ?? remoteDeliveryScope();
  const scopeRef = useRef(deliveryScope); scopeRef.current = deliveryScope;
  const persistenceError = useSyncExternalStore(subscribeWorkspaceDraftPersistence, () => workspaceDraftPersistenceError(deliveryScope), () => '');
  const [directories,setDirectories]=useState<WorkspaceFileDirectories>({});
  const directoriesRef=useRef(directories);directoriesRef.current=directories;
  const [expandedPaths,setExpandedPaths]=useState<Set<string>>(()=>new Set());
  const [rootPath,setRootPath]=useState(target?.expectedCwd??'');
  const lastReaderCwd=useRef<string|undefined>(undefined);
  const [file, setFile] = useState<WorkspaceFileText>();
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [generation, restart] = useState(0);
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState('');
  const [conflict, setConflict] = useState<WorkspaceFileText>();
  const [discard, setDiscard] = useState<(() => void) | undefined>();
  const [invalidated, setInvalidated] = useState(false), [notice, setNotice] = useState('');
  const [mutation, setMutation] = useState<'create' | 'delete' | 'rename' | null>(null), [newName, setNewName] = useState('');
  const dirty = Boolean(file && draft !== file.text);
  const dirtyRef = useRef(false), compareNext = useRef(false);
  dirtyRef.current = dirty;
  const currentFile = useRef(file); currentFile.current = file;
  const fileIdentity = useRef<WorkspaceFileDraftIdentity | undefined>(undefined);
  useEffect(() => { onDirtyChange?.(dirty,file?{path:file.path,cwd:fileIdentity.current?.cwd??rootPath}:undefined); }, [dirty,file?.path,rootPath,onDirtyChange]);
  const owner = useRef<{ reader: WorkspaceFileReader; version: number; busy: boolean; draftScope: Omit<WorkspaceFileDraftIdentity, 'path'> } | undefined>(undefined);
  const lastRequest = useRef<{ path: string; read: boolean }>({ path: target?.path ?? '', read: Boolean(target) });
  const code = useRef<FlatList<{ number: number; text: string }>>(null);
  const horizontalCode = useRef<ScrollView>(null);
  const location = target?.path === file?.path ? target?.line : undefined;
  const lines = useMemo(() => file?.text.split('\n') ?? [], [file]);
  const shown = useMemo(() => lines.slice(0, MAX_LINES).map((text, index) => ({ number: index + 1, text: text.length > MAX_LINE_LENGTH ? `${text.slice(0, MAX_LINE_LENGTH)}…` : text })), [lines]);
  const codeWidth = useMemo(() => Math.max(320, Math.min(112_060, 54 + shown.reduce((max, line) => Math.max(max, [...line.text].reduce((width, char) => width + (char === '\t' ? 4 : 1), 0)), 0) * 14)), [shown]);
  const clipped = useMemo(() => lines.length > MAX_LINES || lines.some(line => line.length > MAX_LINE_LENGTH), [lines]);

  const load = async (nextPath: string, read: boolean, more = false) => {
    const context = owner.current;
    if (!context || context.busy || !visible) return;
    context.busy = true;
    if(read)lastRequest.current = { path: nextPath, read };
    else if(!currentFile.current){lastRequest.current={path:'',read:false};setPath(nextPath);}
    const version = ++context.version;
    setLoading(true); setError('');
    if (read && !compareNext.current) { setFile(undefined); setPath(nextPath); }
    if(!read)setDirectories(previous=>({...previous,[nextPath]:{...previous[nextPath],loading:true,error:undefined}}));
    try {
      await hydrateWorkspaceFileDrafts(context.draftScope.scope);
      if (owner.current !== context || context.version !== version || scopeRef.current !== context.draftScope.scope) return;
      if (read) {
        const result = await context.reader.read(nextPath);
        if (owner.current === context && context.version === version) {
          const identity = { ...context.draftScope, path: nextPath };
          fileIdentity.current = identity;
          const cached = readWorkspaceFileDraft(identity);
          if (cached) {
            setFile(cached.base); setDraft(cached.text); setEditing(true); setNotice('已恢复此会话的未保存草稿');
            if (result.revision !== cached.base.revision || result.text !== cached.base.text) { setConflict(result); setError('电脑文件已变化，请比较并合并后保存'); }
            else setConflict(undefined);
          } else {
            // Every accepted edit is stored in the shared draft cache. Missing
            // cache means another owner saved/discarded it, or this is a new cwd.
            setFile(result); setDraft(result.text); setEditing(false); setConflict(undefined);setNotice('');
          }
          compareNext.current = false;
        }
      } else {
        const result = await context.reader.list(nextPath, more ? directoriesRef.current[nextPath]?.page?.nextCursor : undefined);
        if (owner.current === context && context.version === version) setDirectories(previous => {
          const cached=previous[nextPath]?.page;
          const seen = new Set<string>();
          const entries = (more&&cached?[...cached.entries, ...result.entries]:result.entries).filter(item => !seen.has(item.path) && Boolean(seen.add(item.path))).slice(0, 4096);
          return {...previous,[nextPath]:{page:{...result,entries}}};
        });
      }
    } catch (reason) { if (owner.current === context && context.version === version) {
      const message=reason instanceof Error ? reason.message : '文件未开放、已变化或连接中断';
      if(read)setError(message);else setDirectories(previous=>({...previous,[nextPath]:{...previous[nextPath],loading:false,error:message}}));
    } }
    finally { if (owner.current === context && context.version === version) { context.busy = false; setLoading(false); } }
  };

  useEffect(() => {
    lastRequest.current = { path: target?.path ?? '', read: Boolean(target) };
    compareNext.current = false;
    fileIdentity.current = undefined;
    setDirectories({});setExpandedPaths(new Set());setRootPath(target?.expectedCwd??'');setPath(target?.path??''); setFile(undefined); setDraft(''); setEditing(false); setConflict(undefined); setDiscard(undefined); setNotice(''); setMutation(null);
  }, [target?.path, target?.expectedCwd, target?.sessionKey, target?.surface, deviceId, sessionKey, agentId, surface, deliveryScope]);

  useEffect(() => {
    setError(''); setLoading(false); setInvalidated(false);
    if (!visible) return;
    const invalidate = () => {
      if (owner.current !== context) return;
      context.version += 1; context.busy = false; setLoading(false); setInvalidated(true); setError(dirtyRef.current ? '文件授权或连接已变化，未保存草稿已保留' : '文件授权或连接已变化，请重新读取');
      setDirectories({});setExpandedPaths(new Set());
      if (!dirtyRef.current) { setFile(undefined); }
    };
    const reader = (runtime?.captureFiles ?? captureWorkspaceFiles)({ deviceId, sessionKey, agentId, surface, ...(target ? { expectedCwd: target.expectedCwd, expectedSessionKey: target.sessionKey, expectedSurface: target.surface } : {}) }, invalidate);
    const context = { reader, version: 0, busy: false, draftScope: { scope: deliveryScope, deviceId, agentId, sessionKey, surface, cwd: target?.expectedCwd ?? reader.cwd ?? '' } };
    const cwdChanged=lastReaderCwd.current!==undefined&&lastReaderCwd.current!==context.draftScope.cwd;
    lastReaderCwd.current=context.draftScope.cwd;
    setDirectories(previous=>cwdChanged?{}:Object.fromEntries(Object.entries(previous).map(([key,value])=>[key,value.loading?{...value,loading:false}:value])));
    if(cwdChanged)setExpandedPaths(new Set());
    setRootPath(context.draftScope.cwd);
    owner.current = context;
    if (AppState.currentState && AppState.currentState !== 'active') { invalidate(); context.reader.dispose(); owner.current = undefined; }
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') { invalidate(); context.reader.dispose(); } });
    return () => { listener.remove(); context.reader.dispose(); if (owner.current === context) owner.current = undefined; if (dirtyRef.current) compareNext.current = true; };
  }, [deviceId, sessionKey, agentId, surface, generation, target?.path, target?.expectedCwd, target?.sessionKey, target?.surface, visible, deliveryScope]);

  useEffect(() => {
    const request = lastRequest.current;
    void load(request.path, request.read);
    // Requests belong to this component generation; their results cannot
    // survive hiding, switching stations, devices or the target session.
  }, [deviceId, sessionKey, agentId, surface, generation, target?.path, target?.expectedCwd, target?.sessionKey, target?.surface, visible, deliveryScope]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!file || !location || location > shown.length) return;
    const timer = setTimeout(() => { try {
      code.current?.scrollToIndex({ index: location - 1, animated: false, viewPosition: 0.3 });
      const prefix = [...(shown[location - 1]?.text ?? '')].slice(0, Math.min((target?.column ?? 1) - 1, MAX_LINE_LENGTH));
      const x = prefix.reduce((width, char) => width + (char === '\t' ? 4 * 7 : char.charCodeAt(0) > 255 ? 14 : 7), 0);
      horizontalCode.current?.scrollTo({ x: Math.max(0, Math.min(x - 40, codeWidth - 200)), animated: false });
    } catch { /* bounded viewer may have been replaced */ } }, 0);
    return () => clearTimeout(timer);
  }, [file, location, target?.column, target?.nonce, shown, codeWidth]);

  const confirmDiscard = (action: () => void) => { if (dirty) setDiscard(() => action); else action(); };
  const forgetDraft = () => { if (fileIdentity.current) discardWorkspaceFileDraft(fileIdentity.current); };
  const editDraft = (text: string, base = file): boolean => {
    const identity = fileIdentity.current;
    if (!base || !identity || !visible || identity.scope !== scopeRef.current || identity.deviceId !== deviceId || identity.agentId !== agentId || identity.sessionKey !== sessionKey || identity.surface !== surface) return false;
    const saved = saveWorkspaceFileDraft(identity, base, text);
    if (!saved.ok) { setError(saved.message); return false; }
    setDraft(text); return true;
  };
  const refresh = () => { compareNext.current = dirty;setDirectories({});setExpandedPaths(new Set()); restart(value => value + 1); };
  const back = () => confirmDiscard(() => {
    forgetDraft();
    compareNext.current = false; setEditing(false); setConflict(undefined); setDraft('');setFile(undefined);setPath('');setNotice('');setError('');
    lastRequest.current={path:'',read:false};
    if(!directoriesRef.current['']?.page)void load('', false);
  });
  const selectFile=(nextPath:string)=>{if(nextPath===file?.path||loading||invalidated||!visible)return;confirmDiscard(()=>{
    forgetDraft();compareNext.current=false;setEditing(false);setConflict(undefined);setDraft('');setNotice('');
    void load(nextPath,true);
  });};
  const toggleDirectory=(directoryPath:string)=>{
    if(loading||invalidated||!visible)return;
    const expanding=!expandedPaths.has(directoryPath);
    setExpandedPaths(previous=>{const next=new Set(previous);if(expanding)next.add(directoryPath);else next.delete(directoryPath);return next;});
    if(!file){lastRequest.current={path:'',read:false};setPath(directoryPath);setError('');}
    if(expanding&&!directoriesRef.current[directoryPath]?.page)void load(directoryPath,false);
  };
  const save = async () => {
    const context = owner.current, before = file;
    if (!context || context.busy || !visible || invalidated || !before?.revision || !context.reader.writable || !context.reader.write || !dirty || conflict) return;
    context.busy = true;
    const version = ++context.version;
    setLoading(true); setError(''); setNotice('');
    try {
      const after = await context.reader.write(before.path, draft, before.revision);
      if (owner.current !== context || context.version !== version) return;
      forgetDraft();
      setFile(after); setDraft(after.text); setNotice('已保存到电脑'); onSaved?.({ before, after });
    } catch (reason) {
      if (owner.current !== context || context.version !== version) return;
      const message = reason instanceof Error ? reason.message : '保存失败，草稿已保留';
      setError(message);
      if (/workspace_file_conflict|已变化|无法确认/.test(message)) {
        try {
          const latest = await context.reader.read(before.path);
          if (owner.current === context && context.version === version) setConflict(latest);
        } catch { /* Keep the original revision and draft; never force an overwrite. */ }
      }
    } finally { if (owner.current === context && context.version === version) { context.busy = false; setLoading(false); } }
  };
  const editable = Boolean(file?.revision && owner.current?.reader.writable && !invalidated && visible);
  const manageable = Boolean(owner.current?.reader.manageable && !invalidated && visible && !loading);
  const mutate = async () => {
    const context = owner.current, action = mutation, before = file;
    if (!context || context.busy || !manageable || !action || dirty) return;
    if (action !== 'create' && before && canMutatePath?.(before.path) === false) { setError('此文件有未保存草稿，请先保存或丢弃'); return; }
    const parent = before ? before.path.split('/').slice(0, -1).join('/') : path;
    const destination = parent ? `${parent}/${newName.trim()}` : newName.trim();
    if (action !== 'delete' && (!newName.trim() || /[/\\]/.test(newName) || newName.trim().startsWith('.'))) { setError('请输入当前目录中的有效文件名'); return; }
    context.busy = true; const version = ++context.version; setLoading(true); setError('');
    try {
      let result: WorkspaceFileText | undefined;
      if (action === 'create') { if (!context.reader.create) throw new Error('电脑尚未开放新建文件'); result = await context.reader.create(destination, ''); }
      else {
        if (!before?.revision) throw new Error('请重新读取文件后操作');
        if (action === 'delete') { if (!context.reader.remove) throw new Error('电脑尚未开放删除文件'); await context.reader.remove(before.path, before.revision); }
        else { if (!context.reader.rename) throw new Error('电脑尚未开放重命名'); result = await context.reader.rename(before.path, destination, before.revision); }
      }
      if (owner.current !== context || context.version !== version) return;
      forgetDraft(); setMutation(null); setEditing(false); setConflict(undefined); setNotice(action === 'create' ? '已在电脑上新建文件' : action === 'delete' ? '已从电脑删除文件' : '文件已重命名');
      onFileMutation?.({ action, path: action === 'create' ? destination : before!.path, ...(action === 'rename' ? { destination } : {}) });
      if (result) { setFile(result); setDraft(result.text); setPath(result.path); fileIdentity.current = { ...context.draftScope, path: result.path }; lastRequest.current = { path: result.path, read: true }; if (action === 'create') setEditing(true); }
      else { setFile(undefined); setDraft(''); setPath(parent);lastRequest.current = { path: '', read: false }; }
      // Mutations refresh only their containing directory, retaining the tree's other branches.
      const updated=await context.reader.list(parent);
      if(owner.current!==context||context.version!==version)return;
      setDirectories(previous=>({...previous,[parent]:{page:updated}}));
    } catch (reason) { if (owner.current === context && context.version === version) setError(reason instanceof Error ? reason.message : '文件操作失败，请刷新目录'); }
    finally { if (owner.current === context && context.version === version) { context.busy = false; setLoading(false); } }
  };
  return <View testID="remote-files" style={styles.body}>
    <WorkspaceFileBrowser key={`${deliveryScope}|${deviceId}|${sessionKey}|${agentId}|${surface}|${target?.expectedCwd??''}`} rootLabel={rootPath||'当前工作区'} rootPath={rootPath||undefined} directories={directories} expandedPaths={expandedPaths} selectedPath={file?.path??(lastRequest.current.read?path:undefined)} busy={loading||invalidated||!visible} onToggleDirectory={toggleDirectory} onLoadMore={directoryPath=>void load(directoryPath,false,Boolean(directoriesRef.current[directoryPath]?.page?.nextCursor))} onSelectFile={selectFile} onReturnToDirectory={back}
      toolbarActions={closeMenu=><>
        <Pressable accessibilityRole="button" accessibilityLabel="刷新文件" disabled={loading||!visible} onPress={()=>{closeMenu();refresh();}} style={styles.menuAction}><Icon name="regenerate" size={17} color={dk.muted}/><Text style={styles.menuText}>刷新文件</Text></Pressable>
        {!file&&owner.current?.reader.manageable?<Pressable accessibilityRole="button" accessibilityLabel="新建文件" disabled={!manageable} onPress={()=>{closeMenu();setMutation('create');setNewName('');}} style={styles.menuAction}><Icon name="plus" size={17} color={dk.muted}/><Text style={styles.menuText}>新建文件</Text></Pressable>:null}
        {file&&onOpenFile?<Pressable accessibilityRole="button" accessibilityLabel="在新标签页打开文件" disabled={loading||invalidated||!visible} onPress={()=>{closeMenu();onOpenFile(file.path);}} style={styles.menuAction}><Icon name="newTab" size={17} color={dk.muted}/><Text style={styles.menuText}>在新标签页打开文件</Text></Pressable>:null}
      </>}
      status={<>
    {discard ? <View style={styles.status}><Text style={styles.error}>放弃此文件尚未保存的修改？</Text><View style={styles.actions}><Pressable accessibilityRole="button" onPress={() => setDiscard(undefined)}><Text style={styles.moreText}>继续编辑</Text></Pressable><Pressable accessibilityRole="button" onPress={() => { const action = discard; setDiscard(undefined); action(); }}><Text style={styles.moreText}>放弃修改</Text></Pressable></View></View> : null}
    {loading&&lastRequest.current.read ? <SkeletonGroup label="正在读取文件" style={{ paddingHorizontal: 12 }}><SkeletonRows rows={5} avatar={18} /></SkeletonGroup> : null}
    {error ? <View style={styles.status}><Text style={styles.error}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="重试文件读取" onPress={refresh}><Text style={styles.moreText}>{dirty ? '重新连接并比较' : '重新读取'}</Text></Pressable></View> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={styles.hint}>{notice}</Text> : null}
    {persistenceError ? <Text accessibilityRole="alert" style={styles.error}>{persistenceError}</Text> : null}
    {mutation ? <View style={styles.conflict}>
      <Text style={styles.path}>{mutation === 'create' ? '新建文件' : mutation === 'rename' ? '重命名文件' : `删除 ${file?.path}？`}</Text>
      {mutation === 'delete' ? <Text style={styles.hint}>将删除电脑上的这个文件。未保存的修改需要先保存或放弃。</Text> : <TextInput accessibilityLabel="文件名" value={newName} onChangeText={setNewName} autoCapitalize="none" autoCorrect={false} style={styles.filenameInput}/>}
      <View style={styles.actions}><Pressable accessibilityRole="button" accessibilityLabel="取消文件操作" disabled={loading} onPress={() => setMutation(null)}><Text style={styles.moreText}>取消</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="确认文件操作" disabled={!manageable || dirty} onPress={() => void mutate()}><Text style={styles.moreText}>{mutation === 'delete' ? '删除文件' : '确认'}</Text></Pressable></View>
    </View> : null}
    </>}>
    {file ? <>
      <View style={styles.head}><Text style={styles.path} numberOfLines={1}>{file.path}</Text><Text style={styles.readOnly}>{dirty?'未保存':editable?'可编辑':'只读'}</Text></View>
      <View style={styles.actions}>
        {onOpenProjectPreview && projectPreviewSource(file.path) ? <Pressable accessibilityRole="button" accessibilityLabel="运行项目预览" accessibilityHint={dirty ? '请先保存文件修改' : '检查源文件所属项目，确认后启动'} disabled={loading || invalidated || !visible || dirty} onPress={() => onOpenProjectPreview(file.path)}><Text style={[styles.moreText, (loading || dirty || invalidated) && styles.disabled]}>运行项目预览</Text></Pressable> : null}
        {!editing ? <Pressable accessibilityRole="button" accessibilityLabel="编辑文件" disabled={!editable || loading} onPress={() => { setEditing(true); setNotice(''); }}><Text style={[styles.moreText, !editable && styles.disabled]}>编辑</Text></Pressable> : <>
          <Pressable accessibilityRole="button" accessibilityLabel="保存到电脑" disabled={!editable || loading || !dirty || Boolean(conflict)} onPress={() => void save()}><Text style={[styles.moreText, (!editable || loading || !dirty || Boolean(conflict)) && styles.disabled]}>{loading ? '保存中…' : '保存到电脑'}</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="撤销未保存修改" disabled={loading} onPress={() => confirmDiscard(() => { forgetDraft(); setDraft(file.text); setConflict(undefined); setEditing(false); setError(''); })}><Text style={styles.moreText}>撤销修改</Text></Pressable>
        </>}
        {dirty ? <Pressable accessibilityRole="button" accessibilityLabel="复制文件草稿" onPress={() => { void Clipboard.setStringAsync(draft).then(() => setNotice('草稿已复制')); }}><Text style={styles.moreText}>复制草稿</Text></Pressable> : null}
        {owner.current?.reader.manageable && !editing ? <><Pressable accessibilityRole="button" accessibilityLabel="重命名文件" disabled={!manageable || dirty} onPress={() => { setMutation('rename'); setNewName(file.path.split('/').pop() ?? ''); }}><Text style={styles.moreText}>重命名</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="删除文件" disabled={!manageable || dirty} onPress={() => setMutation('delete')}><Text style={styles.moreText}>删除</Text></Pressable></> : null}
      </View>
      {conflict ? <View style={styles.conflict}><Text style={styles.error}>电脑上的最新内容（下方仍保留你的草稿）</Text><ScrollView style={styles.comparison}><Text selectable style={styles.code}>{conflict.text}</Text></ScrollView><Pressable accessibilityRole="button" accessibilityLabel="合并最新文件版本" onPress={() => { if (!editDraft(draft, conflict)) return; setFile(conflict); setConflict(undefined); setEditing(true); setError(''); setNotice('已采用最新版本作为保存基准，请合并差异后保存'); }}><Text style={styles.moreText}>保留草稿，合并到最新版本</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="放弃草稿使用电脑版本" onPress={() => confirmDiscard(() => { forgetDraft(); setFile(conflict); setDraft(conflict.text); setConflict(undefined); setEditing(false); setError(''); })}><Text style={styles.moreText}>放弃草稿，使用电脑版本</Text></Pressable></View> : null}
      {onReference ? <Pressable accessibilityRole="button" accessibilityLabel="引用此文件" disabled={loading || Boolean(error) || !file.text.length} onPress={() => { if (owner.current && !loading && !error) onReference({ kind: 'file', sessionKey, label: file.path, path: file.path, text: file.text }); }} style={styles.more}><Text style={styles.moreText}>引用此文件 / 选择行范围</Text></Pressable> : null}
      {editing ? <TextInput accessibilityLabel="文件内容编辑器" multiline value={draft} onChangeText={text => { editDraft(text); }} editable={!loading && visible} autoCorrect={false} autoCapitalize="none" spellCheck={false} style={styles.editor} textAlignVertical="top" /> : <>
      {clipped || location && location > shown.length ? <Text style={styles.hint}>{location && location > shown.length ? '该行超出手机显示范围' : '只读预览已截断，编辑器保留完整内容'}</Text> : null}
      <ScrollView ref={horizontalCode} horizontal style={styles.list} contentContainerStyle={{ width: codeWidth, flexGrow: 1 }}><FlatList ref={code} data={shown} keyExtractor={item => String(item.number)} initialNumToRender={24} maxToRenderPerBatch={24} windowSize={5}
        getItemLayout={(_data, index) => ({ length: 22, offset: index * 22, index })} style={[styles.list, { width: codeWidth }]}
        renderItem={({ item }) => <View style={[styles.codeRow, item.number === location && styles.highlight]}><Text style={styles.lineNumber}>{item.number}</Text><Text selectable numberOfLines={1} style={styles.code}>{item.text || ' '}</Text></View>} /></ScrollView></>}
    </> : null}
    </WorkspaceFileBrowser>
  </View>;
}

const useStyles = themed((_c, d) => StyleSheet.create({
  filenameInput: { minHeight: 38, padding: 8, color: d.text, backgroundColor: d.surface, borderWidth: 1, borderColor: d.line, borderRadius: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 18, paddingVertical: 10, paddingHorizontal: 8 }, disabled: { opacity: 0.4 }, editor: { flex: 1, minHeight: 180, color: d.text, backgroundColor: d.surface2, borderRadius: 8, padding: 12, fontFamily: mono, fontSize: 12, lineHeight: 20 }, conflict: { padding: 10, gap: 12, backgroundColor: d.surface2, borderRadius: 8, marginBottom: 8 }, comparison: { maxHeight: 150 },
  body: { flex: 1,minHeight:0 }, head: { flexDirection: 'row', alignItems: 'center', minHeight: 40, gap: 6,paddingHorizontal:10 }, menuAction:{minHeight:40,flexDirection:'row',alignItems:'center',gap:10},menuText:{fontSize:15,color:d.text},path: { flex: 1, color: d.text, fontSize: 13 }, readOnly: { color: d.muted, fontSize: 11 }, list: { flex: 1 }, status: { minHeight: 36, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 8 }, error: { color: d.muted, fontSize: 12 }, more: { minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: d.surface2, marginVertical: 8 }, moreText: { color: d.accentText, fontSize: 12 }, hint: { color: d.muted, fontSize: 11, padding: 10 }, codeRow: { height: 22, flexDirection: 'row', alignItems: 'center', gap: 7 }, lineNumber: { width: 36, textAlign: 'right', color: d.faint, fontFamily: mono, fontSize: 10 }, code: { flex: 1, color: d.text, fontFamily: mono, fontSize: 11, lineHeight: 20 }, highlight: { backgroundColor: d.accentSoft },
}));
