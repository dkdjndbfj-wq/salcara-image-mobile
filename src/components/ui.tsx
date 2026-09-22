import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import React from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radius, spacing } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

export type DialogAction = {
  label: string;
  onPress?: () => void;
  tone?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
};

/** Hide the keyboard and explicitly blur the native input that owns it. */
export function dismissKeyboardAndBlur() {
  const focusedInput = TextInput.State.currentlyFocusedInput();
  if (focusedInput) TextInput.State.blurTextInput(focusedInput);
  Keyboard.dismiss();
}

export function IconButton({
  icon,
  onPress,
  label,
  active = false,
  disabled = false,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        dismissKeyboardAndBlur();
        onPress();
      }}
      style={({ pressed }) => [styles.iconButton, active && styles.activeIconButton, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Ionicons name={icon} size={21} color={active ? colors.primaryStrong : colors.text} />
    </Pressable>
  );
}

export function Chip({
  label,
  selected = false,
  onPress,
  disabled = false,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={() => {
        dismissKeyboardAndBlur();
        onPress();
      }}
      style={({ pressed }) => [styles.chip, selected && styles.selectedChip, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={[styles.chipText, selected && styles.selectedChipText]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

export function PrimaryButton({
  label,
  onPress,
  loading = false,
  disabled = false,
  icon,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  icon?: IconName;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={() => {
        dismissKeyboardAndBlur();
        onPress();
      }}
      style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryPressed, (disabled || loading) && styles.disabled]}
    >
      {loading ? <ActivityIndicator color="#fff" /> : icon ? <Ionicons name={icon} size={19} color="#fff" /> : null}
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

export function Sheet({
  visible,
  title,
  onClose,
  children,
  scroll = true,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  scroll?: boolean;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={() => {
        dismissKeyboardAndBlur();
        onClose();
      }}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        {/* Keep the dismiss target behind the sheet so it never steals a scroll gesture. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityLabel="关闭弹窗"
          onPress={() => {
            dismissKeyboardAndBlur();
            onClose();
          }}
        />
        <KeyboardAvoidingView
          style={styles.sheetPlacement}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
        >
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>{title}</Text>
              <IconButton icon="close" label="关闭" onPress={onClose} />
            </View>
            {scroll ? (
              <ScrollView
                style={styles.sheetScroll}
                contentContainerStyle={styles.sheetContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                nestedScrollEnabled
                showsVerticalScrollIndicator
              >
                {children}
              </ScrollView>
            ) : (
              <View style={styles.sheetBody}>{children}</View>
            )}
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

export function AppDialog({
  visible,
  title,
  message,
  icon = 'information-circle-outline',
  actions,
  children,
  dismissible = true,
  onClose,
}: {
  visible: boolean;
  title: string;
  message?: string;
  icon?: IconName;
  actions?: DialogAction[];
  children?: ReactNode;
  dismissible?: boolean;
  onClose: () => void;
}) {
  const resolvedActions = actions?.length ? actions : [{ label: '知道了', tone: 'primary' as const, onPress: onClose }];
  const close = () => {
    if (!dismissible) return;
    dismissKeyboardAndBlur();
    onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={close}
    >
      <View style={styles.dialogBackdrop}>
        {dismissible && <Pressable accessibilityLabel="关闭提示" style={StyleSheet.absoluteFill} onPress={close} />}
        <View accessibilityViewIsModal style={styles.dialogCard}>
          <View style={styles.dialogIcon}>
            <Ionicons name={icon} size={25} color={colors.primaryStrong} />
          </View>
          <Text style={styles.dialogTitle}>{title}</Text>
          {message ? <Text style={styles.dialogMessage}>{message}</Text> : null}
          {children}
          <View style={styles.dialogActions}>
            {resolvedActions.map((action, index) => {
              const tone = action.tone ?? (index === resolvedActions.length - 1 ? 'primary' : 'secondary');
              return (
                <Pressable
                  key={`${action.label}-${index}`}
                  accessibilityRole="button"
                  disabled={action.disabled}
                  onPress={() => {
                    dismissKeyboardAndBlur();
                    action.onPress?.();
                  }}
                  style={({ pressed }) => [
                    styles.dialogAction,
                    tone === 'primary' && styles.dialogActionPrimary,
                    tone === 'danger' && styles.dialogActionDanger,
                    pressed && styles.pressed,
                    action.disabled && styles.disabled,
                  ]}
                >
                  <Text style={[
                    styles.dialogActionText,
                    tone === 'primary' && styles.dialogActionTextPrimary,
                    tone === 'danger' && styles.dialogActionTextDanger,
                  ]}>
                    {action.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  iconButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  activeIconButton: { backgroundColor: colors.blueSurface, borderColor: colors.primary },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  chip: { minHeight: 38, maxWidth: 220, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  selectedChip: { backgroundColor: colors.blueSurface, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  selectedChipText: { color: colors.primaryStrong },
  primaryButton: { minHeight: 48, borderRadius: radius.md, paddingHorizontal: spacing.lg, backgroundColor: colors.primary, flexDirection: 'row', gap: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  primaryPressed: { backgroundColor: colors.primaryStrong },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(17,24,39,0.28)' },
  sheetPlacement: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%', minHeight: 220, flexShrink: 1, backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden' },
  sheetHandle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: spacing.sm },
  sheetScroll: { flexShrink: 1 },
  sheetContent: { paddingBottom: spacing.xl },
  sheetBody: { paddingBottom: spacing.xl },
  sheetHeader: { minHeight: 64, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '700' },
  dialogBackdrop: { flex: 1, padding: spacing.xl, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(17,24,39,0.32)' },
  dialogCard: { width: '100%', maxWidth: 420, borderRadius: 22, padding: spacing.xl, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, gap: spacing.md },
  dialogIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSurface },
  dialogTitle: { color: colors.text, fontSize: 18, lineHeight: 24, fontWeight: '800' },
  dialogMessage: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  dialogActions: { marginTop: spacing.sm, flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: spacing.sm },
  dialogAction: { minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  dialogActionPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  dialogActionDanger: { backgroundColor: colors.dangerSurface, borderColor: '#FECACA' },
  dialogActionText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  dialogActionTextPrimary: { color: '#FFFFFF' },
  dialogActionTextDanger: { color: colors.danger },
});
