import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { useDesk } from '../theme';
import type { AgentId, SessionInfo } from './client';
import { captureWorkspaceFiles, captureProjectWorkspaceFiles, type WorkspaceFileReader } from './workspace-files';
import { getRemoteState, openSession, remoteDeliveryScope, timelineKey, type TimelineItem } from './store';
import { contextBytes, referenceLineRange, type ContextReference } from './context-references';
import { SkeletonGroup, SkeletonRows } from '../components/Skeleton';
import { useWorkspaceRuntime } from './WorkspaceRuntimeContext';

type Message = Extract<TimelineItem, { kind: 'message' }>;
export interface ReferencePreview { kind: 'file' | 'message'; sessionKey?: string; projectPath?: string; label: string; text: string; path?: string; messageId?: string }
interface Props {
  deviceId: string; sessionKey?: string; tool?: string; agentId: AgentId; cwd: string; scope: string; query: string;
  messages: TimelineItem[]; sessions: SessionInfo[]; filesAllowed: boolean; availableHeight?: number; initial?: ReferencePreview;
  onSelect: (value: ContextReference) => void; onClose: () => void;
}
const modeKey = (initial?: ReferencePreview) => initial?.messageId ?? initial?.path ?? '';
const boundedLabel = (value: string) => { let text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim(); while (contextBytes(text) > 200) text = [...text].slice(0, -1).join(''); return text || '引用'; };
const selectable = (item: TimelineItem): item is Message => item.kind === 'message' && item.final && !item.local && !item.parentId && !item.messageOrigin && Boolean(item.text.trim());

/** Reads only explicitly admitted project files or selected session history.
 * Fetch ownership is fenced across close, source changes and late responses. */
