import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator, Animated, Easing, Keyboard, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { brandGradient, colors, motion, radius, shadow } from '../theme';
import { Icon, type IconName } from './Icon';
import { MotionPressable, useReducedMotion } from './MotionPressable';

export { Appear, MotionPressable, useReducedMotion } from './MotionPressable';
export type { IconName } from './Icon';
export type DialogAction = { label: string; onPress?: () => void; tone?: 'primary' | 'secondary' | 'danger'; disabled?: boolean };

export function dismissKeyboardAndBlur() {
  const input = TextInput.State?.currentlyFocusedInput?.();
  if (input) TextInput.State.blurTextInput(input);
  Keyboard.dismiss();
}

export function IconButton({ icon, onPress, label, disabled = false, variant = 'ghost', size = 40, iconSize = 22, color }: {
  icon: IconName; onPress: () => void; label: string; disabled?: boolean;
  variant?: 'ghost' | 'soft' | 'solid'; size?: number; iconSize?: number; color?: string;
}) {
  const tint = color ?? (variant === 'solid' ? colors.onPrimary : colors.text);
  return <MotionPressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} scaleTo={0.9}
    onPress={() => { dismissKeyboardAndBlur(); onPress(); }}
    style={[styles.iconButton, { width: size, height: size, borderRadius: size / 2 }, variant === 'soft' && styles.iconSoft, variant === 'solid' && styles.iconSolid, disabled && styles.disabled]}>
    <Icon name={icon} size={iconSize} color={tint} />
  </MotionPressable>;
}

export function Chip({ label, selected = false, onPress, disabled = false }: { label: string; selected?: boolean; onPress: () => void; disabled?: boolean }) {
  return <MotionPressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} scaleTo={0.95} onPress={() => { dismissKeyboardAndBlur(); onPress(); }}
    style={[styles.chip, selected && styles.chipSelected, disabled && styles.disabled]}>
    <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>{label}</Text>
  </MotionPressable>;
}

export function PrimaryButton({ label, onPress, loading = false, disabled = false, icon, tone = 'primary', style }: {
  label: string; onPress: () => void; loading?: boolean; disabled?: boolean; icon?: IconName; tone?: 'primary' | 'secondary' | 'danger'; style?: StyleProp<ViewStyle>;
}) {
  const fg = tone === 'primary' ? colors.onPrimary : tone === 'danger' ? colors.danger : colors.text;
  return <MotionPressable scaleTo={0.97} accessibilityRole="button" accessibilityState={{ disabled: disabled || loading }} disabled={disabled || loading}
    onPress={() => { dismissKeyboardAndBlur(); onPress(); }}
    style={[styles.button, tone === 'primary' && styles.buttonPrimary, tone === 'secondary' && styles.buttonSecondary, tone === 'danger' && styles.buttonDanger, (disabled || loading) && styles.disabled, style]}>
    {tone === 'primary' && <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.buttonFill]}><BrandFill /></View>}
    {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={19} color={fg} strokeWidth={1.9} /> : null}
    <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
  </MotionPressable>;
}

/** Brand gradient fill (sky → blue → violet) that stretches to its parent. */
function BrandFill() {
  return <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
    <Defs>
      <LinearGradient id="brandFill" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
        <Stop offset="0" stopColor={brandGradient[0]} />
        <Stop offset="0.5" stopColor={brandGradient[1]} />
        <Stop offset="1" stopColor={brandGradient[2]} />
      </LinearGradient>
    </Defs>
    <Rect x="0" y="0" width="100" height="100" fill="url(#brandFill)" />
  </Svg>;
}

function useOverlay(visible: boolean) {
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (visible) setMounted(true);
    if (reduced) { progress.setValue(visible ? 1 : 0); if (!visible) setMounted(false); return; }
    const animation = visible
      ? Animated.spring(progress, { toValue: 1, damping: 26, stiffness: 260, mass: 0.9, useNativeDriver: true })
      : Animated.timing(progress, { toValue: 0, duration: motion.exit, easing: Easing.in(Easing.cubic), useNativeDriver: true });
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false); });
    return () => animation.stop();
  }, [visible, reduced, progress]);
  return { mounted, progress };
}

