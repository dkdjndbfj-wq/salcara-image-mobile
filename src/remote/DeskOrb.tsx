import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, LinearGradient, RadialGradient, Stop } from 'react-native-svg';

import { useReducedMotion } from '../components/MotionPressable';

/**
 * The desktop app's orb (Salcara Bridge home screen): a lit white sphere with two
 * eyes. It floats a little, blinks at random, and while a task runs a thin
 * brand-coloured ring turns around it. Stays white in dark mode, like the desktop.
 */
export function DeskOrb({ size = 104, busy = false, mood = 'idle' }: { size?: number; busy?: boolean; mood?: 'idle' | 'sleepy' | 'alert' }) {
  const reduced = useReducedMotion();
  const float = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(busy ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(float, { toValue: 1, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(float, { toValue: 0, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduced, float]);

  // Blinks never come on a fixed beat.
  useEffect(() => {
    if (reduced) return undefined;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        Animated.sequence([
          Animated.timing(blink, { toValue: 0.08, duration: 90, useNativeDriver: true }),
          Animated.timing(blink, { toValue: 1, duration: 110, useNativeDriver: true }),
        ]).start(next);
      }, 2200 + Math.random() * 3600);
    };
    next();
    return () => clearTimeout(timer);
  }, [reduced, blink]);

  useEffect(() => {
    Animated.timing(ring, { toValue: busy ? 1 : 0, duration: reduced ? 0 : 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    if (!busy || reduced) return undefined;
    spin.setValue(0);
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 2400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [busy, reduced, ring, spin]);

  const eyeW = size * 0.0625, eyeH = size * (mood === 'sleepy' ? 0.06 : mood === 'alert' ? 0.27 : 0.25);
  const ringSize = size + 22;
  const r = ringSize / 2 - 1.5;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: ringSize, height: ringSize + size * 0.22, alignItems: 'center' }}>
    {/* contact shadow on the floor */}
    <Animated.View style={{ position: 'absolute', top: ringSize / 2 + size * 0.5 + 2, opacity: float.interpolate({ inputRange: [0, 1], outputRange: [1, 0.72] }),
      transform: [{ scaleX: float.interpolate({ inputRange: [0, 1], outputRange: [1, 0.86] }) }] }}>
      <Svg width={size * 0.8} height={size * 0.16}><Defs><RadialGradient id="orbFloor" cx="50%" cy="50%" rx="50%" ry="50%">
        <Stop offset="0" stopColor="#19233C" stopOpacity="0.30" /><Stop offset="0.6" stopColor="#19233C" stopOpacity="0.10" /><Stop offset="1" stopColor="#19233C" stopOpacity="0" />
      </RadialGradient></Defs><Ellipse cx={size * 0.4} cy={size * 0.08} rx={size * 0.4} ry={size * 0.08} fill="url(#orbFloor)" /></Svg>
    </Animated.View>
    <Animated.View style={{ width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center',
      transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -5] }) }] }}>
      {/* the working ring */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: ring, transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]}>
        <Svg width={ringSize} height={ringSize}><Defs><LinearGradient id="orbRing" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7CC6FF" /><Stop offset="0.35" stopColor="#3D7BFA" /><Stop offset="0.7" stopColor="#A68BF7" /><Stop offset="1" stopColor="#F4A6CE" />
        </LinearGradient></Defs>
          <Circle cx={ringSize / 2} cy={ringSize / 2} r={r} stroke="url(#orbRing)" strokeWidth={2.2} strokeLinecap="round" fill="none"
            strokeDasharray={`${Math.PI * r * 1.25} ${Math.PI * r * 0.75}`} />
        </Svg>
      </Animated.View>
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#E6EAF1',
        shadowColor: '#1E2846', shadowOpacity: 0.22, shadowRadius: size * 0.16, shadowOffset: { width: 0, height: size * 0.1 }, elevation: 10 }}>
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id="orbBody" cx="50%" cy="42%" rx="50%" ry="50%" fx="50%" fy="42%">
              <Stop offset="0" stopColor="#FBFCFE" /><Stop offset="0.52" stopColor="#EEF1F6" /><Stop offset="0.82" stopColor="#D3D9E4" /><Stop offset="1" stopColor="#B9C1D0" />
            </RadialGradient>
            <RadialGradient id="orbLight" cx="34%" cy="28%" rx="46%" ry="46%" fx="34%" fy="28%">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity="1" /><Stop offset="0.35" stopColor="#FFFFFF" stopOpacity="1" /><Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
            </RadialGradient>
            <RadialGradient id="orbBounce" cx="50%" cy="86%" rx="28%" ry="10%">
              <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" /><Stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#orbBody)" />
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#orbLight)" />
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill="url(#orbBounce)" />
        </Svg>
        <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: size * 0.16 }}>
          {[0, 1].map((i) => <Animated.View key={i} style={{ width: eyeW, height: eyeH, borderRadius: eyeW, backgroundColor: '#10131A', transform: [{ scaleY: blink }] }} />)}
        </View>
      </View>
    </Animated.View>
  </View>;
}
