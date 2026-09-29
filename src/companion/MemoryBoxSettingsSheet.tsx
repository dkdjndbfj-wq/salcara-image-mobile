import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ToggleRow } from '../components/SettingsParts';
import { Group, Sheet, showToast } from '../components/ui';
import { updateMemoryBoxSettings, useMemoryBoxSettings, type MemoryBoxSettings } from '../memorybox/settings';
import { colors } from '../theme';

/**
 * 设置 → 聊天记忆. Two switches; everything else is automatic: memory work uses the app's chat model,
 * and semantic recall uses the chat API's embeddings when that vendor has them (keywords otherwise).
 */
export function MemoryBoxSettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const settings = useMemoryBoxSettings();
  const save = (patch: Partial<MemoryBoxSettings>) => void updateMemoryBoxSettings(patch).catch(() => showToast('没有保存成功', 'alert'));
  return <Sheet visible={visible} title="聊天记忆" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <Text style={styles.lead}>聊天空间的每个角色都有自己的记忆匣：记住你说过的事、把往事整理成概括，所以聊多久都不会忘。全部自动完成，不需要设置。</Text>
      <Group>
        <ToggleRow first icon="bookmark" title="记住聊过的事" detail="关闭后角色仍能聊天，但只记得最近的十几轮；已有记忆会保留" value={settings.enabled} onChange={(enabled) => save({ enabled })} />
        <ToggleRow icon="user" title="让助手也了解我" detail="助手空间可以参考你在聊天里提到的关于自己的事实（不会看到聊天内容）" value={settings.shareWithAssistant} onChange={(shareWithAssistant) => save({ shareWithAssistant })} disabled={!settings.enabled} />
      </Group>
      <Text style={styles.note}>记忆只保存在这台手机上。整理记忆用你当前的对话模型；如果对话 API 支持向量检索（OpenAI、通义、智谱、硅基流动、Gemini 等），还会按意思找回记忆。每个角色的记忆可以在聊天页右上角的记忆匣里查看和修改。</Text>
    </View>
  </Sheet>;
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  lead: { color: colors.textMuted, fontSize: 14, lineHeight: 21, marginVertical: 12, marginHorizontal: 6 },
  note: { color: colors.subtle, fontSize: 12.5, lineHeight: 19, marginTop: 12, marginHorizontal: 6 },
});
