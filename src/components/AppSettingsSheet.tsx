import * as Application from 'expo-application';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useApp } from '../state/AppContext';
import { colors, prettyModel } from '../theme';
import { BrandMark } from './Brand';
import { Icon } from './Icon';
import { Group, ListRow, SectionLabel, Sheet } from './ui';

export function AppSettingsSheet({ visible, onClose, onOpenProviders, onOpenModels, onOpenNetwork, onOpenAbout, onCheckUpdates }: {
  visible: boolean; onClose: () => void; onOpenProviders: () => void; onOpenModels: () => void; onOpenNetwork: () => void; onOpenAbout: () => void; onCheckUpdates: () => void;
}) {
  const { providers, chatProvider, imageProvider } = useApp();
  const go = (callback: () => void) => () => { onClose(); callback(); };
  return <Sheet visible={visible} title="设置" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <View style={styles.hero}>
        <View style={styles.mark}><BrandMark size={76} /></View>
        <Text style={styles.name}>Salcara</Text>
        <Text style={styles.version}>版本 {Application.nativeApplicationVersion ?? '开发版'}</Text>
      </View>

      <SectionLabel>AI</SectionLabel>
      <Group>
        <ListRow first icon="chat" title="对话模型" value={prettyModel(chatProvider?.chatModel) || '未设置'} onPress={go(onOpenModels)} />
        <ListRow icon="palette" title="绘图模型" value={prettyModel(imageProvider?.model) || '未设置'} onPress={go(onOpenModels)} />
        <ListRow icon="server" title="服务" value={providers.length ? `${providers.length} 个` : '未连接'} onPress={go(onOpenProviders)} />
      </Group>

      <SectionLabel>通用</SectionLabel>
      <Group>
        <ListRow first icon="globe" title="网络诊断" onPress={go(onOpenNetwork)} />
        <ListRow icon="cloudDown" title="检查更新" onPress={go(onCheckUpdates)} />
        <ListRow icon="info" title="关于与反馈" onPress={go(onOpenAbout)} />
      </Group>

      <View style={styles.privacy}>
        <Icon name="lock" size={14} color={colors.subtle} />
        <Text style={styles.privacyText}>对话保存在这台设备上，只在发送时交给你选择的服务。</Text>
      </View>
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 24 },
  hero: { alignItems: 'center', paddingTop: 18, paddingBottom: 6, gap: 6 },
  mark: { width: 76, height: 76, marginBottom: 8 },
  name: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  version: { color: colors.subtle, fontSize: 13 },
  privacy: { flexDirection: 'row', alignItems: 'center', gap: 6, justifyContent: 'center', marginTop: 30, paddingHorizontal: 16 },
  privacyText: { color: colors.subtle, fontSize: 12.5, textAlign: 'center' },
});
