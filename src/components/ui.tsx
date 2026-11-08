import React, { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ActivityIndicator, Animated, Easing, Keyboard, Modal, PanResponder, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View, type StyleProp, type ViewStyle,
} from 'react-native';
import { KeyboardSafeView } from './KeyboardSafeView';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { brandGradient, colors, motion, radius, shadow, useDesk, desk, themed } from '../theme';
import { Icon, type IconName } from './Icon';
import { MotionPressable, useReducedMotion } from './MotionPressable';
import { roundedSystemFontFamily } from '../typography';

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
  /** 'ink': the 编程 space's near-black button (desktop look). */
  variant?: 'ghost' | 'soft' | 'solid' | 'glass' | 'ink'; size?: number; iconSize?: number; color?: string;
}) {
  const styles = useStyles();
  const dk = useDesk();
  const tint = color ?? (variant === 'solid' ? colors.onPrimary : variant === 'ink' ? dk.onInk : colors.text);
  return <MotionPressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} scaleTo={0.88} hitSlop={slopFor(size)}
    onPress={() => { dismissKeyboardAndBlur(); onPress(); }}
    style={({ pressed }: { pressed: boolean }) => [styles.iconButton, { width: size, height: size, borderRadius: size / 2 },
      variant === 'ghost' && pressed && styles.iconPressed, variant === 'soft' && styles.iconSoft, variant === 'glass' && styles.iconGlass,
      variant === 'solid' && styles.iconSolid, variant === 'ink' && { backgroundColor: dk.ink }, disabled && styles.disabled]}>
    {variant === 'solid' && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: size / 2, overflow: 'hidden' }]}><BrandFill /><Sheen /></View>}
    <Icon name={icon} size={iconSize} color={tint} />
  </MotionPressable>;
}

/** Pads small controls out to a 48dp touch target without changing their look. */
export function slopFor(size: number, target = 48) {
  return Math.max(0, Math.ceil((target - size) / 2));
}

export function Chip({ label, selected = false, onPress, disabled = false, icon }: { label: string; selected?: boolean; onPress: () => void; disabled?: boolean; icon?: IconName }) {
  const styles = useStyles();
  return <MotionPressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} scaleTo={0.94} onPress={() => { dismissKeyboardAndBlur(); onPress(); }}
    style={[styles.chip, selected && styles.chipSelected, disabled && styles.disabled]}>
    {selected ? <View style={styles.chipDot} /> : icon ? <Icon name={icon} size={15} color={colors.textMuted} /> : null}
    <Text style={[styles.chipText, selected && styles.chipTextSelected]} numberOfLines={1}>{label}</Text>
  </MotionPressable>;
}

export function PrimaryButton({ label, onPress, loading = false, disabled = false, icon, tone = 'primary', style }: {
  label: string; onPress: () => void; loading?: boolean; disabled?: boolean; icon?: IconName; tone?: 'primary' | 'secondary' | 'danger'; style?: StyleProp<ViewStyle>;
}) {
  const styles = useStyles();
  const fg = tone === 'primary' ? colors.onPrimary : tone === 'danger' ? colors.danger : colors.text;
  return <MotionPressable scaleTo={0.965} accessibilityRole="button" accessibilityState={{ disabled: disabled || loading }} disabled={disabled || loading}
    onPress={() => { dismissKeyboardAndBlur(); onPress(); }}
    style={[styles.button, tone === 'primary' && styles.buttonPrimary, tone === 'secondary' && styles.buttonSecondary, tone === 'danger' && styles.buttonDanger, (disabled || loading) && styles.disabled, style]}>
    {tone === 'primary' && <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.buttonFill]}><BrandFill /><Sheen /></View>}
    {loading ? <ActivityIndicator color={fg} /> : icon ? <Icon name={icon} size={19} color={fg} strokeWidth={1.9} /> : null}
    <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
  </MotionPressable>;
}

