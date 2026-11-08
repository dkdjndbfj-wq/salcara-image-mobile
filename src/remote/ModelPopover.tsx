import React, { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { colors, themed } from '../theme';
import { buildModelPresentation } from './model-presentation';
import { hapticModelCommit } from './haptics';
import { ComposerPopover } from './ComposerPopover';

/** Decorative provider mark only; it never parses or submits IDs. */
const FAMILIES = [
  { color: '#10A37F', letter: 'G', test: /^(gpt|o\d|codex|chatgpt)/i },
  { color: '#D97757', letter: 'C', test: /^claude/i },
  { color: '#111827', letter: 'X', test: /^grok/i },
  { color: '#4285F4', letter: 'G', test: /^(gemini|gemma)/i },
  { color: '#4D6BFE', letter: 'D', test: /^deepseek/i },
  { color: '#615CED', letter: 'Q', test: /^(qwen|qwq)/i },
  { color: '#3859FF', letter: 'Z', test: /^glm/i },
  { color: '#16191E', letter: 'K', test: /^(kimi|moonshot)/i },
];
export function ModelDot({ model, size = 18 }: { model: string; size?: number }) {
  const styles = useStyles();
  const name = model.split('/').pop() ?? model, family = FAMILIES.find(item => item.test.test(name));
  return <View style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: family?.color ?? '#8A93A9' }]}>
    <Text style={[styles.dotText, { fontSize: size * 0.5 }]}>{family?.letter ?? (name[0] ?? '?').toUpperCase()}</Text>
  </View>;
}
export interface PopoverAnchor { x: number; y: number }
/** Shared effort-chip colours; model selection itself has no decorative animation. */
export const EFFORT_FIELDS = [
  { id: 'low', ink: '#3A7FD6' }, { id: 'medium', ink: '#2F66E0' },
  { id: 'high', ink: '#3F4BD8' }, { id: 'xhigh', ink: '#4F37CF' },
  { id: 'max', ink: '#5A2FC6' }, { id: 'ultra', ink: '#6526BA' },
] as const;

type Props = {
  visible: boolean; anchor?: PopoverAnchor | null; anchorRef?: RefObject<View | null>;
  value: string; fallback: string; models: string[]; loading: boolean;
  onRefresh: () => void; onSelect: (model: string) => void; onClose: () => void;
  catalogOnly?: boolean; catalogReady?: boolean; error?: string;
  selectionEnabled?: boolean; scopeKey?: string; onFollowComputer?: () => void; interactionBlocked?: boolean;
};

