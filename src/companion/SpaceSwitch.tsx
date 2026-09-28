import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import type { Space } from '../state/AppContext';
import { colors } from '../theme';
import { warm } from './theme';

/** Where the last switch was tapped: the transition grows from there. */
export const switchOrigin = { x: 0, y: 0 };

/** 助手 | 聊天 — the two halves of the app. */
export function SpaceSwitch({ space, onSwitch, tone = space }: { space: Space; onSwitch: (space: Space) => void; tone?: Space }) {
  const position = useRef(new Animated.Value(space === 'assistant' ? 0 : 1)).current;
  useEffect(() => {
    Animated.spring(position, { toValue: space === 'assistant' ? 0 : 1, damping: 18, stiffness: 240, useNativeDriver: true }).start();
  }, [space, position]);
  const pick = (next: Space) => (event: GestureResponderEvent) => {
    switchOrigin.x = event.nativeEvent.pageX;
    switchOrigin.y = event.nativeEvent.pageY;
    if (next !== space) onSwitch(next);
  };
  const companion = tone === 'companion';
  return <View style={[styles.track, companion && { backgroundColor: warm.surfaceStrong }]} accessibilityRole="tablist">
    <Animated.View pointerEvents="none" style={[styles.thumb, companion && styles.thumbWarm, { transform: [{ translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, 48] }) }] }]} />
    {(['assistant', 'companion'] as const).map((item) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: space === item }}
      accessibilityLabel={item === 'assistant' ? '助手' : '聊天'} onPress={pick(item)} hitSlop={4} style={styles.option}>
      <Text style={[styles.label, space === item && (companion ? styles.labelWarm : styles.labelActive)]}>{item === 'assistant' ? '助手' : '聊天'}</Text>
    </Pressable>)}
  </View>;
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', width: 100, height: 34, borderRadius: 17, padding: 2, backgroundColor: colors.surfaceStrong },
  thumb: { position: 'absolute', left: 2, top: 2, width: 48, height: 30, borderRadius: 15, backgroundColor: colors.card, shadowColor: '#1B2150', shadowOpacity: 0.1, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
  thumbWarm: { backgroundColor: warm.card, shadowColor: '#2B2F7A' },
  option: { width: 48, height: 30, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13.5, fontWeight: '600', color: colors.subtle },
  labelActive: { color: colors.text },
  labelWarm: { color: warm.accentDeep },
});
