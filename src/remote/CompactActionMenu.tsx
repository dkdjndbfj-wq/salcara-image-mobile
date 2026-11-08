import React, { useEffect, useRef, type RefObject } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '../components/Icon';
import { useDesk } from '../theme';
import { ComposerPopover } from './ComposerPopover';

export type CompactAction = { id: string; label: string; icon?: IconName; disabled?: boolean; onPress: () => void };

/** A short anchored list; each opening owns its actions until it closes. */
export function CompactActionMenu({ visible, anchorRef, onClose, actions, scopeKey = '', width = 156,
  placement = 'auto', align = 'start', testID = 'compact-action-menu', label = '操作菜单' }: {
  visible: boolean; anchorRef?: RefObject<View | null>; onClose: () => void; actions: CompactAction[];
  scopeKey?: string; width?: number; placement?: 'auto' | 'bottom'; align?: 'start' | 'end'; testID?: string; label?: string;
}) {
  const d = useDesk(), mounted = useRef(true);
  const signature = JSON.stringify([visible, scopeKey, actions.map(({ id, label: text, icon, disabled }) => [id, text, icon, Boolean(disabled)])]);
  const owner = useRef({ signature, scopeKey, visible, epoch: 0, retired: false });
  if (owner.current.signature !== signature) {
    const previous = owner.current;
    owner.current = { signature, scopeKey, visible, epoch: previous.epoch + 1,
      retired: previous.visible && visible && previous.scopeKey === scopeKey && previous.retired };
  }
  const epoch = owner.current.epoch, latest = useRef({ actions, onClose });
  latest.current = { actions, onClose };
  const active = () => mounted.current && owner.current.visible && !owner.current.retired && owner.current.epoch === epoch
    && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const retire = () => { owner.current.retired = true; ++owner.current.epoch; };
  const dismiss = () => { if (active()) { retire(); latest.current.onClose(); } };
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && owner.current.visible && !owner.current.retired) {
        retire(); latest.current.onClose();
      }
    });
    return () => { mounted.current = false; subscription.remove(); };
  }, []);
  return <ComposerPopover visible={visible} anchorRef={anchorRef} onClose={dismiss} width={width}
    placement={placement} align={align} testID={testID} accessibilityLabel={label}>
    <View style={styles.options}>{actions.map(action => <Pressable key={action.id} accessibilityRole="button"
      accessibilityLabel={action.label} accessibilityState={{ disabled: Boolean(action.disabled) }} disabled={action.disabled}
      onPress={() => {
        if (!active()) return;
        const selected = latest.current.actions.find(item => item.id === action.id);
        if (!selected || selected.disabled) return;
        retire(); latest.current.onClose(); selected.onPress();
      }} style={({ pressed }) => [styles.option, pressed && { backgroundColor: d.surface2 }, action.disabled && styles.disabled]}>
      {action.icon ? <Icon name={action.icon} size={16} strokeWidth={1.6} color={d.text2} accent={d.text2}/> : null}
      <Text numberOfLines={1} style={[styles.label, { color: d.text }]}>{action.label}</Text>
    </Pressable>)}</View>
  </ComposerPopover>;
}

const styles = StyleSheet.create({
  options: { padding: 4, borderRadius: 8 },
  option: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, borderRadius: 8 },
  label: { flex: 1, fontSize: 13, lineHeight: 20 },
  disabled: { opacity: .4 },
});
