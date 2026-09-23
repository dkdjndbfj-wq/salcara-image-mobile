import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApp } from '../state/AppContext';
import { colors, radius, spacing } from '../theme';
import { AppDialog, type DialogAction } from './ui';

export function ConversationDrawer({
  visible,
  onClose,
  onOpenProviders,
  onOpenAbout,
  onOpenNetwork,
  onOpenSettings,
}: {
  visible: boolean;
  onClose: () => void;
  onOpenProviders: () => void;
  onOpenAbout: () => void;
  onOpenNetwork: () => void;
  onOpenSettings: () => void;
}) {
  const { conversations, activeConversation, providers, startConversation, selectConversation, removeConversation } = useApp();
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[] } | null>(null);
  const providerName = (id: string) => providers.find((item) => item.id === id)?.name ?? '未知服务商';

  const createConversation = async () => {
    try {
      await startConversation();
      onClose();
    } catch (error) {
      setDialog({ title: '无法新建会话', message: error instanceof Error ? error.message : '请先检查服务商配置。' });
    }
  };

  const confirmDelete = (conversationId: string) => {
    setDialog({
      title: '删除这个会话？',
      message: '会话中的本地图片和文档也会被删除，此操作无法撤销。',
      actions: [
        { label: '取消', tone: 'secondary', onPress: () => setDialog(null) },
        { label: '删除', tone: 'danger', onPress: () => { setDialog(null); void removeConversation(conversationId).catch((error) => setDialog({ title: '无法删除', message: error.message })); } },
      ],
    });
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.drawer} edges={['top', 'bottom']}>
          <View style={styles.header}>
            <View><Text style={styles.brand}>Salcara AI</Text><Text style={styles.subtitle}>你的 AI 工作区</Text></View>
            <Pressable onPress={onClose} style={styles.icon}><Ionicons name="close" size={22} color={colors.text} /></Pressable>
          </View>
          <Pressable
            style={styles.newButton}
            onPress={() => void createConversation()}
          >
            <Ionicons name="add" size={20} color="#FFFFFF" />
            <Text style={styles.newText}>新会话</Text>
          </Pressable>
          <ScrollView style={styles.list} contentContainerStyle={{ gap: 2 }}>
            <Text style={styles.sectionLabel}>会话</Text>
            {conversations.length === 0 && <Text style={styles.empty}>开始对话后，会话会显示在这里。</Text>}
            {conversations.map((conversation) => (
              <Pressable
                key={conversation.id}
                onPress={() => void selectConversation(conversation.id).then(onClose).catch((error) => setDialog({ title: '无法切换', message: error.message }))}
                style={[styles.row, conversation.id === activeConversation?.id && styles.activeRow]}
              >
                <View style={styles.rowBody}>
                  <Text style={styles.title} numberOfLines={1}>{conversation.title}</Text>
                  <Text style={styles.meta}>{conversation.mode === 'chat' ? '对话' : conversation.mode === 'image' ? '生图' : '自动'} · {providerName(conversation.providerId)}</Text>
                </View>
                <Pressable
                  accessibilityLabel="删除会话"
                  onPress={() => confirmDelete(conversation.id)}
                  style={styles.delete}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
                </Pressable>
              </Pressable>
            ))}
          </ScrollView>
          <View style={styles.bottomActions}>
            <Text style={styles.sectionLabel}>设置</Text>
            <Pressable style={styles.providerButton} onPress={onOpenSettings}>
              <Ionicons name="settings-outline" size={20} color={colors.text} />
              <Text style={styles.providerText}>应用设置</Text>
            </Pressable>
            <Pressable style={styles.providerButton} onPress={onOpenNetwork}>
              <Ionicons name="pulse-outline" size={20} color={colors.text} />
              <Text style={styles.providerText}>网络诊断</Text>
            </Pressable>
            <Pressable style={styles.providerButton} onPress={onOpenProviders}>
              <Ionicons name="server-outline" size={20} color={colors.text} />
              <Text style={styles.providerText}>服务商管理</Text>
            </Pressable>
            <Pressable style={styles.providerButton} onPress={onOpenAbout}>
              <Ionicons name="information-circle-outline" size={20} color={colors.text} />
              <Text style={styles.providerText}>关于与更新</Text>
            </Pressable>
          </View>
        </SafeAreaView>
        <Pressable style={styles.dismiss} onPress={onClose} />
      </View>
      <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} actions={dialog?.actions} onClose={() => setDialog(null)} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(17,24,39,0.28)' },
  drawer: { width: '84%', maxWidth: 360, backgroundColor: colors.background, padding: spacing.md },
  dismiss: { flex: 1 },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { color: colors.text, fontSize: 16, fontWeight: '800' },
  subtitle: { color: colors.textMuted, marginTop: 2, fontSize: 11 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  newButton: { marginTop: spacing.md, minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: radius.md, backgroundColor: colors.primary },
  newText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  list: { flex: 1, marginTop: spacing.lg },
  sectionLabel: { color: colors.textMuted, fontSize: 11, fontWeight: '700', paddingVertical: spacing.sm },
  empty: { color: colors.textMuted, lineHeight: 18, paddingVertical: spacing.md, fontSize: 12 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', borderRadius: radius.sm, paddingLeft: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  activeRow: { backgroundColor: colors.blueSurface, borderBottomColor: colors.blueSurface },
  rowBody: { flex: 1, gap: 4 },
  title: { color: colors.text, fontWeight: '600', fontSize: 12 },
  meta: { color: colors.textMuted, fontSize: 10 },
  delete: { width: 42, height: 48, alignItems: 'center', justifyContent: 'center' },
  bottomActions: { borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.xs, gap: 2 },
  providerButton: { width: '100%', minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm },
  providerText: { color: colors.text, fontWeight: '600', fontSize: 12 },
});
