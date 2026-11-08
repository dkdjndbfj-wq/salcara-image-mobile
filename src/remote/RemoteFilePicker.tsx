import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Sheet } from '../components/ui';
import { Icon } from '../components/Icon';
import { ToolbarButton } from './WorkbenchToolbar';
import { themed, useDesk } from '../theme';
import type { AgentId } from './client';
import { appendContextReference, referenceLineRange, type ContextReference } from './context-references';
import { captureProjectWorkspaceFiles, captureWorkspaceFiles, type WorkspaceFileEntry, type WorkspaceFileReader } from './workspace-files';

export interface RemoteFilePickerProps {
  visible: boolean;
  deviceId: string;
  deviceName?: string;
  sessionKey?: string;
  agentId: AgentId;
  tool?: string;
  cwd: string;
  scope: string;
  existingReferences?: readonly ContextReference[];
  onClose: () => void;
  onAdd: (references: ContextReference[]) => void;
}

function parentPath(path: string): string {
  return path ? path.split('/').slice(0, -1).join('/') : '';
}

function pathLabel(path: string): string {
  return path || '项目根目录';
}

export function sortWorkspaceEntries(entries: readonly WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

/**
 * A bounded, project-scoped file explorer for adding computer files to a
 * programming prompt. The reader is always captured for the current device,
 * project and credential scope; it is never reused after the panel closes.
 */
export function RemoteFilePicker({ visible, deviceId, deviceName, sessionKey, agentId, tool, cwd, scope, existingReferences = [], onClose, onAdd }: RemoteFilePickerProps) {
  const dk = useDesk();
  const styles = useStyles();
  const [path, setPath] = useState('');
  const [page, setPage] = useState<{ path: string; entries: WorkspaceFileEntry[]; nextCursor?: string; truncated: boolean }>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const readerRef = useRef<WorkspaceFileReader | undefined>(undefined);
  const requestRef = useRef(0);
  const scopeRef = useRef(scope);

  const close = () => {
    if (adding) return;
    requestRef.current += 1;
    readerRef.current?.dispose();
    readerRef.current = undefined;
    onClose();
  };

  useEffect(() => {
    if (!visible) return;
    const reader = sessionKey
      ? captureWorkspaceFiles({ deviceId, sessionKey, agentId, surface: 'cli', expectedCwd: cwd }, () => {
        requestRef.current += 1;
        setPage(undefined);
        setError('文件授权已变化，请重新打开文件选择');
      })
      : captureProjectWorkspaceFiles({ deviceId, tool: tool ?? String(agentId), cwd }, () => {
        requestRef.current += 1;
        setPage(undefined);
        setError('项目授权已变化，请重新打开文件选择');
      });
    readerRef.current = reader;
    scopeRef.current = scope;
    setPath('');
    setPage(undefined);
    setSelected(new Set());
    setQuery('');
    setError('');
    return () => {
      requestRef.current += 1;
      reader.dispose();
      if (readerRef.current === reader) readerRef.current = undefined;
    };
  }, [visible, deviceId, sessionKey, agentId, tool, cwd, scope, reload]);

  useEffect(() => {
    if (!visible || !readerRef.current) return;
    const reader = readerRef.current;
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        requestRef.current += 1;
        reader.dispose();
        if (readerRef.current === reader) readerRef.current = undefined;
        setPage(undefined);
        setError('文件选择已暂停，请回到前台后重试');
      }
    });
    return () => listener.remove();
  }, [visible, deviceId, sessionKey, agentId, tool, cwd, scope, reload]);

  useEffect(() => {
    if (!visible || !readerRef.current) return;
    const reader = readerRef.current;
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    setPage(undefined);
    void reader.list(path).then(result => {
      if (request !== requestRef.current || scopeRef.current !== scope) return;
      setPage({ ...result, entries: sortWorkspaceEntries(result.entries) });
    }).catch(errorValue => {
      if (request !== requestRef.current || scopeRef.current !== scope) return;
      setError(errorValue instanceof Error ? errorValue.message : '文件目录读取失败');
    }).finally(() => {
      if (request === requestRef.current) setLoading(false);
    });
    return () => { requestRef.current += 1; };
  }, [visible, path, scope, reload]);

  const rows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (page?.entries ?? []).filter(item => !normalized || item.name.toLocaleLowerCase().includes(normalized));
  }, [page?.entries, query]);

  const toggle = (item: WorkspaceFileEntry) => {
    if (item.kind !== 'file' || adding) return;
    if (!selected.has(item.path) && selected.size >= 8) {
      setError('最多选择 8 个文件');
      return;
    }
    setError('');
    setSelected(current => {
      const next = new Set(current);
      if (next.has(item.path)) next.delete(item.path); else next.add(item.path);
      return next;
    });
  };

  const loadMore = () => {
    if (loading || adding || !page?.nextCursor || !readerRef.current || scopeRef.current !== scope) return;
    const reader = readerRef.current;
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    void reader.list(path, page.nextCursor).then(result => {
      if (request !== requestRef.current || scopeRef.current !== scope) return;
      setPage(previous => {
        if (!previous || previous.path !== result.path) return { ...result, entries: sortWorkspaceEntries(result.entries) };
        const seen = new Set<string>();
        const entries = sortWorkspaceEntries([...previous.entries, ...result.entries].filter(item => !seen.has(item.path) && Boolean(seen.add(item.path))));
        return { ...result, entries };
      });
    }).catch(errorValue => {
      if (request === requestRef.current) setError(errorValue instanceof Error ? errorValue.message : '更多文件读取失败');
    }).finally(() => { if (request === requestRef.current) setLoading(false); });
  };

  const addSelected = async () => {
    if (!selected.size || adding || !readerRef.current || scopeRef.current !== scope) return;
    setAdding(true);
    setError('');
    const request = ++requestRef.current;
    const reader = readerRef.current;
    try {
      let next = [...existingReferences];
      for (const filePath of selected) {
        const file = await reader.read(filePath);
        if (request !== requestRef.current || scopeRef.current !== scope) return;
        const lineCount = file.text.split('\n').length;
        const range = referenceLineRange(file.text, 1, lineCount);
        const reference: ContextReference = {
          kind: 'file',
          ...(sessionKey ? { sessionKey } : { projectPath: cwd }),
          label: filePath,
          path: filePath,
          text: range.text,
          startLine: 1,
          endLine: lineCount,
          capturedAt: Date.now(),
        };
        next = appendContextReference(next, reference);
      }
      onAdd(next);
      close();
    } catch (errorValue) {
      if (request === requestRef.current) setError(errorValue instanceof Error ? errorValue.message : '无法添加所选文件');
    } finally {
      if (request === requestRef.current) setAdding(false);
    }
  };

  const footer = <View style={styles.footer}>
    <Text style={styles.selection} numberOfLines={1}>{selected.size ? `已选 ${selected.size} 个文件` : '选择项目文件作为上下文'}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="添加所选文件" accessibilityState={{ disabled: !selected.size || adding, busy: adding }} disabled={!selected.size || adding} onPress={() => void addSelected()} style={[styles.addButton, (!selected.size || adding) && styles.disabled]}>
      {adding ? <ActivityIndicator size="small" color={dk.onInk} /> : <Icon name="plus" size={16} color={dk.onInk} />}
      <Text style={styles.addText}>添加</Text>
    </Pressable>
  </View>;

  return <Sheet visible={visible} presentation="page" scroll={false} title="电脑文件" subtitle={[deviceName, pathLabel(cwd)].filter(Boolean).join(' · ')} headerLeft={<ToolbarButton icon="arrowLeft" label="返回" disabled={adding} onPress={close}/>} onClose={close} footer={footer}>
    <View style={styles.body} testID="remote-file-picker">
      <View style={styles.locationRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回上一级目录" disabled={!path || loading || adding} onPress={() => { setQuery(''); setPath(parentPath(path)); }} style={styles.back}>
          <Icon name="arrowLeft" size={18} color={path ? dk.text : dk.faint} accent={path ? dk.text : dk.faint} />
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crumbs} style={styles.crumbScroll}>
          <Pressable accessibilityRole="button" accessibilityLabel="打开项目根目录" disabled={!path || loading || adding} onPress={() => { setQuery(''); setPath(''); }}><Text style={[styles.crumb, !path && styles.crumbCurrent]}>项目</Text></Pressable>
          {path.split('/').filter(Boolean).map((part, index, parts) => {
            const target = parts.slice(0, index + 1).join('/');
            return <React.Fragment key={target}><Text style={styles.crumbSeparator}>/</Text><Pressable accessibilityRole="button" accessibilityLabel={`打开目录 ${part}`} disabled={target === path || loading || adding} onPress={() => { setQuery(''); setPath(target); }}><Text style={[styles.crumb, target === path && styles.crumbCurrent]} numberOfLines={1}>{part}</Text></Pressable></React.Fragment>;
          })}
        </ScrollView>
        {selected.size ? <Text style={styles.count}>{selected.size}/8</Text> : null}
      </View>
      <View style={styles.search}><Icon name="search" size={15} color={dk.muted} /><TextInput accessibilityLabel="搜索当前目录" value={query} onChangeText={setQuery} placeholder="搜索当前目录" placeholderTextColor={dk.muted} style={styles.searchInput} autoCapitalize="none" autoCorrect={false} />{query ? <Pressable accessibilityRole="button" accessibilityLabel="清除文件搜索" onPress={() => setQuery('')} style={styles.back}><Icon name="close" size={18} color={dk.muted} accent={dk.muted} /></Pressable> : null}</View>
      {error ? <View style={styles.error}><Icon name="alert" size={15} color={dk.bad} /><Text style={styles.errorText}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="重试文件目录" onPress={() => setReload(value => value + 1)}><Text style={styles.retry}>重试</Text></Pressable></View> : null}
      {loading ? <View style={styles.center}><ActivityIndicator size="small" color={dk.muted} /><Text style={styles.hint}>正在读取目录</Text></View>
        : <FlatList data={rows} keyExtractor={item => item.path} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const checked = selected.has(item.path);
            return <Pressable accessibilityRole={item.kind === 'file' ? 'checkbox' : 'button'} accessibilityLabel={item.kind === 'directory' ? `打开目录 ${item.name}` : `${checked ? '取消选择' : '选择'}文件 ${item.name}`} accessibilityState={item.kind === 'file' ? { checked, disabled: adding } : { disabled: adding }} disabled={adding} onPress={() => item.kind === 'directory' ? (setQuery(''), setPath(item.path)) : toggle(item)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <View style={[styles.fileIcon, item.kind === 'directory' && styles.folderIcon]}><Icon name={item.kind === 'directory' ? 'archive' : 'file'} size={17} color={item.kind === 'directory' ? dk.accentText : dk.text2} /></View>
              <View style={styles.rowBody}><Text style={styles.name} numberOfLines={1}>{item.name}</Text><Text style={styles.meta} numberOfLines={1}>{item.kind === 'directory' ? '文件夹' : item.size === undefined ? '文件' : `${Math.max(1, Math.ceil(item.size / 1024))} KB`}</Text></View>
              {item.kind === 'directory' ? <Icon name="chevronRight" size={15} color={dk.faint} /> : <View style={[styles.check, checked && styles.checkOn]}>{checked ? <Icon name="check" size={13} color={dk.onInk} /> : null}</View>}
            </Pressable>;
          }}
          ListEmptyComponent={<View style={styles.center}><Icon name="file" size={22} color={dk.faint} /><Text style={styles.hint}>{query ? '没有匹配的文件' : '这个目录没有可选择的文件'}</Text></View>}
          ListFooterComponent={page?.nextCursor ? <Pressable accessibilityRole="button" accessibilityLabel="加载更多文件" disabled={loading || adding} onPress={loadMore} style={styles.more}><Text style={styles.retry}>加载更多文件</Text></Pressable> : page?.truncated ? <Text style={styles.hint}>目录较大，仅显示部分内容</Text> : null}
        />}
    </View>
  </Sheet>;
}

