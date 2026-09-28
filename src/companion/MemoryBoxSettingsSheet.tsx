import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { DraftField, ToggleRow } from '../components/SettingsParts';
import { Chip, Group, SectionLabel, Sheet, showToast } from '../components/ui';
import { embeddingFailure, updateMemoryBoxSettings, useMemoryBoxSettings, type MemoryBoxSettings } from '../memorybox/settings';
import { useApp } from '../state/AppContext';
import { colors, prettyModel } from '../theme';

/** 设置 → 插件 → 记忆匣. */
export function MemoryBoxSettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const settings = useMemoryBoxSettings();
  const { providers } = useApp();
  const save = (patch: Partial<MemoryBoxSettings>) => void updateMemoryBoxSettings(patch).catch(() => showToast('没有保存成功', 'alert'));
  const openai = providers.filter((item) => item.chatApi !== 'anthropic');
  const chat = providers.filter((item) => item.chatModel);
  const failure = settings.embeddingProviderId ? embeddingFailure(settings.embeddingProviderId) : undefined;
  return <Sheet visible={visible} title="记忆匣" subtitle="聊天空间的长期记忆插件" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <Group>
        <ToggleRow first icon="bookmark" title="启用记忆匣" detail="聊天角色会整理记忆、概括往事，对话永远不会有长度上限" value={settings.enabled} onChange={(enabled) => save({ enabled })} />
      </Group>
      <Text style={styles.note}>关闭后角色仍能聊天，但只记得最近的十几轮对话。已有记忆会保留。</Text>

      <SectionLabel>语义检索（Embeddings）</SectionLabel>
      <Group>
        <ToggleRow first icon="sparkles" title="用 Embeddings 回想" detail="按意思而不只是关键词找回记忆，费用极低（text-embedding-3-small）" value={settings.embeddings} onChange={(embeddings) => save({ embeddings })} disabled={!settings.enabled} />
      </Group>
      {settings.embeddings && settings.enabled ? <Group style={styles.group}>
        <Text style={styles.label}>服务商（需 OpenAI 兼容接口）</Text>
        <View style={styles.chips}>
          <Chip label="自动" selected={!settings.embeddingProviderId} onPress={() => save({ embeddingProviderId: null })} />
          {openai.map((item) => <Chip key={item.id} label={item.name} selected={settings.embeddingProviderId === item.id} onPress={() => save({ embeddingProviderId: item.id })} />)}
        </View>
        <DraftField label="模型" value={settings.embeddingModel} onSave={(embeddingModel) => save({ embeddingModel: embeddingModel.trim() || 'text-embedding-3-small' })} />
        {failure ? <Text style={styles.warn}>这个服务商的 Embeddings 接口返回 {failure}，本次运行期间改用关键词检索。</Text> : null}
        {!openai.length ? <Text style={styles.warn}>没有 OpenAI 兼容的服务商，将只用关键词检索。</Text> : null}
      </Group> : null}

      <SectionLabel>后台整理</SectionLabel>
      <Group style={styles.group}>
        <Text style={styles.label}>整理记忆用的模型（每轮聊天后在后台调用一次，建议选便宜的模型）</Text>
        <View style={styles.chips}>
          <Chip label="跟随角色" selected={!settings.workerProviderId} onPress={() => save({ workerProviderId: null, workerModel: '' })} />
          {chat.map((item) => <Chip key={item.id} label={`${item.name} · ${prettyModel(item.chatModel)}`} selected={settings.workerProviderId === item.id} onPress={() => save({ workerProviderId: item.id, workerModel: item.chatModel ?? '' })} />)}
        </View>
        {settings.workerProviderId ? <DraftField label="模型 ID" value={settings.workerModel} onSave={(workerModel) => save({ workerModel: workerModel.trim() })} /> : null}
      </Group>
      <Group style={{ marginTop: 10 }}>
        <ToggleRow first icon="lightbulb" title="定期反思" detail="记忆积累到一定数量时，总结出更高层的感悟" value={settings.reflection} onChange={(reflection) => save({ reflection })} disabled={!settings.enabled} />
        <ToggleRow icon="user" title="让助手了解我" detail="助手空间可以只读你在聊天中提到的关于自己的事实（不会看到聊天内容）" value={settings.shareWithAssistant} onChange={(shareWithAssistant) => save({ shareWithAssistant })} disabled={!settings.enabled} />
      </Group>
      <Text style={styles.note}>记忆、往事和聊天记录都只保存在这台手机上；整理和检索时，相关片段会发送给你选择的服务商。</Text>
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  group: { padding: 14, gap: 12, marginTop: 10 },
  label: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { color: colors.subtle, fontSize: 12.5, lineHeight: 18, marginTop: 8, marginHorizontal: 6 },
  warn: { color: colors.warningText, fontSize: 12.5, lineHeight: 18 },
});