/** Bottom sheet (drag to dismiss) or a pushed full page. */
export function Sheet({ visible, title, subtitle, onClose, children, scroll = true, footer, presentation = 'sheet', headerRight, background }: {
  visible: boolean; title?: string; subtitle?: string; onClose: () => void; children: ReactNode; scroll?: boolean;
  footer?: ReactNode; presentation?: 'sheet' | 'page'; headerRight?: ReactNode; background?: string;
}) {
  const insets = useSafeAreaInsets();
  const { mounted, progress } = useOverlay(visible);
  const drag = useRef(new Animated.Value(0)).current;
  const page = presentation === 'page';
  const close = () => { dismissKeyboardAndBlur(); onClose(); };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { if (visible) drag.setValue(0); }, [visible, drag]);
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (g.dy > 110 || g.vy > 0.9) closeRef.current();
      else Animated.spring(drag, { toValue: 0, damping: 22, stiffness: 280, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(),
  })).current;
  const pagePan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (e, g) => g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2 && e.nativeEvent.pageX - g.dx < 40,
    onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dx)),
    onPanResponderRelease: (_, g) => {
      if (g.dx > 120 || g.vx > 0.8) closeRef.current();
      else Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
    },
  })).current;
  const transform = page
    ? [{ translateX: Animated.add(drag, progress.interpolate({ inputRange: [0, 1], outputRange: [60, 0] })) }]
    : [{ translateY: Animated.add(drag, progress.interpolate({ inputRange: [0, 1], outputRange: [480, 0] })) }];
  const bg = background ?? colors.card;
  return <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={close}>
    <View style={styles.overlay} accessibilityViewIsModal>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, page ? { backgroundColor: 'rgba(11,18,32,0.12)' } : styles.scrim, { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }) }]} />
      {!page && <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="关闭" onPress={close} />}
      <KeyboardAvoidingView pointerEvents="box-none" style={styles.placement} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View {...(page ? pagePan.panHandlers : {})} style={[styles.sheet, page && styles.page, {
          backgroundColor: bg, paddingTop: page ? insets.top : 0, marginTop: page ? 0 : Math.max(insets.top, 24),
          paddingBottom: footer ? 0 : Math.max(insets.bottom, 12), opacity: page ? progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }) : 1,
          transform,
        }]}>
          {!page && <View {...pan.panHandlers} style={styles.handleZone}><View style={styles.handle} /></View>}
          {(title !== undefined || page) && <View style={[styles.header, page && styles.pageHeader]} {...(!page ? pan.panHandlers : {})}>
            {page ? <IconButton icon="chevronLeft" label="返回" onPress={close} /> : <View style={{ width: 32 }} />}
            <View style={styles.headerCenter}>
              {title ? <Text style={styles.title} numberOfLines={1}>{title}</Text> : null}
              {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
            {headerRight ?? (page ? <View style={{ width: 40 }} /> : <IconButton icon="close" label="关闭" variant="soft" size={32} iconSize={16} color={colors.textMuted} onPress={close} />)}
          </View>}
          {scroll
            ? <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>{children}</ScrollView>
            : <View style={styles.body}>{children}</View>}
          {footer && <View style={[styles.footer, { backgroundColor: bg, paddingBottom: Math.max(insets.bottom, 14) }]}>{footer}</View>}
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  </Modal>;
}

