import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { MotionPressable } from '../components/MotionPressable';
import { useDesk } from '../theme';
import { planSteps } from './blocks';
import type { TimelineItem } from './store';
import { conversationFontFamily } from './conversation-typography';
import { WorkbenchReveal } from './ConversationMotion';

/** Only a plan from this live root turn belongs above the composer. */
export function currentTaskPlan(items: readonly TimelineItem[], activeTurnId?: string) {
  let boundary = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if ('parentId' in item && item.parentId) continue;
    if (item.kind === 'turn' && (!activeTurnId || item.turnId === activeTurnId)) {
      if (item.status !== 'started') return undefined;
      boundary = i; break;
    }
    if (item.kind === 'message' && item.role === 'user' && !activeTurnId) { boundary = i; break; }
  }
  for (let i = items.length - 1; i > boundary; i--) {
    const item = items[i];
    if (item.kind !== 'tool' || item.tool !== 'plan' || item.parentId || item.planKind === 'proposal'
      || (activeTurnId ? item.turnId !== activeTurnId : boundary < 0)) continue;
    const steps = planSteps(item.output);
    if (steps.length) return { item, steps };
  }
  return undefined;
}

export function TaskProgressDock({ items, activeTurnId, running, scopeKey }: {
  items: readonly TimelineItem[]; activeTurnId?: string; running: boolean; scopeKey: string;
}) {
  const d = useDesk(), [expanded, setExpanded] = useState<string>();
  const plan = running ? currentTaskPlan(items, activeTurnId) : undefined;
  if (!plan) return null;
  const key = `${scopeKey}:${activeTurnId ?? plan.item.turnId ?? plan.item.id}`, open = expanded === key;
  const done = plan.steps.filter(step => step.status === 'done').length;
  const current = plan.steps.find(step => step.status === 'active') ?? plan.steps.find(step => step.status === 'pending');
  return <View testID="task-progress-dock" style={[s.wrap, { borderColor: d.line }]}>
    <MotionPressable scaleTo={0.99} accessibilityRole="button" accessibilityLabel={open ? '收起当前任务进度' : '展开当前任务进度'} accessibilityState={{ expanded: open }}
      onPress={() => setExpanded(open ? undefined : key)} style={s.header}>
      <Icon name="listCheck" size={14} color={d.muted} />
      <Text numberOfLines={1} style={[s.text, { color: d.text, flex: 1 }]}>{current?.text ?? '任务步骤已完成'}</Text>
      <Text style={[s.count, { color: d.muted }]}>{done}/{plan.steps.length}</Text>
      <View style={open ? { transform: [{ rotate: '180deg' }] } : undefined}><Icon name="chevronDown" size={12} color={d.muted} /></View>
    </MotionPressable>
    <WorkbenchReveal key={key} visible={open} testID="task-progress-reveal"><ScrollView nestedScrollEnabled style={s.list} contentContainerStyle={{ paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
      {plan.steps.map((step, index) => <View key={index} style={s.row}>
        <Icon name={step.status === 'done' ? 'check' : step.status === 'active' ? 'clock' : 'minus'} size={12} color={step.status === 'active' ? d.text : d.muted} />
        <Text selectable style={[s.text, { flex: 1, color: step.status === 'active' ? d.text : d.muted }]}>{step.text}</Text>
      </View>)}
    </ScrollView></WorkbenchReveal>
  </View>;
}
const s = StyleSheet.create({
  wrap: { marginHorizontal: 10, marginBottom: 5, borderBottomWidth: StyleSheet.hairlineWidth },
  header: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 7 },
  list: { maxHeight: 144 }, row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 5 },
  text: { fontFamily: conversationFontFamily, fontSize: 12, lineHeight: 18 }, count: { fontFamily: conversationFontFamily, fontSize: 11 },
});
