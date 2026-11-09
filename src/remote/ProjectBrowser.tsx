import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { KeyboardSafeView } from '../components/KeyboardSafeView';
import { IconButton } from '../components/ui';
import { ProgrammingAction, ProgrammingCard, ProgrammingField, ProgrammingHeading, ProgrammingRow, ProgrammingSection } from './ProgrammingUi';
import { useDesk } from '../theme';
import type { Project, WorkspaceMode } from './client';
import { parseProjectBrowserResult, type ProjectBrowserResult, type ProjectRequest } from './project-browser';
import { useBackAction, type RegisterBackAction } from './useBackAction';

export function ProjectBrowser({ scopeKey, tool, mode, request, onSelect, onProjectless, projectlessUnavailable, onClose, onBack, explorer = false, browseUnavailable, agentName, onRegisterBack }: {
  scopeKey: string; tool: string; mode: WorkspaceMode; request: ProjectRequest; onSelect: (project: Project) => void; onProjectless?: () => void; projectlessUnavailable?: string; onClose: () => void;
  onBack?: () => void; explorer?: boolean; browseUnavailable?: string; agentName?: string;
  onRegisterBack?: RegisterBackAction;
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
    if (browseUnavailable) { setError(browseUnavailable); return; }
    if (explorer && action === 'select') return;
    const version = ++lifecycle.version;
    const current = () => owner.current === lifecycle && lifecycle.active && lifecycle.version === version;
    pending.current = true; setBusy(true); setError('');
    try {
      const input = { action, ...target, ...(cursor ? { cursor } : {}), ...(action === 'mkdir' ? { name: name.trim() } : {}) };
      const raw = await request(input);
      if (!current()) return;
      const parsed = parseProjectBrowserResult(raw, input, tool, mode, explorer);
      if (action !== 'list') { leave(() => onSelect(parsed.project!)); return; }
      if (parsed.roots) rootLabels.current = Object.fromEntries(parsed.roots.map(root => [root.path, root.name]));
      setLocation(target);
      setResult(previous => cursor && previous.directory && parsed.directory ? { directory: { ...parsed.directory, entries: [...previous.directory.entries, ...parsed.directory.entries] } } : parsed);
    } catch (reason) {
      if (current()) {
        const raw = reason instanceof Error ? reason.message : '目录操作未完成';
        const message = /unknown command|unsupported command|不支持.*指令|不支持.*命令/i.test(raw)
          ? '请更新电脑端后再选择文件夹。'
          : raw.replace(/^(?:explorer_[a-z_]+|project_[a-z_]+|workspace_files_[a-z_]+):\s*/, '');
        setError(message + (action === 'mkdir' && !/^(?:explorer_exists|explorer_uncertain|project_exists|project_not_authorized):/.test(raw) ? '。请返回后刷新目录核对，勿重复创建。' : ''));
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
    if (!location.cwd && onBack) leave(onBack); else close();
  };
  useBackAction(() => { back(); return true; }, onRegisterBack);
  const displayRoot = location.cwd.replace(/\\/g, '/');
  const displayPath = location.path ? `${displayRoot.replace(/\/+$/, '')}/${location.path}` : displayRoot;
  const folderName = !location.path && rootLabels.current[location.cwd] || (location.path || location.cwd).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '文件夹';
  const folders = result.directory?.entries.filter(item => item.kind === 'directory') ?? [];
  const beginNaming = () => {
    if (owner.current !== lifecycle || !lifecycle.active || busy) return;
    setName(''); setError(''); creatingRef.current = true; setCreating(true);
  };
  const folderRow = (label: string, title: string, detail: string | undefined, action: () => void, key: string, first: boolean, drive = false) =>
    <ProgrammingRow key={key} first={first} icon={drive ? 'drive' : 'folder'} title={title} detail={detail} accessibilityLabel={label}
      disabled={busy} onPress={action} trailing="chevron" />;
  return <KeyboardSafeView testID="project-browser" style={[styles.panel, { backgroundColor: d.bg }]}>
    <View style={styles.header}>
      {location.cwd || onBack ? <IconButton label={creating ? '返回选择文件夹' : location.cwd ? '上一级' : '返回选择 Agent'} icon="chevronLeft" onPress={back} disabled={busy} color={d.text2} /> : <View style={styles.headerSpace} />}
      <View style={styles.spacer} />
      <IconButton label="取消新建会话" icon="close" onPress={close} color={d.text2} iconSize={20} />
    </View>
    <ScrollView style={styles.list} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
      <ProgrammingHeading title={creating ? '新建文件夹' : '选择位置'} subtitle={explorer ? (agentName || tool) + ' · ' + (mode === 'code' ? 'Code' : 'Work') : '选择文件夹，也可以直接开始'} step={explorer ? creating ? '3 / 3' : '2 / 3' : undefined} />
      {!location.cwd ? <>
        {onProjectless ? <ProgrammingCard><ProgrammingRow first icon="chat" title="不关联文件夹" detail="直接开始一段新对话" trailing="chevron" accessibilityLabel="不关联文件夹，直接开始"
          onPress={() => { if (owner.current !== lifecycle || !lifecycle.active) return; if (projectlessUnavailable) { setError(projectlessUnavailable); return; } leave(onProjectless); }} /></ProgrammingCard> : null}
        <ProgrammingSection title={explorer ? '电脑磁盘' : '项目文件夹'} action="刷新" actionLabel={explorer ? '刷新电脑磁盘' : '重新读取授权目录'} onAction={() => { if (!busy) void perform('list', location); }} />
      </> : <>
        <ProgrammingCard><View style={styles.location}>
          <View style={[styles.locationIcon, { backgroundColor: d.surface3 }]}><Icon name={location.path ? 'folder' : 'drive'} size={18} color={d.text2} /></View>
          <View style={styles.rowCopy}><Text style={[styles.caption, { color: d.muted }]}>{creating ? '创建位置' : '当前位置'}</Text>
            <Text style={[styles.locationName, { color: d.text }]}>{folderName}</Text>
            <Text selectable style={[styles.path, { color: d.muted }]}>{displayPath}</Text>
          </View>
          {!creating ? <IconButton label="刷新当前目录" icon="regenerate" onPress={() => void perform('list', location)} disabled={busy} color={d.muted} iconSize={17} /> : null}
        </View></ProgrammingCard>
        {!creating ? <ProgrammingSection title="文件夹" hint={folders.length ? folders.length + ' 个' : undefined} /> : null}
      </>}
      {creating ? <>
        <ProgrammingCard style={{ marginTop: 20 }}><ProgrammingField first label="文件夹名称" accessibilityLabel="新文件夹名称" value={name} onChangeText={setName} editable={!busy} autoFocus autoCorrect={false} autoCapitalize="none" returnKeyType="done"
          onSubmitEditing={() => { if (name.trim() && !busy) void perform('mkdir'); }} placeholder="例如：我的新项目" /></ProgrammingCard>
        <Text style={[styles.helper, { color: d.muted }]}>将在上面的位置创建，发送首条消息后开始会话。</Text>
      </> : <>
        {result.roots?.length ? <ProgrammingCard>{result.roots.map((item, index) => folderRow('浏览' + (explorer ? '磁盘' : '目录') + ' ' + item.path, item.name, item.path, () => void perform('list', { cwd: item.path, path: '' }), item.path, index === 0, explorer))}</ProgrammingCard> : null}
        {folders.length ? <ProgrammingCard>{folders.map((item, index) => folderRow('浏览文件夹 ' + item.name, item.name, item.blockedReason, () => { if (item.blockedReason) { setError(item.blockedReason); return; } setName(''); void perform('list', { ...location, path: item.path }); }, item.path, index === 0))}</ProgrammingCard> : null}
        {result.directory?.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="更多文件夹" disabled={busy} onPress={() => void perform('list', location, result.directory!.nextCursor)} style={styles.more}><Text style={[styles.caption, { color: d.accentText }]}>更多文件夹</Text></Pressable> : null}
        {!busy && !error && result.roots?.length === 0 ? <View style={styles.empty}><Icon name={explorer ? 'drive' : 'folder'} size={24} color={d.faint} /><Text style={[styles.locationName, { color: d.text2 }]}>{explorer ? '没有可用磁盘' : '还没有可用文件夹'}</Text><Text style={[styles.emptyDetail, { color: d.muted }]}>{explorer ? '确认电脑磁盘可用后，点按刷新。' : '需要使用项目时，在电脑「设置 → 远程目录授权」添加即可。'}</Text></View> : null}
        {!busy && !error && result.directory && folders.length === 0 ? <View style={styles.empty}><Icon name="folder" size={24} color={d.faint} /><Text style={[styles.locationName, { color: d.text2 }]}>这里没有子文件夹</Text><Text style={[styles.emptyDetail, { color: d.muted }]}>{explorer ? '可以在这里创建新文件夹。' : '可以使用当前文件夹，也可以新建一个。'}</Text></View> : null}
      </>}
      {busy ? <ActivityIndicator accessibilityLabel="正在处理目录" style={styles.loading} color={d.muted} /> : null}
      {error ? <View style={[styles.error, { backgroundColor: d.badSoft }]}><Icon name="alert" size={16} color={d.bad} /><Text accessibilityRole="alert" style={[styles.errorText, { color: d.bad }]}>{error}</Text></View> : null}
    </ScrollView>
    {location.cwd && result.directory ? <View style={styles.footer}>
      {!creating && !explorer ? <ProgrammingAction label="新建文件夹" icon="plus" disabled={busy} tone="secondary" onPress={beginNaming} /> : null}
      <ProgrammingAction accessibilityLabel={creating ? '创建文件夹并使用' : explorer ? '在此位置新建文件夹' : '使用当前文件夹'} label={creating ? '创建并继续' : explorer ? '在这里新建文件夹' : '使用此文件夹'}
        icon={creating ? undefined : 'plus'} loading={busy} disabled={creating && !name.trim()} onPress={() => { if (explorer && !creating) beginNaming(); else void perform(creating ? 'mkdir' : 'select'); }} />
    </View> : null}
  </KeyboardSafeView>;
}
const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, width: '100%', maxWidth: 680, alignSelf: 'center' },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }, headerSpace: { width: 40 }, spacer: { flex: 1 },
  list: { flex: 1 }, content: { paddingHorizontal: 18, paddingBottom: 24 },
  location: { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }, locationIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowCopy: { flex: 1, minWidth: 0, gap: 3 }, caption: { fontSize: 11.5, lineHeight: 17 }, locationName: { fontSize: 13.5, lineHeight: 19, fontWeight: '500' }, path: { fontSize: 11.5, lineHeight: 17, flexShrink: 1 },
  helper: { fontSize: 11.5, lineHeight: 18, marginTop: 10, paddingHorizontal: 4 },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 32, paddingHorizontal: 12 }, emptyDetail: { fontSize: 12, lineHeight: 19, textAlign: 'center', maxWidth: 280 },
  loading: { padding: 24 }, more: { minHeight: 48, alignItems: 'center', justifyContent: 'center' }, error: { padding: 12, gap: 8, flexDirection: 'row', alignItems: 'flex-start', borderRadius: 12, marginTop: 16 }, errorText: { flex: 1, fontSize: 12, lineHeight: 19 },
  footer: { gap: 10, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 18 },
});
