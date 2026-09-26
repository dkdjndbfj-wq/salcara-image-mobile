import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { colors } from '../theme';
import { LogoArt, RIBBON_DIRECTION, RIBBON_ORDER } from './Logo';
import { useReducedMotion } from './MotionPressable';

/**
 * Cold-start animation. The first frame matches the native splash (same logo,
 * same size, white), so the hand-off is invisible. Then: colour blooms behind
 * the mark, the ribbons breathe apart while the mark makes a half turn (it is
 * two-fold symmetric, so it lands on itself), the wordmark rises in, and the
 * whole layer dissolves into the app.
 *
 * Everything is driven by one clock (milliseconds) and interpolated on the
 * native thread; easing is baked into the interpolation tables because the
 * native driver does not accept easing functions in interpolate().
 */

/** Logo size in the native splash: 300px of a 512px image shown 150dp wide. */
export const SPLASH_LOGO_SIZE = Math.round(150 * 300 / 512);
const HOLD_AT = 1380;
const END_AT = 1840;
const CONTENT_OUT = HOLD_AT + 190;
const WORD = 'Salcara';

let revealed = false;
const revealListeners = new Set<() => void>();
function markRevealed() {
  if (revealed) return;
  revealed = true;
  revealListeners.forEach((listener) => listener());
}
/**
 * Becomes true the moment the intro starts lifting. Screens use it as a key so
 * their entrance animations play in view instead of hidden under the intro.
 * Stays false when no intro runs, which changes nothing.
 */
export function useLaunchRevealed(): boolean {
  const [value, setValue] = useState(revealed);
  useEffect(() => {
    if (revealed) { setValue(true); return undefined; }
    const listener = () => setValue(true);
    revealListeners.add(listener);
    return () => { revealListeners.delete(listener); };
  }, []);
  return value;
}

type Key = { at: number; value: number; ease?: (value: number) => number };

/** Samples an eased keyframe track into interpolate() tables. */
function track(keys: Key[], unit = '') {
  const inputRange: number[] = [];
  const outputRange: Array<number | string> = [];
  const push = (at: number, value: number) => {
    if (inputRange.length && at <= inputRange[inputRange.length - 1]) return;
    inputRange.push(at);
    outputRange.push(unit ? `${value}${unit}` : value);
  };
  keys.forEach((key, index) => {
    if (index === 0) { push(key.at, key.value); return; }
    const prev = keys[index - 1];
    const ease = key.ease ?? ((x: number) => x);
    const steps = key.ease ? 10 : 1;
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      push(prev.at + (key.at - prev.at) * t, prev.value + (key.value - prev.value) * ease(t));
    }
  });
  if (inputRange.length === 1) { inputRange.push(inputRange[0] + 1); outputRange.push(outputRange[0]); }
  return { inputRange, outputRange, extrapolate: 'clamp' as const };
}

const out = Easing.out(Easing.cubic);
const inOut = Easing.inOut(Easing.cubic);
const soft = Easing.inOut(Easing.quad);

