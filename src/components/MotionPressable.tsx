import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled?.().then((value) => { if (mounted) setReduced(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setReduced);
    return () => { mounted = false; subscription?.remove?.(); };
  }, []);
  return reduced;
}

/** Pressable with a springy scale-down, used for every tappable control. */
export function MotionPressable({ style, children, onPressIn, onPressOut, scaleTo = 0.94, wrapperStyle, ...props }: Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle>; children?: React.ReactNode; scaleTo?: number; wrapperStyle?: StyleProp<ViewStyle>;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  const animate = (value: number) => {
    if (reduced) { scale.setValue(value); return; }
    Animated.spring(scale, { toValue: value, speed: 40, bounciness: value === 1 ? 8 : 0, useNativeDriver: true }).start();
  };
  return <Animated.View style={[{ transform: [{ scale }], flexShrink: 0 }, wrapperStyle]}>
    <Pressable {...props} style={style} onPressIn={(event) => { animate(scaleTo); onPressIn?.(event); }} onPressOut={(event) => { animate(1); onPressOut?.(event); }}>{children}</Pressable>
  </Animated.View>;
}

/** Fade + rise on mount. `delay` enables staggered entrances. */
export function Appear({ children, delay = 0, distance = 10, style, duration = 280 }: { children: React.ReactNode; delay?: number; distance?: number; style?: StyleProp<ViewStyle>; duration?: number }) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    const animation = Animated.timing(progress, { toValue: 1, duration: reduced ? 0 : duration, delay: reduced ? 0 : delay, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [progress, delay, reduced, duration]);
  return <Animated.View style={[style, { opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }] }]}>{children}</Animated.View>;
}
