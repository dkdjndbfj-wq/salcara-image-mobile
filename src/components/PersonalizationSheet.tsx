import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { clearMemories, editMemory, MAX_MEMORIES, removeMemory, useMemories } from '../agent/memory';
import { updateAgentSettings, useAgentSettings } from '../agent/settings';
import type { Memory } from '../agent/types';
import { colors, themed } from '../theme';
import { Icon } from './Icon';
import { DraftField, ToggleRow } from './SettingsParts';
import { AppDialog, Chip, Group, SectionLabel, Sheet, showToast } from './ui';

const STYLE_PRESETS = ['简洁直接，先给结论', '详细深入，多举例子', '轻松口语，像朋友聊天', '专业严谨，注明依据'];

/** 个性化: what Salcara knows about the user and how it answers. */
export function PersonalizationSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const styles = useStyles();
  const settings = useAgentSettings();
  const memories = useMemories();
  const [editing, setEditing] = useState<Memory | null>(null);
  const [editText, setEditText] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const save = (patch: Parameters<typeof updateAgentSettings>[0]) => void updateAgentSettings(patch).catch(() => showToast('没有保存成功', 'alert'));

  return <Sheet visible={visible} title="关于我与回答风格" onClose={onClose} presentation="page">
    <View style={styles.body}>
      <SectionLabel>关于我</SectionLabel>
      <Group style={styles.group}>
        <DraftField value={settings.aboutMe} onSave={(aboutMe) => save({ aboutMe })} multiline maxLength={1500}
          placeholder="例如：我在杭州做产品经理，平时喜欢摄影；孩子上小学三年级。"
          hint="Salcara 每次回答都会参考这些信息。" />
      </Group>

      <SectionLabel>回答风格</SectionLabel>
      <Group style={styles.group}>
        <View style={styles.chips}>
          {STYLE_PRESETS.map((preset) => <Chip key={preset} label={preset} selected={settings.responseStyle === preset} onPress={() => save({ responseStyle: settings.responseStyle === preset ? '' : preset })} />)}
        </View>
        <DraftField value={settings.responseStyle} onSave={(responseStyle) => save({ responseStyle })} multiline maxLength={1500}
          placeholder="也可以自己写，例如：用中文回答，代码注释用英文；少用表情。" />
      </Group>

      <SectionLabel>记忆</SectionLabel>
      <Group>
        <ToggleRow first icon="bookmark" title="使用记忆" detail="让 Salcara 记住你在对话里提到的长期信息，并在以后的回答中参考" value={settings.memoryEnabled} onChange={(memoryEnabled) => save({ memoryEnabled })} />
      </Group>
      {settings.memoryEnabled ? <Text style={styles.note}>你也可以直接说“记住……”或“忘掉……”。记忆只保存在这台手机上（最多 {MAX_MEMORIES} 条）。</Text> : null}
      {memories.length ? <Group style={styles.memoryGroup}>
        {memories.map((memory, index) => <View key={memory.id} style={[styles.memory, index > 0 && styles.divider]}>
          <Pressable accessibilityRole="button" accessibilityLabel={`编辑记忆：${memory.content}`} onPress={() => { setEditText(memory.content); setEditing(memory); }} style={{ flex: 1 }}>
            <Text style={styles.memoryText}>{memory.content}</Text>
            <Text style={styles.memoryDate}>{new Date(memory.createdAt).toLocaleDateString()}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="删除这条记忆" hitSlop={8} onPress={() => void removeMemory(memory.id).then(() => showToast('已删除'))} style={styles.remove}>
            <Icon name="trash" size={17} color={colors.subtle} />
          </Pressable>
        </View>)}
      </Group> : <View style={styles.empty}>
        <Icon name="bookmark" size={22} color={colors.faint} />
        <Text style={styles.emptyText}>还没有记忆</Text>
      </View>}
      {memories.length ? <Pressable accessibilityRole="button" onPress={() => setConfirmClear(true)} style={styles.clear}><Text style={styles.clearText}>清除全部记忆</Text></Pressable> : null}

      <SectionLabel>对话</SectionLabel>
      <Group>
        <ToggleRow first icon="sparkles" title="追问建议" detail="回答后给出 2～3 个可以一键继续问的问题" value={settings.suggestions} onChange={(suggestions) => save({ suggestions })} />
        <ToggleRow icon="history" title="查找历史对话" detail="你提到“之前聊过的”时，允许 Salcara 搜索这台手机上的历史对话" value={settings.historySearch} onChange={(historySearch) => save({ historySearch })} />
      </Group>
    </View>

    <AppDialog visible={Boolean(editing)} title="编辑记忆" icon="edit" onClose={() => setEditing(null)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setEditing(null) },
      { label: '保存', tone: 'primary', onPress: () => { const memory = editing; setEditing(null); if (memory) void editMemory(memory.id, editText); } },
    ]}>
      <TextInput value={editText} onChangeText={setEditText} multiline autoFocus maxLength={300} style={styles.editInput} textAlignVertical="top" />
    </AppDialog>
    <AppDialog visible={confirmClear} title="清除全部记忆？" message="Salcara 将忘记它记住的所有信息，无法恢复。" icon="trash" onClose={() => setConfirmClear(false)} actions={[
      { label: '取消', tone: 'secondary', onPress: () => setConfirmClear(false) },
      { label: '清除', tone: 'danger', onPress: () => { setConfirmClear(false); void clearMemories().then(() => showToast('已清除')); } },
    ]} />
  </Sheet>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  body: { paddingHorizontal: 16, paddingBottom: 28 },
  group: { padding: 14, gap: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  note: { color: colors.subtle, fontSize: 12.5, lineHeight: 18, marginTop: 8, marginHorizontal: 6 },
  memoryGroup: { marginTop: 12 },
  memory: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 16, paddingRight: 8, paddingVertical: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  memoryText: { color: colors.text, fontSize: 14.5, lineHeight: 21 },
  memoryDate: { color: colors.subtle, fontSize: 11.5, marginTop: 3 },
  remove: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 22 },
  emptyText: { color: colors.subtle, fontSize: 13 },
  clear: { alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 16 },
  clearText: { color: colors.danger, fontSize: 14, fontWeight: '500' },
  editInput: { minHeight: 90, borderRadius: 14, backgroundColor: colors.surfaceStrong, padding: 12, color: colors.text, fontSize: 15, marginTop: 8 },
}));
