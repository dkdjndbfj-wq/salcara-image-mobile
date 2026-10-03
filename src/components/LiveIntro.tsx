import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, useWindowDimensions, View, type ImageSourcePropType } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Ellipse, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { themed } from '../theme';
/**
 * The Live entrance, staged like a film title over the starfield of the key visual:
 * a light blooms up from the bottom edge (the Gemini-style handshake), the camera dollies through the stars
 * and racks them softly out of focus, the logo resolves from a soft glow, a glint runs across the letters
 * and a comet laps its ring, the welcome line and HUD lines draw in, and bokeh drifts in the foreground.
 * Once the titles have landed they lift away and Live takes over: only the starfield, bokeh and rising motes
 * stay as the stage, and the stars quietly brighten with the voice and pulse while Salcara thinks.
 * Everything is transform/opacity on the native driver; soft-focus layers are pre-blurred images.
 */

const ASSETS = {
  stars: require('../../assets/live/stars.webp') as ImageSourcePropType,
  starsSoft: require('../../assets/live/stars-soft.webp') as ImageSourcePropType,
  logo: require('../../assets/live/logo.webp') as ImageSourcePropType,
  logoSoft: require('../../assets/live/logo-soft.webp') as ImageSourcePropType,
  tagline: require('../../assets/live/tagline.webp') as ImageSourcePropType,
  corner: require('../../assets/live/corner.webp') as ImageSourcePropType,
  spark: require('../../assets/live/spark.webp') as ImageSourcePropType,
  side: require('../../assets/live/side.webp') as ImageSourcePropType,
  footer: require('../../assets/live/footer.webp') as ImageSourcePropType,
};

/** The key visual is 941×1672; every piece keeps its place from that frame. */
const POSTER = { width: 941, height: 1672 };
type Piece = { x: number; y: number; w: number; h: number };
const PIECES: Record<'corner' | 'logo' | 'tagline' | 'spark' | 'side' | 'footer', Piece> = {
  corner: { x: 42, y: 15, w: 413, h: 229 },
  logo: { x: 53, y: 140, w: 860, h: 340 },
  tagline: { x: 156, y: 411, w: 646, h: 104 },
  spark: { x: 42, y: 542, w: 49, h: 49 },
  side: { x: 49, y: 596, w: 150, h: 181 },
  footer: { x: 9, y: 1550, w: 459, h: 122 },
};
/** The ring around the logo, fitted from the artwork: centre, unit major axis and semi-axes. */
const RING = { cx: 446, cy: 304, ux: 0.9526, uy: -0.3043, a: 362, b: 69 };
const RING_SAMPLES = 48;

export type IntroMode = 'full' | 'short' | 'none';

let seed = 0;
const nextId = (name: string) => `${name}${(seed += 1)}`;

function Halo({ size, color, strength = 0.95 }: { size: number; color: string; strength?: number }) {
  const id = useRef(nextId('halo')).current;
  return <Svg width={size} height={size}>
    <Defs>
      <RadialGradient id={id} cx="50%" cy="50%" r="50%">
        <Stop offset="0" stopColor={color} stopOpacity={strength} />
        <Stop offset="0.4" stopColor={color} stopOpacity={strength * 0.35} />
        <Stop offset="1" stopColor={color} stopOpacity={0} />
      </RadialGradient>
    </Defs>
    <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
  </Svg>;
}

/** Reveals its children along an axis with a moving clip (transforms only); the content itself stays still. */
function Wipe({ progress, axis, frame, children }: {
  progress: Animated.Value; axis: 'x' | 'y'; frame: { left: number; top: number; width: number; height: number }; children: React.ReactNode;
}) {
  const size = axis === 'x' ? frame.width : frame.height;
  const key = axis === 'x' ? 'translateX' : 'translateY';
  const move = (range: number[]) => ({ transform: [{ [key]: progress.interpolate({ inputRange: [0, 1], outputRange: range }) }] as never });
  return <View pointerEvents="none" style={{ position: 'absolute', left: frame.left, top: frame.top, width: frame.width, height: frame.height, overflow: 'hidden' }}>
    <Animated.View style={[{ width: frame.width, height: frame.height, overflow: 'hidden' }, move([-size, 0])]}>
      <Animated.View style={[{ width: frame.width, height: frame.height }, move([size, 0])]}>{children}</Animated.View>
    </Animated.View>
  </View>;
}