/** A soft highlight on the upper half of filled controls, so they read as lit glass rather than flat paint. */
export function Sheen({ strength = 0.28 }: { strength?: number }) {
  return <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 100 100">
    <Defs>
      <LinearGradient id="uiSheen" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse">
        <Stop offset="0" stopColor="#FFFFFF" stopOpacity={strength} />
        <Stop offset="0.55" stopColor="#FFFFFF" stopOpacity={0} />
      </LinearGradient>
    </Defs>
    <Rect x="0" y="0" width="100" height="100" fill="url(#uiSheen)" />
  </Svg>;
}

/** Brand gradient fill (sky → blue → violet) that stretches to its parent. */
export function BrandFill() {
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

/** Compact floating dialog (outside tap / drag to dismiss) or a pushed full page. */
export function Sheet({ visible, title, subtitle, onClose, onSystemBack, children, scroll = true, footer, presentation = 'sheet', headerRight, headerLeft, background, surfaceRef, dismissible = true, hideHeader = false }: {
  visible: boolean; title?: string; subtitle?: string; onClose: () => void; children: ReactNode; scroll?: boolean;
  footer?: ReactNode; presentation?: 'sheet' | 'page'; headerRight?: ReactNode; headerLeft?: ReactNode; background?: string;
  surfaceRef?: RefObject<View | null>; dismissible?: boolean; hideHeader?: boolean;
  onSystemBack?: () => void;
}) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { mounted, progress } = useOverlay(visible);
  const drag = useRef(new Animated.Value(0)).current;
  const page = presentation === 'page';
  const [keyboardCovered, setKeyboardCovered] = useState(false);
  const dismissibleRef = useRef(dismissible); dismissibleRef.current = dismissible;
  const close = () => { if (dismissibleRef.current) {
    // A nested tool page may consume close while keeping this sheet mounted.
    Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
    dismissKeyboardAndBlur(); onClose();
  } };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { if (visible) drag.setValue(0); }, [visible, drag]);
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => dismissibleRef.current && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => {
      if (dismissibleRef.current && (g.dy > 110 || g.vy > 0.9)) closeRef.current();
      else Animated.spring(drag, { toValue: 0, damping: 22, stiffness: 280, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(),
  })).current;
  const pagePan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (e, g) => dismissibleRef.current && g.dx > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2 && e.nativeEvent.pageX - g.dx < 40,
    onPanResponderMove: (_, g) => drag.setValue(Math.max(0, g.dx)),
    onPanResponderRelease: (_, g) => {
      if (dismissibleRef.current && (g.dx > 120 || g.vx > 0.8)) closeRef.current();
      else Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
    },
  })).current;
  const transform = page
    ? [{ translateX: Animated.add(drag, progress.interpolate({ inputRange: [0, 1], outputRange: [60, 0] })) }]
    : [{ translateY: Animated.add(drag, progress.interpolate({ inputRange: [0, 1], outputRange: [12, 0] })) },
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }];
  const bg = background ?? colors.card;
  return <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={() => {
    if (visible && dismissibleRef.current) (onSystemBack ?? close)();
  }}>
    <View style={styles.overlay} accessibilityViewIsModal onAccessibilityEscape={close}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, page ? { backgroundColor: 'rgba(11,18,32,0.12)' } : styles.scrim, { opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }) }]} />
      {!page && <Pressable testID="sheet-backdrop" style={StyleSheet.absoluteFill} accessible={false} importantForAccessibility="no" onPress={close} />}
      <KeyboardSafeView pointerEvents="box-none" onOcclusionChange={setKeyboardCovered} style={[styles.placement, !page && styles.placementFloat, !page && { paddingTop: Math.max(insets.top, 16) + 8, paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
        <Animated.View ref={surfaceRef} collapsable={surfaceRef ? false : undefined} {...(page ? pagePan.panHandlers : {})} style={[styles.sheet, page && styles.page, {
          backgroundColor: bg, paddingTop: page ? insets.top : 0,
          paddingBottom: footer ? 0 : page ? (!keyboardCovered ? Math.max(insets.bottom, 12) : 12) : 4, opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
          transform,
        }]}>
          {!hideHeader && (title !== undefined || page) && <View style={[styles.header, page && styles.pageHeader]} {...(!page ? pan.panHandlers : {})}>
            {page ? headerLeft ?? <IconButton icon="chevronLeft" label="返回" onPress={close} /> : headerLeft}
            <View style={[styles.headerCenter, !page && styles.dialogHeaderText]}>
              {title ? <Text accessibilityRole="header" style={[styles.title, !page && styles.floatingTitle]} numberOfLines={page ? 1 : 2}>{title}</Text> : null}
              {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
            {headerRight ?? (page ? <View style={{ width: 40 }} /> : null)}
          </View>}
          {scroll
            ? <ScrollView style={styles.scroll} contentContainerStyle={page ? styles.content : styles.floatingContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>{children}</ScrollView>
            : <View style={[styles.body, page ? { flex: 1 } : { paddingBottom: 0 }]}>{children}</View>}
          {footer && <View style={[styles.footer, { backgroundColor: bg, paddingBottom: page && !keyboardCovered ? Math.max(insets.bottom, 14) : 14 }]}>{footer}</View>}
        </Animated.View>
      </KeyboardSafeView>
      <ToastHost />
    </View>
  </Modal>;
}

export function AppDialog({ visible, title, message, icon, actions, children, dismissible = true, onClose }: {
  visible: boolean; title: string; message?: string; icon?: IconName | string; actions?: DialogAction[]; children?: ReactNode; dismissible?: boolean; onClose: () => void;
}) {
  const styles = useStyles();
  const d = useDesk();
  const { mounted, progress } = useOverlay(visible);
  const resolved = actions?.length ? actions : [{ label: '好的', tone: 'primary' as const, onPress: onClose }];
  const close = () => { if (dismissible) { dismissKeyboardAndBlur(); onClose(); } };
  const danger = resolved.some((action) => action.tone === 'danger');
  const glyph = normalizeIcon(icon);
  return <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={close}>
    <KeyboardSafeView style={styles.dialogBackdrop}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]} />
      {dismissible && <Pressable testID="dialog-backdrop" accessible={false} importantForAccessibility="no" style={StyleSheet.absoluteFill} onPress={close} />}
      <Animated.View accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.dialog, { opacity: progress, transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }] }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dialogContent}>
          <View style={styles.dialogHead}>
            {glyph && <View style={[styles.dialogIcon, danger && styles.dialogIconDanger]}><Icon name={glyph} size={16} color={danger ? colors.danger : d.muted} /></View>}
            <Text accessibilityRole="header" style={styles.dialogTitle}>{title}</Text>
          </View>
          {message ? <Text selectable style={styles.dialogMessage}>{message}</Text> : null}
          {children}
        </ScrollView>
        <View style={[styles.dialogActions, resolved.length > 2 && styles.dialogActionsStacked]}>{resolved.map((action, index) => {
          const quiet = resolved.length > 2 && /^(关闭|取消)$/.test(action.label);
          const tone = quiet ? 'secondary' : action.tone ?? (index === resolved.length - 1 ? 'primary' : 'secondary');
          return <MotionPressable key={`${action.label}-${index}`} scaleTo={0.98} accessibilityRole="button" accessibilityState={{disabled:action.disabled}} disabled={action.disabled}
            hitSlop={4} wrapperStyle={resolved.length > 2 ? {alignSelf:'stretch'} : {flexShrink:1}}
            onPress={() => { dismissKeyboardAndBlur(); action.onPress?.(); }}
            style={({ pressed }) => [styles.dialogAction, tone === 'primary' && styles.dialogPrimary, tone === 'danger' && styles.dialogDanger, quiet && styles.dialogQuiet, pressed && { opacity: 0.8 }, action.disabled && styles.disabled]}>
            <Text style={[styles.dialogActionText, tone === 'primary' && { color: d.onInk }, tone === 'danger' && { color: colors.danger }, quiet && { color: colors.textMuted, fontWeight: '500' }]}>{action.label}</Text>
          </MotionPressable>;
        })}</View>
      </Animated.View>
    </KeyboardSafeView>
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
  const styles = useStyles();
  return <View style={[styles.group, style]}>{children}</View>;
}
export const Card = Group;

