import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { motion } from '../theme';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (mounted) setReduced(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { mounted = false; subscription.remove(); };
  }, []);
  return reduced;
}

export function MotionPressable({ style, children, onPressIn, onPressOut, ...props }: Omit<PressableProps, 'style' | 'children'> & { style?: StyleProp<ViewStyle>; children?: React.ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  const animate = (value: number) => Animated.timing(scale, { toValue: value, duration: reduced ? 0 : motion.press, useNativeDriver: true }).start();
  return <Animated.View style={{ transform: [{ scale }], flexShrink: 0 }}>
    <Pressable {...props} style={style} onPressIn={(event) => { animate(0.96); onPressIn?.(event); }} onPressOut={(event) => { animate(1); onPressOut?.(event); }}>{children}</Pressable>
  </Animated.View>;
}
