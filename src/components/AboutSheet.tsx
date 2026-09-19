import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme';
import { PrimaryButton, Sheet } from './ui';

const QQ_NUMBER = '2423034538';

export function AboutSheet({ visible, onClose, onCheckUpdates }: { visible: boolean; onClose: () => void; onCheckUpdates: () => void }) {
  const [copied, setCopied] = useState(false);
  const version = Application.nativeApplicationVersion ?? '开发版';
  const build = Application.nativeBuildVersion;

  useEffect(() => {
    if (!visible) setCopied(false);
  }, [visible]);

  const copyQQ = async () => {
    await Clipboard.setStringAsync(QQ_NUMBER);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_800);
  };

  return (
    <Sheet visible={visible} title="关于与更新" onClose={onClose}>
      <View style={styles.body}>
        <View style={styles.hero}>
          <Image source={require('../../assets/icon.png')} style={styles.logo} />
          <View style={styles.heroText}>
            <Text style={styles.name}>Salcara Image</Text>
            <Text style={styles.version}>版本 {version}{build ? `（${build}）` : ''}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>联系与反馈</Text>
          <Pressable onPress={() => void copyQQ()} style={({ pressed }) => [styles.contactRow, pressed && styles.pressed]}>
            <View style={styles.contactIcon}><Ionicons name="chatbubble-ellipses-outline" size={21} color={colors.primaryStrong} /></View>
            <View style={styles.contactText}>
              <Text style={styles.contactTitle}>联系 QQ</Text>
              <Text selectable style={styles.contactValue}>{QQ_NUMBER}</Text>
            </View>
            <Text style={styles.copyText}>{copied ? '已复制' : '复制'}</Text>
          </Pressable>
        </View>

        <PrimaryButton label="检查软件更新" icon="cloud-download-outline" onPress={() => { onClose(); onCheckUpdates(); }} />
        <Text style={styles.hint}>更新包只从 Salcara Image 官方 GitHub Releases 获取。覆盖安装会保留本机的服务商、会话和图片数据。</Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.lg },
  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.sm },
  logo: { width: 76, height: 76, borderRadius: 22 },
  heroText: { flex: 1, gap: 5 },
  name: { color: colors.text, fontSize: 21, fontWeight: '800' },
  version: { color: colors.textMuted, fontSize: 13 },
  card: { padding: spacing.md, gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, backgroundColor: colors.surface },
  cardLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  contactRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  contactIcon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: colors.blueSurface },
  contactText: { flex: 1, gap: 3 },
  contactTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  contactValue: { color: colors.textMuted, fontSize: 13 },
  copyText: { color: colors.primaryStrong, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.68 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 19 },
});