function seeded(start: number) {
  let state = start;
  return () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
}

/** A value that runs 0→1 forever, after an initial delay. */
function useCycle(duration: number, delay: number, run: boolean) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!run) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(value, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));
    const timer = setTimeout(() => loop.start(), delay);
    return () => { clearTimeout(timer); loop.stop(); };
  }, [run, value, delay, duration]);
  return value;
}

function Particle({ x, y, size, rise, duration, delay, color, run }: { x: number; y: number; size: number; rise: number; duration: number; delay: number; color: string; run: boolean }) {
  const value = useCycle(duration, delay, run);
  return <Animated.View style={{
    position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: size, backgroundColor: color,
    opacity: value.interpolate({ inputRange: [0, 0.2, 0.7, 1], outputRange: [0, 0.95, 0.6, 0] }),
    transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -rise] }) }],
  }} />;
}

/** Big out-of-focus lights in the foreground; they drift a little faster than the stars for depth. */
function Bokeh({ x, y, size, color, strength, duration, run }: { x: number; y: number; size: number; color: string; strength: number; duration: number; run: boolean }) {
  const value = useCycle(duration, 0, run);
  return <Animated.View style={{
    position: 'absolute', left: x - size / 2, top: y - size / 2,
    opacity: value.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.55, 1, 0.55] }),
    transform: [
      { translateX: value.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, size * 0.18, 0] }) },
      { translateY: value.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, -size * 0.22, 0] }) },
    ],
  }}><Halo size={size} color={color} strength={strength} /></Animated.View>;
}

export type BackdropPhase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error';