export function AppDialog({ visible, title, message, icon, actions, children, dismissible = true, onClose }: {
  visible: boolean; title: string; message?: string; icon?: IconName | string; actions?: DialogAction[]; children?: ReactNode; dismissible?: boolean; onClose: () => void;
}) {
  const { mounted, progress } = useOverlay(visible);
  const resolved = actions?.length ? actions : [{ label: '好的', tone: 'primary' as const, onPress: onClose }];
  const close = () => { if (dismissible) { dismissKeyboardAndBlur(); onClose(); } };
  const danger = resolved.some((action) => action.tone === 'danger');
  const glyph = normalizeIcon(icon);
  return <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={close}>
    <View style={styles.dialogBackdrop}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]} />
      {dismissible && <Pressable accessibilityLabel="关闭提示" style={StyleSheet.absoluteFill} onPress={close} />}
      <Animated.View accessibilityViewIsModal style={[styles.dialog, { opacity: progress, transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dialogContent}>
          {glyph && <View style={[styles.dialogIcon, danger && { backgroundColor: colors.dangerSurface }]}><Icon name={glyph} size={22} color={danger ? colors.danger : colors.primary} /></View>}
          <Text style={styles.dialogTitle}>{title}</Text>
          {message ? <Text selectable style={styles.dialogMessage}>{message}</Text> : null}
          {children}
        </ScrollView>
        <View style={styles.dialogActions}>{resolved.map((action, index) => {
          const tone = action.tone ?? (index === resolved.length - 1 ? 'primary' : 'secondary');
          return <Pressable key={`${action.label}-${index}`} accessibilityRole="button" disabled={action.disabled}
            onPress={() => { dismissKeyboardAndBlur(); action.onPress?.(); }}
            style={({ pressed }) => [styles.dialogAction, tone === 'primary' && styles.actionPrimary, tone === 'danger' && styles.actionDanger, pressed && { opacity: 0.8 }, action.disabled && styles.disabled]}>
            <Text style={[styles.actionText, (tone === 'primary' || tone === 'danger') && { color: colors.onPrimary }]}>{action.label}</Text>
          </Pressable>;
        })}</View>
      </Animated.View>
    </View>
  </Modal>;
}

const LEGACY: Record<string, IconName> = {
  'alert-circle-outline': 'alert', 'information-circle-outline': 'info', 'image-outline': 'image', 'document-text-outline': 'file', 'brush-outline': 'brush',
  'hourglass-outline': 'hourglass', 'trash-outline': 'trash', 'create-outline': 'edit', 'cloud-download-outline': 'cloudDown', 'checkmark-circle-outline': 'checkCircle',
  'pulse-outline': 'pulse', 'chatbubble-ellipses-outline': 'chat', 'shield-checkmark-outline': 'lock', 'warning-outline': 'alert', 'download-outline': 'download',
};
function normalizeIcon(icon?: string): IconName | null {
  if (!icon) return null;
  return (LEGACY[icon] ?? icon) as IconName;
}

/** Inset-grouped list container, like iOS settings. */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.group, style]}>{children}</View>;
}
export const Card = Group;

export function ListRow({ icon, title, detail, value, onPress, right, danger = false, first = false }: {
  icon?: IconName; title: string; detail?: string; value?: string; onPress?: () => void; right?: ReactNode; danger?: boolean; first?: boolean;
}) {
  return <Pressable accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceStrong }]}>
    {icon && <Icon name={icon} size={21} color={danger ? colors.danger : colors.textSecondary} />}
    <View style={[styles.rowBody, !first && styles.rowDivider]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowTitle, danger && { color: colors.danger }]} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={styles.rowDetail} numberOfLines={2}>{detail}</Text> : null}
      </View>
      {value ? <Text style={styles.rowValue} numberOfLines={1}>{value}</Text> : null}
      {right ?? (onPress ? <Icon name="chevronRight" size={18} color={colors.faint} /> : null)}
    </View>
  </Pressable>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

// ——— Toast ———
type ToastMessage = { id: number; text: string; icon: IconName };
let toastListener: ((toast: ToastMessage) => void) | null = null;
let toastId = 0;
export function showToast(text: string, icon: IconName = 'checkCircle') { toastListener?.({ id: ++toastId, text, icon }); }

