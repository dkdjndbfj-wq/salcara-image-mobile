import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import * as SafeArea from 'react-native-safe-area-context';
import { useReducedMotion } from '../components/MotionPressable';
import { KeyboardSafeView } from '../components/KeyboardSafeView';
import { Icon, type IconName } from '../components/Icon';
import { Sheet, dismissKeyboardAndBlur } from '../components/ui';
import { themed, useDesk } from '../theme';

/**
 * Programming-only surfaces, in the desktop app's look (Salcara Bridge): a quiet
 * grey canvas, white cards with hairline borders, one clear title per page, a
 * near-black primary button and the blue kept for small accents. Colours come
 * from `desk` in theme.ts and follow light / dark.
 */

export function ProgrammingHeading({ title, subtitle, step }: { title: string; subtitle?: string; step?: string }) {
  const match = step?.match(/(\d+)\s*\/\s*(\d+)/);
  const current = match ? Number(match[1]) : 0;
  const total = match ? Math.min(6, Number(match[2])) : 0;
  const programmingStyles = useProgrammingStyles();
  return <View style={programmingStyles.heading}>
    {step ? <View style={programmingStyles.stepRow} accessibilityLabel={total ? `第 ${current} 步，共 ${total} 步` : step}>
      {total ? Array.from({ length: total }, (_, index) => <View key={index} style={[programmingStyles.stepSegment, index < current && programmingStyles.stepSegmentOn]} />) : null}
      <Text style={programmingStyles.step}>{step}</Text>
    </View> : null}
    <Text accessibilityRole="header" style={programmingStyles.title}>{title}</Text>
    {subtitle ? <Text style={programmingStyles.subtitle}>{subtitle}</Text> : null}
  </View>;
}

/** Section label with an optional quiet trailing action. */
export function ProgrammingSection({ title, hint, action, onAction, actionLabel }: {
  title: string; hint?: string; action?: string; onAction?: () => void; actionLabel?: string;
}) {
  const programmingStyles = useProgrammingStyles();
  const t = useDesk();
  return <View style={programmingStyles.sectionRow}>
    <Text style={programmingStyles.sectionTitle}>{title}</Text>
    {action && onAction ? <Pressable accessibilityRole="button" accessibilityLabel={actionLabel ?? action} onPress={onAction} hitSlop={8} style={programmingStyles.sectionAction}>
      <Text style={programmingStyles.sectionActionText}>{action}</Text><Icon name="chevronRight" size={13} color={t.accentText} />
    </Pressable> : hint ? <Text style={programmingStyles.sectionHint} numberOfLines={1}>{hint}</Text> : null}
  </View>;
}

export function ProgrammingAction({ label, onPress, icon, loading = false, disabled = false, tone = 'primary', style }: {
  label: string; onPress: () => void; icon?: IconName; loading?: boolean; disabled?: boolean;
  tone?: 'primary' | 'secondary' | 'danger'; style?: StyleProp<ViewStyle>;
}) {
  const programmingStyles = useProgrammingStyles();
  const t = useDesk();
  const blocked = loading || disabled;
  const foreground = tone === 'danger' ? t.bad : tone === 'secondary' ? t.text : t.onInk;
  // Buttons are not list rows: no trailing chevron, label and icon centred together.
  const leading = loading ? <ActivityIndicator size="small" color={foreground} /> : icon && icon !== 'chevronRight' ? <Icon name={icon} size={16} color={foreground} /> : null;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: blocked, busy: loading }} disabled={blocked}
    onPress={() => { dismissKeyboardAndBlur(); onPress(); }} style={({ pressed }) => [programmingStyles.action,
      tone === 'secondary' && programmingStyles.actionSecondary, tone === 'danger' && programmingStyles.actionDanger,
      blocked ? { opacity: 0.45 } : pressed ? { opacity: 0.78, transform: [{ scale: 0.985 }] } : null, style]}>
    <View style={programmingStyles.actionInner}>
      {leading ? <View style={programmingStyles.actionForeground}>{leading}</View> : null}
      <Text numberOfLines={1} style={[programmingStyles.actionText, { color: foreground }]}>{label}</Text>
    </View>
  </Pressable>;
}

export function ProgrammingCard({ children, style, soft = false }: { children: ReactNode; style?: StyleProp<ViewStyle>; soft?: boolean }) {
  const programmingStyles = useProgrammingStyles();
  return <View style={[programmingStyles.card, soft && programmingStyles.cardSoft, style]}>{children}</View>;
}

