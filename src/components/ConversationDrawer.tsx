import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Conversation } from '../domain';
import { useApp } from '../state/AppContext';
import { colors, prettyModel, radius, shadow } from '../theme';
import { BrandMark } from './Brand';
import { Icon } from './Icon';
import { AppDialog, dismissKeyboardAndBlur, MotionPressable, useReducedMotion, type DialogAction } from './ui';

export function ConversationDrawer({ visible, onClose, onNewChat, onOpenSettings }: {
  visible: boolean; onClose: () => void; onNewChat: () => void; onOpenSettings: () => void;
}) {
  const { conversations, activeConversationId, chatProvider, imageProvider, openConversation, deleteConversation, renameConversation, busy } = useApp();
  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(visible);
  const [menuFor, setMenuFor] = useState<Conversation | null>(null);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [renameText, setRenameText] = useState('');
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[]; icon?: string } | null>(null);
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;
  const width = Math.min(useWindowDimensions().width * 0.86, 340);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;

  useEffect(() => {
    if (visible) { setMounted(true); setQuery(''); drag.setValue(0); }
    const animation = visible
      ? Animated.spring(progress, { toValue: 1, damping: 24, stiffness: 230, useNativeDriver: true })
      : Animated.timing(progress, { toValue: 0, duration: reduced ? 0 : 200, easing: Easing.in(Easing.cubic), useNativeDriver: true });
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false); });
    return () => animation.stop();
  }, [visible, progress, drag, reduced]);

  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dx < -10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderMove: (_, g) => drag.setValue(Math.min(0, g.dx)),
    onPanResponderRelease: (_, g) => {
      if (g.dx < -80 || g.vx < -0.6) onCloseRef.current();
      else Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
    },
  })).current;

  const groups = useMemo(() => {
    const search = query.trim().toLowerCase();
    const matches = conversations.filter((item) => !search || item.title.toLowerCase().includes(search));
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const day = 86_400_000;
    const buckets: { title: string; items: Conversation[] }[] = ['今天', '昨天', '7 天内', '30 天内', '更早'].map((title) => ({ title, items: [] }));
    for (const item of [...matches].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const t = item.updatedAt;
      const index = t >= start.getTime() ? 0 : t >= start.getTime() - day ? 1 : t >= start.getTime() - 7 * day ? 2 : t >= start.getTime() - 30 * day ? 3 : 4;
      buckets[index].items.push(item);
    }
    return buckets.filter((group) => group.items.length);
  }, [conversations, query]);

  const report = (title: string, error: unknown) => setDialog({ title, message: error instanceof Error ? error.message : '请稍后再试', icon: 'alert' });
  const open = (conversation: Conversation) => {
    dismissKeyboardAndBlur();
    if (conversation.id === activeConversationId) { onClose(); return; }
    void openConversation(conversation.id).then(onClose).catch((error) => report('暂时无法切换', error));
  };
  const confirmDelete = (conversation: Conversation) => setDialog({
    title: '删除这个对话？', message: `“${conversation.title}”及其中的图片和文件会从这台设备上删除，无法恢复。`, icon: 'trash',
    actions: [
      { label: '取消', tone: 'secondary', onPress: () => setDialog(null) },
      { label: '删除', tone: 'danger', onPress: () => { setDialog(null); void deleteConversation(conversation.id).catch((error) => report('无法删除', error)); } },
    ],
  });
  const engineSummary = [prettyModel(chatProvider?.chatModel), prettyModel(imageProvider?.model)].filter(Boolean).join(' · ') || '连接你的 AI 服务';

  let rowIndex = 0;
  return <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <View style={styles.overlay}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.shade, { opacity: progress }]} />
      <Pressable accessibilityLabel="关闭侧边栏" style={StyleSheet.absoluteFill} onPress={onClose} />
      <Animated.View {...pan.panHandlers} style={[styles.panel, { width, transform: [{ translateX: Animated.add(drag, progress.interpolate({ inputRange: [0, 1], outputRange: [-width - 20, 0] })) }] }]}>
        <SafeAreaView style={styles.drawer} edges={['top', 'bottom']}>
          <View style={styles.topRow}>
            <View style={styles.search}>
              <Icon name="search" size={17} color={colors.subtle} />
              <TextInput placeholder="搜索" accessibilityLabel="搜索对话" value={query} onChangeText={setQuery} style={styles.searchInput} placeholderTextColor={colors.subtle} />
              {query ? <Pressable accessibilityLabel="清空搜索" hitSlop={8} onPress={() => setQuery('')}><Icon name="close" size={15} color={colors.subtle} strokeWidth={2} /></Pressable> : null}
            </View>
            <MotionPressable scaleTo={0.88} accessibilityRole="button" accessibilityLabel="新对话" disabled={busy} onPress={() => { dismissKeyboardAndBlur(); onNewChat(); onClose(); }} style={[styles.compose, busy && { opacity: 0.4 }]}>
              <Icon name="compose" size={21} color={colors.text} />
            </MotionPressable>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="开始新对话" disabled={busy} onPress={() => { dismissKeyboardAndBlur(); onNewChat(); onClose(); }} style={({ pressed }) => [styles.brandRow, pressed && { backgroundColor: colors.surface }]}>
            <BrandMark size={30} />
            <Text style={styles.brand}>Salcara</Text>
          </Pressable>

          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
            {!groups.length && <View style={styles.empty}>
              <Icon name={query ? 'search' : 'chat'} size={26} color={colors.faint} />
              <Text style={styles.emptyText}>{query ? '没有找到相关对话' : '对话会出现在这里'}</Text>
            </View>}
            {groups.map((group) => <View key={group.title}>
              <Text style={styles.groupLabel}>{group.title}</Text>
              {group.items.map((conversation) => {
                const active = conversation.id === activeConversationId;
                const delay = Math.min(rowIndex++, 12) * 22;
                return <DrawerRow key={conversation.id} delay={visible ? delay : 0} active={active} title={conversation.title}
                  onPress={() => open(conversation)} onMore={() => setMenuFor(conversation)} />;
              })}
            </View>)}
          </ScrollView>

          <Pressable accessibilityRole="button" accessibilityLabel="设置" onPress={() => { onClose(); onOpenSettings(); }} style={({ pressed }) => [styles.settings, pressed && { backgroundColor: colors.surface }]}>
            <View style={styles.avatar}><Icon name="settings" size={18} color={colors.textSecondary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.settingsTitle}>设置</Text>
              <Text style={styles.settingsHint} numberOfLines={1}>{engineSummary}</Text>
            </View>
            <Icon name="chevronRight" size={18} color={colors.faint} />
          </Pressable>
        </SafeAreaView>
      </Animated.View>
    </View>

    <AppDialog visible={Boolean(menuFor)} title={menuFor?.title ?? ''} icon="chat" onClose={() => setMenuFor(null)} actions={[
      { label: '重命名', tone: 'secondary', onPress: () => { const c = menuFor; setMenuFor(null); if (c) { setRenameText(c.title); setRenaming(c); } } },
      { label: '删除', tone: 'danger', onPress: () => { const c = menuFor; setMenuFor(null); if (c) confirmDelete(c); } },
    ]} />
    <AppDialog visible={Boolean(renaming)} title="重命名对话" icon="edit" onClose={() => setRenaming(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setRenaming(null) },
      { label: '保存', tone: 'primary', disabled: !renameText.trim(), onPress: () => { const c = renaming; setRenaming(null); if (c) void renameConversation(c.id, renameText).catch((error) => report('无法重命名', error)); } },
    ]}>
      <TextInput value={renameText} onChangeText={setRenameText} autoFocus selectTextOnFocus maxLength={60} style={styles.renameInput} placeholder="对话名称" placeholderTextColor={colors.subtle} />
    </AppDialog>
    <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} icon={dialog?.icon} actions={dialog?.actions} onClose={() => setDialog(null)} />
  </Modal>;
}

