import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors } from '../theme';
import { BrandMark } from './Brand';
import { Icon } from './Icon';
import { Group, ListRow, Sheet, showToast } from './ui';

const QQ_NUMBER = '2423034538';

export function AboutSheet({ visible, onClose, onCheckUpdates }: { visible: boolean; onClose: () => void; onCheckUpdates: () => void }) {
  const version = Application.nativeApplicationVersion ?? '开发版';
  const build = Application.nativeBuildVersion;
  const copyQQ = () => void Clipboard.setStringAsync(QQ_NUMBER).then(() => showToast('QQ 号已复制'));
  return <Sheet visible={visible} title="关于" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <View style={styles.hero}>
        <View style={styles.halo}><BrandMark size={96} /></View>
        <Text style={styles.name}>Salcara</Text>
        <Text style={styles.tagline}>对话、理解与创作，都在一句话之间</Text>
        <Text style={styles.version}>版本 {version}{build ? ` (${build})` : ''}</Text>
      </View>
      <Group>
        <ListRow first icon="cloudDown" title="检查更新" onPress={() => { onClose(); onCheckUpdates(); }} />
        <ListRow icon="chat" title="联系与反馈" value={`QQ ${QQ_NUMBER}`} onPress={copyQQ} right={<Icon name="copy" size={17} color={colors.faint} />} />
      </Group>
      <Text style={styles.note}>新版本可在应用内下载安装。使用同一签名覆盖安装，会保留本机的对话与设置。</Text>
      <View style={styles.privacy}>
        <Icon name="lock" size={14} color={colors.subtle} />
        <Text style={styles.privacyText}>对话与文件保存在你的手机中，只在发送时交给你选择的服务。</Text>
      </View>
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  hero: { alignItems: 'center', paddingTop: 28, paddingBottom: 30, gap: 6 },
  halo: { width: 96, height: 96, marginBottom: 14 },
  name: { color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.8 },
  tagline: { color: colors.textMuted, fontSize: 14.5 },
  version: { color: colors.subtle, fontSize: 12.5, marginTop: 8 },
  note: { color: colors.subtle, fontSize: 12.5, lineHeight: 19, marginTop: 14, marginHorizontal: 16 },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 30, paddingHorizontal: 16 },
  privacyText: { flex: 1, color: colors.subtle, fontSize: 12.5, lineHeight: 18 },
});
