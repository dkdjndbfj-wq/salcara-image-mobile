import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';
import type { FileEdit } from './blocks';
import type { BrowserNavigation } from './browser-navigation';
import { CompactActionMenu } from './CompactActionMenu';
import { localServiceCanOpenOnPhone, openLocalRemoteWebsite, openRemoteWebsite, resolveRemoteLink } from './remote-links';

export type UndoChangesResult = { message: string; restoredPaths: string[] };

/** Group presentation by path, retaining the original ordered edits for review/undo. */
export function groupFileChanges(files: FileEdit[]): FileEdit[] {
  const groups = new Map<string, FileEdit>();
  for (const file of files) {
    const previous = groups.get(file.path);
    groups.set(file.path, previous ? { ...file, id: previous.id,
      add: previous.add + file.add, del: previous.del + file.del,
      diff: [previous.diff, file.diff].filter(Boolean).join('\n'),
      status: previous.status === 'running' || file.status === 'running' ? 'running'
        : previous.status === 'failed' || file.status === 'failed' ? 'failed'
          : previous.status === 'interrupted' || file.status === 'interrupted' ? 'interrupted' : 'done',
    } : { ...file });
  }
  return [...groups.values()];
}

export function ConversationPreviewCard({ navigation, onOpen }: {
  navigation: BrowserNavigation; onOpen: (navigation: BrowserNavigation) => void;
}) {
  const dk = useDesk(), s = useStyles();
  const identity = JSON.stringify([navigation.url, navigation.pageId, navigation.action]);
  const [menu, setMenu] = useState(false), anchor = useRef<View>(null);
  useEffect(() => { setMenu(false); }, [identity]);
  const link = resolveRemoteLink(navigation.url);
  const external = link.kind === 'web' || link.kind === 'local-service' && localServiceCanOpenOnPhone(navigation.url);
  const select = (value: 'app' | 'external' | 'copy') => {
    if (value === 'external' && !external) return;
    if (value === 'app') onOpen(navigation);
    else if (value === 'external') {
      if (link.kind === 'local-service') openLocalRemoteWebsite(navigation.url); else openRemoteWebsite(navigation.url);
    } else void Clipboard.setStringAsync(navigation.url);
  };
  return <View testID="conversation-preview-card" style={s.card}>
    <View style={s.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={`打开网页预览 ${navigation.url}`} onPress={() => onOpen(navigation)} style={s.main}>
        <View style={s.glyph}><Icon name="globe" size={22} color={dk.muted} accent={dk.muted} strokeWidth={1.6}/></View>
        <View style={s.heading}><Text style={s.title}>网页预览</Text><Text selectable numberOfLines={1} style={s.subtitle}>{navigation.url}</Text></View>
      </Pressable>
      <Pressable ref={anchor} collapsable={false} accessibilityRole="button" accessibilityLabel="网页预览打开方式" accessibilityState={{expanded:menu}} aria-expanded={menu} onPress={() => setMenu(value=>!value)} style={s.button}>
        <Text style={s.buttonText}>打开方式</Text><View style={menu ? {transform:[{rotate:'180deg'}]} : undefined}><Icon name="chevronDown" size={14} color={dk.muted} accent={dk.muted} /></View>
      </Pressable>
    </View>
    <CompactActionMenu visible={menu} anchorRef={anchor} scopeKey={identity} onClose={()=>setMenu(false)} width={156} placement="bottom" align="end" testID="preview-open-menu" label="网页打开方式" actions={[
      {id:'app',label:'在应用内打开',icon:'newTab',onPress:()=>select('app')},
      {id:'external',label:'在浏览器打开',icon:'external',disabled:!external,onPress:()=>select('external')},
      {id:'copy',label:'复制链接',icon:'copy',onPress:()=>select('copy')},
    ]}/>
  </View>;
}

export function ConversationChangesCard({ files, onOpenFile, onReview, onUndo, undoUnavailable }: {
  files: FileEdit[]; onOpenFile: (file: FileEdit) => void; onReview: (files: FileEdit[]) => void;
  onUndo?: (files: FileEdit[]) => Promise<UndoChangesResult>; undoUnavailable?: string;
}) {
  const dk = useDesk(), s = useStyles();
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UndoChangesResult | null>(null);
  const owner = useRef(0);
  const signature = JSON.stringify(files.map(file => [file.id, file.path, file.status, file.diff]));
  useEffect(() => { owner.current++; setResult(null); setBusy(false); setConfirm(false); return () => { owner.current++; }; }, [signature]);
  const grouped = groupFileChanges(files);
  const add = grouped.reduce((total, file) => total + file.add, 0), del = grouped.reduce((total, file) => total + file.del, 0);
  const complete = grouped.every(file => file.status === 'done');
  const undone = Boolean(result && grouped.every(file => result.restoredPaths.includes(file.path)));
  const undo = async () => {
    if (!onUndo || busy || !complete || undone) return;
    const epoch = owner.current;
    setConfirm(false); setBusy(true);
    try {
      const restored = result?.restoredPaths ?? [];
      const value = await onUndo(files.filter(file => !restored.includes(file.path)));
      if (epoch === owner.current) setResult({...value,restoredPaths:[...new Set([...restored,...value.restoredPaths])]});
    }
    catch (error) { if (epoch === owner.current) setResult({ message: error instanceof Error ? error.message : '撤销未完成，请检查电脑上的文件', restoredPaths: [] }); }
    finally { if (epoch === owner.current) setBusy(false); }
  };
  if (!grouped.length) return null;
  return <View testID="conversation-changes-card" style={s.card}>
    <View style={[s.header, s.wrap]}>
      <View style={s.main}><View style={s.glyph}><Icon name="file" size={24} color={dk.muted} /></View>
        <View style={s.heading}><Text style={s.title}>{undone ? '已撤销' : complete ? '已编辑' : grouped.some(file => file.status === 'running') ? '正在编辑' : '文件变更'} {grouped.length} 个文件</Text>
          <View style={s.stats}><Text style={[s.count, { color: dk.ok }]}>+{add}</Text><Text style={[s.count, { color: dk.bad }]}>-{del}</Text>
            {grouped.length < files.length ? <Text style={s.detail}>累计改动</Text> : null}</View>
        </View>
      </View>
      <View style={s.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel="撤销本组文件变更" accessibilityHint={undoUnavailable}
          disabled={!onUndo || !complete || busy || undone} onPress={() => setConfirm(value => !value)}
          style={[s.quietButton, (!onUndo || !complete || busy || undone) && s.disabled]}>
          <Text style={s.buttonText}>{busy ? '撤销中' : undone ? '已撤销' : '撤销'}</Text>
          {busy ? <ActivityIndicator size="small" color={dk.muted} /> : <Icon name="undo" size={16} color={dk.text2} />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="查看本组文件变更" onPress={() => onReview(files)} style={s.button}><Text style={s.buttonText}>查看变更</Text></Pressable>
      </View>
    </View>
    {confirm ? <View style={s.notice}><Text style={s.note}>撤销这 {grouped.length} 个文件的本组修改？会先核对电脑上的当前内容；存在冲突的文件不会覆盖。</Text>
      <View style={s.actions}><Pressable accessibilityRole="button" onPress={() => setConfirm(false)} style={s.quietButton}><Text style={s.buttonText}>取消</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="确认撤销文件变更" onPress={() => void undo()} style={s.button}><Text style={s.buttonText}>确认撤销</Text></Pressable></View>
    </View> : null}
    {result || undoUnavailable ? <Text accessibilityLiveRegion="polite" style={s.note}>{result?.message ?? undoUnavailable}</Text> : null}
    <View style={s.files}>{grouped.map(file => <Pressable key={file.path} accessibilityRole="button" accessibilityLabel={`查看修改文件 ${file.path}`}
      onPress={() => onOpenFile(file)} style={s.file}>
      <Text style={s.path} numberOfLines={1} ellipsizeMode="middle">{file.status === 'running' ? `正在编辑 · ${file.path}` : file.path}</Text>
      {result?.restoredPaths.includes(file.path) ? <Text style={s.detail}>已撤销</Text> : <View style={s.stats}><Text style={[s.count, { color: dk.ok }]}>+{file.add}</Text><Text style={[s.count, { color: dk.bad }]}>-{file.del}</Text></View>}
    </Pressable>)}</View>
  </View>;
}

const useStyles = themed((_, d) => StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, borderColor: d.line, backgroundColor: d.surface, marginTop: 12, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16 }, wrap: { flexWrap: 'wrap' },
  main: { flexDirection: 'row', alignItems: 'center', gap: 13, flex: 1, minWidth: 150 },
  glyph: { width: 48, height: 48, borderRadius: 13, backgroundColor: d.surface2, alignItems: 'center', justifyContent: 'center' },
  heading: { flex: 1, minWidth: 0, gap: 5 }, title: { fontSize: 16, fontWeight: '600', color: d.text },
  subtitle: { color: d.muted, fontSize: 13 }, stats: { flexDirection: 'row', alignItems: 'center', gap: 5 }, count: { fontSize: 14, fontVariant: ['tabular-nums'] },
  detail: { fontSize: 11, color: d.muted }, actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' },
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: d.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, minHeight: 36 },
  quietButton: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingVertical: 9, paddingHorizontal: 4, minHeight: 36 }, buttonText: { color: d.text2, fontSize: 14 }, disabled: { opacity: 0.4 },
  files: { borderTopWidth: 1, borderTopColor: d.line, paddingVertical: 5 }, file: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 11 },
  path: { flex: 1, minWidth: 0, fontSize: 14, color: d.text2 }, notice: { paddingBottom: 12, paddingHorizontal: 16 }, note: { color: d.muted, fontSize: 12, lineHeight: 18, paddingHorizontal: 16, paddingBottom: 12 },
}));