function DrawerRow({ title, active, delay, onPress, onMore }: { title: string; active: boolean; delay: number; onPress: () => void; onMore: () => void }) {
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(appear, { toValue: 1, duration: 260, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [appear, delay]);
  return <Animated.View style={{ opacity: appear, transform: [{ translateX: appear.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] }}>
    <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress} onLongPress={onMore} delayLongPress={320}
      style={({ pressed }) => [styles.row, active && styles.rowActive, pressed && !active && { backgroundColor: colors.surface }]}>
            <Text style={[styles.rowTitle, active && styles.rowTitleActive]} numberOfLines={1}>{title}</Text>
      <Pressable accessibilityLabel={`更多操作：${title}`} hitSlop={6} onPress={onMore} style={styles.more}><Icon name="more" size={18} color={active ? colors.text : colors.faint} /></Pressable>
    </Pressable>
  </Animated.View>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  shade: { backgroundColor: colors.scrim },
  panel: { flex: 1, backgroundColor: colors.card, ...shadow.float },
  drawer: { flex: 1, paddingHorizontal: 12 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8 },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 42, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surfaceStrong },
  searchInput: { flex: 1, height: 42, color: colors.text, fontSize: 15, padding: 0 },
  compose: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 48, paddingHorizontal: 8, marginTop: 14, borderRadius: 14 },
  brandIcon: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft },
  brand: { color: colors.text, fontSize: 15.5, fontWeight: '600' },
  list: { flex: 1, marginTop: 4 },
  groupLabel: { color: colors.subtle, fontSize: 12.5, fontWeight: '500', paddingTop: 18, paddingBottom: 6, paddingHorizontal: 10 },
  empty: { paddingVertical: 64, alignItems: 'center', gap: 12 },
  emptyText: { color: colors.subtle, fontSize: 13.5 },
  row: { height: 44, flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingLeft: 10, marginBottom: 1 },
  rowActive: { backgroundColor: colors.surfaceStrong },
  rowTitle: { flex: 1, color: colors.textSecondary, fontSize: 15 },
  rowTitleActive: { color: colors.text, fontWeight: '500' },
  more: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  settings: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 8, borderRadius: 16, marginBottom: 6, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceStrong },
  settingsTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  settingsHint: { color: colors.subtle, fontSize: 12, marginTop: 2 },
  renameInput: { minHeight: 48, borderRadius: 14, backgroundColor: colors.surfaceStrong, paddingHorizontal: 14, color: colors.text, fontSize: 15.5, marginTop: 8 },
});
