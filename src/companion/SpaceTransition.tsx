import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { Icon, type IconName } from '../components/Icon';
import { useReducedMotion } from '../components/MotionPressable';
import type { Space } from '../state/AppContext';
import { switchOrigin } from './SpaceSwitch';
import { SPACE_GRADIENTS } from './theme';

/**
 * Full-screen change between the two spaces. A gradient bloom grows from the switch while a burst of
 * little shapes flies out of your finger (chat bubbles and hearts into the chat space, sparkles back to
 * the assistant); a greeting glyph pops up in the middle — a bubble that "types", or a spinning spark —
 * the new space is mounted underneath while everything is covered, then the bloom dissolves.
 */

type Particle = { icon: IconName; angle: number; distance: number; size: number; spin: number; delay: number; lift: number };

function makeParticles(space: Space, seed: number): Particle[] {
  let state = seed;
  const random = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
  const icons: IconName[] = space === 'companion' ? ['heartFill', 'chat', 'sparkle', 'heartFill', 'smile', 'star'] : ['sparkle', 'sparkles', 'star', 'sparkle', 'bolt'];
  return Array.from({ length: 16 }, (_, index) => ({
    icon: icons[index % icons.length],
    angle: (index / 16) * Math.PI * 2 + random() * 0.5,
    distance: 110 + random() * 190,
    size: 14 + random() * 16,
    spin: (random() - 0.5) * 120,
    delay: random() * 120,
    lift: 30 + random() * 60,
  }));
}

function Burst({ particle, progress, x, y }: { particle: Particle; progress: Animated.Value; x: number; y: number }) {
  const local = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }), [progress]);
  const dx = Math.cos(particle.angle) * particle.distance;
  const dy = Math.sin(particle.angle) * particle.distance - particle.lift;
  return <Animated.View pointerEvents="none" style={{
    position: 'absolute', left: x - particle.size / 2, top: y - particle.size / 2,
    opacity: local.interpolate({ inputRange: [0, 0.1, 0.7, 1], outputRange: [0, 1, 0.9, 0] }),
    transform: [
      { translateX: local.interpolate({ inputRange: [0, 1], outputRange: [0, dx] }) },
      { translateY: local.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, dy * 0.85, dy + particle.lift * 0.6] }) },
      { rotate: local.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${particle.spin}deg`] }) },
      { scale: local.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0.2, 1.15, 0.6] }) },
    ],
  }}>
    <Icon name={particle.icon} size={particle.size} color="#FFFFFF" />
  </Animated.View>;
}

/** Centre glyph: a speech bubble whose dots type (chat), or a spark that spins (assistant). */
function Greeting({ space, pop, fade }: { space: Space; pop: Animated.Value; fade: Animated.Value }) {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.stagger(120, dots.map((dot) => Animated.sequence([
      Animated.timing(dot, { toValue: 1, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(dot, { toValue: 0, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver: true }),
    ]))));
    loop.start();
    return () => loop.stop();
  }, [dots]);
  const style = {
    opacity: fade,
    transform: [
      { scale: Animated.add(pop.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }), fade.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] })) },
      { rotate: pop.interpolate({ inputRange: [0, 1], outputRange: [space === 'companion' ? '-12deg' : '-90deg', '0deg'] }) },
    ],
  };
  if (space === 'assistant') return <Animated.View style={[styles.glyph, style]}><Icon name="sparkle" size={64} color="#FFFFFF" /></Animated.View>;
  return <Animated.View style={[styles.bubble, style]}>
    {dots.map((dot, index) => <Animated.View key={index} style={[styles.dot, { transform: [{ translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -7] }) }] }]} />)}
    <View style={styles.tail} />
  </Animated.View>;
}

export function SpaceTransition({ space, children }: { space: Space; children: (shown: Space) => React.ReactNode }) {
  const [shown, setShown] = useState(space);
  const [cover, setCover] = useState<Space | null>(null);
  const [runId, setRunId] = useState(0);
  const grow = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  const { width, height } = useWindowDimensions();
  const origin = useRef({ x: width / 2, y: 80 });

  useEffect(() => {
    if (space === shown) return undefined;
    if (reduced) { setShown(space); return undefined; }
    origin.current = { x: switchOrigin.x || width / 2, y: switchOrigin.y || 80 };
    setCover(space);
    setRunId((value) => value + 1);
    grow.setValue(0);
    fade.setValue(1);
    burst.setValue(0);
    pop.setValue(0);
    Animated.timing(burst, { toValue: 1, duration: 1000, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    Animated.sequence([Animated.delay(200), Animated.spring(pop, { toValue: 1, damping: 9, stiffness: 180, useNativeDriver: true })]).start();
    const animation = Animated.timing(grow, { toValue: 1, duration: 460, easing: Easing.inOut(Easing.cubic), useNativeDriver: true });
    animation.start(({ finished }) => {
      if (!finished) return;
      setShown(space);
      Animated.timing(fade, { toValue: 0, duration: 420, delay: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => setCover(null));
    });
    return () => animation.stop();
  }, [space, shown, reduced, grow, fade, burst, pop, width]);

  const particles = useMemo(() => (cover ? makeParticles(cover, 1234 + runId * 97) : []), [cover, runId]);
  const radius = Math.hypot(Math.max(origin.current.x, width - origin.current.x), Math.max(origin.current.y, height - origin.current.y)) * 1.1;
  const size = radius * 2;
  const colors = cover ? SPACE_GRADIENTS[cover] : SPACE_GRADIENTS.assistant;
  return <View style={styles.root}>
    {children(shown)}
    {cover && <Animated.View pointerEvents="auto" style={[StyleSheet.absoluteFill, { opacity: fade }]}>
      <Animated.View style={{
        position: 'absolute', left: origin.current.x - radius, top: origin.current.y - radius, width: size, height: size,
        transform: [{ scale: grow.interpolate({ inputRange: [0, 1], outputRange: [0.02, 1] }) }],
      }}>
        <Svg width={size} height={size}>
          <Defs>
            <RadialGradient id="spaceBloom" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor={colors[0]} />
              <Stop offset="0.55" stopColor={colors[1]} />
              <Stop offset="1" stopColor={colors[2]} />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width={size} height={size} rx={radius} fill="url(#spaceBloom)" />
        </Svg>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: grow.interpolate({ inputRange: [0.6, 1], outputRange: [0, 0.35], extrapolate: 'clamp' }) }]}>
        <Svg width="100%" height="100%"><Defs><LinearGradient id="spaceSheen" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.9} /><Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} /></LinearGradient></Defs><Rect x="0" y="0" width="100%" height="100%" fill="url(#spaceSheen)" /></Svg>
      </Animated.View>
      <View pointerEvents="none" style={styles.center}><Greeting key={runId} space={cover} pop={pop} fade={fade} /></View>
      {particles.map((particle, index) => <Burst key={`${runId}-${index}`} particle={particle} progress={burst} x={origin.current.x} y={origin.current.y} />)}
    </Animated.View>}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  glyph: { width: 96, height: 96, alignItems: 'center', justifyContent: 'center' },
  bubble: { width: 104, height: 66, borderRadius: 33, backgroundColor: 'rgba(255,255,255,0.95)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, shadowColor: '#2B2F7A', shadowOpacity: 0.25, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  dot: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#7B6CF6' },
  tail: { position: 'absolute', left: 18, bottom: -6, width: 18, height: 18, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.95)', transform: [{ rotate: '45deg' }] },
});
