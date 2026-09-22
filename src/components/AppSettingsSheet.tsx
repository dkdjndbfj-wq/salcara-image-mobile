import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext';
import { colors, radius, spacing } from '../theme';
import { Chip, PrimaryButton, Sheet } from './ui';

export function AppSettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { composerMode, setComposerMode, activeProvider } = useApp();
  return <Sheet visible={visible} title="应用设置" onClose={onClose}>
    <View style={styles.body}>
      <View style={styles.card}>
        <Text style={styles.title}>默认工作模式</Text>
        <Text style={styles.hint}>Salcara AI 默认以通用对话开始；需要生图时再切换模式。</Text>
        <View style={styles.chips}>
          <Chip label="对话" selected={composerMode === 'chat'} onPress={() => void setComposerMode('chat')} />
          <Chip label="图片创作" selected={composerMode === 'image'} onPress={() => void setComposerMode('image')} />
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.title}>当前连接</Text>
        <Text style={styles.value}>{activeProvider?.name ?? '尚未配置服务商'}</Text>
        <Text style={styles.hint}>{activeProvider ? '服务商地址、模型和密钥可在“服务商管理”中分别配置。密钥只保存到本机安全存储。' : '先添加一个服务商，才能开始对话或图片创作。'}</Text>
      </View>
      <PrimaryButton label="完成" icon="checkmark" onPress={onClose} />
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.md },
  card: { padding: spacing.md, gap: spacing.sm, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  title: { color: colors.text, fontSize: 15, fontWeight: '800' },
  value: { color: colors.primaryStrong, fontSize: 14, fontWeight: '700' },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 19 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
