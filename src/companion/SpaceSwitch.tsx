import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import { usePendingApprovalCount } from '../remote/store';
import type { Space } from '../state/AppContext';
import { colors, themed } from '../theme';
import { warm } from './theme';

/** Where the last switch was tapped: the transition grows from there. */
export const switchOrigin = { x: 0, y: 0 };

const SPACES: ReadonlyArray<{ id: Space; label: string }> = [
  { id: 'assistant', label: '助手' },
  { id: 'companion', label: '聊天' },
  { id: 'remote', label: '编程' },
];
const SEGMENT = 44;

/** 助手 | 聊天 | 编程 — the three spaces of the app. The thumb springs to the chosen one. */
export function SpaceSwitch({ space, onSwitch, tone = space }: { space: Space; onSwitch: (space: Space) => void; tone?: Space }) {
  const styles = useStyles();
  const index = Math.max(0, SPACES.findIndex((item) => item.id === space));
  const position = useRef(new Animated.Value(index)).current;
  const squash = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(position, { toValue: index, damping: 17, stiffness: 230, mass: 0.9, useNativeDriver: true }),
      Animated.sequence([
        Animated.timing(squash, { toValue: 1.18, duration: 110, useNativeDriver: true }),
        Animated.spring(squash, { toValue: 1, damping: 10, stiffness: 260, useNativeDriver: true }),
      ]),
    ]).start();
  }, [index, position, squash]);
  const pick = (next: Space) => (event: GestureResponderEvent) => {
    switchOrigin.x = event.nativeEvent.pageX;
    switchOrigin.y = event.nativeEvent.pageY;
    if (next !== space) onSwitch(next);
  };
  const approvals = usePendingApprovalCount();
  // One switch everywhere: the programming style (cool track, white thumb, brand-blue label).
  void tone; const companion = false; const remote = true;
  return <View style={[styles.track, companion && { backgroundColor: warm.surfaceStrong }, remote && styles.trackRemote]} accessibilityRole="tablist">
    <Animated.View pointerEvents="none" style={[styles.thumb, companion && styles.thumbWarm, {
      transform: [{ translateX: position.interpolate({ inputRange: [0, SPACES.length - 1], outputRange: [0, SEGMENT * (SPACES.length - 1)] }) }, { scaleX: squash }],
    }]} />
    {SPACES.map((item) => <Pressable key={item.id} accessibilityRole="tab" accessibilityState={{ selected: space === item.id }}
      accessibilityLabel={item.label} onPress={pick(item.id)} hitSlop={4} style={styles.option}>
      <Text style={[styles.label, space === item.id && (companion ? styles.labelWarm : remote ? styles.labelRemote : styles.labelActive)]}>{item.label}</Text>
      {item.id === 'remote' && approvals > 0 && space !== 'remote' ? <View style={styles.badge} /> : null}
    </Pressable>)}
  </View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  track: { flexDirection: 'row', width: SEGMENT * 3 + 4, height: 34, borderRadius: 17, padding: 2, backgroundColor: c.surfaceStrong },
  trackRemote: { backgroundColor: d.surface3 },
  thumb: { position: 'absolute', left: 2, top: 2, width: SEGMENT, height: 30, borderRadius: 15, backgroundColor: d.surface, shadowColor: d.shadow, shadowOpacity: 0.1, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  thumbWarm: { backgroundColor: warm.card, shadowColor: '#2B2F7A' },
  option: { width: SEGMENT, height: 30, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13.5, fontWeight: '600', color: c.subtle },
  labelActive: { color: c.text },
  labelWarm: { color: warm.accentDeep },
  labelRemote: { color: d.text },
  badge: { position: 'absolute', top: 4, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: c.danger, borderWidth: 1, borderColor: c.card },
}));
