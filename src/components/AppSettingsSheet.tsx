import * as Application from 'expo-application';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useMemories } from '../agent/memory';
import { useAgentSettings } from '../agent/settings';
import { useMemoryBoxSettings } from '../memorybox/settings';
import { useRemote } from '../remote/store';
import { useApp } from '../state/AppContext';
import { colors, prettyModel } from '../theme';
import { BrandMark } from './Brand';
import { Icon } from './Icon';
import { Group, ListRow, SectionLabel, Sheet } from './ui';
import { modelById } from '../voice/catalog';
import { localModelsOffered } from '../voice/native';
import { useVoiceSettings } from '../voice/settings';

export function AppSettingsSheet({ visible, onClose, onOpenProviders, onOpenModels, onOpenNetwork, onOpenAbout, onCheckUpdates, onOpenVoice, onOpenPersonalization, onOpenTools, onOpenAgents, onOpenMemoryBox, onOpenRemote }: {
  visible: boolean; onClose: () => void; onOpenProviders: () => void; onOpenModels: (tab?: 'chat' | 'image') => void; onOpenNetwork: () => void; onOpenAbout: () => void; onCheckUpdates: () => void;
  onOpenVoice: () => void; onOpenPersonalization: () => void; onOpenTools: () => void; onOpenAgents: () => void; onOpenMemoryBox: () => void; onOpenRemote: () => void;
}) {
  const remote = useRemote();
  const online = remote.devices.filter((device) => device.online).length;
  const memoryBox = useMemoryBoxSettings();
  const voice = useVoiceSettings();
  const agent = useAgentSettings();
  const memories = useMemories();
  const { providers, chatProvider, imageProvider } = useApp();
  // Sub-pages open on top of Settings, so Back returns here instead of to the chat.
  const go = (callback: () => void) => () => { callback(); };
  const leave = (callback: () => void) => () => { onClose(); callback(); };
  return <Sheet visible={visible} title="设置" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <View style={styles.hero}>
        <View style={styles.mark}><BrandMark size={76} /></View>
        <Text style={styles.name}>Salcara</Text>
        <Text style={styles.version}>版本 {Application.nativeApplicationVersion ?? '开发版'}</Text>
      </View>

      <SectionLabel>模型与 API</SectionLabel>
      <Group>
        <ListRow first icon="chat" title="对话模型" detail="助手和聊天通用" value={prettyModel(chatProvider?.chatModel) || '未设置'} onPress={go(() => onOpenModels('chat'))} />
        <ListRow icon="palette" title="绘图" detail="模型、画幅、作图描述" value={prettyModel(imageProvider?.model) || '未设置'} onPress={go(() => onOpenModels('image'))} />
        <ListRow icon="mic" title="语音" value={voice.inputEngine === 'local' && localModelsOffered() ? (modelById(voice.localModel)?.name ?? '本地模型') : '云端识别'} onPress={go(onOpenVoice)} />
        <ListRow icon="server" title="API 管理" detail="各平台的地址和密钥" value={providers.length ? `${providers.length} 个` : '未添加'} onPress={go(onOpenProviders)} />
      </Group>

      <SectionLabel>电脑</SectionLabel>
      <Group>
        <ListRow first icon="code" title="远程编程" detail="在手机上用电脑里的 Codex 和 Claude Code"
          value={remote.phase !== 'ready' ? '未设置' : online ? `${online} 台在线` : remote.devices.length ? '电脑离线' : ''} onPress={go(onOpenRemote)} />
      </Group>

      <SectionLabel>个性化</SectionLabel>
      <Group>
        <ListRow first icon="user" title="关于我与回答风格" detail="助手的记忆也在这里" value={agent.memoryEnabled ? (memories.length ? `${memories.length} 条记忆` : '') : '记忆已关'} onPress={go(onOpenPersonalization)} />
        <ListRow icon="bookmark" title="聊天记忆" detail="聊天空间的角色记得你说过的事" value={memoryBox.enabled ? '开' : '关'} onPress={go(onOpenMemoryBox)} />
        <ListRow icon="globe" title="联网与手机操作" value={agent.webSearch === 'off' ? '联网已关' : '联网已开'} onPress={go(onOpenTools)} />
      </Group>

      <SectionLabel>其他</SectionLabel>
      <Group>
        <ListRow first icon="cloudDown" title="检查更新" onPress={leave(onCheckUpdates)} />
        <ListRow icon="info" title="关于与反馈" value="QQ 群 881490534" onPress={go(onOpenAbout)} />
        <ListRow icon="pulse" title="网络诊断" detail="连不上 API 时用" onPress={go(onOpenNetwork)} />
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
