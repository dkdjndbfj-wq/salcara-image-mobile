import * as Application from 'expo-application';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useAgents } from '../agent/agents';
import { useMemories } from '../agent/memory';
import { SEARCH_ENGINES, useAgentSettings } from '../agent/settings';
import { useMemoryBoxSettings } from '../memorybox/settings';
import { useApp } from '../state/AppContext';
import { colors, prettyModel } from '../theme';
import { BrandMark } from './Brand';
import { Icon } from './Icon';
import { Group, ListRow, SectionLabel, Sheet } from './ui';
import { modelById } from '../voice/catalog';
import { useVoiceSettings } from '../voice/settings';

export function AppSettingsSheet({ visible, onClose, onOpenProviders, onOpenModels, onOpenNetwork, onOpenAbout, onCheckUpdates, onOpenVoice, onOpenPersonalization, onOpenTools, onOpenAgents, onOpenMemoryBox }: {
  visible: boolean; onClose: () => void; onOpenProviders: () => void; onOpenModels: () => void; onOpenNetwork: () => void; onOpenAbout: () => void; onCheckUpdates: () => void;
  onOpenVoice: () => void; onOpenPersonalization: () => void; onOpenTools: () => void; onOpenAgents: () => void; onOpenMemoryBox: () => void;
}) {
  const memoryBox = useMemoryBoxSettings();
  const voice = useVoiceSettings();
  const agent = useAgentSettings();
  const memories = useMemories();
  const agents = useAgents();
  const search = SEARCH_ENGINES.find((engine) => engine.id === agent.webSearch)?.label ?? '自动';
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

      <SectionLabel>AI</SectionLabel>
      <Group>
        <ListRow first icon="chat" title="对话模型" value={prettyModel(chatProvider?.chatModel) || '未设置'} onPress={go(onOpenModels)} />
        <ListRow icon="palette" title="绘图模型" value={prettyModel(imageProvider?.model) || '未设置'} onPress={go(onOpenModels)} />
        <ListRow icon="mic" title="语音" value={voice.inputEngine === 'local' ? (modelById(voice.localModel)?.name ?? '本地模型') : '云端识别'} onPress={go(onOpenVoice)} />
        <ListRow icon="server" title="服务" value={providers.length ? `${providers.length} 个` : '未连接'} onPress={go(onOpenProviders)} />
      </Group>

      <SectionLabel>助手</SectionLabel>
      <Group>
        <ListRow first icon="user" title="个性化" detail="关于我、回答风格与记忆" value={agent.memoryEnabled ? (memories.length ? `${memories.length} 条记忆` : '记忆已开') : '记忆已关'} onPress={go(onOpenPersonalization)} />
        <ListRow icon="globe" title="工具与联网" detail="联网搜索、画图自检、手机操作" value={search} onPress={go(onOpenTools)} />
        <ListRow icon="bot" title="智能体" value={agents.length ? `${agents.length} 个` : '新建'} onPress={go(onOpenAgents)} />
      </Group>

      <SectionLabel>插件</SectionLabel>
      <Group>
        <ListRow first icon="bookmark" title="记忆匣" detail="聊天空间的长期记忆、往事概括与记忆画布" value={memoryBox.enabled ? '已启用' : '已关闭'} onPress={go(onOpenMemoryBox)} />
      </Group>

      <SectionLabel>通用</SectionLabel>
      <Group>
        <ListRow first icon="pulse" title="网络诊断" onPress={go(onOpenNetwork)} />
        <ListRow icon="cloudDown" title="检查更新" onPress={leave(onCheckUpdates)} />
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
