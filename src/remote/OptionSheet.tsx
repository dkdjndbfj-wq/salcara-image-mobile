import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../components/Icon';
import { ProgrammingPanel } from './ProgrammingUi';
import { colors, desk, themed, useDesk } from '../theme';

export interface Option<T extends string> { value: T; label: string; detail?: string; danger?: boolean }

/** A floating panel with one checked choice, used by the remote composer. */
export function OptionSheet<T extends string>({ visible, title, subtitle, value, options, onSelect, onClose, empty }: {
  visible: boolean; title: string; subtitle?: string; value: T; options: Array<Option<T>>; onSelect: (value: T) => void; onClose: () => void; empty?: string;
}) {
  const dk = useDesk();
  const styles = useStyles();
  return <ProgrammingPanel visible={visible} title={title} subtitle={subtitle} onClose={onClose}>
    <View style={styles.list}>
      {options.length ? options.map((option, index) => {
        const selected = option.value === value;
        return <Pressable key={`${option.value}:${index}`} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => onSelect(option.value)}
          style={({ pressed }: { pressed: boolean }) => [styles.row, selected && (option.danger ? styles.selectedDanger : styles.selected), pressed && !selected && styles.pressed]}>
          <View style={[styles.radio, selected && { borderColor: option.danger ? dk.bad : dk.ink, backgroundColor: option.danger ? dk.bad : dk.ink }]}>
            {selected ? <Icon name="check" size={11} color={dk.onInk} strokeWidth={2.6} /> : null}
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[styles.label, option.danger && { color: dk.bad }, selected && !option.danger && { color: dk.text, fontWeight: '600' }]} numberOfLines={1}>{option.label}</Text>
            {option.detail ? <Text style={styles.detail} numberOfLines={2}>{option.detail}</Text> : null}
          </View>
        </Pressable>;
      }) : <Text style={styles.empty}>{empty ?? '没有可选项'}</Text>}
    </View>
  </ProgrammingPanel>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  list: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11, minHeight: 48, borderRadius: 14, backgroundColor: d.surface2, borderWidth: 1, borderColor: 'transparent' },
  selected: { backgroundColor: d.surface, borderColor: d.ink }, selectedDanger: { backgroundColor: d.badSoft, borderColor: d.bad },
  pressed: { backgroundColor: d.surface3 },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: d.faint, backgroundColor: d.surface, alignItems: 'center', justifyContent: 'center' },
  label: { color: d.text, fontSize: 14.5, fontWeight: '500' },
  detail: { color: d.muted, fontSize: 12, lineHeight: 17 },
  empty: { color: d.muted, fontSize: 13.5, lineHeight: 20, padding: 18, textAlign: 'center' },
}));
