import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { KeyboardSafeView } from '../components/KeyboardSafeView';
import { conversationFontFamily } from './conversation-typography';
import { useDesk } from '../theme';
import type { Project, WorkspaceMode } from './client';
import { parseProjectBrowserResult, type ProjectBrowserResult, type ProjectRequest } from './project-browser';
import { useBackAction } from './useBackAction';

export function ProjectBrowser({ scopeKey, tool, mode, request, onSelect, onProjectless, projectlessUnavailable, onClose }: {
  scopeKey: string; tool: string; mode: WorkspaceMode; request: ProjectRequest; onSelect: (project: Project) => void; onProjectless?: () => void; projectlessUnavailable?: string; onClose: () => void;
}) {
  const d = useDesk();
  const identity = JSON.stringify([scopeKey, tool, mode]);
  const lifecycle = useMemo(() => ({ identity, version: 0, active: true }), [identity]);
  const owner = useRef(lifecycle);
  owner.current = lifecycle;
  const [location, setLocation] = useState({ cwd: '', path: '' });
  const [result, setResult] = useState<ProjectBrowserResult>({});
  const rootLabels = useRef<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const pending = useRef(false), creatingRef = useRef(creating); creatingRef.current = creating;
  const perform = async (action: 'list' | 'select' | 'mkdir', target = location, cursor?: string) => {
    if (pending.current || owner.current !== lifecycle || !lifecycle.active || action === 'mkdir' && !creatingRef.current || action === 'select' && creatingRef.current) return;
    const version = ++lifecycle.version;
    const current = () => owner.current === lifecycle && lifecycle.active && lifecycle.version === version;
    pending.current = true; setBusy(true); setError('');
    try {
      const input = { action, ...target, ...(cursor ? { cursor } : {}), ...(action === 'mkdir' ? { name: name.trim() } : {}) };
      const raw = await request(input);
      if (!current()) return;
      const parsed = parseProjectBrowserResult(raw, input, tool, mode);
      if (action !== 'list') { leave(() => onSelect(parsed.project!)); return; }
      if (parsed.roots) rootLabels.current = Object.fromEntries(parsed.roots.map(root => [root.path, root.name]));
      setLocation(target);
      setResult(previous => cursor && previous.directory && parsed.directory ? { directory: { ...parsed.directory, entries: [...previous.directory.entries, ...parsed.directory.entries] } } : parsed);
    } catch (reason) {
      if (current()) {
        const raw = reason instanceof Error ? reason.message : '目录操作未完成';
        const message = /unknown command|unsupported command|不支持.*指令|不支持.*命令/i.test(raw)
          ? '请更新电脑端后再选择文件夹。'
          : raw.replace(/^(?:project_[a-z_]+|workspace_files_[a-z_]+):\s*/, '');
        setError(message + (action === 'mkdir' && !/^(?:project_exists|project_not_authorized):/.test(raw) ? '。请返回后刷新目录核对，勿重复创建。' : ''));
      }
    } finally { if (current()) { pending.current = false; setBusy(false); } }
  };
  useEffect(() => {
    lifecycle.active = true;
    pending.current = false; rootLabels.current = {}; setLocation({ cwd: '', path: '' }); setResult({}); setName(''); creatingRef.current = false; setCreating(false);
    void perform('list', { cwd: '', path: '' });
    return () => { lifecycle.active = false; lifecycle.version++; };
  }, [lifecycle]); // eslint-disable-line react-hooks/exhaustive-deps
  const leave = (action: () => void) => { if (owner.current !== lifecycle || !lifecycle.active) return; lifecycle.active = false; lifecycle.version++; pending.current = false; action(); };
  const close = () => leave(onClose);
  const back = () => {
    if (owner.current !== lifecycle || !lifecycle.active) return;
    if (creating && !busy) { creatingRef.current = false; setCreating(false); setError(''); return; }
    if (location.cwd && !busy) { setName(''); void perform('list', location.path ? { ...location, path: location.path.split('/').slice(0, -1).join('/') } : { cwd: '', path: '' }); return; }
    close();
  };
  useBackAction(() => { back(); return true; });
  const displayPath = location.cwd ? `${location.cwd.replace(/[\\/]+$/, '')}${location.path ? ' / ' + location.path : ''}` : '';
  const folderName = !location.path && rootLabels.current[location.cwd] || (location.path || location.cwd).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '文件夹';
  const folders = result.directory?.entries.filter(item => item.kind === 'directory') ?? [];
  const iconButton = (label: string, icon: 'close' | 'arrowLeft' | 'regenerate', action: () => void, disabled = false) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={action} style={({ pressed }) => [styles.iconButton, { opacity: disabled ? .4 : 1, backgroundColor: pressed ? d.press : 'transparent' }]}><Icon name={icon} size={21} color={d.text2} /></Pressable>;
  const folderRow = (label: string, title: string, path: string | undefined, action: () => void, key: string) =>
    <Pressable key={key} accessibilityRole="button" accessibilityLabel={label} disabled={busy} onPress={action} style={({ pressed }) => [styles.folderRow, { borderBottomColor: d.line, backgroundColor: pressed ? d.press : 'transparent', opacity: busy ? .55 : 1 }]}>
      <View style={[styles.folderIcon, { backgroundColor: d.surface2 }]}><Icon name="folder" size={23} color={d.accentText} /></View>
      <View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.rowTitle, { color: d.text }]}>{title}</Text>{path ? <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.path, { color: d.muted }]}>{path}</Text> : null}</View><Icon name="chevronRight" size={17} color={d.faint} />
    </Pressable>;
  return <KeyboardSafeView testID="project-browser" style={[styles.panel, { backgroundColor: d.surface }]}>
    <View style={[styles.header, { borderBottomColor: d.line }]}>
      {location.cwd ? iconButton(creating ? '返回选择文件夹' : '上一级', 'arrowLeft', back, busy) : <View style={styles.iconButton} />}
      <Text accessibilityRole="header" style={[styles.headerTitle, { color: d.text }]}>{creating ? '新建文件夹' : location.cwd ? '选择文件夹' : '新会话'}</Text>
      {iconButton('取消新建会话', 'close', close)}
    </View>
    <ScrollView style={styles.list} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {!location.cwd ? <>
        <View style={styles.intro}><Text style={[styles.title, { color: d.text }]}>从哪里开始？</Text><Text style={[styles.subtitle, { color: d.muted }]}>文件夹可选，按这次的任务来。</Text></View>
        {onProjectless ? <Pressable accessibilityRole="button" accessibilityLabel="不关联文件夹，直接开始" onPress={() => { if (owner.current !== lifecycle || !lifecycle.active) return; if (projectlessUnavailable) { setError(projectlessUnavailable); return; } leave(onProjectless); }} style={({ pressed }) => [styles.standalone, { backgroundColor: pressed ? d.press : d.accentSoft }]}>
          <View style={[styles.standaloneIcon, { backgroundColor: d.surface }]}><Icon name="chat" size={24} color={d.accentText} /></View>
          <View style={styles.rowCopy}><Text style={[styles.rowTitle, { color: d.text }]}>不关联文件夹</Text><Text style={[styles.subtitle, { color: d.muted }]}>直接开始一段新对话</Text></View><Icon name="chevronRight" size={19} color={d.accentText} />
        </Pressable> : null}
        <View style={styles.sectionHeading}><Text style={[styles.sectionTitle, { color: d.muted }]}>从项目文件夹开始</Text>{iconButton('重新读取授权目录', 'regenerate', () => void perform('list', location), busy)}</View>
      </> : <View style={[styles.location, { backgroundColor: d.surface2 }]}>
        <Icon name="folder" size={21} color={d.accentText} /><View style={styles.rowCopy}>
          <Text style={[styles.locationLabel, { color: d.muted }]}>{creating ? '创建位置' : '当前位置'}</Text><Text numberOfLines={1} style={[styles.rowTitle, { color: d.text }]}>{folderName}</Text>
          <Text selectable numberOfLines={2} ellipsizeMode="middle" style={[styles.path, { color: d.muted }]}>{displayPath}</Text>
        </View>{!creating ? iconButton('刷新当前目录', 'regenerate', () => void perform('list', location), busy) : null}
      </View>}
      {creating ? <View style={styles.form}>
        <Text style={[styles.rowTitle, { color: d.text }]}>文件夹名称</Text>
        <TextInput accessibilityLabel="新文件夹名称" value={name} onChangeText={setName} editable={!busy} autoFocus autoCorrect={false} autoCapitalize="none" returnKeyType="done"
          onSubmitEditing={() => { if (name.trim() && !busy) void perform('mkdir'); }} placeholder="例如：我的新项目" placeholderTextColor={d.faint} style={[styles.input, { color: d.text, borderColor: d.lineStrong, backgroundColor: d.surface2 }]} />
        <Text style={[styles.subtitle, { color: d.muted }]}>将在上面的位置创建，不会覆盖已有文件夹。</Text>
      </View> : <>
        {result.roots?.map(item => folderRow(`浏览目录 ${item.path}`, item.name, item.path, () => void perform('list', { cwd: item.path, path: '' }), item.path))}
        {folders.map(item => folderRow(`浏览文件夹 ${item.name}`, item.name, undefined, () => { setName(''); void perform('list', { ...location, path: item.path }); }, item.path))}
        {result.directory?.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="更多文件夹" disabled={busy} onPress={() => void perform('list', location, result.directory!.nextCursor)} style={styles.more}><Text style={[styles.subtitle, { color: d.accentText }]}>更多文件夹</Text></Pressable> : null}
        {!busy && !error && result.roots?.length === 0 ? <View style={styles.empty}><Icon name="folder" size={29} color={d.faint} /><Text style={[styles.rowTitle, { color: d.text2 }]}>还没有可用文件夹</Text><Text style={[styles.emptyDetail, { color: d.muted }]}>需要使用项目时，在电脑「设置 → 远程目录授权」添加即可。</Text></View> : null}
        {!busy && !error && result.directory && folders.length === 0 ? <View style={styles.empty}><Icon name="folder" size={29} color={d.faint} /><Text style={[styles.rowTitle, { color: d.text2 }]}>这里没有子文件夹</Text><Text style={[styles.emptyDetail, { color: d.muted }]}>可以使用当前文件夹，也可以新建一个。</Text></View> : null}
      </>}
      {busy ? <ActivityIndicator accessibilityLabel="正在处理目录" style={styles.loading} color={d.accentText} /> : null}
      {error ? <View style={[styles.error, { backgroundColor: d.badSoft }]}><Text accessibilityRole="alert" style={[styles.subtitle, { color: d.bad }]}>{error}</Text></View> : null}
    </ScrollView>
    {location.cwd && result.directory ? <View style={[styles.footer, { borderTopColor: d.line, backgroundColor: d.surface }]}>
      {!creating ? <Pressable accessibilityRole="button" accessibilityLabel="新建文件夹" disabled={busy} onPress={() => { if (owner.current === lifecycle && lifecycle.active) { setName(''); setError(''); creatingRef.current = true; setCreating(true); } }} style={[styles.newFolder, { opacity: busy ? .4 : 1 }]}><Icon name="plus" size={21} color={d.text2} /><Text style={[styles.actionText, { color: d.text2 }]}>新建文件夹</Text></Pressable> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={creating ? '创建文件夹并使用' : '使用当前文件夹'} disabled={busy || creating && !name.trim()} onPress={() => void perform(creating ? 'mkdir' : 'select')}
        style={({ pressed }) => [styles.primary, { backgroundColor: d.accent, opacity: busy || creating && !name.trim() ? .45 : pressed ? .8 : 1 }]}><Text style={[styles.actionText, { color: '#FFFFFF' }]}>{creating ? '创建并继续' : '使用此文件夹'}</Text></Pressable>
    </View> : null}
  </KeyboardSafeView>;
}
const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, width: '100%', maxWidth: 680, alignSelf: 'center' },
  header: { minHeight: 62, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  headerTitle: { flex: 1, textAlign: 'center', fontFamily: conversationFontFamily, fontSize: 17, lineHeight: 24, fontWeight: '600' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  list: { flex: 1 }, content: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 24 }, intro: { gap: 8, marginBottom: 24 },
  title: { fontFamily: conversationFontFamily, fontSize: 25, lineHeight: 34, fontWeight: '600' }, subtitle: { fontFamily: conversationFontFamily, fontSize: 13, lineHeight: 21 },
  standalone: { paddingHorizontal: 16, paddingVertical: 20, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 14 },
  standaloneIcon: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }, rowCopy: { flex: 1, minWidth: 0, gap: 4 },
  rowTitle: { fontFamily: conversationFontFamily, fontSize: 15, lineHeight: 23, fontWeight: '500' }, sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, marginBottom: 4 },
  sectionTitle: { fontFamily: conversationFontFamily, fontSize: 12, lineHeight: 18, fontWeight: '500' },
  folderRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  folderIcon: { width: 43, height: 43, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, path: { fontFamily: conversationFontFamily, fontSize: 11.5, lineHeight: 18 },
  location: { borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 }, locationLabel: { fontFamily: conversationFontFamily, fontSize: 11, lineHeight: 16 },
  form: { marginTop: 18, gap: 12 }, input: { minHeight: 52, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, fontFamily: conversationFontFamily, fontSize: 16 },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 44, paddingHorizontal: 12 }, emptyDetail: { fontFamily: conversationFontFamily, fontSize: 12, lineHeight: 20, textAlign: 'center', maxWidth: 280 },
  loading: { padding: 24 }, more: { minHeight: 48, alignItems: 'center', justifyContent: 'center' }, error: { padding: 14, borderRadius: 12, marginTop: 16 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 22, paddingTop: 14, paddingBottom: 20 },
  newFolder: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 7, paddingRight: 5 }, primary: { flex: 1, minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 16, paddingHorizontal: 12 },
  actionText: { fontFamily: conversationFontFamily, fontSize: 14, lineHeight: 22, fontWeight: '600' },
});
