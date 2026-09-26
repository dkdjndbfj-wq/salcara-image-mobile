import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Keyboard, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, motion } from '../theme';
import { MotionPressable, useReducedMotion } from './MotionPressable';

type IconName = ComponentProps<typeof Ionicons>['name'];
export type DialogAction = { label: string; onPress?: () => void; tone?: 'primary' | 'secondary' | 'danger'; disabled?: boolean };

export function dismissKeyboardAndBlur() {
  const input = TextInput.State.currentlyFocusedInput?.();
  if (input) TextInput.State.blurTextInput(input);
  Keyboard.dismiss();
}

export function IconButton({ icon, onPress, label, active = false, disabled = false }: { icon: IconName; onPress: () => void; label: string; active?: boolean; disabled?: boolean }) {
  return <MotionPressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={() => { dismissKeyboardAndBlur(); onPress(); }} style={[styles.iconButton, active && styles.iconActive, disabled && styles.disabled]}><Ionicons name={icon} size={22} color={active ? colors.primaryStrong : colors.text} /></MotionPressable>;
}

export function Chip({ label, selected = false, onPress, disabled = false }: { label: string; selected?: boolean; onPress: () => void; disabled?: boolean }) {
  return <MotionPressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={() => { dismissKeyboardAndBlur(); onPress(); }} style={[styles.chip, selected && styles.selectedChip, disabled && styles.disabled]}><Text style={[styles.chipText, selected && styles.selectedText]} numberOfLines={1}>{label}</Text>{selected && <Ionicons name="checkmark" size={14} color={colors.primaryStrong} />}</MotionPressable>;
}

export function PrimaryButton({ label, onPress, loading = false, disabled = false, icon }: { label: string; onPress: () => void; loading?: boolean; disabled?: boolean; icon?: IconName }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || loading }} disabled={disabled || loading} onPress={() => { dismissKeyboardAndBlur(); onPress(); }} style={({ pressed }) => [styles.primary, pressed && { opacity: 0.84, transform: [{ scale: 0.99 }] }, (disabled || loading) && styles.disabled]}>{loading ? <ActivityIndicator color="#fff" /> : icon ? <Ionicons name={icon} size={18} color="#fff" /> : null}<Text style={styles.primaryText}>{label}</Text></Pressable>;
}

function useOverlay(visible: boolean) {
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(progress, { toValue: visible ? 1 : 0, duration: reduced ? 0 : visible ? motion.enter : motion.exit, useNativeDriver: true });
    animation.start(({ finished }) => { if (finished && !visible) setMounted(false); });
    return () => animation.stop();
  }, [visible, reduced, progress]);
  return { mounted, progress };
}

export function Sheet({ visible, title, onClose, children, scroll = true, footer, presentation = 'sheet' }: { visible: boolean; title: string; onClose: () => void; children: ReactNode; scroll?: boolean; footer?: ReactNode; presentation?: 'sheet' | 'page' }) {
  const insets = useSafeAreaInsets();
  const { mounted, progress } = useOverlay(visible);
  const drag = useRef(new Animated.Value(0)).current;
  const page = presentation === 'page';
  const close = () => { dismissKeyboardAndBlur(); onClose(); };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { if (visible) drag.setValue(0); }, [visible, drag]);
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderMove: (_, gesture) => drag.setValue(Math.max(0, gesture.dy)),
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dy > 90 || gesture.vy > 0.9) closeRef.current();
      Animated.spring(drag, { toValue: 0, damping: 24, stiffness: 250, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(),
  })).current;
  return <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={close}>
    <View style={styles.overlay} accessibilityViewIsModal>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]} />
      <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="关闭弹窗" onPress={close} />
      <KeyboardAvoidingView pointerEvents="box-none" style={styles.placement} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Animated.View style={[styles.sheet, page && styles.page, { marginTop: page ? insets.top : Math.max(insets.top, 24), paddingBottom: Math.max(insets.bottom, 12), opacity: progress, transform: [{ translateY: Animated.add(drag, progress.interpolate({ inputRange: [0, 1], outputRange: [page ? 28 : 70, 0] })) }] }]}>
          {!page && <View {...pan.panHandlers} style={styles.handleZone} accessibilityLabel="向下拖动关闭"><View style={styles.handle} /></View>}
          <View style={[styles.sheetHeader, page && styles.pageHeader]}>
            {page && <IconButton icon="arrow-back" label="返回" onPress={close} />}
            <Text style={styles.sheetTitle} numberOfLines={1}>{title}</Text>
            {!page && <IconButton icon="close" label="关闭" onPress={close} />}
          </View>
          {scroll ? <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" nestedScrollEnabled showsVerticalScrollIndicator={false}>{children}</ScrollView> : <View style={styles.body}>{children}</View>}
          {footer && <View style={styles.footer}>{footer}</View>}
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  </Modal>;
}