export function ListRow({ icon, title, detail, value, onPress, right, danger = false, first = false }: {
  icon?: IconName; title: string; detail?: string; value?: string; onPress?: () => void; right?: ReactNode; danger?: boolean; first?: boolean;
}) {
  const styles = useStyles();
  return <Pressable accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceStrong }]}>
    {icon && <View style={styles.rowIcon}><Icon name={icon} size={20} color={danger ? colors.danger : colors.textSecondary} /></View>}
    <View style={[styles.rowBody, !first && styles.rowDivider]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowTitle, danger && { color: colors.danger }]} numberOfLines={1}>{title}</Text>
        {detail ? <Text style={styles.rowDetail} numberOfLines={2}>{detail}</Text> : null}
      </View>
      {value ? <Text style={styles.rowValue} numberOfLines={1}>{value}</Text> : null}
      {right ?? (onPress ? <Icon name="chevronRight" size={15} color={colors.faint} strokeWidth={2} /> : null)}
    </View>
  </Pressable>;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

// ——— Toast ———
type ToastMessage = { id: number; text: string; icon: IconName; onPress?: () => void };
/**
 * Every open layer (screen, sheet, image preview) mounts its own host; the most
 * recently mounted one — the one on top — shows the toast, so confirmations are
 * never hidden behind a native modal.
 */
