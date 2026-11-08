import React, { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon, type IconName } from '../components/Icon';
import { useDesk } from '../theme';

export type WegentMenuItem = { id: string; label: string; onSelect: () => void; checked?: boolean; disabled?: boolean };
export type WegentMenuProps = { label: string; icon?: IconName; title?: string; disabled?: boolean; items: WegentMenuItem[] };
export type WegentSurfaceProps = { children: ReactNode; enabled?: boolean; fallbackStyle?: StyleProp<ViewStyle> };
export type WegentToolbarProps = { features: ReactNode; actions: ReactNode; enabled?: boolean };

/** Native rendering of the same upstream surface/toolbar geometry. */
export function WegentComposerSurface({ children, enabled = true, fallbackStyle }: WegentSurfaceProps) {
  const d = useDesk();
  return <View style={enabled ? [styles.surface, { backgroundColor: d.surface, borderColor: d.line }] : fallbackStyle}>{children}</View>;
}
export function WegentComposerToolbar({ features, actions }: WegentToolbarProps) {
  return <View testID="composer-toolbar" style={styles.toolbar}><View style={styles.features}>{features}</View><View style={styles.actions}>{actions}</View></View>;
}
export function WegentActionMenu({ label, icon = 'more', title, disabled, items }: WegentMenuProps) {
  const d = useDesk(), [open, setOpen] = useState(false);
  return <View style={{ zIndex: open ? 100 : 1 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: open, disabled }} disabled={disabled} onPress={() => setOpen(value => !value)} style={styles.trigger}>
      <Icon name={icon} size={15} color={d.text2} />{title ? <Text numberOfLines={1} style={{ color: d.text2, fontSize: 12, maxWidth: 125 }}>{title}</Text> : null}{title ? <Icon name="chevronDown" size={11} color={d.muted} /> : null}
    </Pressable>
    {open ? <View style={[styles.menu, { backgroundColor: d.surface, borderColor: d.line }]}>
      {items.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={item.label} accessibilityState={{ selected: item.checked, disabled: item.disabled }} disabled={item.disabled} onPress={() => { setOpen(false); item.onSelect(); }} style={styles.item}>
        <Text style={{ color: d.text, fontSize: 13, flex: 1 }}>{item.label}</Text>{item.checked ? <Icon name="check" size={14} color={d.muted} /> : null}
      </Pressable>)}
      <Pressable accessibilityRole="button" accessibilityLabel={`关闭${label}`} onPress={() => setOpen(false)} style={styles.item}><Text style={{ color: d.muted, fontSize: 12 }}>关闭</Text></Pressable>
    </View> : null}
  </View>;
}
const styles = StyleSheet.create({
  surface: { position: 'relative', minHeight: 76, borderRadius: 26, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 20, shadowOffset: { width: 0, height: 3 } },
  toolbar: { minHeight: 32, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, rowGap: 4, paddingTop: 4 },
  features: { minWidth: 0, maxWidth: '100%', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }, actions: { minWidth: 160, marginLeft: 'auto', flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  trigger: { minWidth: 28, height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 7 },
  menu: { position: 'absolute', bottom: 36, left: 0, minWidth: 190, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 4, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 20, elevation: 10 }, item: { height: 34, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
});