/** One row inside a ProgrammingCard: glyph · title/detail · trailing accessory. */
export function ProgrammingRow({ icon, leading, title, detail, trailing, onPress, first = false, disabled = false, accessibilityLabel, accessibilityRole = 'button', checked }: {
  icon?: IconName; leading?: ReactNode; title: string; detail?: ReactNode; trailing?: ReactNode | 'chevron' | 'check' | null; onPress?: () => void;
  first?: boolean; disabled?: boolean; accessibilityLabel?: string; accessibilityRole?: 'button' | 'radio'; checked?: boolean;
}) {
  const programmingStyles = useProgrammingStyles();
  const t = useDesk();
  const accessory = trailing === 'chevron' ? <Icon name="chevronRight" size={15} color={t.faint} />
    : trailing === 'check' ? <Icon name="check" size={17} color={t.accent} /> : trailing ?? null;
  const content = <>
    {leading ?? (icon ? <View style={programmingStyles.glyph}><Icon name={icon} size={16} color={t.text2} /></View> : null)}
    <View style={programmingStyles.body}>
      <Text style={programmingStyles.name} numberOfLines={1}>{title}</Text>
      {typeof detail === 'string' ? <Text style={programmingStyles.detail} numberOfLines={1}>{detail}</Text> : detail ?? null}
    </View>
    {accessory}
  </>;
  if (!onPress) return <View style={[programmingStyles.row, !first && programmingStyles.divider]}>{content}</View>;
  return <Pressable accessibilityRole={accessibilityRole} accessibilityLabel={accessibilityLabel ?? title}
    accessibilityState={accessibilityRole === 'radio' ? { checked: Boolean(checked), disabled } : { disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [programmingStyles.row, !first && programmingStyles.divider, pressed && programmingStyles.rowPressed]}>{content}</Pressable>;
}

/** Small status dot + text, e.g. 在线 · Windows. */
export function ProgrammingStatus({ tone, text }: { tone: 'online' | 'pending' | 'offline'; text: string }) {
  const programmingStyles = useProgrammingStyles();
  const t = useDesk();
  return <View style={programmingStyles.status}>
    <View style={[programmingStyles.statusDot, { backgroundColor: tone === 'online' ? t.ok : tone === 'pending' ? t.warn : t.faint }]} />
    <Text style={programmingStyles.detail} numberOfLines={1}>{text}</Text>
  </View>;
}

export function ProgrammingField({ label, first = false, ...props }: React.ComponentProps<typeof TextInput> & { label: string; first?: boolean }) {
  const programmingStyles = useProgrammingStyles();
  const t = useDesk();
  return <View style={[programmingStyles.field, !first && programmingStyles.divider]}><Text style={programmingStyles.fieldLabel}>{label}</Text>
    <TextInput {...props} accessibilityLabel={props.accessibilityLabel ?? label} autoCapitalize={props.autoCapitalize ?? 'none'} autoCorrect={false} placeholderTextColor={t.faint} style={[programmingStyles.input, props.style]} />
  </View>;
}

export function ProgrammingSheet({ visible, title, subtitle, onClose, children, footer, headerRight, dismissible = true, compact = false }: {
  visible: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; headerRight?: ReactNode; dismissible?: boolean;
  /** A short choice (Agent, computer, API) rises as a bottom sheet instead of taking over the page. */
  compact?: boolean;
}) {
  const programmingStyles = useProgrammingStyles();
  if (compact) return <ProgrammingPanel visible={visible} title={title} subtitle={subtitle} onClose={onClose} headerRight={headerRight} dismissible={dismissible} footer={footer}>{children}</ProgrammingPanel>;
  // The page header only carries back / actions; the page title is the large heading below.
  return <Sheet visible={visible} presentation="page" onClose={onClose} headerRight={headerRight} dismissible={dismissible}>
    <View style={programmingStyles.page}><ProgrammingHeading title={title} subtitle={subtitle} />{children}
      {footer ? <View style={programmingStyles.actions}>{footer}</View> : null}
    </View>
  </Sheet>;
}

/**
 * Floating panel used for every short choice in 编程 (no bottom sheets): a card
 * that fades and scales in at the centre, or as a menu under the top-right button.
 */
export function ProgrammingPanel({ visible, title, subtitle, onClose, children, footer, headerRight, dismissible = true, placement = 'center' }: {
  visible: boolean; title?: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; headerRight?: ReactNode;
  dismissible?: boolean; placement?: 'center' | 'menu';
}) {
  const programmingStyles = useProgrammingStyles();
  const t = useDesk();
  const reduced = useReducedMotion();
  // Some test hosts stub the safe-area module; the menu only needs the top inset.
  const insets = typeof SafeArea.useSafeAreaInsets === 'function' ? SafeArea.useSafeAreaInsets() : { top: 0 };
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(progress, { toValue: visible ? 1 : 0, duration: reduced ? 0 : visible ? 200 : 140, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false); });
    return () => animation.stop();
  }, [visible, reduced, progress]);
  if (!mounted && !visible) return null;
  const close = () => { if (dismissible) { dismissKeyboardAndBlur(); onClose(); } };
  const menu = placement === 'menu';
  return <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={close}>
    <KeyboardSafeView style={[programmingStyles.panelBackdrop, menu && { justifyContent: 'flex-start', alignItems: 'flex-end', paddingTop: insets.top + 50, paddingRight: 10 }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: menu ? t.scrimLight : t.scrim, opacity: progress }]} />
      <Pressable accessible={false} importantForAccessibility="no" style={StyleSheet.absoluteFill} onPress={close} />
      <Animated.View accessibilityViewIsModal style={[programmingStyles.panel, menu && programmingStyles.panelMenu, {
        opacity: progress,
        transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [menu ? 0.94 : 0.96, 1] }) }, { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [menu ? -6 : 8, 0] }) }],
      }]}>
        {title ? <View style={programmingStyles.panelHead}>
          <View style={{ flex: 1, minWidth: 0 }}><Text accessibilityRole="header" style={programmingStyles.panelTitle} numberOfLines={1}>{title}</Text>
            {subtitle ? <Text style={programmingStyles.panelSubtitle} numberOfLines={2}>{subtitle}</Text> : null}</View>
          {headerRight}
          {dismissible ? <Pressable accessibilityRole="button" accessibilityLabel="关闭" hitSlop={10} onPress={close} style={programmingStyles.panelClose}><Icon name="close" size={14} color={t.muted} /></Pressable> : null}
        </View> : null}
        <ScrollView style={{ maxHeight: height * (menu ? 0.6 : 0.62) }} contentContainerStyle={[programmingStyles.panelBody, !title && { paddingTop: 8 }]} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>{children}</ScrollView>
        {footer ? <View style={programmingStyles.panelFooter}>{footer}</View> : null}
      </Animated.View>
    </KeyboardSafeView>
  </Modal>;
}

