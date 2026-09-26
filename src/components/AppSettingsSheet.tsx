import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ComposerMode } from '../domain';
import { useApp } from '../state/AppContext';
import { colors, radius } from '../theme';
import { AppDialog, Sheet } from './ui';

const MODES: { value: ComposerMode; title: string; hint: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { value: 'auto', title: '智能选择', hint: '对话、读文件和创作图片都在同一会话中', icon: 'sparkles-outline' },
  { value: 'chat', title: '仅对话', hint: '问答与内容分析，不调用图片创作', icon: 'chatbubble-outline' },
  { value: 'image', title: '直接创作图片', hint: '明确使用图片 API 生成或编辑图片', icon: 'image-outline' },
];

export function AppSettingsSheet({ visible, onClose, onOpenProviders, onOpenNetwork, onOpenAbout, onCheckUpdates }: {
  visible: boolean; onClose: () => void; onOpenProviders?: () => void; onOpenNetwork?: () => void; onOpenAbout?: () => void; onCheckUpdates?: () => void;
}) {
  const { composerMode, setComposerMode, providers, generating } = useApp();
  const [modeExpanded, setModeExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentMode = MODES.find((item) => item.value === composerMode) ?? MODES[0];
  const open = (callback?: () => void) => { if (callback) { onClose(); callback(); } };
  return <Sheet visible={visible} title="设置" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <Text style={styles.section}>连接与模型</Text>
      <SettingsRow icon="server-outline" label="服务商" detail={providers.length ? `已连接 ${providers.length} 个` : '添加 API 地址与密钥'} onPress={() => open(onOpenProviders)} />
      <Text style={styles.note}>对话与图片服务商分别配置，可在聊天中随时选择模型。</Text>
      <Text style={styles.section}>使用偏好</Text>
      <SettingsRow icon="sparkles-outline" label="工作方式" detail={currentMode.title} onPress={() => setModeExpanded((expanded) => !expanded)} expanded={modeExpanded} />
      {modeExpanded && <View style={styles.modes}>{MODES.map((mode) => <Pressable key={mode.value} accessibilityRole="radio" accessibilityState={{ selected: mode.value === composerMode, disabled: generating }} disabled={generating} onPress={() => { void setComposerMode(mode.value).then(() => setModeExpanded(false)).catch((reason) => setError(reason instanceof Error ? reason.message : '暂时无法更改设置')); }} style={({ pressed }) => [styles.modeRow, mode.value === composerMode && styles.selectedMode, pressed && styles.pressed]}><Ionicons name={mode.icon} size={20} color={mode.value === composerMode ? colors.primaryStrong : colors.textMuted} /><View style={styles.copy}><Text style={styles.modeTitle}>{mode.title}</Text><Text style={styles.modeHint}>{mode.hint}</Text></View>{mode.value === composerMode && <Ionicons name="checkmark" size={19} color={colors.primaryStrong} />}</Pressable>)}</View>}
      <Text style={styles.section}>支持</Text>
      <SettingsRow icon="pulse-outline" label="网络诊断" onPress={() => open(onOpenNetwork)} />
      <SettingsRow icon="cloud-download-outline" label="检查更新" onPress={() => open(onCheckUpdates ?? onOpenAbout)} />
      <SettingsRow icon="information-circle-outline" label="关于 Salcara AI" detail="版本与联系反馈" onPress={() => open(onOpenAbout)} />
      <View style={styles.privacy}><Ionicons name="shield-checkmark-outline" size={17} color={colors.textMuted} /><Text style={styles.privacyText}>数据保存在此设备，API 密钥使用安全存储。</Text></View>
    </View>
    <AppDialog visible={Boolean(error)} title="无法更改设置" message={error ?? ''} onClose={() => setError(null)} />
  </Sheet>;
}

function SettingsRow({ icon, label, detail, onPress, expanded }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; detail?: string; onPress: () => void; expanded?: boolean }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}><View style={styles.icon}><Ionicons name={icon} size={21} color={colors.text} /></View><Text style={styles.rowLabel}>{label}</Text>{detail && <Text style={styles.detail} numberOfLines={1}>{detail}</Text>}<Ionicons name={expanded ? 'chevron-down' : 'chevron-forward'} size={17} color={colors.textMuted} /></Pressable>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 },
  section: { fontSize: 12, fontWeight: '600', color: colors.textMuted, marginTop: 26, marginBottom: 8, paddingHorizontal: 3 },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  icon: { width: 28, alignItems: 'center' },
  rowLabel: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '500' },
  detail: { maxWidth: '47%', color: colors.textMuted, fontSize: 12 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 19, marginTop: 11, marginHorizontal: 3 },
  modes: { paddingVertical: 8, gap: 3 },
  modeRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 12, paddingVertical: 12, borderRadius: radius.md },
  selectedMode: { backgroundColor: colors.blueSurface },
  copy: { flex: 1, gap: 4 },
  modeTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  modeHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  pressed: { opacity: 0.65 },
  privacy: { flexDirection: 'row', gap: 7, alignItems: 'center', marginTop: 38, paddingHorizontal: 3 },
  privacyText: { flex: 1, color: colors.textMuted, fontSize: 12, lineHeight: 19 },
});