export function ToastHost() {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  useEffect(() => {
    toastListener = setToast;
    return () => { if (toastListener === setToast) toastListener = null; };
  }, []);
  useEffect(() => {
    if (!toast) return;
    progress.setValue(0);
    const animation = Animated.sequence([
      Animated.spring(progress, { toValue: 1, damping: 18, stiffness: 240, useNativeDriver: true }),
      Animated.delay(1400),
      Animated.timing(progress, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => { if (finished) setToast(null); });
    return () => animation.stop();
  }, [toast, progress]);
  if (!toast) return null;
  return <Animated.View pointerEvents="none" style={[styles.toast, { top: insets.top + 10, opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) }, { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }]}>
    <Icon name={toast.icon} size={17} color="#FFFFFF" strokeWidth={1.9} />
    <Text style={styles.toastText}>{toast.text}</Text>
  </Animated.View>;
}

const styles = StyleSheet.create({
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  iconSoft: { backgroundColor: colors.surfaceStrong },
  iconSolid: { backgroundColor: colors.primary },
  disabled: { opacity: 0.35 },
  chip: { height: 36, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  chipSelected: { backgroundColor: colors.primarySoft, borderColor: colors.glow },
  chipText: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '500' },
  chipTextSelected: { color: colors.primaryDeep, fontWeight: '600' },
  button: { minHeight: 52, borderRadius: radius.pill, paddingHorizontal: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonPrimary: { backgroundColor: colors.primary, ...shadow.glow },
  buttonFill: { borderRadius: radius.pill, overflow: 'hidden' },
  buttonSecondary: { backgroundColor: colors.surfaceStrong },
  buttonDanger: { backgroundColor: colors.dangerSurface },
  buttonText: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  overlay: { flex: 1 },
  scrim: { backgroundColor: colors.scrim },
  placement: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%', flexShrink: 1, minHeight: 180, borderTopLeftRadius: 30, borderTopRightRadius: 30, overflow: 'hidden', ...shadow.float },
  page: { flex: 1, maxHeight: '100%', borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  handleZone: { height: 18, alignItems: 'center', justifyContent: 'flex-end' },
  handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: colors.tint },
  header: { minHeight: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 6 },
  pageHeader: { paddingHorizontal: 6, minHeight: 52 },
  headerCenter: { flex: 1, alignItems: 'center' },
  title: { color: colors.text, fontSize: 17, fontWeight: '600', letterSpacing: -0.2 },
  subtitle: { color: colors.subtle, fontSize: 12, marginTop: 2 },
  scroll: { flexShrink: 1 },
  content: { paddingBottom: 18 },
  body: { flexShrink: 1, paddingBottom: 8 },
  footer: { paddingHorizontal: 20, paddingTop: 10 },
  dialogBackdrop: { flex: 1, padding: 32, justifyContent: 'center', alignItems: 'center' },
  dialog: { maxHeight: '80%', width: '100%', maxWidth: 360, padding: 24, borderRadius: 28, backgroundColor: colors.card, ...shadow.float },
  dialogContent: { gap: 8 },
  dialogIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft, marginBottom: 8 },
  dialogTitle: { color: colors.text, fontSize: 18, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2 },
  dialogMessage: { color: colors.textMuted, fontSize: 14.5, lineHeight: 22 },
  dialogActions: { marginTop: 22, flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  dialogAction: { minHeight: 42, paddingHorizontal: 20, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceStrong },
  actionPrimary: { backgroundColor: colors.primary },
  actionDanger: { backgroundColor: colors.danger },
  actionText: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  group: { backgroundColor: colors.surface, borderRadius: 20, overflow: 'hidden' },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16 },
  rowBody: { flex: 1, minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 14, paddingVertical: 10 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  rowTitle: { color: colors.text, fontSize: 15.5, fontWeight: '400' },
  rowDetail: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  rowValue: { color: colors.subtle, fontSize: 14, maxWidth: '50%' },
  sectionLabel: { color: colors.subtle, fontSize: 12.5, fontWeight: '500', marginTop: 26, marginBottom: 8, marginLeft: 16 },
  toast: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, height: 42, borderRadius: radius.pill, backgroundColor: 'rgba(11,18,32,0.92)', ...shadow.float, zIndex: 100 },
  toastText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
});
