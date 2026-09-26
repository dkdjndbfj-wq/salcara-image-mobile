import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Conversation } from '../domain';
import { useApp } from '../state/AppContext';
import { colors, radius } from '../theme';
import { AppDialog, dismissKeyboardAndBlur, type DialogAction } from './ui';
import { useReducedMotion } from './MotionPressable';

export function ConversationDrawer({ visible, onClose, onOpenProviders, onOpenSettings }: {
  visible: boolean; onClose: () => void; onOpenProviders: () => void; onOpenAbout: () => void; onOpenNetwork: () => void; onOpenSettings: () => void;
}) {
  const { conversations, activeConversation, providers, startConversation, selectConversation, removeConversation } = useApp();
  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(visible);
  const reduceMotion = useReducedMotion();
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[] } | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const drawerWidth = Math.min(useWindowDimensions().width * 0.86, 360);
  useEffect(() => {
    if (visible) { setMounted(true); setQuery(''); }
    const animation = Animated.timing(progress, { toValue: visible ? 1 : 0, duration: reduceMotion ? 0 : visible ? 240 : 180, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false); });
    return () => animation.stop();
  }, [visible, progress, reduceMotion]);

  const groups = useMemo(() => {
    const search = query.trim().toLowerCase();
    const matches = conversations.filter((conversation) => !search || conversation.title.toLowerCase().includes(search));
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const yesterday = new Date(start); yesterday.setDate(yesterday.getDate() - 1);
    const week = new Date(start); week.setDate(week.getDate() - 7);
    const result: { title: string; items: Conversation[] }[] = ['今天', '昨天', '最近 7 天', '更早'].map((title) => ({ title, items: [] }));
    for (const item of [...matches].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const index = item.updatedAt >= start.getTime() ? 0 : item.updatedAt >= yesterday.getTime() ? 1 : item.updatedAt >= week.getTime() ? 2 : 3;
      result[index].items.push(item);
    }
    return result.filter((group) => group.items.length);
  }, [conversations, query]);

  const createConversation = async () => {
    dismissKeyboardAndBlur();
    if (!providers.length) { onClose(); onOpenProviders(); return; }
    try { await startConversation(); onClose(); }
    catch (error) { setDialog({ title: '无法新建会话', message: error instanceof Error ? error.message : '请先检查服务商配置。' }); }
  };
  const confirmDelete = (conversation: Conversation) => setDialog({
    title: '删除会话？', message: `“${conversation.title}”及其中的本地图片和文件将从此设备删除。`,
    actions: [
      { label: '取消', tone: 'secondary', onPress: () => setDialog(null) },
      { label: '删除', tone: 'danger', onPress: () => { setDialog(null); void removeConversation(conversation.id).catch((error) => setDialog({ title: '无法删除', message: error.message })); } },
    ],
  });

  return <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <View style={styles.overlay}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade, { opacity: progress }]} />
      <Pressable accessibilityLabel="关闭会话列表" style={StyleSheet.absoluteFill} onPress={onClose} />
      <Animated.View style={[styles.panel, { width: drawerWidth, transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-drawerWidth, 0] }) }] }]}>
        <SafeAreaView style={styles.drawer} edges={['top', 'bottom']}>
          <View style={styles.header}><Text style={styles.brand}>Salcara AI</Text><Pressable accessibilityLabel="关闭侧边栏" onPress={onClose} style={styles.icon}><Ionicons name="chevron-back" size={22} color={colors.textMuted} /></Pressable></View>
          <View style={styles.search}><Ionicons name="search-outline" size={18} color={colors.textMuted} /><TextInput placeholder="搜索会话" accessibilityLabel="搜索会话" value={query} onChangeText={setQuery} style={styles.searchInput} placeholderTextColor={colors.textMuted} />{query ? <Pressable accessibilityLabel="清空搜索" style={styles.clear} onPress={() => setQuery('')}><Ionicons name="close-circle" size={16} color={colors.textMuted} /></Pressable> : null}</View>
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.newButton, pressed && styles.pressed]} onPress={() => void createConversation()}><Ionicons name="create-outline" size={20} color={colors.primaryStrong} /><Text style={styles.newText}>新会话</Text><Ionicons name="add" size={19} color={colors.primaryStrong} /></Pressable>
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
            {!groups.length && <View style={styles.empty}><Ionicons name={query ? 'search-outline' : 'chatbubbles-outline'} size={28} color={colors.textMuted} /><Text style={styles.emptyText}>{query ? '没有找到相关会话' : '从一个问题开始'}</Text></View>}
            {groups.map((group) => <View key={group.title}><Text style={styles.sectionLabel}>{group.title}</Text>{group.items.map((conversation) => <Pressable key={conversation.id} accessibilityRole="button" accessibilityState={{ selected: conversation.id === activeConversation?.id }} onPress={() => { dismissKeyboardAndBlur(); void selectConversation(conversation.id).then(onClose).catch((error) => setDialog({ title: '无法切换', message: error.message })); }} onLongPress={() => confirmDelete(conversation)} style={({ pressed }) => [styles.row, conversation.id === activeConversation?.id && styles.activeRow, pressed && styles.pressed]}><Text style={[styles.title, conversation.id === activeConversation?.id && styles.activeTitle]} numberOfLines={1}>{conversation.title}</Text><Pressable accessibilityLabel={`会话选项：${conversation.title}`} onPress={() => confirmDelete(conversation)} style={styles.more}><Ionicons name="ellipsis-horizontal" size={16} color={colors.textMuted} /></Pressable></Pressable>)}</View>)}
          </ScrollView>
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.settings, pressed && styles.pressed]} onPress={onOpenSettings}><View style={styles.settingsIcon}><Ionicons name="settings-outline" size={21} color={colors.text} /></View><View style={styles.settingsCopy}><Text style={styles.settingsTitle}>设置</Text><Text style={styles.settingsHint}>服务商、偏好与更新</Text></View><Ionicons name="chevron-forward" size={17} color={colors.textMuted} /></Pressable>
        </SafeAreaView>
      </Animated.View>
    </View>
    <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} actions={dialog?.actions} onClose={() => setDialog(null)} />
  </Modal>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1 }, shade: { backgroundColor: 'rgba(15,23,42,0.25)' },
  panel: { flex: 1, backgroundColor: colors.background },
  drawer: { flex: 1, paddingHorizontal: 16 },
  header: { height: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 7 },
  brand: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 44, paddingLeft: 12, borderRadius: radius.md, backgroundColor: colors.surface },
  searchInput: { flex: 1, minHeight: 44, color: colors.text, fontSize: 14 },
  clear: { width: 42, height: 44, alignItems: 'center', justifyContent: 'center' },
  newButton: { marginTop: 12, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 13, borderRadius: radius.md, backgroundColor: colors.blueSurface },
  newText: { flex: 1, color: colors.primaryStrong, fontWeight: '600', fontSize: 14 },
  list: { flex: 1, marginTop: 14 }, listContent: { paddingBottom: 18 },
  sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '500', paddingTop: 15, paddingBottom: 9, paddingHorizontal: 10 },
  empty: { paddingVertical: 48, alignItems: 'center', gap: 14 }, emptyText: { color: colors.textMuted, fontSize: 13 },
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', borderRadius: radius.sm, paddingLeft: 12, marginBottom: 2 },
  activeRow: { backgroundColor: colors.surface },
  title: { flex: 1, color: colors.text, fontSize: 14 }, activeTitle: { fontWeight: '600' },
  more: { width: 44, height: 48, alignItems: 'center', justifyContent: 'center' },
  settings: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: 7 },
  settingsIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  settingsCopy: { flex: 1, gap: 4 }, settingsTitle: { color: colors.text, fontSize: 14, fontWeight: '600' }, settingsHint: { color: colors.textMuted, fontSize: 12 },
  pressed: { opacity: 0.65 },
});
