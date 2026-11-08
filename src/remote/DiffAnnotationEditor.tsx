import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useDesk } from '../theme';
import { showToast } from '../components/ui';
import { diffSelectionReference, parseDiffForAnnotations } from './diff-annotations';
import type { ContextReference } from './context-references';
import { DiffView, mono } from './parts';

export function DiffAnnotationEditor({ path, diff, sessionKey, unavailableReason, onAdd, count = 0, presentation = 'editor', renderHunkMenu }: {
  path: string; diff: string; sessionKey?: string; unavailableReason?: string;
  onAdd?: (reference: ContextReference) => boolean | undefined; count?: number;
  presentation?: 'editor' | 'inline'; renderHunkMenu?: (hunk: number) => React.ReactNode;
}) {
  const dk = useDesk(), parsed = useMemo(() => parseDiffForAnnotations(path, diff), [path, diff]);
  const hunkGaps = useMemo(() => {
    const gaps = new Map<number, number>();
    let previousNewEnd = 0;
    for (const line of parsed.lines) {
      if (line.raw.startsWith('@@')) {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(line.raw);
        const start = Number(match?.[1] ?? 1), count = Number(match?.[2] ?? 1);
        gaps.set(line.hunk, Math.max(0, start + (count === 0 ? 1 : 0) - previousNewEnd - 1));
        previousNewEnd = start + Math.max(0, count - 1);
      }
    }
    return gaps;
  }, [parsed]);
  const [selection, setSelection] = useState<{ side: 'old' | 'new'; anchor: number; end: number }>();
  const [annotation, setAnnotation] = useState('');
  const [availableHeight, setAvailableHeight] = useState(640), compact = availableHeight < 320;
  const [availableWidth, setAvailableWidth] = useState(0), wide = availableWidth >= 600;
  const reason = unavailableReason || parsed.error || (!sessionKey || !onAdd ? '当前任务暂不支持差异批注' : undefined);
  const select = (side: 'old' | 'new', line: number) => {
    if (reason) return;
    setSelection(current => current?.side === side ? { ...current, end: line } : { side, anchor: line, end: line });
  };
  const start = selection ? Math.min(selection.anchor, selection.end) : 0, end = selection ? Math.max(selection.anchor, selection.end) : 0;
  const add = () => {
    if (reason || !selection || !sessionKey) return;
    try {
      if (onAdd?.(diffSelectionReference(parsed, sessionKey, selection.side, start, end, annotation))) {
        setSelection(undefined); setAnnotation(''); showToast('批注已加入当前任务草稿，发送后才会提交', 'checkCircle');
      }
    } catch (error) { showToast(error instanceof Error ? error.message : '无法添加差异批注', 'alert'); }
  };
  if (presentation === 'inline') return <View testID="inline-review-diff" style={{ minWidth: 0 }} onLayout={event => setAvailableWidth(event.nativeEvent.layout.width)}>
    {parsed.error ? <View><Text style={{ padding: 10, color: dk.muted, fontSize: wide ? 15 : 13 }}>{parsed.error}</Text><DiffView diff={diff} maxHeight={1_000_000}/></View> :
      <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ minWidth: '100%' }} keyboardShouldPersistTaps="handled">
        <View style={{ minWidth: '100%' }}>{parsed.lines.map((line, index) => {
          if (line.hunk < 0) return null;
          if (line.raw.startsWith('@@')) {
            const gap = hunkGaps.get(line.hunk) ?? 0;
            return <View key={index} style={{ width: availableWidth || undefined, minHeight: wide ? 48 : 34, flexDirection: 'row', alignItems: 'center', backgroundColor: dk.surface === '#FFFFFF' ? '#F3F3F3' : dk.surface2, paddingLeft: wide ? 10 : 8, paddingRight: 6 }}>
              <Text style={{ flex: 1, color: dk.muted, fontSize: wide ? 18 : 13 }}>{gap ? `${gap} 行未修改` : '变更'}</Text>{renderHunkMenu?.(line.hunk)}
            </View>;
          }
          const removed = line.oldLine !== undefined && line.newLine === undefined, added = line.newLine !== undefined && line.oldLine === undefined;
          const side = removed ? 'old' : 'new', value = removed ? line.oldLine : line.newLine;
          const selected = selection?.side === side && value !== undefined && value >= start && value <= end;
          const color = removed ? dk.bad : added ? dk.ok : dk.text;
          return <View key={index} style={{ flexDirection: 'row', alignItems: 'stretch', minHeight: wide ? 32 : 28, backgroundColor: removed ? dk.surface === '#FFFFFF' ? '#FBE6E2' : `${dk.bad}12` : added ? dk.surface === '#FFFFFF' ? '#E7F4E7' : `${dk.ok}12` : dk.surface }}>
            <Pressable accessibilityRole="button" accessibilityLabel={value === undefined ? `差异说明 ${index}` : `选择${side === 'old' ? '旧' : '新'}行 ${value}`}
              accessibilityState={{ disabled: Boolean(reason) || value === undefined, selected }} disabled={Boolean(reason) || value === undefined} onPress={() => value !== undefined && select(side, value)}
              style={{ width: wide ? 68 : 48, minHeight: wide ? 32 : 28, justifyContent: 'center', borderLeftWidth: wide ? 4 : 3, borderLeftColor: selected ? dk.accentText : removed ? dk.bad : added ? dk.ok : 'transparent', backgroundColor: selected ? dk.surface2 : undefined }}>
              <Text style={{ fontFamily: mono, fontSize: wide ? 16 : 12, color: selected ? dk.accentText : removed || added ? color : dk.muted, textAlign: 'center' }}>{value ?? ''}</Text>
            </Pressable>
            <Text selectable style={{ fontFamily: mono, fontSize: wide ? 17 : 14, lineHeight: wide ? 26 : 22, color, paddingVertical: 3, paddingHorizontal: 9 }}>{line.raw || ' '}</Text>
          </View>;
        })}</View>
      </ScrollView>}
    {selection && !reason ? <View style={{ padding: 10, gap: 6, borderTopWidth: 1, borderTopColor: dk.line, backgroundColor: dk.surface }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: dk.muted, fontSize: wide ? 15 : 12 }}>{selection.side === 'old' ? '旧版本' : '新版本'} · 第 {start}–{end} 行</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="清除差异选区" onPress={() => setSelection(undefined)} style={{ padding: 6 }}><Text style={{ color: dk.muted, fontSize: wide ? 16 : 14 }}>取消</Text></Pressable>
      </View>
      <TextInput accessibilityLabel="差异批注评论" multiline value={annotation} onChangeText={setAnnotation} maxLength={8192} placeholder="添加评论（可选）" placeholderTextColor={dk.muted}
        style={{ color: dk.text, backgroundColor: dk.surface2, fontSize: wide ? 16 : 14, minHeight: 44, maxHeight: 100, padding: 9, borderRadius: 7, textAlignVertical: 'top' }}/>
      <Pressable accessibilityRole="button" accessibilityLabel="加入差异批注草稿" onPress={add} style={{ padding: 8, alignSelf: 'flex-end' }}><Text style={{ color: dk.accentText, fontSize: wide ? 16 : 14 }}>加入草稿</Text></Pressable>
    </View> : null}
  </View>;
  return <View style={{ flex: 1, minHeight: 0 }} onLayout={event => setAvailableHeight(event.nativeEvent.layout.height)}>
    <View style={{ padding: 10, gap: 4, backgroundColor: dk.surface2 }}>
      {!compact || reason ? <Text style={{ color: dk.muted, fontSize: 12 }}>{reason || '点击旧行号或新行号选择；再点同侧行号选择范围。'}</Text> : null}
      <Text style={{ color: dk.muted, fontSize: 11 }}>差异版本 {parsed.revision.slice(0, 12)} · 草稿中 {count} 条批注</Text>
    </View>
    {parsed.error ? <ScrollView style={{ flex: 1 }}><DiffView diff={diff} maxHeight={1_000_000} /></ScrollView> : <FlatList keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ padding: 8 }}
      data={parsed.lines} keyExtractor={(_, index) => String(index)} extraData={[selection, reason]}
      ListHeaderComponent={<View style={{ flexDirection: 'row', paddingVertical: 6 }}><Text style={{ width: 48, color: dk.muted, textAlign: 'center' }}>旧</Text><Text style={{ width: 48, color: dk.muted, textAlign: 'center' }}>新</Text><Text style={{ color: dk.muted, fontSize: 12 }}>代码</Text></View>}
      renderItem={({ item: line, index }) => <View style={{ flexDirection: 'row', alignItems: 'stretch', backgroundColor: line.raw.startsWith('+') ? `${dk.ok}12` : line.raw.startsWith('-') ? `${dk.bad}12` : undefined }}>
          {(['old', 'new'] as const).map(side => { const value = side === 'old' ? line.oldLine : line.newLine, selected = selection?.side === side && value !== undefined && value >= start && value <= end;
            return <Pressable key={side} accessibilityRole="button" accessibilityLabel={value === undefined ? `${side === 'old' ? '旧' : '新'}侧无行号 ${index}` : `选择${side === 'old' ? '旧' : '新'}行 ${value}`}
              accessibilityState={{ disabled: !!reason || value === undefined, selected }} disabled={!!reason || value === undefined} onPress={() => value !== undefined && select(side, value)}
              style={{ width: 48, minHeight: 36, justifyContent: 'center', backgroundColor: selected ? dk.surface2 : undefined, borderLeftWidth: selected ? 2 : 0, borderColor: dk.accentText }}>
              <Text style={{ color: selected ? dk.accentText : dk.muted, fontFamily: mono, fontSize: 11, textAlign: 'center' }}>{value ?? ''}</Text>
            </Pressable>;
          })}
          <Text selectable style={{ flex: 1, color: dk.text, fontFamily: mono, fontSize: 12, lineHeight: 19, paddingVertical: 8 }}>{line.raw || ' '}</Text>
        </View>} />}
    {selection && !reason ? <View style={{ padding: 10, gap: 6, backgroundColor: dk.surface2, flexShrink: 0 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      <Text style={{ color: dk.text, fontSize: 12 }}>{selection.side === 'old' ? '旧版本' : '新版本'} · 第 {start}–{end} 行</Text>
      {compact ? <Pressable accessibilityRole="button" accessibilityLabel="清除差异选区" onPress={() => setSelection(undefined)}><Text style={{ color: dk.muted, fontSize: 12 }}>重选</Text></Pressable> : null}
      </View>
      <View style={compact ? { flexDirection: 'row', alignItems: 'flex-end', gap: 5 } : undefined}>
      <TextInput accessibilityLabel="差异批注评论" multiline value={annotation} onChangeText={setAnnotation} maxLength={8192} placeholder="添加评论（可选）" placeholderTextColor={dk.muted}
        style={{ color: dk.text, backgroundColor: dk.surface, minHeight: 44, maxHeight: compact ? 62 : 88, padding: 8, textAlignVertical: 'top', borderRadius: 6, ...(compact ? { flex: 1 } : {}) }} />
      {compact ? <Pressable accessibilityRole="button" accessibilityLabel="加入差异批注草稿" onPress={add} style={{ padding: 10 }}><Text style={{ color: dk.accentText, fontSize: 12 }}>加入草稿</Text></Pressable> : null}
      </View>
      {!compact ? <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="清除差异选区" onPress={() => setSelection(undefined)} style={{ padding: 10 }}><Text style={{ color: dk.muted }}>重选范围</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="加入差异批注草稿" onPress={add} style={{ padding: 10 }}><Text style={{ color: dk.accentText }}>加入草稿</Text></Pressable>
      </View> : null}
    </View> : null}
  </View>;
}