function LiveBackdropView({ mode, onReveal, onDone, phase = 'listening', energy }: {
  mode: IntroMode; onReveal: () => void; onDone?: () => void; phase?: BackdropPhase; energy?: Animated.Value;
}) {
  const styles = useStyles();
  const { width: W, height: H } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [posterGone, setPosterGone] = useState(mode === 'none');
  const lite = mode === 'short';
  const ids = useRef({ bloom: nextId('bloom'), sweep: nextId('sweep'), scrim: nextId('scrim') }).current;

  // Layout: the starfield covers the screen like the poster; the HUD text is fitted to the width
  // (never cropped) and spread so the header sits under the status bar and the footer on the bottom edge.
  const cover = Math.max(W / POSTER.width, H / POSTER.height);
  const art = { left: (W - POSTER.width * cover) / 2, top: (H - POSTER.height * cover) / 2, width: POSTER.width * cover, height: POSTER.height * cover };
  const s = Math.min(W / POSTER.width, (H / POSTER.height) * 1.05);
  const offX = (W - POSTER.width * s) / 2;
  const spare = Math.max(0, H - POSTER.height * s);
  const headTop = insets.top * 0.7 + spare * 0.12;
  const midTop = headTop + spare * 0.22;
  const frame = (piece: Piece, top: number) => ({ left: offX + piece.x * s, top: top + piece.y * s, width: piece.w * s, height: piece.h * s });
  const footerTop = H - (POSTER.height - PIECES.footer.y) * s - insets.bottom * 0.35;
  const logo = frame(PIECES.logo, headTop);

  const v = useRef(Object.fromEntries([
    'bloom', 'dolly', 'warp', 'focus', 'logo', 'logoSharp', 'glint', 'comet', 'sweep',
    'corner', 'tagline', 'spark', 'side', 'footer', 'bokeh', 'exit', 'drift', 'voiceOn', 'think',
  ].map((name) => [name, new Animated.Value(0)])) as Record<string, Animated.Value>).current;
  const initialised = useRef(false);
  if (!initialised.current) {
    initialised.current = true;
    // Without an entrance everything starts in its settled state.
    if (mode === 'none') for (const name of ['focus', 'dolly', 'warp', 'exit', 'bloom']) v[name].setValue(1);
  }
  const fallbackEnergy = useRef(new Animated.Value(0)).current;
  const voice = energy ?? fallbackEnergy;
  const main = useRef<ReturnType<typeof Animated.parallel> | null>(null);
  const exiting = useRef(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (revealTimer.current) clearTimeout(revealTimer.current); }, []);
  const callbacks = useRef({ onReveal, onDone });
  callbacks.current = { onReveal, onDone };

  const settle = () => Animated.timing(v.drift, { toValue: 1, duration: 18000, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  const exit = () => {
    if (exiting.current) return;
    exiting.current = true;
    main.current?.stop();
    // Live comes in once the titles have mostly lifted away, so captions never sit on top of the welcome text.
    revealTimer.current = setTimeout(() => callbacks.current.onReveal(), lite ? 220 : 480);
    Animated.parallel([
      Animated.timing(v.exit, { toValue: 1, duration: lite ? 480 : 820, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(v.focus, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.timing(v.dolly, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(v.warp, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.timing(v.bloom, { toValue: 1, duration: 500, useNativeDriver: true }),
    ]).start(() => {
      setPosterGone(true);
      callbacks.current.onDone?.();
    });
    settle();
  };

  useEffect(() => {
    if (mode === 'none') {
      callbacks.current.onReveal();
      callbacks.current.onDone?.();
      settle();
      return undefined;
    }
    const k = lite ? 0.55 : 1;
    const at = (delay: number, value: Animated.Value, duration: number, easing: (value: number) => number = Easing.out(Easing.cubic)) => Animated.sequence([
      Animated.delay(delay * k),
      Animated.timing(value, { toValue: 1, duration: duration * k, easing, useNativeDriver: true }),
    ]);
    const expo = Easing.out(Easing.exp);
    const steps = lite ? [
      at(0, v.bloom, 900, Easing.inOut(Easing.cubic)), at(0, v.dolly, 1500, expo), at(0, v.warp, 900),
      at(350, v.focus, 800, Easing.inOut(Easing.cubic)),
      at(150, v.logo, 800, expo), at(450, v.logoSharp, 600), at(500, v.tagline, 700, expo), at(200, v.bokeh, 900),
      Animated.delay(1700),
    ] : [
      at(0, v.bloom, 1400, Easing.inOut(Easing.cubic)),
      at(0, v.dolly, 2600, expo),
      at(0, v.warp, 1500, Easing.out(Easing.quad)),
      at(1100, v.focus, 1200, Easing.inOut(Easing.cubic)),
      at(500, v.logo, 1100, expo),
      at(800, v.logoSharp, 650, Easing.inOut(Easing.cubic)),
      at(700, v.sweep, 1300, Easing.inOut(Easing.cubic)),
      at(1200, v.comet, 1600, Easing.inOut(Easing.sin)),
      at(900, v.tagline, 900, expo),
      at(1000, v.corner, 800, expo),
      at(1150, v.spark, 700, Easing.out(Easing.back(1.8))),
      at(1250, v.side, 800, expo),
      at(1400, v.footer, 800, expo),
      at(1700, v.glint, 900, Easing.inOut(Easing.cubic)),
      at(400, v.bokeh, 1600, Easing.inOut(Easing.quad)),
      // A short beat on the finished title card, then it lifts away and Live takes over.
      Animated.delay(3500),
    ];
    main.current = Animated.parallel(steps);
    main.current.start(({ finished }) => { if (finished) exit(); });
    return () => main.current?.stop();
    // The timeline runs once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const particles = useMemo(() => {
    const random = seeded(20260928);
    return Array.from({ length: 24 }, (_, index) => ({
      key: index, x: random() * W, y: H * (0.2 + random() * 0.8), size: 1.4 + random() * 2.6, rise: 50 + random() * 120,
      duration: 4200 + random() * 4200, delay: 400 + random() * 2600,
      color: index % 6 === 0 ? '#F2C879' : index % 3 === 0 ? '#FFFFFF' : '#8CCBFF',
    }));
  }, [W, H]);
  const bokeh = useMemo(() => [
    { x: W * 0.08, y: H * 0.56, size: W * 0.34, color: '#F2C879', strength: 0.22, duration: 9000 },
    { x: W * 0.92, y: H * 0.2, size: W * 0.26, color: '#8CCBFF', strength: 0.3, duration: 11000 },
    { x: W * 0.22, y: H * 0.9, size: W * 0.42, color: '#7B8CFF', strength: 0.22, duration: 12000 },
    { x: W * 0.62, y: H * 0.74, size: W * 0.14, color: '#F2C879', strength: 0.4, duration: 8000 },
    { x: W * 0.4, y: H * 0.34, size: W * 0.1, color: '#BFE4FF', strength: 0.45, duration: 7000 },
  ], [W, H]);

  const out = v.exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const clamp01 = { inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' as const };
  // Once settled, the sharp stars come up with the voice (yours while you talk, Salcara's while it speaks) and pulse while it thinks.
  const twinkle = Animated.add(
    Animated.multiply(v.voiceOn, voice.interpolate({ inputRange: [0.15, 1], outputRange: [0, 0.5], extrapolate: 'clamp' })),
    v.think.interpolate({ inputRange: [0, 1], outputRange: [0, 0.3] }),
  ).interpolate(clamp01);

  const settled = posterGone || exiting.current;
  useEffect(() => {
    if (!settled) return undefined;
    Animated.timing(v.voiceOn, { toValue: phase === 'speaking' || phase === 'hearing' ? 1 : 0, duration: 320, useNativeDriver: true }).start();
    if (phase !== 'thinking' || mode === 'none') { Animated.timing(v.think, { toValue: 0, duration: 300, useNativeDriver: true }).start(); return undefined; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v.think, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(v.think, { toValue: 0.25, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [settled, phase, mode, v]);
  const ring = useMemo(() => Array.from({ length: RING_SAMPLES + 1 }, (_, index) => {
    const t = Math.PI + (index / RING_SAMPLES) * Math.PI * 2;
    const px = RING.cx + RING.a * RING.ux * Math.cos(t) - RING.b * RING.uy * Math.sin(t);
    const py = RING.cy + RING.a * RING.uy * Math.cos(t) + RING.b * RING.ux * Math.sin(t);
    return { x: offX + px * s, y: headTop + py * s };
  }), [offX, s, headTop]);
  const along = (lag: number, pick: 'x' | 'y') => v.comet.interpolate({
    inputRange: ring.map((_, index) => index / RING_SAMPLES + lag), outputRange: ring.map((point) => point[pick]), extrapolate: 'clamp',
  });
  const flare = (center: number) => v.comet.interpolate({ inputRange: [center - 0.07, center, center + 0.14], outputRange: [0, 1, 0], extrapolate: 'clamp' });
  const star = (px: number, py: number) => ({ x: offX + px * s, y: headTop + py * s });
  const flares = [{ point: star(791, 194), value: flare(0.5), color: '#9CD2FF' }, { point: star(101, 414), value: flare(0.985), color: '#FFC98A' }];
  const glintWidth = Math.max(44, logo.width * 0.14);
  const scale = (value: Animated.Value | Animated.AnimatedInterpolation<number>, from: number, to = 1) => value.interpolate({ inputRange: [0, 1], outputRange: [from, to] });

  return <View pointerEvents={posterGone ? 'none' : 'auto'} style={StyleSheet.absoluteFill}>
    {/* Bloom: a light rising from the bottom edge, like a voice session waking up. It settles into a low glow. */}
    <Animated.View pointerEvents="none" style={{
      position: 'absolute', left: -W * 0.35, top: H * 0.45, width: W * 1.7, height: H * 0.9,
      opacity: Animated.multiply(v.bloom.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0.95, 0.4] }), v.exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] })),
      transform: [{ translateY: v.bloom.interpolate({ inputRange: [0, 1], outputRange: [H * 0.35, 0] }) }, { scale: v.bloom.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.1] }) }],
    }}>
      <Svg width={W * 1.7} height={H * 0.9}>
        <Defs>
          <RadialGradient id={ids.bloom} cx="50%" cy="72%" rx="50%" ry="55%">
            <Stop offset="0" stopColor="#9FD3FF" stopOpacity={0.9} />
            <Stop offset="0.35" stopColor="#4C7DFF" stopOpacity={0.45} />
            <Stop offset="0.7" stopColor="#6B4DFF" stopOpacity={0.12} />
            <Stop offset="1" stopColor="#070B1F" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Ellipse cx={W * 0.85} cy={H * 0.65} rx={W * 0.85} ry={H * 0.5} fill={`url(#${ids.bloom})`} />
      </Svg>
    </Animated.View>

    {/* Starfield: a dolly through sharp stars (with a faster foreground copy for depth), then a rack focus to soft stars,
        keeping a faint layer of sharp stars that brightens with the voice during Live. */}
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, {
      transform: [
        { scale: Animated.add(scale(v.dolly, 1.32, 1.05), v.drift.interpolate({ inputRange: [0, 1], outputRange: [0, -0.05] })) },
        { rotate: v.dolly.interpolate({ inputRange: [0, 1], outputRange: ['-4deg', '0deg'] }) },
      ],
    }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: v.focus.interpolate({ inputRange: [0, 1], outputRange: [0, 0.85] }) }]}>
        <Image source={ASSETS.starsSoft} style={{ position: 'absolute', ...art }} resizeMode="cover" fadeDuration={0} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: Animated.multiply(v.warp, v.focus.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] })) }]}>
        <Image source={ASSETS.stars} style={{ position: 'absolute', ...art }} resizeMode="cover" fadeDuration={0} />
      </Animated.View>
      {settled ? <Animated.View style={[StyleSheet.absoluteFill, { opacity: twinkle }]}>
        <Image source={ASSETS.stars} style={{ position: 'absolute', ...art }} resizeMode="cover" fadeDuration={0} />
      </Animated.View> : null}
    </Animated.View>
    {posterGone || lite ? null : <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, {
      opacity: v.warp.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 0.45, 0] }),
      transform: [{ scale: scale(v.warp, 2.1, 1.3) }],
    }]}>
      <Image source={ASSETS.stars} style={{ position: 'absolute', ...art }} resizeMode="cover" fadeDuration={0} />
    </Animated.View>}

    {/* Reading scrim for the Live controls and captions: a little shade under the top bar, more along the bottom. */}
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: v.exit }]}>
      <Svg width={W} height={H}>
        <Defs>
          <LinearGradient id={ids.scrim} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#060917" stopOpacity={0.45} />
            <Stop offset="0.2" stopColor="#060917" stopOpacity={0} />
            <Stop offset="0.5" stopColor="#060917" stopOpacity={0.08} />
            <Stop offset="1" stopColor="#060917" stopOpacity={0.85} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width={W} height={H} fill={`url(#${ids.scrim})`} />
      </Svg>
    </Animated.View>

    {posterGone ? null : <>
      {/* A soft diagonal light sweeping across the frame, like a lens catching the light. */}
      {lite ? null : <Animated.View pointerEvents="none" style={{
        position: 'absolute', left: -W, top: -H * 0.25, width: W * 0.9, height: H * 1.5,
        opacity: v.sweep.interpolate({ inputRange: [0, 0.2, 0.8, 1], outputRange: [0, 1, 1, 0] }),
        transform: [{ translateX: scale(v.sweep, 0, W * 2.2) }, { rotate: '18deg' }],
      }}>
        <Svg width={W * 0.9} height={H * 1.5}>
          <Defs>
            <LinearGradient id={ids.sweep} x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor="#BFE4FF" stopOpacity={0} />
              <Stop offset="0.5" stopColor="#BFE4FF" stopOpacity={0.16} />
              <Stop offset="1" stopColor="#BFE4FF" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width={W * 0.9} height={H * 1.5} fill={`url(#${ids.sweep})`} />
        </Svg>
      </Animated.View>}

      {/* HUD text, logo and the welcome line: they only belong to the entrance and lift away as Live takes over. */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, {
        opacity: out,
        transform: [{ translateY: v.exit.interpolate({ inputRange: [0, 1], outputRange: [0, -18] }) }, { scale: v.exit.interpolate({ inputRange: [0, 1], outputRange: [1, 0.97] }) }],
      }]}>
        {lite ? null : <Wipe progress={v.corner} axis="y" frame={frame(PIECES.corner, headTop)}>
          <Image source={ASSETS.corner} style={styles.fill} fadeDuration={0} />
        </Wipe>}

        {/* Logo: resolves from a soft glow while its tracking tightens, then the sharp letters take over. */}
        <Animated.View style={{ position: 'absolute', ...logo, transform: [{ scaleX: scale(v.logo, 1.14) }, { scale: scale(v.logo, 1.08) }] }}>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: Animated.multiply(v.logo, v.logoSharp.interpolate({ inputRange: [0, 1], outputRange: [1, 0.25] })) }]}>
            <Image source={ASSETS.logoSoft} style={styles.fill} fadeDuration={0} />
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, { opacity: v.logoSharp }]}>
            <Image source={ASSETS.logo} style={styles.fill} fadeDuration={0} />
          </Animated.View>
        </Animated.View>
        {/* Glint: a white copy of the logo seen through a moving window, so the shine follows the letters. */}
        {lite ? null : <View style={{ position: 'absolute', ...logo, overflow: 'hidden' }}>
          <Animated.View style={{
            position: 'absolute', left: 0, top: 0, width: glintWidth, height: logo.height, overflow: 'hidden',
            opacity: v.glint.interpolate({ inputRange: [0, 0.15, 0.85, 1], outputRange: [0, 0.7, 0.7, 0] }),
            transform: [{ translateX: scale(v.glint, -glintWidth, logo.width) }],
          }}>
            <Animated.View style={{ width: logo.width, height: logo.height, transform: [{ translateX: scale(v.glint, glintWidth, -logo.width) }] }}>
              <Image source={ASSETS.logo} style={[styles.fill, { tintColor: '#FFFFFF' }]} fadeDuration={0} />
            </Animated.View>
          </Animated.View>
        </View>}
        {/* Comet lapping the ring with a fading tail, flaring as it passes the two stars. */}
        {lite ? null : <Animated.View style={[StyleSheet.absoluteFill, { opacity: v.comet.interpolate({ inputRange: [0, 0.05, 0.88, 1], outputRange: [0, 1, 1, 0] }) }]}>
          {Array.from({ length: 10 }, (_, index) => 9 - index).map((index) => {
            const size = index === 0 ? 6 : Math.max(1.6, 5 - index * 0.4);
            return <Animated.View key={index} style={{
              position: 'absolute', left: -size / 2, top: -size / 2, width: size, height: size, borderRadius: size,
              backgroundColor: index === 0 ? '#FFFFFF' : '#A9DBFF', opacity: 1 - index * 0.09,
              transform: [{ translateX: along(index * 0.011, 'x') }, { translateY: along(index * 0.011, 'y') }],
            }} />;
          })}
          <Animated.View style={{ position: 'absolute', left: -20, top: -20, transform: [{ translateX: along(0, 'x') }, { translateY: along(0, 'y') }] }}>
            <Halo size={40} color="#8CCBFF" />
          </Animated.View>
        </Animated.View>}
        {lite ? null : flares.map(({ point, value, color }, index) => <Animated.View key={index} style={{
          position: 'absolute', left: point.x - 32, top: point.y - 32, opacity: value, transform: [{ scale: scale(value, 0.4, 1.35) }],
        }}><Halo size={64} color={color} /></Animated.View>)}

        {/* 欢迎来到聊天 live / WELCOME TO CHAT LIVE */}
        <Animated.View style={{
          position: 'absolute', ...frame(PIECES.tagline, headTop), opacity: v.tagline,
          transform: [{ translateY: scale(v.tagline, 14, 0) }, { scaleX: scale(v.tagline, 1.18) }],
        }}>
          <Image source={ASSETS.tagline} style={styles.fill} fadeDuration={0} />
        </Animated.View>
        {lite ? null : <>
          <Animated.View style={{
            position: 'absolute', ...frame(PIECES.spark, midTop), opacity: v.spark,
            transform: [{ rotate: v.spark.interpolate({ inputRange: [0, 1], outputRange: ['-120deg', '0deg'] }) }, { scale: scale(v.spark, 0.2) }],
          }}>
            <Image source={ASSETS.spark} style={styles.fill} fadeDuration={0} />
          </Animated.View>
          <Wipe progress={v.side} axis="y" frame={frame(PIECES.side, midTop)}>
            <Image source={ASSETS.side} style={styles.fill} fadeDuration={0} />
          </Wipe>
          <Animated.View style={{
            position: 'absolute', left: offX + PIECES.footer.x * s, top: footerTop, width: PIECES.footer.w * s, height: PIECES.footer.h * s,
            opacity: v.footer, transform: [{ translateY: scale(v.footer, 20, 0) }],
          }}>
            <Image source={ASSETS.footer} style={styles.fill} fadeDuration={0} />
          </Animated.View>
        </>}
      </Animated.View>
    </>}

    {/* Foreground depth: bokeh and rising motes. They stay on as the ambience of Live. */}
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: posterGone ? 0.55 : v.bokeh }]}>
      {bokeh.map((item, index) => <Bokeh key={index} {...item} run={mode !== 'none'} />)}
    </Animated.View>
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {particles.map(({ key, ...particle }) => <Particle key={key} {...particle} run={mode !== 'none'} />)}
    </View>

    {posterGone ? null : <Pressable accessibilityRole="button" accessibilityLabel="跳过开场动画" style={StyleSheet.absoluteFill} onPress={exit} />}
  </View>;
}

// Live re-renders on every caption and phase change; the backdrop only cares about its own props.
export const LiveBackdrop = React.memo(LiveBackdropView);

const useStyles = themed((c, d) => StyleSheet.create({
  fill: { width: '100%', height: '100%' },
}));
