import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, prettyModel, radius } from '../theme';
import { Icon } from './Icon';
import { PrimaryButton, Sheet } from './ui';

/** Searchable model list. Typing a model ID is an optional fallback. */
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
  return <Sheet visible={visible} title={title} onClose={onClose} scroll={false}
    headerRight={<Pressable accessibilityLabel="刷新模型列表" disabled={loading} onPress={onRefresh} hitSlop={8} style={styles.refresh}>
      {loading ? <ActivityIndicator size="small" color={colors.primary} /> : <Icon name="regenerate" size={19} color={colors.textMuted} />}
    </Pressable>}>
    <View style={styles.body}>
      <View style={styles.search}>
        <Icon name="search" size={17} color={colors.subtle} />
        <TextInput accessibilityLabel="搜索模型" placeholder="搜索模型" value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} placeholderTextColor={colors.subtle} style={styles.searchInput} />
        {query ? <Pressable accessibilityLabel="清空模型搜索" hitSlop={8} onPress={() => setQuery('')}><Icon name="close" size={15} color={colors.subtle} strokeWidth={2} /></Pressable> : null}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList data={options} keyExtractor={(item) => item} style={styles.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        renderItem={({ item }) => {
          const selected = item === value;
          return <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={() => choose(item)}
            style={({ pressed }) => [styles.option, selected && styles.selected, pressed && { backgroundColor: colors.surfaceStrong }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.optionTitle, selected && { color: colors.primaryDeep }]}>{prettyModel(item)}</Text>
              <Text style={styles.optionId}>{item}</Text>
            </View>
            {selected && <Icon name="check" size={20} color={colors.primary} strokeWidth={2.2} />}
          </Pressable>;
        }}
        ListEmptyComponent={!loading ? <Text style={styles.empty}>{query ? '没有找到匹配的模型' : '没有读取到模型，可以手动填写'}</Text> : <Text style={styles.empty}>正在读取模型…</Text>} />
      <View style={styles.manual}>
        {manual ? <View style={styles.manualBody}>
          <TextInput accessibilityLabel="自定义模型 ID" value={customModel} onChangeText={setCustomModel} autoFocus placeholder="输入模型 ID" placeholderTextColor={colors.faint} autoCapitalize="none" autoCorrect={false} style={styles.manualInput} />
          <PrimaryButton label="使用这个模型" disabled={!customModel.trim()} onPress={() => choose(customModel)} />
        </View> : <Pressable accessibilityRole="button" onPress={() => setManual(true)} style={styles.manualToggle}>
          <Icon name="edit" size={17} color={colors.textMuted} />
          <Text style={styles.manualText}>手动填写模型 ID</Text>
        </Pressable>}
      </View>
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 12, gap: 8, flexShrink: 1 },
  refresh: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong },
  searchInput: { flex: 1, height: 44, color: colors.text, fontSize: 15.5, padding: 0 },
  error: { color: colors.warningText, fontSize: 12.5, lineHeight: 18, paddingHorizontal: 6 },
  list: { flexGrow: 0, maxHeight: 380, marginTop: 4 },
  option: { minHeight: 58, paddingVertical: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16 },
  selected: { backgroundColor: colors.blueSurface },
  optionTitle: { color: colors.text, fontSize: 15.5, fontWeight: '500' },
  optionId: { color: colors.faint, fontSize: 12, marginTop: 2 },
  empty: { paddingVertical: 36, color: colors.subtle, fontSize: 14, textAlign: 'center' },
  manual: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, marginTop: 4, paddingTop: 4 },
  manualToggle: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  manualText: { color: colors.textMuted, fontSize: 14.5 },
  manualBody: { gap: 12, paddingTop: 8 },
  manualInput: { height: 50, borderRadius: 16, backgroundColor: colors.surfaceStrong, color: colors.text, fontSize: 15.5, paddingHorizontal: 16 },
});
