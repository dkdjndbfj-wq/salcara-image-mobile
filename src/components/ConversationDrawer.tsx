import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useApp } from '../state/AppContext';
import { colors, radius, spacing } from '../theme';

export function ConversationDrawer({
  visible,
  onClose,
  onOpenProviders,
}: {
  visible: boolean;
  onClose: () => void;
  onOpenProviders: () => void;
}) {
  const { conversations, activeConversation, providers, startConversation, selectConversation, removeConversation } = useApp();
  const providerName = (id: string) => providers.find((item) => item.id === id)?.name ?? '未知服务商';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.drawer} edges={['top', 'bottom']}>
          <View style={styles.header}>
            <View><Text style={styles.brand}>Salcara Image</Text><Text style={styles.subtitle}>本地图片工作台</Text></View>
            <Pressable onPress={onClose} style={styles.icon}><Ionicons name="close" size={22} color={colors.text} /></Pressable>
          </View>
          <Pressable
            style={styles.newButton}
            onPress={() => void startConversation().then(onClose).catch((error) => Alert.alert('无法新建', error.message))}
          >
            <Ionicons name="add" size={20} color={colors.primaryStrong} />
            <Text style={styles.newText}>新会话</Text>
          </Pressable>
          <View style={styles.list}>
            <Text style={styles.sectionLabel}>最近会话</Text>
            {conversations.length === 0 && <Text style={styles.empty}>生成第一张图片后，会话会显示在这里。</Text>}
            {conversations.map((conversation) => (
              <Pressable
                key={conversation.id}
                onPress={() => void selectConversation(conversation.id).then(onClose)}
                style={[styles.row, conversation.id === activeConversation?.id && styles.activeRow]}
              >
                <View style={styles.rowBody}>
                  <Text style={styles.title} numberOfLines={1}>{conversation.title}</Text>
                  <Text style={styles.meta}>{providerName(conversation.providerId)}</Text>
                </View>
                <Pressable
                  accessibilityLabel="删除会话"
                  onPress={() => Alert.alert('删除这个会话？', '会话中的本地图片也会被删除。', [
                    { text: '取消', style: 'cancel' },
                    { text: '删除', style: 'destructive', onPress: () => void removeConversation(conversation.id) },
                  ])}
                  style={styles.delete}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
                </Pressable>
              </Pressable>
            ))}
          </View>
          <Pressable style={styles.providerButton} onPress={onOpenProviders}>
            <Ionicons name="server-outline" size={20} color={colors.text} />
            <Text style={styles.providerText}>服务商管理</Text>
          </Pressable>
        </SafeAreaView>
        <Pressable style={styles.dismiss} onPress={onClose} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: 'row', backgroundColor: 'rgba(17,24,39,0.28)' },
  drawer: { width: '84%', maxWidth: 360, backgroundColor: colors.background, padding: spacing.lg },
  dismiss: { flex: 1 },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { color: colors.text, fontSize: 20, fontWeight: '800' },
  subtitle: { color: colors.textMuted, marginTop: 2, fontSize: 12 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  newButton: { marginTop: spacing.lg, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, borderRadius: radius.md, backgroundColor: colors.blueSurface, borderWidth: 1, borderColor: colors.primary },
  newText: { color: colors.primaryStrong, fontWeight: '700' },
  list: { flex: 1, gap: spacing.sm, marginTop: spacing.xl },
  sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  empty: { color: colors.textMuted, lineHeight: 20, paddingVertical: spacing.md },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', borderRadius: radius.md, paddingLeft: spacing.md },
  activeRow: { backgroundColor: colors.blueSurface },
  rowBody: { flex: 1, gap: 4 },
  title: { color: colors.text, fontWeight: '600', fontSize: 14 },
  meta: { color: colors.textMuted, fontSize: 11 },
  delete: { width: 42, height: 48, alignItems: 'center', justifyContent: 'center' },
  providerButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.md },
  providerText: { color: colors.text, fontWeight: '700' },
});