export function LaunchIntro({ ready, onDone, onFirstFrame }: { ready: boolean; onDone: () => void; onFirstFrame?: () => void }) {
  const clock = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const phase = useRef<'intro' | 'holding' | 'leaving'>('intro');
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const leave = useRef(() => {
    if (phase.current === 'leaving') return;
    phase.current = 'leaving';
    markRevealed();
    Animated.timing(clock, { toValue: END_AT, duration: reduced ? 220 : END_AT - HOLD_AT, easing: Easing.linear, useNativeDriver: true })
      .start(() => onDoneRef.current());
  }).current;

  useEffect(() => {
    const intro = reduced
      ? Animated.sequence([Animated.delay(250), Animated.timing(clock, { toValue: HOLD_AT, duration: 0, useNativeDriver: true })])
      : Animated.timing(clock, { toValue: HOLD_AT, duration: HOLD_AT, easing: Easing.linear, useNativeDriver: true });
    intro.start(() => {
      phase.current = 'holding';
      if (readyRef.current) leave();
    });
    return () => intro.stop();
  }, [clock, leave, reduced]);

  useEffect(() => { if (ready && phase.current === 'holding') leave(); }, [ready, leave]);

  const logo = SPLASH_LOGO_SIZE;
  const glow = Math.min(width, height) * 1.15;
  const anim = useMemo(() => ({
    glowOpacity: clock.interpolate(track([{ at: 0, value: 0 }, { at: 480, value: 1, ease: out }, { at: HOLD_AT, value: 1 }, { at: CONTENT_OUT, value: 0, ease: soft }])),
    glowScale: clock.interpolate(track([{ at: 0, value: 0.3 }, { at: 950, value: 1, ease: out }, { at: END_AT, value: 1.25, ease: soft }])),
    glowSpin: clock.interpolate(track([{ at: 0, value: -40 }, { at: END_AT, value: 30, ease: soft }], 'deg')),
    rotate: clock.interpolate(track([{ at: 0, value: 0 }, { at: 140, value: 0 }, { at: 1060, value: 180, ease: inOut }], 'deg')),
    scale: clock.interpolate(track([
      { at: 0, value: 1 }, { at: 140, value: 1 }, { at: 400, value: 0.9, ease: soft }, { at: 820, value: 1.2, ease: soft },
      { at: 1080, value: 1.12, ease: soft }, { at: HOLD_AT, value: 1.12 }, { at: CONTENT_OUT, value: 1.3, ease: Easing.in(Easing.quad) },
    ])),
    lift: clock.interpolate(track([{ at: 0, value: 0 }, { at: 960, value: 0 }, { at: 1300, value: -30, ease: out }])),
    spread: clock.interpolate(track([{ at: 0, value: 0 }, { at: 220, value: 0 }, { at: 560, value: 1, ease: soft }, { at: 1020, value: 0, ease: inOut }])),
    // Staged exit: the mark and wordmark dissolve first, then the white layer lifts off the app.
    content: clock.interpolate(track([{ at: 0, value: 1 }, { at: HOLD_AT, value: 1 }, { at: CONTENT_OUT, value: 0, ease: soft }])),
    wordDrop: clock.interpolate(track([{ at: 0, value: 0 }, { at: HOLD_AT, value: 0 }, { at: CONTENT_OUT, value: -8, ease: soft }])),
    fade: clock.interpolate(track([{ at: 0, value: 1 }, { at: CONTENT_OUT - 10, value: 1 }, { at: END_AT, value: 0, ease: soft }])),
    letters: WORD.split('').map((_, index) => {
      const start = 1000 + index * 42;
      return {
        opacity: clock.interpolate(track([{ at: 0, value: 0 }, { at: start, value: 0 }, { at: start + 260, value: 1, ease: out }])),
        rise: clock.interpolate(track([{ at: 0, value: 16 }, { at: start, value: 16 }, { at: start + 340, value: 0, ease: out }])),
      };
    }),
  }), [clock]);

  const spreadDistance = logo * 0.07;
  return <Animated.View pointerEvents="auto" accessibilityLabel="Salcara 正在启动" style={[StyleSheet.absoluteFill, styles.root, { opacity: anim.fade }]}
    onLayout={() => onFirstFrame?.()}>
    <Animated.View pointerEvents="none" style={[styles.center, { width: glow, height: glow, marginLeft: -glow / 2, marginTop: -glow / 2, opacity: anim.glowOpacity, transform: [{ rotate: anim.glowSpin }, { scale: anim.glowScale }] }]}>
      <Svg width={glow} height={glow} viewBox="0 0 100 100">
        <Defs>
          <RadialGradient id="introSky" cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor="#7CC6FF" stopOpacity={0.55} /><Stop offset="1" stopColor="#7CC6FF" stopOpacity={0} /></RadialGradient>
          <RadialGradient id="introViolet" cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor="#A68BF7" stopOpacity={0.42} /><Stop offset="1" stopColor="#A68BF7" stopOpacity={0} /></RadialGradient>
          <RadialGradient id="introPink" cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor="#F4A6CE" stopOpacity={0.5} /><Stop offset="1" stopColor="#F4A6CE" stopOpacity={0} /></RadialGradient>
        </Defs>
        <Circle cx="38" cy="40" r="30" fill="url(#introSky)" />
        <Circle cx="62" cy="46" r="28" fill="url(#introViolet)" />
        <Circle cx="48" cy="63" r="26" fill="url(#introPink)" />
      </Svg>
    </Animated.View>

    <Animated.View style={[styles.center, { width: logo, height: logo, marginLeft: -logo / 2, marginTop: -logo / 2, opacity: anim.content, transform: [{ translateY: anim.lift }, { rotate: anim.rotate }, { scale: anim.scale }] }]}>
      {RIBBON_ORDER.map((part) => {
        const direction = RIBBON_DIRECTION[part];
        return <Animated.View key={part} style={[StyleSheet.absoluteFill, { transform: [
          { translateX: Animated.multiply(anim.spread, direction.x * spreadDistance) },
          { translateY: Animated.multiply(anim.spread, direction.y * spreadDistance) },
        ] }]}>
          <LogoArt size={logo} parts={[part]} />
        </Animated.View>;
      })}
    </Animated.View>

    <Animated.View pointerEvents="none" style={[styles.wordRow, { top: height / 2 + logo / 2 + 4, opacity: anim.content, transform: [{ translateY: anim.wordDrop }] }]}>
      {WORD.split('').map((letter, index) => <Animated.Text key={`${letter}${index}`} style={[styles.letter, {
        opacity: anim.letters[index].opacity, transform: [{ translateY: anim.letters[index].rise }],
      }]}>{letter}</Animated.Text>)}
    </Animated.View>
  </Animated.View>;
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.background, zIndex: 100, elevation: 100 },
  center: { position: 'absolute', left: '50%', top: '50%' },
  wordRow: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'center' },
  letter: { color: colors.text, fontSize: 30, lineHeight: 38, fontWeight: '600', letterSpacing: -0.4 },
});
