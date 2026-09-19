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
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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

const styles = StyleSheet.create({
  iconButton: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border },
  activeIconButton: { backgroundColor: colors.blueSurface, borderColor: colors.primary },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  chip: { minHeight: 38, maxWidth: 220, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  selectedChip: { backgroundColor: colors.blueSurface, borderColor: colors.primary },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  selectedChipText: { color: colors.primaryStrong },
  primaryButton: { minHeight: 48, borderRadius: radius.md, paddingHorizontal: spacing.lg, backgroundColor: colors.primary, flexDirection: 'row', gap: spacing.sm, alignItems: 'center', justifyContent: 'center' },
  primaryPressed: { backgroundColor: colors.primaryStrong },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(17,24,39,0.28)' },
  sheetPlacement: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%', minHeight: 220, flexShrink: 1, backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden' },
  sheetHandle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border, marginTop: spacing.sm },
  sheetScroll: { flexShrink: 1 },
  sheetContent: { paddingBottom: spacing.xl },
  sheetBody: { paddingBottom: spacing.xl },
  sheetHeader: { minHeight: 64, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  sheetTitle: { color: colors.text, fontSize: 19, fontWeight: '700' },
});
