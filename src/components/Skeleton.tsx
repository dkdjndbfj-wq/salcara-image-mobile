import React, { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';

import { useScheme } from '../theme';
import { useReducedMotion } from './MotionPressable';

/**
 * Loading placeholders shaped like the content that is about to appear. Every block on screen
 * breathes together from one shared animation, so a page of skeletons reads as one calm surface.
 */
const Pulse = createContext<Animated.Value | null>(null);

export function SkeletonGroup({ children, label = '正在加载', style, testID }: { children: ReactNode; label?: string; style?: StyleProp<ViewStyle>; testID?: string }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) { value.setValue(0.5); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: 720, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(value, { toValue: 0, duration: 720, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduced, value]);
  return <Pulse.Provider value={value}>
    <View testID={testID} accessible accessibilityRole="progressbar" accessibilityLabel={label} accessibilityState={{ busy: true }} style={style}>{children}</View>
  </Pulse.Provider>;
}

export function Skeleton({ width = '100%', height = 12, radius = 6, style }: { width?: DimensionValue; height?: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const pulse = useContext(Pulse);
  const dark = useScheme() === 'dark';
  const base = dark ? '#262B35' : '#E9ECF2';
  const opacity = pulse ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) : 0.8;
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: base, opacity }, style]} />;
}

/** Rows of an avatar-and-two-lines list (sessions, computers, files). */
export function SkeletonRows({ rows = 5, avatar = 32, style }: { rows?: number; avatar?: number; style?: StyleProp<ViewStyle> }) {
  const widths = ['62%', '48%', '70%', '54%', '66%', '44%'] as const;
  return <View style={style}>
    {Array.from({ length: rows }, (_, i) => <View key={i} style={styles.row}>
      {avatar ? <Skeleton width={avatar} height={avatar} radius={Math.round(avatar * 0.3)} /> : null}
      <View style={styles.lines}>
        <Skeleton width={widths[i % widths.length]} height={13} />
        <Skeleton width={`${30 + (i * 7) % 20}%`} height={10} />
      </View>
    </View>)}
  </View>;
}

/** A conversation being read: alternating user and assistant blocks. */
export function SkeletonThread({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.thread, style]}>
    <View style={styles.userBubble}><Skeleton width={180} height={40} radius={18} /></View>
    <View style={styles.answer}>
      <Skeleton width="92%" height={12} />
      <Skeleton width="84%" height={12} />
      <Skeleton width="58%" height={12} />
    </View>
    <Skeleton width="100%" height={64} radius={14} />
    <View style={styles.userBubble}><Skeleton width={130} height={40} radius={18} /></View>
    <View style={styles.answer}>
      <Skeleton width="88%" height={12} />
      <Skeleton width="66%" height={12} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4 },
  lines: { flex: 1, gap: 7 },
  thread: { gap: 16, paddingHorizontal: 16, paddingTop: 16 },
  userBubble: { alignItems: 'flex-end' },
  answer: { gap: 9 },
});