export interface ContextReferencePickerHandle { keyDown: (key: string) => boolean }
export const ContextReferencePicker = forwardRef<ContextReferencePickerHandle, Props>(function ContextReferencePicker(props, ref) {
  const dk = useDesk(), window = useWindowDimensions();
  const runtime = useWorkspaceRuntime();
  const available = props.availableHeight ?? window.height;
  const maxHeight = Math.max(160, Math.min(330, available - 140));
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [props.query, modeKey(props.initial)]);
  const [mode, setMode] = useState<'files' | 'messages' | 'tasks'>(props.filesAllowed ? 'files' : 'messages');
  const [preview, setPreview] = useState<ReferencePreview | undefined>(props.initial);
  const [start, setStart] = useState('1'), [end, setEnd] = useState(String(props.initial?.text.split('\n').length ?? 1));
  const [files, setFiles] = useState<string[]>([]), [partial, setPartial] = useState(false);
  const [taskMessages, setTaskMessages] = useState<{ session: SessionInfo; items: Message[] }>();
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const generation = useRef(0), active = useRef(true), pendingRead = useRef<WorkspaceFileReader | undefined>(undefined);
  const busy = useRef(0), list = useRef<FlatList>(null), retry = useRef<(() => void) | undefined>(undefined);
  const createReader = (invalidate?: () => void) => props.sessionKey
    ? (runtime?.captureFiles ?? captureWorkspaceFiles)({ deviceId: props.deviceId, sessionKey: props.sessionKey, agentId: props.agentId, surface: 'cli', expectedCwd: props.cwd }, invalidate)
    : (runtime ? runtime.captureProjectFiles ?? (()=>{throw new Error('当前连接未开放项目文件引用');}) : captureProjectWorkspaceFiles)({ deviceId: props.deviceId, tool: props.tool ?? String(props.agentId), cwd: props.cwd }, invalidate);
  const sourceCurrent = () => active.current && (runtime?.scope ?? remoteDeliveryScope()) === props.scope;
  useEffect(() => { active.current = true; return () => { active.current = false; ++generation.current; pendingRead.current?.dispose(); }; }, []);
  useEffect(() => {
    if (mode !== 'files' || !props.filesAllowed || preview) return;
    const version = ++generation.current;
    busy.current = version;
    let live = true;
    const reader = createReader(() => {
      if (live && active.current) { ++generation.current; busy.current = 0; setFiles([]); setLoading(false); setError('来源或文件授权已变化，请重新打开引用'); }
    });
    setLoading(true); setError(''); setFiles([]); setPartial(false);
    void (async () => {
      const queue = [''], result: string[] = []; let requests = 0, clipped = false;
      while (queue.length && requests < 64 && result.length < 1000) {
        const path = queue.shift()!; let cursor: string | undefined;
        do {
          const page = await reader.list(path, cursor); ++requests;
          if (!live || version !== generation.current || !sourceCurrent()) return;
          for (const item of page.entries) { if (item.kind === 'file') result.push(item.path); else if (queue.length < 128) queue.push(item.path); else clipped = true; }
          cursor = page.nextCursor; clipped ||= page.truncated && !cursor;
        } while (cursor && requests < 64 && result.length < 1000);
        clipped ||= Boolean(cursor);
      }
      if (live && version === generation.current && sourceCurrent()) { setFiles(result.slice(0, 1000)); setPartial(clipped || Boolean(queue.length) || result.length > 1000); }
    })().catch(e => { if (live && version === generation.current) setError(e instanceof Error ? e.message : '文件列表读取失败'); })
      .finally(() => { reader.dispose(); if (busy.current === version) busy.current = 0; if (live && version === generation.current) setLoading(false); });
    return () => { live = false; reader.dispose(); if (busy.current === version) busy.current = 0; ++generation.current; };
  }, [mode, props.deviceId, props.sessionKey, props.tool, props.agentId, props.cwd, props.scope, props.filesAllowed, reload, Boolean(preview)]);
  const showPreview = (next: ReferencePreview) => { setPreview(next); setStart('1'); setEnd(String(next.text.split('\n').length)); setError(''); };
  const readFile = async (path: string) => {
    if (loading || busy.current || !sourceCurrent()) return;
    const version = ++generation.current;
    const reader = createReader();
    pendingRead.current = reader; busy.current = version; retry.current = () => void readFile(path);
    setLoading(true); setError('');
    try { const file = await reader.read(path); if (version === generation.current && sourceCurrent()) showPreview({ kind: 'file', ...(props.sessionKey ? { sessionKey: props.sessionKey } : { projectPath: props.cwd }), label: boundedLabel(path), path, text: file.text }); }
    catch (e) { if (version === generation.current && sourceCurrent()) setError(e instanceof Error ? e.message : '文件读取失败'); }
    finally { reader.dispose(); if (pendingRead.current === reader) pendingRead.current = undefined; if (busy.current === version) busy.current = 0; if (version === generation.current && active.current) setLoading(false); }
  };
  const readTask = async (session: SessionInfo) => {
    if (loading || busy.current || !sourceCurrent()) return;
    const version = ++generation.current; busy.current = version; retry.current = () => void readTask(session); setLoading(true); setError('');
    try {
      const direct = runtime ? await (runtime.readContextSession ? runtime.readContextSession(session.sessionKey) : Promise.reject(new Error('当前连接尚未开放任务引用'))) : undefined;
      if (!runtime) await openSession(props.deviceId, session.sessionKey, { background: true });
      if (version !== generation.current || !sourceCurrent()) return;
      const current = runtime ? direct : getRemoteState().timelines[timelineKey(props.deviceId, session.sessionKey)];
      if (current?.error || !current?.snapshotAt || current.session?.cwd !== props.cwd || current.session.tool !== session.tool || current.session.controlSurface === 'desktop' || current.session.controlSurface === 'read-only') throw new Error('任务来源已变化或历史未确认');
      setTaskMessages({ session: current.session, items: current.items.filter(selectable) });
    } catch (e) { if (version === generation.current && sourceCurrent()) setError(e instanceof Error ? e.message : '任务读取失败'); }
    finally { if (busy.current === version) busy.current = 0; if (version === generation.current && active.current) setLoading(false); }
  };
  const query = props.query.toLocaleLowerCase();
  const rows = useMemo(() => {
    if (mode === 'files') return files.filter(path => path.toLocaleLowerCase().includes(query)).map(path => ({ id: path, label: path, action: () => void readFile(path) }));
    if (mode === 'tasks' && !taskMessages) return props.sessions.filter(s => s.sessionKey !== props.sessionKey && s.tool === (props.tool ?? props.sessionKey?.split(':')[0]) && s.cwd === props.cwd && s.controlSurface !== 'desktop' && s.controlSurface !== 'read-only' && `${s.title} ${s.sessionKey}`.toLocaleLowerCase().includes(query)).map(s => ({ id: s.sessionKey, label: s.title || s.sessionKey, action: () => void readTask(s) }));
    const items = mode === 'tasks' ? taskMessages?.items ?? [] : props.messages.filter(selectable);
    return [...items].reverse().filter(item => mode === 'tasks' || item.text.toLocaleLowerCase().includes(query)).map(item => ({ id: item.id, label: `${item.role === 'user' ? '你' : 'Agent'} · ${item.text}`, action: () => showPreview({ kind: 'message', sessionKey: taskMessages && mode === 'tasks' ? taskMessages.session.sessionKey : props.sessionKey,
      label: boundedLabel(`${mode === 'tasks' ? taskMessages?.session.title : '当前对话'} · ${item.role === 'user' ? '你' : 'Agent'}`), messageId: item.id, text: item.text }) }));
  }, [mode, files, props.query, props.messages, props.sessions, props.sessionKey, props.tool, props.agentId, props.cwd, props.deviceId, props.scope, taskMessages, loading]);
  useEffect(() => { if (!preview && !loading && rows.length) list.current?.scrollToIndex({ index: Math.min(selected, rows.length - 1), animated: false }); }, [selected, rows.length, preview, loading]);
  useImperativeHandle(ref, () => ({ keyDown: key => {
    if (preview || loading || !rows.length) return false;
    if (key === 'ArrowDown' || key === 'ArrowUp') { setSelected(index => (index + (key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length); return true; }
    if (key === 'Enter' || key === 'Tab') { rows[Math.min(selected, rows.length - 1)]?.action(); return true; }
    return false;
  } }), [preview, loading, rows, selected]);
  const add = () => {
    if (!preview || !sourceCurrent()) return;
    try {
      const first = Number(start), last = Number(end), range = referenceLineRange(preview.text, first, last);
      props.onSelect({ kind: preview.kind, ...(preview.sessionKey ? { sessionKey: preview.sessionKey } : { projectPath: preview.projectPath }), label: boundedLabel(preview.label), text: range.text, capturedAt: Date.now(),
        ...(preview.kind === 'file' ? { path: preview.path!, startLine: first, endLine: last } : { messageId: preview.messageId!, startOffset: range.start, endOffset: range.end }) });
    } catch (e) { setError(e instanceof Error ? e.message : '引用范围无效'); }
  };
  return <View testID="context-reference-picker" style={[styles.root, { maxHeight, backgroundColor: dk.surface, borderColor: dk.line }]}>
    <View style={styles.header}><Text style={[styles.title, { color: dk.text }]}>{preview ? '引用内容' : taskMessages ? taskMessages.session.title : '添加上下文'}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭引用选择" onPress={props.onClose} style={styles.button}><Text style={{ color: dk.muted }}>关闭</Text></Pressable></View>
    {preview ? <>
      <Text numberOfLines={1} style={{ color: dk.muted, fontSize: 11 }}>{preview.label}</Text>
      <ScrollView style={[styles.preview, { maxHeight: Math.max(40, maxHeight - 150) }]} keyboardShouldPersistTaps="handled"><Text selectable style={{ color: dk.text, fontSize: 12, lineHeight: 18 }}>{preview.text}</Text></ScrollView>
      <View style={styles.header}><Text style={{ color: dk.muted }}>行</Text><TextInput accessibilityLabel="引用起始行" keyboardType="number-pad" value={start} onChangeText={setStart} style={[styles.range, { color: dk.text, borderColor: dk.line }]} />
        <Text style={{ color: dk.muted }}>至</Text><TextInput accessibilityLabel="引用结束行" keyboardType="number-pad" value={end} onChangeText={setEnd} style={[styles.range, { color: dk.text, borderColor: dk.line }]} />
        <Pressable accessibilityRole="button" accessibilityLabel="添加所选引用" onPress={add} style={styles.button}><Text style={{ color: dk.accentText }}>添加引用</Text></Pressable></View>
      <Text style={{ color: dk.muted, fontSize: 10 }}>发送所选内容快照；以后文件变化不会修改这份引用。</Text>
    </> : <>
      <View style={styles.tabs}>{(['files', 'messages', 'tasks'] as const).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityState={{ selected: mode === tab, disabled: tab === 'files' && !props.filesAllowed }} disabled={tab === 'files' && !props.filesAllowed}
        onPress={() => { if (mode === tab && !taskMessages) return; ++generation.current; busy.current = 0; retry.current = undefined; pendingRead.current?.dispose(); pendingRead.current = undefined; setMode(tab); setSelected(0); setTaskMessages(undefined); setError(''); setLoading(false); }} style={styles.button}><Text style={{ color: mode === tab ? dk.accentText : dk.muted }}>{tab === 'files' ? '文件' : tab === 'messages' ? '消息' : '任务'}</Text></Pressable>)}</View>
      {loading ? <SkeletonGroup label="正在读取引用"><SkeletonRows rows={4} avatar={0} /></SkeletonGroup> : <FlatList ref={list} style={[styles.list, { maxHeight: Math.max(40, maxHeight - 105) }]} data={rows} keyboardShouldPersistTaps="handled" keyExtractor={item => item.id} getItemLayout={(_, index) => ({ length: 48, offset: 48 * index, index })}
        renderItem={({ item, index }) => <Pressable accessibilityRole="button" accessibilityState={{ selected: index === selected }} onPress={item.action} style={[styles.row, index === selected && { backgroundColor: dk.surface2 }]}><Text numberOfLines={2} style={{ color: dk.text, fontSize: 12, lineHeight: 16 }}>{item.label}</Text></Pressable>}
        ListEmptyComponent={<Text style={{ color: dk.muted, padding: 10 }}>没有匹配内容</Text>} />}
      {partial && mode === 'files' ? <Text style={{ color: dk.muted, fontSize: 10 }}>项目较大，仅列出部分文件；可从文件侧栏选择具体目录。</Text> : null}
      {taskMessages ? <Pressable accessibilityRole="button" onPress={() => setTaskMessages(undefined)} style={styles.button}><Text style={{ color: dk.accentText }}>返回任务列表</Text></Pressable> : null}
    </>}
    {error ? <View><Text accessibilityRole="alert" style={{ color: dk.bad, fontSize: 11 }}>{error}</Text>{!preview ? <Pressable accessibilityRole="button" onPress={() => { if (retry.current) retry.current(); else setReload(n => n + 1); }} style={styles.button}><Text style={{ color: dk.accentText }}>重试</Text></Pressable> : null}</View> : null}
  </View>;
});
const styles = StyleSheet.create({ root: { overflow: 'hidden', borderWidth: 1, borderRadius: 12, padding: 10, marginHorizontal: 10, gap: 5, maxHeight: 330 }, header: { flexDirection: 'row', gap: 8, alignItems: 'center' }, title: { flex: 1, fontSize: 12, fontWeight: '500' }, tabs: { flexDirection: 'row', gap: 10 }, button: { minHeight: 32, paddingHorizontal: 5, justifyContent: 'center' }, list: { maxHeight: 190 }, row: { height: 48, justifyContent: 'center', paddingVertical: 7, paddingHorizontal: 4 }, preview: { maxHeight: 150 }, range: { borderWidth: 1, borderRadius: 5, width: 52, padding: 5, fontSize: 12 } });