const useStyles = themed((_c, d) => StyleSheet.create({
  body: { flex: 1, paddingHorizontal: 18 }, locationRow: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8 }, back: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }, crumbScroll: { flex: 1, minWidth: 0 }, crumbs: { alignItems: 'center', gap: 7, paddingRight: 4 }, crumb: { color: d.muted, fontSize: 13 }, crumbCurrent: { color: d.text, fontWeight: '600' }, crumbSeparator: { color: d.faint, fontSize: 12 }, count: { color: d.accentText, fontSize: 11, fontVariant: ['tabular-nums'] }, search: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: d.surface2, marginBottom: 8 }, searchInput: { flex: 1, minWidth: 0, color: d.text, fontSize: 13, paddingVertical: 0 }, list: { paddingBottom: 16 }, row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, borderRadius: 12 }, pressed: { backgroundColor: d.surface2 }, fileIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: d.surface2 }, folderIcon: { backgroundColor: d.accentSoft }, rowBody: { flex: 1, minWidth: 0, gap: 2 }, name: { color: d.text, fontSize: 13 }, meta: { color: d.muted, fontSize: 10.5 }, check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: d.lineStrong, alignItems: 'center', justifyContent: 'center' }, checkOn: { backgroundColor: d.accent, borderColor: d.accent }, footer: { minHeight: 66, paddingHorizontal: 18, paddingTop: 10, paddingBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: d.line }, selection: { flex: 1, color: d.muted, fontSize: 12 }, addButton: { minHeight: 42, minWidth: 92, paddingHorizontal: 16, borderRadius: 12, backgroundColor: d.ink, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, addText: { color: d.onInk, fontSize: 13, fontWeight: '600' }, disabled: { opacity: 0.45 }, center: { minHeight: 130, alignItems: 'center', justifyContent: 'center', gap: 8 }, hint: { color: d.muted, fontSize: 11, paddingVertical: 10 }, more: { minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: d.surface2, marginTop: 8 }, error: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 7 }, errorText: { flex: 1, color: d.bad, fontSize: 11, lineHeight: 16 }, retry: { color: d.accentText, fontSize: 11 },
}));
