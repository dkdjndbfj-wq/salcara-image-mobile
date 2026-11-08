import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, LinearGradient, RadialGradient, Stop } from 'react-native-svg';

import { useReducedMotion } from '../components/MotionPressable';

export type OrbMood = 'idle' | 'sleepy' | 'alert' | 'waiting';

let orbSeed = 0;
function useOrbId() {
  const ref = useRef('');
  if (!ref.current) { orbSeed += 1; ref.current = `orb${orbSeed}`; }
  return ref.current;
}

/**
 * The desktop app's orb, redesigned: a pearl-white sphere with two eyes and a faint
 * brand-coloured glow underneath (sky → violet). Four states:
 *  - idle: floats a little and blinks at random;
 *  - busy (working): a brand-gradient arc turns around it and the eyes glance aside;
 *  - waiting: an amber ring and warm glow, eyes wide (an approval or question is pending);
 *  - sleepy (offline): eyes closed, no glow, no float.
 * `compact` drops the floor shadow and float, for list rows and title bars (≤ 28px).
 */
export function DeskOrb({ size = 104, busy = false, mood = 'idle', compact = size <= 28 }: {
  size?: number; busy?: boolean; mood?: OrbMood; compact?: boolean;
}) {
  const reduced = useReducedMotion();
  const id = useOrbId();
  const float = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(busy ? 1 : 0)).current;
  const sleepy = mood === 'sleepy';
  const waiting = mood === 'waiting' || mood === 'alert';
  const still = reduced || compact || sleepy;

  useEffect(() => {
    if (still) { float.setValue(0); return undefined; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(float, { toValue: 1, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(float, { toValue: 0, duration: 3000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [still, float]);

  // Blinks never come on a fixed beat.
  useEffect(() => {
    if (reduced || sleepy) return undefined;
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
  }, [reduced, sleepy, blink]);

  useEffect(() => {
    Animated.timing(ring, { toValue: busy ? 1 : 0, duration: reduced ? 0 : 500, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    if (!busy || reduced) return undefined;
    spin.setValue(0);
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 2400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [busy, reduced, ring, spin]);

  const eyeW = Math.max(2, size * 0.07);
  const eyeH = sleepy ? Math.max(1.5, size * 0.035) : size * (waiting ? 0.28 : 0.24);
  const eyeLen = sleepy ? size * 0.14 : eyeW;
  const glance = busy && !waiting ? size * 0.07 : 0;
  const pad = compact ? Math.max(3, Math.round(size * 0.12)) : Math.round(size * 0.12);
  const ringSize = size + pad * 2;
  const r = ringSize / 2 - 1.5;
  const floorH = compact ? 0 : size * 0.22;
  const glowTop = waiting ? '#F5C77E' : '#7CC6FF';
  const glowBottom = waiting ? '#E8A23C' : '#A68BF7';
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: ringSize, height: ringSize + floorH, alignItems: 'center' }}>
    {!compact && <Animated.View style={{ position: 'absolute', top: ringSize / 2 + size * 0.5 + 2, opacity: float.interpolate({ inputRange: [0, 1], outputRange: [1, 0.7] }),
      transform: [{ scaleX: float.interpolate({ inputRange: [0, 1], outputRange: [1, 0.86] }) }] }}>
      <Svg width={size * 0.8} height={size * 0.16}><Defs><RadialGradient id={`${id}floor`} cx="50%" cy="50%" rx="50%" ry="50%">
        <Stop offset="0" stopColor="#19233C" stopOpacity={sleepy ? 0.16 : 0.26} /><Stop offset="0.6" stopColor="#19233C" stopOpacity="0.08" /><Stop offset="1" stopColor="#19233C" stopOpacity="0" />
      </RadialGradient></Defs><Ellipse cx={size * 0.4} cy={size * 0.08} rx={size * 0.4} ry={size * 0.08} fill={`url(#${id}floor)`} /></Svg>
    </Animated.View>}
    <Animated.View style={{ width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center',
      transform: [{ translateY: float.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.05] }) }] }}>
      {/* the working arc */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: ring, transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]}>
        <Svg width={ringSize} height={ringSize}><Defs><LinearGradient id={`${id}ring`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7CC6FF" /><Stop offset="0.35" stopColor="#3D7BFA" /><Stop offset="0.7" stopColor="#A68BF7" /><Stop offset="1" stopColor="#F4A6CE" />
        </LinearGradient></Defs>
          <Circle cx={ringSize / 2} cy={ringSize / 2} r={r} stroke={`url(#${id}ring)`} strokeWidth={compact ? 1.6 : 2.4} strokeLinecap="round" fill="none"
            strokeDasharray={`${Math.PI * r * 1.25} ${Math.PI * r * 0.75}`} />
        </Svg>
      </Animated.View>
      {waiting && !busy ? <View style={[StyleSheet.absoluteFill, { borderRadius: ringSize / 2, borderWidth: compact ? 1.5 : 2, borderColor: 'rgba(232,162,60,0.6)' }]} /> : null}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#E6EAF1', opacity: sleepy ? 0.85 : 1,
        shadowColor: '#1E2846', shadowOpacity: compact ? 0.16 : sleepy ? 0.1 : 0.18, shadowRadius: Math.max(2, size * 0.15), shadowOffset: { width: 0, height: Math.max(1, size * 0.08) }, elevation: compact ? 2 : 8 }}>
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id={`${id}body`} cx="34%" cy="26%" rx="72%" ry="72%" fx="34%" fy="26%">
              <Stop offset="0" stopColor="#FFFFFF" /><Stop offset="0.3" stopColor={waiting ? '#FBF8F3' : '#F6F8FB'} />
              <Stop offset="0.72" stopColor={sleepy ? '#DADEE5' : waiting ? '#ECE6DC' : '#E2E7EF'} /><Stop offset="1" stopColor={sleepy ? '#C8CDD6' : waiting ? '#DCD3C6' : '#CDD4E0'} />
            </RadialGradient>
            <RadialGradient id={`${id}glow`} cx="50%" cy="100%" rx="62%" ry="44%">
              <Stop offset="0" stopColor={glowBottom} stopOpacity="0.38" /><Stop offset="0.5" stopColor={glowTop} stopOpacity="0.2" /><Stop offset="1" stopColor={glowTop} stopOpacity="0" />
            </RadialGradient>
          </Defs>
          <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id}body)`} />
          {!sleepy && <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id}glow)`} />}
        </Svg>
        <View style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
          gap: size * (sleepy ? 0.14 : 0.16), transform: [{ translateX: glance }, { translateY: sleepy ? size * 0.02 : waiting ? -size * 0.03 : -size * 0.02 }] }}>
          {[0, 1].map((i) => <Animated.View key={i} style={{ width: eyeLen, height: eyeH, borderRadius: Math.max(eyeW, eyeH), backgroundColor: sleepy ? '#5F6879' : '#10131A', transform: [{ scaleY: sleepy ? 1 : blink }] }} />)}
        </View>
      </View>
    </Animated.View>
  </View>;
}
