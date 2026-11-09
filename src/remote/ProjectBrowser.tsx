import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import type { Project, WorkspaceMode } from './client';
import { parseProjectBrowserResult, type ProjectBrowserResult, type ProjectRequest } from './project-browser';
import { useBackAction } from './useBackAction';

export function ProjectBrowser({ scopeKey, tool, mode, request, onSelect, onClose }: {
  scopeKey: string; tool: string; mode: WorkspaceMode; request: ProjectRequest; onSelect: (project: Project) => void; onClose: () => void;
}) {
  const d = useDesk();
  const identity = JSON.stringify([scopeKey, tool, mode]);
  const lifecycle = useMemo(() => ({ identity, version: 0, active: true }), [identity]);
  const owner = useRef(lifecycle);
  owner.current = lifecycle;
  const [location, setLocation] = useState({ cwd: '', path: '' });
  const [result, setResult] = useState<ProjectBrowserResult>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [name, setName] = useState('');
  const pending = useRef(false);
  const perform = async (action: 'list' | 'select' | 'mkdir', target = location, cursor?: string) => {
    if (pending.current || owner.current !== lifecycle || !lifecycle.active) return;
    const version = ++lifecycle.version;
    const current = () => owner.current === lifecycle && lifecycle.active && lifecycle.version === version;
    pending.current = true; setBusy(true); setError('');
    try {
      const input = { action, ...target, ...(cursor ? { cursor } : {}), ...(action === 'mkdir' ? { name: name.trim() } : {}) };
      const raw = await request(input);
      if (!current()) return;
      const parsed = parseProjectBrowserResult(raw, input, tool, mode);
      if (action !== 'list') { onSelect(parsed.project!); return; }
      setLocation(target);
      setResult(previous => cursor && previous.directory && parsed.directory ? { directory: { ...parsed.directory, entries: [...previous.directory.entries, ...parsed.directory.entries] } } : parsed);
    } catch (reason) {
      if (current()) {
        const raw = reason instanceof Error ? reason.message : '目录操作未完成';
        const message = /unknown command|unsupported command|不支持.*指令|不支持.*命令/i.test(raw)
          ? '这台电脑暂不支持手机新建项目，请更新电脑端后重新读取。'
          : raw.replace(/^(?:project_[a-z_]+|workspace_files_[a-z_]+):\s*/, '');
        setError(message + (action === 'mkdir' && !/^(?:project_exists|project_not_authorized):/.test(raw) ? '。创建结果不确定时，请刷新目录核对后选择，勿重复创建。' : ''));
      }
    } finally { if (current()) { pending.current = false; setBusy(false); } }
  };
  useEffect(() => {
    lifecycle.active = true;
    pending.current = false; setLocation({ cwd: '', path: '' }); setResult({}); setName('');
    void perform('list', { cwd: '', path: '' });
    return () => { lifecycle.active = false; lifecycle.version++; };
  }, [lifecycle]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (owner.current !== lifecycle || !lifecycle.active) return; lifecycle.active = false; lifecycle.version++; pending.current = false; onClose(); };
  useBackAction(() => { close(); return true; });
  const button = (label: string, action: () => void, disabled = busy) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={action} style={[styles.button, { borderColor: d.line, opacity: disabled ? .45 : 1 }]}><Text style={{ color: d.accentText }}>{label}</Text></Pressable>;
  return <View testID="project-browser" style={[styles.panel, { backgroundColor: d.surface }]}>
    <View style={styles.row}><Text accessibilityRole="header" style={[styles.title, { color: d.text }]}>新建项目</Text>{button('取消新建项目', close, false)}</View>
    <Text style={{ color: d.muted }}>选择这台电脑的文件夹，或在选定位置创建文件夹，再开始第一条 {mode === 'code' ? 'Code' : 'Work'} 会话。</Text>
    <Text selectable style={{ color: d.text2 }}>{location.cwd ? `${location.cwd}${location.path ? ' / ' + location.path : ''}` : '电脑已授权的目录'}</Text>
    <View style={styles.row}>{location.cwd ? button('上一级', () => { setName(''); void perform('list', location.path ? { ...location, path: location.path.split('/').slice(0, -1).join('/') } : { cwd: '', path: '' }); }) : null}{button(location.cwd ? '刷新当前目录' : '重新读取授权目录', () => void perform('list', location))}</View>
    {busy ? <ActivityIndicator color={d.accentText} /> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: d.bad }}>{error}</Text> : null}
    <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
      {result.roots?.map(item => <Pressable key={item.path} accessibilityRole="button" accessibilityLabel={`浏览目录 ${item.path}`} disabled={busy} onPress={() => void perform('list', { cwd: item.path, path: '' })} style={styles.entry}><Icon name="folder" size={18} color={d.muted} /><View style={{ flex: 1 }}><Text style={{ color: d.text }}>{item.name}</Text><Text style={{ color: d.muted }}>{item.path}</Text></View></Pressable>)}
      {result.directory?.entries.filter(item => item.kind === 'directory').map(item => <Pressable key={item.path} accessibilityRole="button" accessibilityLabel={`浏览文件夹 ${item.name}`} disabled={busy} onPress={() => { setName(''); void perform('list', { ...location, path: item.path }); }} style={styles.entry}><Icon name="folder" size={18} color={d.muted} /><Text style={{ color: d.text }}>{item.name}</Text></Pressable>)}
      {result.directory?.nextCursor ? button('更多文件夹', () => void perform('list', location, result.directory!.nextCursor)) : null}
      {!busy && result.roots?.length === 0 ? <Text style={{ color: d.muted }}>暂无可用授权目录。请在这台电脑的「设置 → 远程目录授权」允许目录，再点击重新读取。</Text> : null}
      {!busy && result.directory?.entries.length === 0 ? <Text style={{ color: d.muted }}>这里没有子文件夹，可以选择当前文件夹。</Text> : null}
    </ScrollView>
    {location.cwd && result.directory ? <>
      {button('使用当前文件夹', () => void perform('select'))}
      <View style={styles.row}><TextInput accessibilityLabel="新文件夹名称" value={name} onChangeText={setName} editable={!busy} autoCapitalize="none" placeholder="新文件夹名称" placeholderTextColor={d.muted} style={[styles.input, { color: d.text, borderColor: d.line }]} />{button('创建文件夹并使用', () => void perform('mkdir'), busy || !name.trim())}</View>
    </> : null}
  </View>;
}
const styles = StyleSheet.create({ panel: { flex: 1, padding: 16, gap: 12 }, row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, title: { flex: 1, fontSize: 20, fontWeight: '600' }, button: { minHeight: 40, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderRadius: 9 }, list: { flex: 1 }, entry: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 }, input: { flex: 1, minWidth: 120, minHeight: 42, borderWidth: 1, borderRadius: 9, paddingHorizontal: 10 } });