const toastListeners: Array<(toast: ToastMessage) => void> = [];
let toastId = 0;
export function showToast(text: string, icon: IconName = 'checkCircle', onPress?: () => void) { toastListeners[toastListeners.length - 1]?.({ id: ++toastId, text, icon, onPress }); }

export function ToastHost() {
  const styles = useStyles();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  useEffect(() => {
    toastListeners.push(setToast);
    return () => {
      const index = toastListeners.lastIndexOf(setToast);
      if (index >= 0) toastListeners.splice(index, 1);
    };
  }, []);
  useEffect(() => {
    if (!toast) return;
    progress.setValue(0);
    const animation = Animated.sequence([
      Animated.spring(progress, { toValue: 1, damping: 18, stiffness: 240, useNativeDriver: true }),
      Animated.delay(toast.onPress ? 3600 : 1400),
      Animated.timing(progress, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]);
    animation.start(({ finished }) => { if (finished) setToast(null); });
    return () => animation.stop();
  }, [toast, progress]);
  if (!toast) return null;
  const body = <>
    <View style={styles.toastIcon}><Icon name={toast.icon} size={15} color="#FFFFFF" strokeWidth={1.9} /></View>
    <Text style={styles.toastText} numberOfLines={3}>{toast.text}</Text>
    {toast.onPress ? <Icon name="chevronRight" size={16} color="rgba(255,255,255,0.7)" /> : null}
  </>;
  return <Animated.View pointerEvents={toast.onPress ? 'box-none' : 'none'} style={[styles.toast, { top: insets.top + 10, opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-20, 0] }) }, { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }]}>
    {toast.onPress
      ? <Pressable accessibilityRole="button" onPress={() => { const action = toast.onPress; setToast(null); action?.(); }} style={styles.toastPress}>{body}</Pressable>
      : body}
  </Animated.View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  iconPressed: { backgroundColor: colors.surfaceStrong },
  iconSoft: { backgroundColor: colors.surfaceStrong },
  iconGlass: { backgroundColor: c.glass, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, ...shadow.soft },
  iconSolid: { backgroundColor: colors.primary, ...shadow.glow },
  disabled: { opacity: 0.35 },
  chip: { height: 36, paddingHorizontal: 14, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  chipSelected: { backgroundColor: colors.primarySoft, borderColor: 'rgba(61,123,250,0.45)' },
  chipDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.primary },
  chipText: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '500' },
  chipTextSelected: { color: colors.primaryDeep, fontWeight: '600' },
  button: { minHeight: 52, borderRadius: radius.pill, paddingHorizontal: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonPrimary: { backgroundColor: colors.primary, ...shadow.glow, shadowOpacity: 0.36, shadowRadius: 18 },
  buttonFill: { borderRadius: radius.pill, overflow: 'hidden' },
  buttonSecondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, ...shadow.soft },
  buttonDanger: { backgroundColor: colors.dangerSurface },
  buttonText: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2 },
  overlay: { flex: 1 },
  scrim: { backgroundColor: colors.scrim },
  placement: { flex: 1, justifyContent: 'flex-end' },
  /** Every non-page panel floats in the middle of the screen: nothing slides up from the bottom. */
  placementFloat: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 14 },
  sheet: { width: '100%', maxWidth: 460, maxHeight: '100%', flexShrink: 1, minHeight: 100, borderRadius: 20, overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, ...shadow.float, shadowColor: d.shadow, shadowOpacity: 0.12, shadowRadius: 24 },
  page: { flex: 1, maxWidth: '100%', maxHeight: '100%', borderRadius: 0, borderWidth: 0 },
  header: { minHeight: 50, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 12, gap: 8 },
  pageHeader: { paddingHorizontal: 6, paddingTop: 0, paddingBottom: 0, minHeight: 52, gap: 6 },
  headerCenter: { flex: 1, alignItems: 'center' },
  dialogHeaderText: { minWidth: 0, alignItems: 'flex-start' },
  title: { color: colors.text, fontSize: 16.5, fontWeight: '600', letterSpacing: -0.2 },
  floatingTitle: { fontFamily: roundedSystemFontFamily, fontSize: 14, lineHeight: 21, letterSpacing: 0 },
  subtitle: { fontFamily: roundedSystemFontFamily, color: colors.subtle, fontSize: 11, lineHeight: 16, marginTop: 3 },
  scroll: { flexShrink: 1 },
  content: { paddingBottom: 18 },
  floatingContent: { paddingBottom: 4 },
  body: { flexShrink: 1, paddingBottom: 8 },
  footer: { paddingHorizontal: 20, paddingTop: 10 },
  dialogBackdrop: { flex: 1, padding: 18, justifyContent: 'center', alignItems: 'center' },
  dialog: { maxHeight: '85%', width: '100%', maxWidth: 400, padding: 18, borderRadius: 20, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, ...shadow.float, shadowColor: d.shadow, shadowOpacity: 0.12, shadowRadius: 24 },
  dialogContent: { gap: 8 },
  dialogHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 2 },
  dialogIcon: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  dialogIconDanger: { backgroundColor: colors.dangerSurface },
  dialogTitle: { flex: 1, fontFamily: roundedSystemFontFamily, color: colors.text, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  dialogMessage: { fontFamily: roundedSystemFontFamily, color: colors.textMuted, fontSize: 12, lineHeight: 19 },
  dialogActions: { marginTop: 16, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
  dialogActionsStacked: { flexDirection: 'column' },
  dialogQuiet: { backgroundColor: 'transparent', minHeight: 36 },
  dialogAction: { minHeight: 36, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  dialogPrimary: { backgroundColor: d.ink }, dialogDanger: { backgroundColor: colors.dangerSurface },
  dialogActionText: { fontFamily: roundedSystemFontFamily, color: colors.text, fontSize: 12, lineHeight: 18, fontWeight: '500', textAlign: 'center' },
  actionPrimary: { backgroundColor: colors.primary },
  actionDanger: { backgroundColor: colors.danger },
  actionText: { color: colors.text, fontSize: 14.5, fontWeight: '600' },
  group: { backgroundColor: colors.card, borderRadius: 14, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  row: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 14 },
  rowIcon: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 12, paddingVertical: 8 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.divider },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '400' },
  rowDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 16 },
  rowValue: { color: colors.textMuted, fontSize: 14, maxWidth: '50%' },
  sectionLabel: { color: colors.textMuted, fontSize: 12.5, fontWeight: '500', marginTop: 20, marginBottom: 6, marginLeft: 16 },
  toast: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 9, paddingLeft: 8, paddingRight: 18, paddingVertical: 8, minHeight: 44, maxWidth: '90%', borderRadius: 22, backgroundColor: 'rgba(14,19,37,0.9)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)', ...shadow.float, zIndex: 100 },
  toastPress: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1 },
  toastIcon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(124,198,255,0.28)' },
  toastText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500', flexShrink: 1, lineHeight: 19 },
}));
