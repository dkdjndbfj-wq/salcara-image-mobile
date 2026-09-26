import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius } from '../theme';
import { PrimaryButton, Sheet } from './ui';

/** Shared searchable selection surface. Typing a model ID is an optional fallback. */
export function ModelSelect({ visible, title, value, models, loading = false, error, onClose, onSelect, onRefresh }: {
  visible: boolean; title: string; value: string; models: string[]; loading?: boolean; error?: string | null;
  onClose: () => void; onSelect: (model: string) => void; onRefresh: () => void;
}) {
  const [query, setQuery] = useState('');
  const [manual, setManual] = useState(false);
  const [customModel, setCustomModel] = useState('');
  useEffect(() => { if (visible) { setQuery(''); setManual(false); setCustomModel(''); } }, [visible]);
  const options = useMemo(() => [...new Set([value, ...models].filter(Boolean))]
    .filter((item) => item.toLowerCase().includes(query.trim().toLowerCase())), [value, models, query]);
  const choose = (model: string) => { if (!model.trim()) return; onSelect(model.trim()); onClose(); };
  return <Sheet visible={visible} title={title} onClose={onClose} scroll={false}>
    <View style={styles.body}>
      <View style={styles.search}>
        <Ionicons name="search-outline" size={18} color={colors.textMuted} />
        <TextInput accessibilityLabel="搜索模型" placeholder="搜索模型名称" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.textMuted} style={styles.searchInput} />
        {query ? <Pressable accessibilityLabel="清空模型搜索" onPress={() => setQuery('')} style={styles.clear}><Ionicons name="close-circle" size={17} color={colors.textMuted} /></Pressable> : null}
      </View>
      <View style={styles.listHeader}><Text style={styles.caption}>{loading ? '正在读取模型…' : `${options.length} 个可选模型`}</Text><Pressable accessibilityLabel="刷新模型列表" disabled={loading} onPress={onRefresh} style={styles.refresh}>{loading ? <ActivityIndicator size="small" color={colors.primaryStrong} /> : <Ionicons name="refresh-outline" size={17} color={colors.primaryStrong} />}<Text style={styles.link}>刷新</Text></Pressable></View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList data={options} keyExtractor={(item) => item} style={styles.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityState={{ selected: item === value }} style={({ pressed }) => [styles.option, item === value && styles.selected, pressed && styles.pressed]} onPress={() => choose(item)}><Text style={[styles.optionText, item === value && styles.selectedText]}>{item}</Text>{item === value && <Ionicons name="checkmark" size={20} color={colors.primaryStrong} />}</Pressable>} ListEmptyComponent={!loading ? <Text style={styles.empty}>{query ? '没有找到匹配的模型' : '点击刷新读取服务商的模型列表'}</Text> : null} />
      <View style={styles.manual}>
        <Pressable style={styles.manualToggle} onPress={() => setManual((open) => !open)}><Text style={styles.caption}>没有找到需要的模型？</Text><Text style={styles.link}>{manual ? '收起' : '手动添加'}</Text></Pressable>
        {manual && <View style={styles.manualBody}><TextInput accessibilityLabel="自定义模型 ID" value={customModel} onChangeText={setCustomModel} placeholder="输入服务商提供的模型 ID" placeholderTextColor={colors.textMuted} autoCapitalize="none" autoCorrect={false} style={styles.manualInput} /><PrimaryButton label="使用这个模型" disabled={!customModel.trim()} onPress={() => choose(customModel)} /></View>}
      </View>
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingBottom: 16, gap: 8, flexShrink: 1 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 46, paddingLeft: 13, borderRadius: radius.md, backgroundColor: colors.surface },
  searchInput: { flex: 1, minHeight: 46, color: colors.text, fontSize: 15 },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  listHeader: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  caption: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  refresh: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 12 },
  link: { color: colors.primaryStrong, fontSize: 13, fontWeight: '600' },
  list: { flexGrow: 0, maxHeight: 340 },
  option: { minHeight: 52, paddingVertical: 13, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radius.sm },
  optionText: { flex: 1, fontSize: 14, lineHeight: 21, color: colors.text },
  selected: { backgroundColor: colors.blueSurface },
  selectedText: { color: colors.primaryStrong, fontWeight: '600' },
  pressed: { opacity: 0.65 },
  error: { color: colors.warningText, fontSize: 12, lineHeight: 18, paddingBottom: 4 },
  empty: { paddingVertical: 30, color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  manual: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginTop: 6 },
  manualToggle: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  manualBody: { gap: 12, paddingBottom: 8 },
  manualInput: { minHeight: 46, borderBottomWidth: 1, borderColor: colors.border, color: colors.text, fontSize: 14, paddingHorizontal: 2 },
});
