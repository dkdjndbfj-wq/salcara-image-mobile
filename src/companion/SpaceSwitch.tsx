import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import { useReducedMotion } from '../components/MotionPressable';
import { usePendingApprovalCount } from '../remote/store';
import type { Space } from '../state/AppContext';
import { colors, themed } from '../theme';

/** Where the last switch was tapped: the transition grows from there. */
export const switchOrigin = { x: 0, y: 0 };

const SPACES: ReadonlyArray<{ id: Space; label: string }> = [
  { id: 'assistant', label: '助手' },
  { id: 'companion', label: '聊天' },
  { id: 'remote', label: '编程' },
];
const SEGMENT = 52;
const BAR = 16;

/**
 * 助手 · 聊天 · 编程 — quiet text tabs with a short blue selection bar.
 */
export function SpaceSwitch({ space, onSwitch }: { space: Space; onSwitch: (space: Space) => void; tone?: Space }) {
  const styles = useStyles();
  const reduced = useReducedMotion();
  const index = Math.max(0, SPACES.findIndex((item) => item.id === space));
  const position = useRef(new Animated.Value(index)).current;
  useEffect(() => {
    if (reduced) { position.setValue(index); return; }
    Animated.timing(position, { toValue: index, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [index, position, reduced]);
  const pick = (next: Space) => (event: GestureResponderEvent) => {
    switchOrigin.x = event.nativeEvent.pageX;
    switchOrigin.y = event.nativeEvent.pageY;
    if (next !== space) onSwitch(next);
  };
  const approvals = usePendingApprovalCount();
  return <View style={styles.track} accessibilityRole="tablist">
    {SPACES.map((item) => {
      const selected = space === item.id;
      return <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={item.label}
        onPress={pick(item.id)} hitSlop={6} style={styles.option}>
        <Text style={[styles.label, selected && styles.labelActive]}>{item.label}</Text>
        {item.id === 'remote' && approvals > 0 && space !== 'remote' ? <View style={styles.badge} /> : null}
      </Pressable>;
    })}
    <Animated.View pointerEvents="none" style={[styles.bar, {
      transform: [{ translateX: position.interpolate({ inputRange: [0, SPACES.length - 1], outputRange: [0, SEGMENT * (SPACES.length - 1)] }) }],
    }]} />
  </View>;
}

const useStyles = themed((c) => StyleSheet.create({
  track: { flexDirection: 'row', width: SEGMENT * SPACES.length, height: 40 },
  option: { width: SEGMENT, height: 40, alignItems: 'center', justifyContent: 'center', paddingBottom: 4 },
  label: { fontSize: 16, fontWeight: '500', color: c.textMuted, letterSpacing: -0.1 },
  labelActive: { color: c.text, fontWeight: '600' },
  bar: { position: 'absolute', left: (SEGMENT - BAR) / 2, bottom: 3, width: BAR, height: 3, borderRadius: 2, backgroundColor: colors.primary },
  badge: { position: 'absolute', top: 7, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: c.danger, borderWidth: 1, borderColor: c.card },
}));
