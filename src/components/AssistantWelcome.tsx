import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, themed } from '../theme';
import { Icon, type IconName } from './Icon';

export type AssistantPromptSuggestion = {
  icon: IconName;
  title: string;
  hint: string;
  prompt?: string;
  action?: 'files' | 'gallery' | 'camera' | 'research';
  draw?: boolean;
};

export function AssistantWelcome({ title, suggestions, onSuggestion }: {
  title: string;
  suggestions: AssistantPromptSuggestion[];
  onSuggestion: (item: AssistantPromptSuggestion) => void;
}) {
  const styles = useStyles();

  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
    <View style={styles.intro}>
      <Text style={styles.greeting}>{title}</Text>
      <Text style={styles.prompt}>今天想一起完成什么？</Text>
    </View>
    <View style={styles.suggestions}>
      {suggestions.map((item) => <Pressable key={item.title} accessibilityRole="button" accessibilityLabel={item.title}
        onPress={() => onSuggestion(item)} style={({ pressed }) => [styles.suggestion, pressed && styles.pressed]}>
        <Icon name={item.icon} size={18} color={colors.textSecondary} strokeWidth={1.8} />
        <View style={styles.copy}>
          <Text style={styles.name} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.hint} numberOfLines={1}>{item.hint}</Text>
        </View>
        <Icon name="chevronRight" size={16} color={colors.faint} strokeWidth={1.8} />
      </Pressable>)}
    </View>
  </ScrollView>;
}

const useStyles = themed((c) => StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'center', width: '100%', maxWidth: 680, alignSelf: 'center', paddingHorizontal: 24, paddingTop: 24, paddingBottom: 20 },
  intro: { alignItems: 'center', gap: 8, marginBottom: 28 },
  greeting: { marginTop: 7, color: c.textMuted, fontSize: 15, lineHeight: 21, fontWeight: '500' },
  prompt: { color: c.text, fontSize: 26, lineHeight: 34, fontWeight: '600', textAlign: 'center' },
  suggestions: { width: '100%' },
  suggestion: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  name: { color: c.text, fontSize: 14.5, lineHeight: 20, fontWeight: '500' },
  hint: { color: c.textMuted, fontSize: 12.5, lineHeight: 17 },
  pressed: { opacity: 0.62 },
}));
