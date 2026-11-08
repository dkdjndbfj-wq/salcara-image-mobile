import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import { contextReferenceKey, isContextAnnotation, type ContextReference } from './context-references';

export function ContextReferenceChips({ references, onRemove, onAnnotationChange, onNavigate, editRequest, onFinishEditing, availableHeight = 240 }: {
  references: readonly ContextReference[]; onRemove?: (index: number) => void;
  onAnnotationChange?: (index: number, annotation: string) => void;
  onNavigate?: (reference: ContextReference) => void;
  editRequest?: { key: string; nonce: number }; onFinishEditing?: () => void; availableHeight?: number;
}) {
  const dk = useDesk(), [expanded, setExpanded] = useState<string>();
  const [annotationsOpen, setAnnotationsOpen] = useState(false), [editing, setEditing] = useState<string>();
  const annotations = references.map((item, index) => ({ item, index })).filter(({ item }) => isContextAnnotation(item));
  useEffect(() => {
    if (editRequest) { setAnnotationsOpen(true); setEditing(editRequest.key); }
  }, [editRequest]);
  const finish = () => { setEditing(undefined); onFinishEditing?.(); };
  return <View style={{ gap: 4 }}><View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
    {annotations.length ? <Pressable accessibilityRole="button" accessibilityLabel={`查看 ${annotations.length} 条注释`} accessibilityState={{ expanded: annotationsOpen }} aria-expanded={annotationsOpen}
      onPress={() => { setAnnotationsOpen(!annotationsOpen); if (annotationsOpen) finish(); }} style={{ backgroundColor: dk.surface2, borderRadius: 5, padding: 8, maxWidth: '100%' }}>
      <Text style={{ color: dk.accentText, fontSize: 12 }}>{annotations.length} 条注释</Text>
    </Pressable> : null}
    {references.map((item, index) => { if (isContextAnnotation(item)) return null; const key = contextReferenceKey(item); return <View key={key} style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '100%', backgroundColor: dk.surface2, borderRadius: 5 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`查看引用 ${item.label}`} accessibilityState={{ expanded: expanded === key }} aria-expanded={expanded === key} onPress={() => setExpanded(expanded === key ? undefined : key)} style={{ padding: 6, flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ color: dk.accentText, fontSize: 11 }}>{item.kind === 'file' ? `${item.label}:${item.startLine}–${item.endLine}` : item.label}</Text>
      </Pressable>{onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`移除引用 ${item.label}`} onPress={() => onRemove(index)} style={{ width: 32, height: 32, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}><Icon name="close" size={14} color={dk.muted} accent={dk.muted} /></Pressable> : null}
    </View>; })}
  </View>{annotationsOpen && annotations.length ? <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ maxHeight: Math.max(100, Math.min(240, availableHeight)), backgroundColor: dk.surface2, borderRadius: 8 }} contentContainerStyle={{ padding: 10, gap: 12 }}>
    {annotations.map(({ item, index }, ordinal) => { const key = contextReferenceKey(item), edit = editing === key && Boolean(onAnnotationChange); return <View key={key} style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ color: dk.muted, fontSize: 11, flex: 1 }}>{ordinal + 1}. {item.label}{item.kind === 'diff' ? ` · ${item.side === 'old' ? '旧版本' : '新版本'} ${item.startLine}–${item.endLine}` : ''}</Text>
        {onNavigate && item.kind === 'message' ? <Pressable accessibilityRole="button" accessibilityLabel={`查看注释 ${ordinal + 1} 的原消息`} onPress={() => onNavigate(item)} style={{ padding: 6 }}><Text style={{ color: dk.accentText, fontSize: 12 }}>原消息</Text></Pressable> : null}
        {onAnnotationChange && !edit ? <Pressable accessibilityRole="button" accessibilityLabel={`编辑注释 ${ordinal + 1}`} onPress={() => setEditing(key)} style={{ padding: 6 }}><Text style={{ color: dk.accentText, fontSize: 12 }}>编辑</Text></Pressable> : null}
        {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={`删除注释 ${ordinal + 1}`} onPress={() => { onRemove(index); if (edit) finish(); }} style={{ padding: 6 }}><Text style={{ color: dk.muted, fontSize: 12 }}>删除</Text></Pressable> : null}
      </View>
      <Text style={{ color: dk.muted, fontSize: 11 }}>{item.kind === 'diff' ? `差异快照 · 版本 ${item.sourceRevision?.slice(0, 12)} · ${item.path}` : '所选文本'}</Text>
      <Text selectable style={{ color: dk.text, fontSize: 12, lineHeight: 18, paddingLeft: 8, borderLeftColor: dk.accentText, borderLeftWidth: 2 }}>{item.text}</Text>
      {edit ? <View style={{ gap: 5 }}><TextInput accessibilityLabel={`注释 ${ordinal + 1} 的评论`} placeholder="添加可选评论…" placeholderTextColor={dk.muted}
        multiline autoFocus value={item.annotation ?? ''} onChangeText={value => onAnnotationChange?.(index, value)} maxLength={8192}
        style={{ color: dk.text, backgroundColor: dk.surface, padding: 8, borderRadius: 5, minHeight: 44, maxHeight: 120, textAlignVertical: 'top', fontSize: 13 }} />
        <Pressable accessibilityRole="button" accessibilityLabel={`完成编辑注释 ${ordinal + 1}`} onPress={finish} style={{ padding: 6, alignSelf: 'flex-end' }}><Text style={{ color: dk.accentText, fontSize: 12 }}>完成</Text></Pressable>
      </View> : item.annotation ? <View style={{ gap: 3 }}><Text style={{ color: dk.muted, fontSize: 11 }}>用户评论</Text><Text selectable style={{ color: dk.text, fontSize: 12, lineHeight: 18 }}>{item.annotation}</Text></View> : null}
    </View>; })}
  </ScrollView> : null}{references.map(item => !isContextAnnotation(item) && contextReferenceKey(item) === expanded ? <ScrollView key={expanded} style={{ maxHeight: 120, padding: 6, backgroundColor: dk.surface2 }}><Text selectable style={{ color: dk.text, fontSize: 11, lineHeight: 16 }}>{item.text}</Text></ScrollView> : null)}</View>;
}
