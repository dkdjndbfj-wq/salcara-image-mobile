import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { themed } from '../theme';
import type { AgentId, AgentProfile } from './client';
import { ToolBadge } from './parts';

export type AgentGridItem = {
  id: AgentId; name: string; tool: AgentProfile['tool']; client?: string;
  detail: string; disabled?: boolean; accessibilityLabel: string;
};

/** Home and new-conversation selection use the same cards and responsive sizing. */
export function AgentGrid({ items, onSelect }: { items: AgentGridItem[]; onSelect: (id: AgentId) => void }) {
  const styles = useStyles();
  const [width, setWidth] = useState(0);
  const columns = width >= 580 ? 5 : width >= 336 ? 3 : 2;
  const size = width ? Math.min(132, (width - 8 * (columns - 1)) / columns) : 108;
  return <View style={styles.grid} onLayout={event => setWidth(event.nativeEvent.layout.width)}>{items.map(item =>
    <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.accessibilityLabel}
      accessibilityState={{ disabled: Boolean(item.disabled) }} disabled={item.disabled} onPress={() => { if (!item.disabled) onSelect(item.id); }}
      style={({ pressed }) => [styles.card, { width: size }, item.disabled && styles.disabled, pressed && styles.pressed]}>
      <ToolBadge tool={item.tool} client={item.client} size={24} />
      <Text style={styles.name} numberOfLines={2}>{item.name}</Text>
      <Text style={[styles.detail, item.disabled && styles.unavailable]} numberOfLines={1}>{item.detail}</Text>
    </Pressable>)}
  </View>;
}

const useStyles = themed((_c, t) => StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: { aspectRatio: 1, padding: 10, borderRadius: 14, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, gap: 5 },
  pressed: { backgroundColor: t.surface2, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.55 }, unavailable: { color: t.faint },
  name: { color: t.text, fontSize: 13, lineHeight: 17, fontWeight: '600', flexGrow: 1 },
  detail: { color: t.muted, fontSize: 10.5, lineHeight: 14 },
}));