export function AppDialog({ visible, title, message, icon = 'information-circle-outline', actions, children, dismissible = true, onClose }: { visible: boolean; title: string; message?: string; icon?: IconName; actions?: DialogAction[]; children?: ReactNode; dismissible?: boolean; onClose: () => void }) {
  const { mounted, progress } = useOverlay(visible);
  const resolved = actions?.length ? actions : [{ label: '知道了', tone: 'primary' as const, onPress: onClose }];
  const close = () => { if (dismissible) { dismissKeyboardAndBlur(); onClose(); } };
  return <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={close}>
    <View style={styles.dialogBackdrop}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]} />
      {dismissible && <Pressable accessibilityLabel="关闭提示" style={StyleSheet.absoluteFill} onPress={close} />}
      <Animated.View accessibilityViewIsModal style={[styles.dialog, { opacity: progress, transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }] }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.dialogContent}>
          <View style={styles.dialogIcon}><Ionicons name={icon} size={23} color={colors.primaryStrong} /></View>
          <Text style={styles.dialogTitle}>{title}</Text>
          {message ? <Text selectable style={styles.dialogMessage}>{message}</Text> : null}
          {children}
        </ScrollView>
        <View style={styles.dialogActions}>{resolved.map((action, index) => {
          const tone = action.tone ?? (index === resolved.length - 1 ? 'primary' : 'secondary');
          return <Pressable key={`${action.label}-${index}`} accessibilityRole="button" disabled={action.disabled} onPress={() => { dismissKeyboardAndBlur(); action.onPress?.(); }} style={({ pressed }) => [styles.dialogAction, tone === 'primary' && styles.actionPrimary, tone === 'danger' && styles.actionDanger, pressed && { opacity: 0.7 }, action.disabled && styles.disabled]}><Text style={[styles.actionText, tone === 'primary' && { color: '#fff' }, tone === 'danger' && { color: colors.danger }]}>{action.label}</Text></Pressable>;
        })}</View>
      </Animated.View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  iconActive: { backgroundColor: colors.blueSurface }, disabled: { opacity: 0.4 },
  chip: { minHeight: 44, maxWidth: 290, paddingHorizontal: 14, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'transparent' },
  selectedChip: { backgroundColor: colors.blueSurface, borderColor: '#C8DFF7' }, chipText: { color: colors.text, fontSize: 13, fontWeight: '500', flexShrink: 1 }, selectedText: { color: colors.primaryStrong },
  primary: { minHeight: 48, borderRadius: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.primaryStrong }, primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  overlay: { flex: 1 }, scrim: { backgroundColor: 'rgba(24,33,47,0.28)' }, placement: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '94%', flexShrink: 1, minHeight: 220, backgroundColor: colors.background, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden' },
  page: { flex: 1, maxHeight: '100%', borderTopLeftRadius: 0, borderTopRightRadius: 0 },
  handleZone: { height: 22, alignItems: 'center', justifyContent: 'center' }, handle: { width: 32, height: 4, borderRadius: 2, backgroundColor: '#D8DEE6' },
  sheetHeader: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingLeft: 24, paddingRight: 12, gap: 4 }, pageHeader: { paddingLeft: 6, minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  sheetTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '600' }, scroll: { flexShrink: 1 }, content: { paddingBottom: 16 }, body: { flexShrink: 1, paddingBottom: 12 }, footer: { paddingHorizontal: 20, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.background },
  dialogBackdrop: { flex: 1, padding: 28, justifyContent: 'center', alignItems: 'center' }, dialog: { maxHeight: '80%', width: '100%', maxWidth: 380, padding: 24, borderRadius: 24, backgroundColor: colors.background }, dialogContent: { gap: 12 }, dialogIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSurface }, dialogTitle: { color: colors.text, fontSize: 19, lineHeight: 27, fontWeight: '600' }, dialogMessage: { color: colors.textMuted, fontSize: 14, lineHeight: 22 }, dialogActions: { marginTop: 22, flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }, dialogAction: { minHeight: 44, paddingHorizontal: 18, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, actionPrimary: { backgroundColor: colors.primaryStrong }, actionDanger: { backgroundColor: colors.dangerSurface }, actionText: { color: colors.text, fontSize: 14, fontWeight: '600' },
});
