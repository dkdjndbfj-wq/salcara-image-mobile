import React, { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AppState, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Icon } from '../components/Icon';
import { themed, useDesk } from '../theme';

/** An unshaded, anchored menu. Modal supplies only the native portal/back button. */
export function ComposerPopover({ visible, anchorRef, anchorRevision, onClose, children, header, maxHeight: requestedMaxHeight, width: requestedWidth = 352, placement = 'auto', align = 'start', testID, accessibilityLabel = '输入框菜单' }: {
  visible: boolean; anchorRef?: RefObject<View | null>; onClose: () => void; children: ReactNode; width?: number; placement?: 'auto' | 'bottom'; align?: 'start' | 'end'; testID?: string; accessibilityLabel?: string;
  anchorRevision?: string | number;
  header?: ReactNode; maxHeight?: number;
}) {
  const styles = useStyles(), window = useWindowDimensions();
  const [keyboardTop, setKeyboardTop] = useState<number>(), [panelHeight, setPanelHeight] = useState(200);
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number; height: number }>();
  const generation = useRef(0);
  const width = Math.max(0, Math.min(requestedWidth, window.width - 24));
  const bottom = Math.min(window.height, keyboardTop ?? window.height);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', event => setKeyboardTop(event.endCoordinates.screenY));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(undefined));
    return () => { show.remove(); hide.remove(); };
  }, []);
  useEffect(() => {
    const current = ++generation.current;
    if (!visible) { setAnchor(undefined); return; }
    const frame = requestAnimationFrame(() => anchorRef?.current?.measureInWindow((x, y, measuredWidth, height) => {
      if (generation.current === current && measuredWidth > 0) setAnchor({ x, y, width: measuredWidth, height });
    }));
    return () => { ++generation.current; cancelAnimationFrame(frame); };
  }, [visible, anchorRef, anchorRevision, window.width, window.height, keyboardTop]);
  const anchorLeft = anchor ? anchor.x + (align === 'end' ? anchor.width - width : 0) : window.width - width - 12;
  const left = Math.max(12, Math.min(window.width - width - 12, anchorLeft));
  const anchorTop = Math.min(anchor?.y ?? bottom - 72, bottom - 12);
  const spaceAbove = anchorTop - 20, spaceBelow = bottom - (anchorTop + (anchor?.height ?? 32)) - 20;
  const contentHeight = Math.min(panelHeight, requestedMaxHeight ?? Infinity);
  const below = placement === 'bottom' ? spaceBelow >= Math.min(contentHeight, spaceAbove) : contentHeight > spaceAbove && spaceBelow > spaceAbove;
  const maxHeight = Math.max(44, Math.min(below ? spaceBelow : spaceAbove, requestedMaxHeight ?? Infinity));
  const top = below ? anchorTop + (anchor?.height ?? 32) + 8 : Math.max(12, anchorTop - Math.min(panelHeight, maxHeight) - 8);
  return <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
      <Pressable testID={testID ? `${testID}-backdrop` : undefined} accessibilityRole="button" accessibilityLabel={`关闭${accessibilityLabel}`} onPress={onClose} style={StyleSheet.absoluteFill} />
      <View testID={testID} accessibilityLabel={accessibilityLabel}
        onLayout={event => { const height = event.nativeEvent.layout.height; if (height > 0) setPanelHeight(height); }}
        style={[styles.panel, { left, top, width, maxHeight }]}>
        {header}
        <ScrollView style={styles.scroll} keyboardShouldPersistTaps="always" bounces={false} showsVerticalScrollIndicator={requestedMaxHeight !== undefined}>{children}</ScrollView>
      </View>
    </View>
  </Modal>;
}

export function ComposerPermissionIcon({ kind = 'shield', color }: { kind?: 'hand' | 'review' | 'shield'; color: string }) {
  return <Svg width={19} height={21} viewBox="0 0 24 24" {...(Platform.OS === 'web' ? { 'aria-hidden': true as const } : { accessible: false })}>
    {kind === 'hand' ? <Path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11 3.5a1.5 1.5 0 0 1 3 0V11 5a1.5 1.5 0 0 1 3 0v7-4a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6.5 7-2.5 0-4.1-1.3-5.7-3.3L4.5 14a1.6 1.6 0 0 1 2.5-2l2 2" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /> : <><Path d="m12 2 9 4v7c0 4-3 7-9 9-6-2-9-5-9-9V6l9-4Z" fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" /><Path d={kind === 'review' ? 'm8 9 3 3-3 3m5 1h3' : 'M12 7v6m0 4v.1'} fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></>}
  </Svg>;
}

export type ComposerMenuOption<T extends string> = { value: T; label: string; danger?: boolean; disabled?: boolean; icon?: 'hand' | 'review' | 'shield' };
export function ComposerOptionMenu<T extends string>({ visible, anchorRef, value, options, onSelect, onClose, scopeKey = '', accessibilityLabel = '权限菜单' }: {
  visible: boolean; anchorRef?: RefObject<View | null>; value: T; options: ComposerMenuOption<T>[]; onSelect: (value: T) => void; onClose: () => void; scopeKey?: string; accessibilityLabel?: string;
}) {
  const styles = useStyles(), d = useDesk();
  const signature = JSON.stringify([visible, scopeKey, value, options]);
  const owner = useRef({ signature, epoch: 0 });
  if (owner.current.signature !== signature) owner.current = { signature, epoch: owner.current.epoch + 1 };
  const epoch = owner.current.epoch, mounted = useRef(true);
  const active = () => mounted.current && visible && owner.current.epoch === epoch && AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const dismiss = () => { if (active()) { ++owner.current.epoch; onClose(); } };
  useEffect(() => { mounted.current = true; const subscription = AppState.addEventListener('change', state => { if (state !== 'active') { ++owner.current.epoch; onClose(); } }); return () => { mounted.current = false; subscription.remove(); }; }, [onClose]);
  return <ComposerPopover visible={visible} anchorRef={anchorRef} onClose={dismiss} width={260} testID="composer-permission-menu" accessibilityLabel={accessibilityLabel}>
    <View style={styles.options}>{options.map(option => {
      const selected = option.value === value, color = option.danger ? '#F45B0B' : d.text;
      return <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: selected, disabled: Boolean(option.disabled) }} aria-checked={selected} disabled={option.disabled}
        onPress={() => { if (active() && !option.disabled) { ++owner.current.epoch; onSelect(option.value); } }}
        style={({ pressed }) => [styles.option, (pressed || selected) && { backgroundColor: d.surface2 }, option.disabled && { opacity: .4 }]}>
        <ComposerPermissionIcon kind={option.icon ?? (option.value === 'ask' || option.value === 'workspace-write' ? 'hand' : option.value === 'auto_review' ? 'review' : 'shield')} color={color} />
        <Text numberOfLines={1} style={[styles.label, { color }]}>{option.label}</Text>
        {selected ? <Icon name="check" size={17} color={color} /> : <View style={{ width: 17 }} />}
      </Pressable>;
    })}</View>
  </ComposerPopover>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  panel: { position: 'absolute', backgroundColor: c.card, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, shadowColor: '#000', shadowOpacity: .09, shadowRadius: 16, shadowOffset: { width: 0, height: 5 }, elevation: 12, overflow: 'hidden' },
  scroll: { minHeight: 0, flexShrink: 1 },
  options: { padding: 5, gap: 2 }, option: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 42, paddingHorizontal: 9, borderRadius: 8 }, label: { flex: 1, fontSize: 14, lineHeight: 20, color: d.text },
}));