export const useProgrammingStyles = themed((_c, t) => StyleSheet.create({
  panelBackdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  panel: { width: '100%', maxWidth: 380, borderRadius: 22, backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, overflow: 'hidden',
    shadowColor: t.shadow, shadowOpacity: 0.16, shadowRadius: 30, shadowOffset: { width: 0, height: 12 }, elevation: 12 },
  panelMenu: { width: 264, maxWidth: 264, borderRadius: 18 },
  panelHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4 },
  panelTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700', color: t.text }, panelSubtitle: { fontSize: 12, lineHeight: 17, color: t.muted, marginTop: 2 },
  panelClose: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: t.surface3 },
  panelBody: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 14 },
  panelFooter: { paddingHorizontal: 14, paddingBottom: 14 },
  page: { paddingHorizontal: 18, paddingBottom: 28 }, compact: { paddingHorizontal: 16, paddingBottom: 8 },
  heading: { paddingTop: 6, paddingBottom: 16 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 10 },
  stepSegment: { width: 18, height: 3, borderRadius: 2, backgroundColor: t.line }, stepSegmentOn: { backgroundColor: t.ink },
  step: { fontSize: 11, color: t.muted, letterSpacing: 0.6, marginLeft: 6, fontVariant: ['tabular-nums'] },
  title: { fontSize: 22, lineHeight: 29, color: t.text, fontWeight: '700', letterSpacing: -0.4 },
  subtitle: { color: t.muted, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  card: { backgroundColor: t.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.line, borderRadius: 16, overflow: 'hidden' },
  cardSoft: { backgroundColor: t.surface2, borderColor: t.line },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 20, marginBottom: 8, minHeight: 20 },
  sectionTitle: { color: t.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.3 },
  sectionHint: { color: t.faint, fontSize: 11, flexShrink: 1 },
  sectionAction: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 32 }, sectionActionText: { color: t.accentText, fontSize: 12, fontWeight: '500' },
  section: { color: t.muted, fontSize: 12, fontWeight: '600', letterSpacing: 0.3, marginTop: 20, marginBottom: 8 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: t.line },
  row: { minHeight: 54, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 9, gap: 11 },
  rowPressed: { backgroundColor: t.press },
  glyph: { width: 32, height: 32, borderRadius: 9, backgroundColor: t.surface3, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, minWidth: 0, gap: 2 }, name: { color: t.text, fontSize: 14, fontWeight: '500' },
  detail: { color: t.muted, fontSize: 11.5, lineHeight: 16 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 }, statusDot: { width: 6, height: 6, borderRadius: 3 },
  action: { minHeight: 46, paddingVertical: 11, paddingHorizontal: 16, backgroundColor: t.ink, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: t.ink, justifyContent: 'center' },
  actionInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, zIndex: 1 },
  actionSecondary: { backgroundColor: t.surface, borderColor: t.lineStrong },
  actionDanger: { backgroundColor: t.badSoft, borderColor: 'transparent' }, actionText: { textAlign: 'center', fontSize: 14, fontWeight: '600', letterSpacing: 0.2 }, actionForeground: { alignItems: 'center', justifyContent: 'center' }, actions: { marginTop: 18, gap: 8 },
  field: { paddingHorizontal: 14, paddingVertical: 11, gap: 4 }, fieldLabel: { fontSize: 11.5, lineHeight: 15, color: t.muted },
  input: { fontSize: 15, color: t.text, padding: 0, minHeight: 26 },
  note: { fontSize: 11.5, lineHeight: 17, color: t.muted, marginTop: 12 }, error: { fontSize: 12, lineHeight: 18, color: t.bad, marginTop: 12 },
}));