/** Model choices only. Reasoning and Agent configuration have their own controls. */
export function ModelPopover({ visible, anchorRef, value, fallback, models, loading, onRefresh, onSelect, onClose,
  catalogOnly, catalogReady = true, error, selectionEnabled = true, scopeKey = '', onFollowComputer, interactionBlocked = false }: Props) {
  const styles = useStyles(), current = value || fallback;
  const presentation = useMemo(() => buildModelPresentation(models), [models]);
  const list = useMemo(() => catalogOnly ? catalogReady ? presentation.items : []
    : current && !presentation.items.some(item => item.id === current) ? [{ id: current, label: current }, ...presentation.items] : presentation.items,
  [catalogOnly, catalogReady, current, presentation]);
  const canSelect = selectionEnabled && !interactionBlocked && !loading;
  const [revision, setRevision] = useState(0);
  type Pending = { epoch: number; kind: 'model' | 'default'; id: string };
  const pending = useRef<Pending | null>(null), [preview, setPreview] = useState<Pending | null>(null);
  const signature = JSON.stringify([visible, scopeKey, list, loading, selectionEnabled, interactionBlocked, value, fallback, catalogOnly, catalogReady, Boolean(onFollowComputer), revision]);
  const owner = useRef({ signature, epoch: 0, visible }), active = useRef(visible), mounted = useRef(true);
  if (owner.current.signature !== signature) {
    pending.current = null;
    if (!visible) active.current = false;
    else if (!owner.current.visible) active.current = true;
    owner.current = { signature, epoch: owner.current.epoch + 1, visible };
  }
  const epoch = owner.current.epoch;
  const currentAction = () => mounted.current && active.current && visible && owner.current.epoch === epoch
    && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const retire = () => { pending.current = null; active.current = false; owner.current.epoch += 1; };
  // Only an explicit dismissal confirms a preview. Ownership/catalog/lifecycle
  // changes retire it without writing a preference for the replacement context.
  const close = () => {
    if (!currentAction()) return;
    const choice = pending.current?.epoch === epoch ? pending.current : null;
    const modelChanged = choice?.kind === 'model' && canSelect && choice.id !== current && list.some(item => item.id === choice.id);
    const followsDefault = choice?.kind === 'default' && !interactionBlocked && !loading && Boolean(onFollowComputer) && value !== '';
    retire();
    if (modelChanged) { hapticModelCommit(); onSelect(choice!.id); }
    else if (followsDefault) { hapticModelCommit(); onFollowComputer!(); }
    onClose();
  };
  const latestClose = useRef(onClose); latestClose.current = onClose;
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', state => {
      if (state !== 'active' && active.current) { retire(); latestClose.current(); }
    });
    return () => { mounted.current = false; listener.remove(); };
  }, []);
  const choose = (id: string) => {
    if (!currentAction() || !canSelect || !list.some(item => item.id === id)) return;
    const choice: Pending = { epoch, kind: 'model', id };
    pending.current = choice; setPreview(choice);
  };
  const choice = preview?.epoch === epoch ? preview : null;
  const selected = choice?.kind === 'model' ? choice.id : current;
  const defaultSelected = Boolean(onFollowComputer) && (choice?.kind === 'default' || !choice && value === '');
  return <ComposerPopover visible={visible} anchorRef={anchorRef} onClose={close} width={256} testID="remote-model-popover" accessibilityLabel="模型选择">
    <View style={styles.body}>
      <View style={styles.header}>
        <Text style={styles.heading}>模型{presentation.familyLabel ? ` · ${presentation.familyLabel}` : ''}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="刷新模型列表" disabled={loading || interactionBlocked}
          accessibilityState={{ disabled: loading || interactionBlocked }} style={styles.refresh} onPress={() => {
            if (currentAction() && !loading && !interactionBlocked) { pending.current = null; owner.current.epoch += 1; setRevision(previous => previous + 1); onRefresh(); }
          }}>{loading ? <ActivityIndicator size="small" color={colors.textMuted}/> : <Icon name="regenerate" size={15} color={colors.textMuted}/>}</Pressable>
      </View>
      <ScrollView style={styles.models} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {list.map((item, index) => <Pressable key={`${epoch}:${item.id}`} testID={`remote-model-node-${index}`} accessibilityRole="radio"
          accessibilityLabel={item.label} accessibilityHint={item.id} accessibilityState={{ checked: !defaultSelected && selected === item.id, disabled: !canSelect }} aria-checked={!defaultSelected && selected === item.id} disabled={!canSelect}
          onPress={() => choose(item.id)} accessibilityActions={[{ name: 'activate', label: '使用此模型' }]} onAccessibilityTap={() => choose(item.id)}
          onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate') choose(item.id); }}
          style={({ pressed }) => [styles.row, !defaultSelected && selected === item.id && styles.selected, pressed && styles.pressed, !canSelect && styles.disabled]}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.model}>{item.label}</Text>
          {!defaultSelected && selected === item.id ? <Icon name="check" size={15} color={colors.textSecondary}/> : null}
        </Pressable>)}
        {error ? <Text accessibilityRole="alert" style={styles.note}>{error}</Text> : !list.length && !loading ? <Text style={styles.note}>暂无可用模型</Text> : null}
      </ScrollView>
      {onFollowComputer ? <Pressable accessibilityRole="radio" accessibilityLabel="使用默认模型" accessibilityState={{ checked: defaultSelected, disabled: interactionBlocked || loading }} aria-checked={defaultSelected} disabled={interactionBlocked || loading} style={[styles.follow, defaultSelected && styles.selected]}
        onPress={() => { if (currentAction() && !interactionBlocked && !loading) { const next: Pending = { epoch, kind: 'default', id: fallback }; pending.current = next; setPreview(next); } }}><Text style={styles.defaultLabel}>使用默认模型</Text>{defaultSelected ? <Icon name="check" size={15} color={colors.textSecondary}/> : null}</Pressable> : null}
    </View>
  </ComposerPopover>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  body: { paddingHorizontal: 4, paddingVertical: 3 }, header: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, paddingLeft: 8 },
  heading: { color: c.textMuted, fontSize: 12, lineHeight: 16 }, refresh: { width: 30, height: 28, alignItems: 'center', justifyContent: 'center' },
  models: { maxHeight: 252 }, row: { minHeight: 36, borderRadius: 6, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  model: { color: c.text, fontSize: 13, lineHeight: 20, flex: 1 }, selected: { backgroundColor: c.tint }, pressed: { backgroundColor: c.tint }, disabled: { opacity: 0.4 },
  note: { color: c.textMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 8, paddingVertical: 8 }, defaultLabel: { color: c.textSecondary, fontSize: 12, lineHeight: 18 },
  follow: { minHeight: 36, paddingHorizontal: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.divider, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dot: { alignItems: 'center', justifyContent: 'center' }, dotText: { color: d.onInk, fontWeight: '800' },
}));
