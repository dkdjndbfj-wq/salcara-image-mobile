import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { colors } from '../theme';
import { Icon, type IconName } from './Icon';

/** A settings row with a switch. */
export function ToggleRow({ icon, title, detail, value, onChange, first = false, disabled = false }: {
  icon?: IconName; title: string; detail?: string; value: boolean; onChange: (value: boolean) => void; first?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="switch" accessibilityState={{ checked: value, disabled }} disabled={disabled} onPress={() => onChange(!value)}
    style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceStrong }, disabled && { opacity: 0.45 }]}>
    {icon ? <Icon name={icon} size={21} color={colors.textSecondary} /> : null}
    <View style={[styles.rowBody, !first && styles.divider]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.title}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      <Switch value={value} disabled={disabled} onValueChange={onChange} trackColor={{ true: colors.primary, false: colors.tint }} thumbColor="#FFFFFF" />
    </View>
  </Pressable>;
}

/** A radio option row. */
export function RadioRow({ title, detail, selected, onPress, first = false }: { title: string; detail?: string; selected: boolean; onPress: () => void; first?: boolean }) {
  return <Pressable accessibilityRole="radio" accessibilityState={{ selected }} onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceStrong }]}>
    <View style={[styles.rowBody, !first && styles.divider]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.title, selected && { fontWeight: '600' }]}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      <View style={[styles.radio, selected && styles.radioOn]}>{selected ? <View style={styles.radioDot} /> : null}</View>
    </View>
  </Pressable>;
}

/**
 * A text field that keeps its own draft and saves when editing ends, so
 * typing never writes to storage on every keystroke.
 */
export function DraftField({ label, hint, value, onSave, placeholder, multiline = false, secure = false, maxLength }: {
  label?: string; hint?: string; value: string; onSave: (value: string) => void; placeholder?: string; multiline?: boolean; secure?: boolean; maxLength?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const saved = useRef(value);
  useEffect(() => { saved.current = value; if (!focused) setDraft(value); }, [value, focused]);
  // Android fires both onEndEditing and onBlur; save a given draft only once.
  const commit = () => { if (draft !== saved.current) { saved.current = draft; onSave(draft); } };
  return <View style={styles.field}>
    {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
    <TextInput value={draft} onChangeText={setDraft} placeholder={placeholder} placeholderTextColor={colors.subtle}
      onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); commit(); }}
      onEndEditing={commit}
      multiline={multiline} secureTextEntry={secure} autoCapitalize="none" autoCorrect={!secure} maxLength={maxLength}
      textAlignVertical={multiline ? 'top' : 'center'} style={[styles.input, multiline && styles.inputMultiline]} />
    {hint ? <Text style={styles.hint}>{hint}</Text> : null}
  </View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16 },
  rowBody: { flex: 1, minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingRight: 14, paddingVertical: 10 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  title: { color: colors.text, fontSize: 15.5 },
  detail: { color: colors.subtle, fontSize: 12.5, lineHeight: 17 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.6, borderColor: colors.faint, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.primary },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: colors.primary },
  field: { gap: 8 },
  fieldLabel: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  input: { minHeight: 44, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: colors.card, color: colors.text, fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  inputMultiline: { minHeight: 104, lineHeight: 21 },
  hint: { color: colors.subtle, fontSize: 12, lineHeight: 17 },
});
