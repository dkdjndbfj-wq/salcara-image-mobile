import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Icon } from '../components/Icon';
import { showToast } from '../components/ui';
import { themed, useDesk } from '../theme';
import { mono } from './parts';
import { projectName } from './projection';
import { WorkspaceFileBrowser, type WorkspaceFileDirectories } from './WorkspaceFileBrowser';
import type { WorkspaceFileEntry } from './workspace-files';

/** Demo files use the same project-relative paths as the live file browser. */
function demoDirectories(files: Record<string, string>): WorkspaceFileDirectories {
  const directories = new Map<string, Map<string, WorkspaceFileEntry>>([['', new Map()]]);
  for (const path of Object.keys(files)) {
    const parts = path.split('/');
    let parent = '';
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index], child = parent ? `${parent}/${name}` : name;
      const kind = index === parts.length - 1 ? 'file' : 'directory';
      directories.get(parent)!.set(child, { name, path: child, kind });
      if (kind === 'directory' && !directories.has(child)) directories.set(child, new Map());
      parent = child;
    }
  }
  return Object.fromEntries([...directories].map(([path, entries]) => [path, { page: {
    path, truncated: false,
    entries: [...entries.values()].sort((left, right) => left.kind === right.kind
      ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1),
  } }]));
}

export function DemoWorkspaceFiles({ files, rootPath, onOpenFile }: {
  files: Record<string, string>; rootPath: string; onOpenFile: (path: string) => void;
}) {
  const styles = useStyles(), dk = useDesk();
  const directories = useMemo(() => demoDirectories(files), [files]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string>();
  const [wide, setWide] = useState(false);
  const toggleDirectory = (path: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const copyProjectPath = async () => {
    try { await Clipboard.setStringAsync(rootPath); showToast('项目路径已复制', 'checkCircle'); }
    catch { showToast('复制失败，请重试', 'alert'); }
  };
  const content = selectedPath === undefined ? undefined : files[selectedPath];
  const toolbarActions = selectedPath || rootPath ? (closeMenu: () => void) => <>
    {selectedPath ? <Pressable accessibilityRole="button" accessibilityLabel="在新标签页打开" onPress={() => { closeMenu(); onOpenFile(selectedPath); }} style={styles.action}>
      <Icon name="newTab" size={18} color={dk.muted} accent={dk.muted}/><Text style={styles.actionText}>在新标签页打开</Text>
    </Pressable> : null}
    {rootPath ? <Pressable accessibilityRole="button" accessibilityLabel="复制项目路径" onPress={() => { closeMenu(); void copyProjectPath(); }} style={styles.action}>
      <Icon name="copy" size={18} color={dk.muted}/><Text style={styles.actionText}>复制项目路径</Text>
    </Pressable> : null}
  </> : undefined;
  return <View testID="demo-workspace-files" onLayout={event => setWide(event.nativeEvent.layout.width >= 600)} style={styles.root}>
    <WorkspaceFileBrowser rootLabel={rootPath ? projectName(rootPath) : '工作区'} rootPath={rootPath} directories={directories}
      expandedPaths={expanded} selectedPath={selectedPath} onToggleDirectory={toggleDirectory} onLoadMore={() => {}}
      onSelectFile={setSelectedPath} onReturnToDirectory={() => setSelectedPath(undefined)} toolbarActions={toolbarActions}>
      {selectedPath !== undefined ? <View style={styles.root}>
        <Text numberOfLines={1} style={[styles.path, wide && styles.widePath]}>{selectedPath}</Text>
        <ScrollView style={styles.codeViewport} contentContainerStyle={styles.codeContent}>
          <ScrollView horizontal contentContainerStyle={styles.codeRow}>
            <View style={styles.gutter}>{(content ?? '').split('\n').map((_, index) => <Text key={index} style={[styles.lineNumber, wide && styles.wideCode]}>{index + 1}</Text>)}</View>
            <Text testID="demo-workspace-file-content" accessibilityLabel={`文件内容 ${selectedPath}`} selectable style={[styles.code, wide && styles.wideCode]}>{content ?? ''}</Text>
          </ScrollView>
        </ScrollView>
      </View> : null}
    </WorkspaceFileBrowser>
  </View>;
}

const useStyles = themed((_c, d) => StyleSheet.create({
  root: { flex: 1, minHeight: 0, minWidth: 0 },
  action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8 },
  actionText: { fontSize: 15, color: d.text },
  path: { paddingHorizontal: 14, paddingVertical: 10, fontSize: 13, color: d.muted }, widePath: { fontSize: 15 },
  codeViewport: { flex: 1, minHeight: 0 }, codeContent: { flexGrow: 1 },
  codeRow: { flexGrow: 1, alignItems: 'flex-start', paddingVertical: 8, paddingRight: 16 },
  gutter: { paddingHorizontal: 12, minWidth: 44 },
  lineNumber: { textAlign: 'right', fontFamily: mono, fontSize: 13, lineHeight: 22, color: d.muted },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 22, color: d.text }, wideCode: { fontSize: 16, lineHeight: 26 },
}));
