import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { CREATION_SKILLS, type CreationSkillId } from '../creation-skills';
import { colors, radius, spacing } from '../theme';
import { Sheet } from './ui';

export function CreationSkillPicker({ visible, selectedId, onSelect, onClose }: {
  visible: boolean;
  selectedId: CreationSkillId | null;
  onSelect: (id: CreationSkillId | null) => void;
  onClose: () => void;
}) {
  const choose = (id: CreationSkillId | null) => { onSelect(id); onClose(); };
  return <Sheet visible={visible} title="创作技能" onClose={onClose}>
    <View style={styles.content}>
      <Text style={styles.intro}>选好技能，再描述你的想法。发送时会先检查要求，沿用你选定的图片模型和画质。</Text>
      <View style={styles.list}>
        <SkillRow title="不使用技能" description="按消息内容自动选择对话或图片创作" icon="chatbubble-outline" selected={!selectedId} onPress={() => choose(null)} />
        {CREATION_SKILLS.map((skill) => <SkillRow key={skill.id} title={skill.title} description={skill.description} icon={skill.icon} selected={selectedId === skill.id} onPress={() => choose(skill.id)} />)}
      </View>
      <Text style={styles.footnote}>海报可保留艺术标题；大量正文会先规划留白和排版，当前版本需后期补充正文。</Text>
    </View>
  </Sheet>;
}

function SkillRow({ title, description, icon, selected, onPress }: {
  title: string; description: string; icon: React.ComponentProps<typeof Ionicons>['name']; selected: boolean; onPress: () => void;
}) {
  return <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} accessibilityLabel={title} onPress={onPress} style={({ pressed }) => [styles.row, selected && styles.selected, pressed && styles.pressed]}>
    <View style={[styles.icon, selected && styles.selectedIcon]}><Ionicons name={icon} size={20} color={selected ? colors.primaryStrong : colors.textMuted} /></View>
    <View style={styles.copy}><Text style={styles.title}>{title}</Text><Text style={styles.description}>{description}</Text></View>
    <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={selected ? colors.primaryStrong : colors.border} />
  </Pressable>;
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.lg },
  intro: { fontSize: 13, lineHeight: 20, color: colors.textMuted },
  list: { gap: 6 },
  row: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radius.md, padding: 12 },
  selected: { backgroundColor: colors.blueSurface },
  pressed: { opacity: 0.68 },
  icon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  selectedIcon: { backgroundColor: colors.background },
  copy: { flex: 1, gap: 5 },
  title: { color: colors.text, fontSize: 14, fontWeight: '600' },
  description: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  footnote: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
});
