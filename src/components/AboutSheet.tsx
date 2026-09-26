import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '../theme';
import { Sheet } from './ui';

const QQ_NUMBER = '2423034538';

export function AboutSheet({ visible, onClose, onCheckUpdates }: { visible: boolean; onClose: () => void; onCheckUpdates: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const version = Application.nativeApplicationVersion ?? '开发版';
  const build = Application.nativeBuildVersion;
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  useEffect(() => { if (!visible) setCopied(false); }, [visible]);
  const copyQQ = async () => {
    await Clipboard.setStringAsync(QQ_NUMBER); setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1_800);
  };
  return <Sheet visible={visible} title="关于" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <View style={styles.hero}><Image source={require('../../assets/icon.png')} style={styles.logo} /><Text style={styles.name}>Salcara AI</Text><Text style={styles.tagline}>想法、对话与创作</Text><Text style={styles.version}>版本 {version}{build ? ` · ${build}` : ''}</Text></View>
      <Pressable accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => { onClose(); onCheckUpdates(); }}><Ionicons name="cloud-download-outline" size={22} color={colors.text} /><Text style={styles.rowTitle}>检查更新</Text><Ionicons name="chevron-forward" size={17} color={colors.textMuted} /></Pressable>
      <Pressable accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={() => void copyQQ()}><Ionicons name="chatbubble-ellipses-outline" size={22} color={colors.text} /><View style={styles.copy}><Text style={styles.rowTitle}>联系与反馈</Text><Text style={styles.hint}>QQ {QQ_NUMBER}</Text></View><Text style={styles.link}>{copied ? '已复制' : '复制'}</Text></Pressable>
      <Text style={styles.note}>检查更新后可在应用内下载并安装。使用同一签名的新版本覆盖安装，会保留本机会话与配置。</Text>
      <View style={styles.privacy}><Ionicons name="lock-closed-outline" size={17} color={colors.textMuted} /><Text style={styles.privacyText}>会话与文件保存在手机中，只有发送消息时才提交给你选择的服务商。</Text></View>
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 24, paddingBottom: 24 },
  hero: { alignItems: 'center', paddingTop: 34, paddingBottom: 42, gap: 8 },
  logo: { width: 80, height: 80, borderRadius: 24, marginBottom: 12 },
  name: { color: colors.text, fontSize: 22, fontWeight: '700' },
  tagline: { color: colors.textMuted, fontSize: 13 },
  version: { color: colors.textMuted, fontSize: 12, marginTop: 8, backgroundColor: colors.surface, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 12 },
  row: { minHeight: 70, flexDirection: 'row', alignItems: 'center', gap: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  rowTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '500' },
  copy: { flex: 1, gap: 5, paddingVertical: 15 },
  hint: { color: colors.textMuted, fontSize: 13 },
  link: { color: colors.primaryStrong, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.65 },
  note: { color: colors.textMuted, fontSize: 12, lineHeight: 20, marginTop: 18 },
  privacy: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, marginTop: 46 },
  privacyText: { flex: 1, color: colors.textMuted, fontSize: 12, lineHeight: 20 },
});
