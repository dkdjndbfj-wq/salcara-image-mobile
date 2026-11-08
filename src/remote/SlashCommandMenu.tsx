import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, AppState, FlatList, Platform, Pressable, Text, View } from 'react-native';
import { useKeyboardViewportHeight } from '../components/KeyboardSafeView';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import { slashCommandDisabled, type SlashCommandEntry } from './slash-commands';

export interface SlashCommandMenuProps {
  entries: SlashCommandEntry[];
  onSelect: (entry: SlashCommandEntry) => void;
  onClose: () => void;
  onReload: () => void;
  loading?: boolean;
  error?: string;
  disabled?: boolean;
  selectedId?: string;
  sourceLabel?: string;
}
export function SlashCommandMenu({ entries, onSelect, onClose, onReload, loading = false, error = '', disabled = false, selectedId, sourceLabel }: SlashCommandMenuProps) {
  const d = useDesk(), height = useKeyboardViewportHeight();
  const list = useRef<FlatList<SlashCommandEntry>>(null);
  const mounted = useRef(true), latest = useRef({ entries, onSelect, disabled, loading, error });
  latest.current = { entries, onSelect, disabled, loading, error };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selectedIndex = entries.findIndex(entry => entry.id === selectedId);
  useEffect(() => {
    if (selectedIndex >= 0) list.current?.scrollToIndex({ index: selectedIndex, animated: false, viewPosition: 0.5 });
  }, [selectedIndex, entries]);
  return <View testID="remote-slash-menu" style={{ width: '100%', maxWidth: 440, alignSelf: 'flex-start', maxHeight: Math.max(44, Math.min(360, height * 0.45, height - 220)), backgroundColor: d.surface, borderColor: d.line, borderWidth: 1, borderRadius: 14, overflow: 'hidden', padding: 4, elevation: 8, shadowColor: d.shadow, shadowOpacity: 0.09, shadowRadius: 12 }}>
    <FlatList ref={list} testID="remote-slash-command-list" data={entries} keyExtractor={entry => entry.id} keyboardShouldPersistTaps="handled" nestedScrollEnabled
      onScrollToIndexFailed={({ averageItemLength, index }) => list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false })}
      initialNumToRender={8} maxToRenderPerBatch={8} style={{ flexGrow: 0 }}
      ListEmptyComponent={!loading && !error ? <Text style={{ color: d.muted, fontSize: 12, lineHeight: 16, padding: 8 }}>没有匹配的命令或技能</Text> : null}
      renderItem={({ item, index }) => {
        const selected = selectedId === item.id, skillGroup = item.kind === 'skill';
        const selectionDisabled = slashCommandDisabled(item, { disabled, loading, error });
        const firstInGroup = index === 0 || (entries[index - 1].kind === 'skill') !== skillGroup;
        const label = skillGroup ? `选择技能 ${item.label}，${item.command}${item.pathLabel ? `，${item.pathLabel}` : ''}`
          : item.kind === 'skills' ? '浏览技能命令' : `选择${item.label}，${item.command}`;
        return <View>
          {firstInGroup && skillGroup ? <Text accessibilityRole="header" style={{ color: d.muted, fontSize: 10.5, lineHeight: 14, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 3 }}>{`${sourceLabel ? `${sourceLabel} ` : ''}技能`}</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint={item.disabledReason || item.description} accessibilityState={{ disabled: selectionDisabled, selected }} disabled={selectionDisabled}
            onPress={() => {
              const current = latest.current, entry = current.entries.find(candidate => candidate.id === item.id);
              if (mounted.current && entry === item && !slashCommandDisabled(entry, current) && AppState.currentState !== 'background' && AppState.currentState !== 'inactive') current.onSelect(entry);
            }} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 8, paddingVertical: 7, gap: 9, borderRadius: 9, flexDirection: 'row', alignItems: 'center',
              backgroundColor: selected || pressed ? d.press : d.surface, opacity: selectionDisabled ? 0.45 : 1 })}>
            <Icon name={item.icon ?? (skillGroup || item.kind === 'skills' ? 'sparkle' : item.kind === 'mode' ? 'listCheck' : item.kind === 'compact' ? 'minimize' : 'code')} size={17} color={d.text2} strokeWidth={1.6} />
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <Text numberOfLines={1} style={{ color: d.muted, fontSize: 12.5, lineHeight: 19 }}>
                <Text style={{ color: d.text, fontSize: 13, fontWeight: '500' }}>{item.label}</Text>
                {item.disabledReason || item.description ? <Text>{`  ${item.disabledReason || item.description}`}</Text> : null}
              </Text>
              {item.pathLabel ? <Text numberOfLines={2} style={{ color: d.faint, fontSize: 10.5, lineHeight: 14 }}>{item.pathLabel}</Text> : null}
            </View>
            {item.submenu ? <Icon name="chevronRight" size={13} color={d.faint} strokeWidth={1.6} /> : null}
          </Pressable>
        </View>;
      }} />
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, paddingTop: 3, paddingBottom: 2 }}>
      {loading ? <ActivityIndicator accessibilityLabel="正在读取快捷命令" size="small" color={d.muted} /> : null}
      <Text accessibilityRole={error ? 'alert' : undefined} numberOfLines={2} style={{ color: error ? d.bad : d.faint, fontSize: 10.5, lineHeight: 14, flex: 1 }}>{error || (loading ? '正在读取…' : Platform.OS === 'web' ? '↑↓ 选择 · ↵ 确认' : '轻点选择')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新读取快捷命令" disabled={disabled || loading} onPress={onReload} hitSlop={8}><Icon name="history" size={13} color={d.muted} /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="关闭快捷命令" onPress={onClose} hitSlop={8}><Icon name="close" size={13} color={d.muted} /></Pressable>
    </View>
  </View>;
}

