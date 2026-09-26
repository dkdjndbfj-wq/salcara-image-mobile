import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, View } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';

import { brandStops } from '../theme';

const LOGO = require('../../assets/brand-logo.png');
import { useReducedMotion } from './MotionPressable';

let gradientSeed = 0;
function useGradientId(prefix: string) {
  const ref = useRef<string | null>(null);
  if (!ref.current) { gradientSeed += 1; ref.current = `${prefix}${gradientSeed}`; }
  return ref.current;
}

/** The Salcara logo (raster artwork with transparent background). */
export function BrandMark({ size = 28 }: { size?: number }) {
  return <Image source={LOGO} style={{ width: size, height: size }} resizeMode="contain" accessibilityIgnoresInvertColors />;
}

/** The logo slowly turning and breathing — shown while Salcara is thinking. Its two-fold symmetry makes the loop seamless. */
export function LivingMark({ size = 22, active = true }: { size?: number; active?: boolean }) {
  const spin = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!active || reduced) return;
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 2600, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [active, reduced, spin]);
  return <Animated.View style={{ width: size, height: size, transform: [
    { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) },
    { scale: spin.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.94, 1.06, 0.94] }) },
  ] }}>
    <BrandMark size={size} />
  </Animated.View>;
}

/** Gradient headline text (SVG), e.g. the greeting on the home screen. */
export function GradientText({ text, fontSize = 32, width = 320, weight = '600' }: { text: string; fontSize?: number; width?: number; weight?: '500' | '600' | '700' }) {
  const id = useGradientId('gt');
  const height = Math.round(fontSize * 1.35);
  return <View style={{ width, height }}>
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2={String(Math.min(width, fontSize * text.length * 1.05))} y2="0" gradientUnits="userSpaceOnUse">
          {brandStops.map((stop) => <Stop key={stop.offset} offset={String(stop.offset)} stopColor={stop.color} />)}
        </LinearGradient>
      </Defs>
      <SvgText x="0" y={fontSize * 1.02} fontSize={fontSize} fontWeight={weight} fill={`url(#${id})`} letterSpacing={-0.5}>{text}</SvgText>
    </Svg>
  </View>;
}
