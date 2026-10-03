import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { useVoiceConversation, type LivePhase } from '../voice/useVoiceConversation';
import { LiveBackdrop, type IntroMode } from './LiveIntro';
import { LogoArt } from './Logo';
import { Icon } from './Icon';
import { MotionPressable, useReducedMotion } from './MotionPressable';

import { themed } from '../theme';
/**
 * Live voice conversation, in the spirit of Gemini Live: a dark stage, an
 * aurora that listens, thinks and speaks with you, big captions, and every
 * interaction answered by motion.
 */

const STAGE = '#060917';
export const PHASE_TEXT: Record<LivePhase, string> = {
  connecting: '正在连接',
  listening: '我在听，直接说吧',
  hearing: '正在听你说',
  thinking: '思考中',
  speaking: '点按屏幕即可打断',
  error: '出了点问题',
};

let glowSeed = 0;
function Glow({ color, size, intensity = 0.9 }: { color: string; size: number; intensity?: number }) {
  const id = useRef(`live${(glowSeed += 1)}`).current;
  return <Svg width={size} height={size}>
    <Defs>
      <RadialGradient id={id} cx="50%" cy="50%" r="50%">
        <Stop offset="0" stopColor={color} stopOpacity={intensity} />
        <Stop offset="0.55" stopColor={color} stopOpacity={intensity * 0.35} />
        <Stop offset="1" stopColor={color} stopOpacity={0} />
      </RadialGradient>
    </Defs>
    <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
  </Svg>;
}

/** Loops a value 0→1→0 forever (native driver). */
export function useLoop(duration: number, enabled: boolean, delay = 0) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!enabled) { value.setValue(0.5); return undefined; }
    const loop = Animated.loop(Animated.sequence([
      Animated.delay(delay),
      Animated.timing(value, { toValue: 1, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(value, { toValue: 0, duration, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [value, duration, enabled, delay]);
  return value;
}

/** The aurora: cool light while you talk, warm light while Salcara talks, a swirl while it thinks. */
const Aurora = React.memo(function Aurora({ phase, energy, warmth, muted }: { phase: LivePhase; energy: Animated.Value; warmth: Animated.Value; muted: boolean }) {
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const driftA = useLoop(3800, !reduced);
  const driftB = useLoop(4600, !reduced, 400);
  const driftC = useLoop(5400, !reduced, 900);
  const swirl = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced || phase !== 'thinking') { Animated.timing(swirl, { toValue: 0, duration: 500, useNativeDriver: true }).start(); return undefined; }
    const loop = Animated.loop(Animated.timing(swirl, { toValue: 1, duration: 2400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [phase, reduced, swirl]);

  const size = Math.max(width, height) * 0.95;
  const lift = energy.interpolate({ inputRange: [0, 1], outputRange: [size * 0.1, -size * 0.1] });
  const grow = energy.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.35] });
  const glowOpacity = energy.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] });
  const orb = (color: string, x: number, drift: Animated.Value, range: number, scale = 1, key?: string) => <Animated.View key={key ?? color} style={{
    position: 'absolute', left: x * width - (size * scale) / 2, bottom: -size * scale * 0.5,
    transform: [
      { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [-range, range] }) },
      { translateY: lift },
      { scale: grow },
    ],
  }}><Glow color={color} size={size * scale} /></Animated.View>;

  return <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: muted ? 0.28 : glowOpacity }]}>
    <Animated.View style={[StyleSheet.absoluteFill, {
      transform: [{ rotate: swirl.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['0deg', '8deg', '0deg'] }) }, { scale: swirl.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.06, 1] }) }],
    }]}>
      {/* Cool layer: listening & hearing */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: warmth.interpolate({ inputRange: [0, 1], outputRange: [1, 0.25] }) }]}>
        {orb('#3D7BFA', 0.18, driftA, width * 0.12, 0.9, 'c1')}
        {orb('#7CC6FF', 0.55, driftB, width * 0.1, 1, 'c2')}
        {orb('#5B6CFF', 0.9, driftC, width * 0.12, 0.85, 'c3')}
      </Animated.View>
      {/* Warm layer: speaking */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: warmth }]}>
        {orb('#A68BF7', 0.25, driftB, width * 0.14, 0.95, 'w1')}
        {orb('#8E9BFF', 0.7, driftA, width * 0.12, 0.9, 'w2')}
        {orb('#7CC6FF', 0.48, driftC, width * 0.08, 0.7, 'w3')}
      </Animated.View>
    </Animated.View>
  </Animated.View>;
});

export function Dots({ color = 'rgba(255,255,255,0.62)' }: { color?: string } = {}) {
  const styles = useStyles();
  const [count, setCount] = useState(0);
  useEffect(() => { const timer = setInterval(() => setCount((value) => (value + 1) % 4), 380); return () => clearInterval(timer); }, []);
  return <Text style={[styles.status, { color }]}>{'.'.repeat(count)}<Text style={{ opacity: 0 }}>{'.'.repeat(3 - count)}</Text></Text>;
}

/** Ripple where the user tapped to interrupt. */
export function Ripple({ x, y, onDone, color = '#FFFFFF' }: { x: number; y: number; onDone: () => void; color?: string }) {
  const styles = useStyles();
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(value, { toValue: 1, duration: 650, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(onDone);
  }, [value, onDone]);
  return <Animated.View pointerEvents="none" style={[styles.ripple, {
    left: x - 60, top: y - 60, backgroundColor: color,
    opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
    transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.2, 3.2] }) }],
  }]} />;
}

export function RoundButton({ label, icon, onPress, tone = 'glass', ring, theme = 'dark', accent = '#7CC6FF' }: {
  label: string; icon: React.ComponentProps<typeof Icon>['name']; onPress: () => void; tone?: 'glass' | 'light' | 'danger'; ring?: Animated.Value;
  theme?: 'dark' | 'light'; accent?: string;
}) {
  const styles = useStyles();
  const light = theme === 'light';
  const background = tone === 'danger' ? '#FF4D5E' : tone === 'light' ? (light ? '#1B2150' : '#FFFFFF') : light ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.1)';
  const color = tone === 'light' ? (light ? '#FFFFFF' : STAGE) : tone === 'danger' ? '#FFFFFF' : light ? '#1B2150' : '#FFFFFF';
  return <View style={styles.buttonSlot}>
    {ring ? <Animated.View pointerEvents="none" style={[styles.buttonRing, { borderColor: accent },
      { opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }),
      transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] }) }] },
    ]} /> : null}
    <MotionPressable accessibilityRole="button" accessibilityLabel={label} scaleTo={0.88} onPress={onPress} style={[styles.button, { backgroundColor: background }, light && tone === 'glass' && styles.buttonLight]}>
      <Icon name={icon} size={26} color={color} strokeWidth={1.9} />
    </MotionPressable>
    <Text style={[styles.buttonLabel, light && { color: 'rgba(27,33,80,0.7)' }]}>{label}</Text>
  </View>;
}

export function LiveMode({ visible, paused = false, onClose, onOpenSettings }: { visible: boolean; paused?: boolean; onClose: () => void; onOpenSettings: () => void }) {
  const [mounted, setMounted] = useState(visible);
  const [session, setSession] = useState(false);
  const enter = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (visible) {
      setMounted(true);
      setSession(true);
      Animated.spring(enter, { toValue: 1, damping: 22, stiffness: 140, useNativeDriver: true }).start();
    } else if (mounted) {
      setSession(false);
      Animated.timing(enter, { toValue: 0, duration: reduced ? 0 : 280, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setMounted(false));
    }
  }, [visible, enter, mounted, reduced]);
  if (!mounted) return null;
  return <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
    <StatusBar style="light" />
    {/* Paused while voice settings are open: the mic stops, and the new settings apply on return. */}
    <LiveStage active={session && !paused} enter={enter} onClose={onClose} onOpenSettings={onOpenSettings} />
  </Modal>;
}

/** Drives the stage: `energy` follows the voice (yours while you talk, the reply's while it speaks), `warmth` the phase. */
export function useLiveEnergy(live: ReturnType<typeof useVoiceConversation>, reduced: boolean) {
  const energy = useRef(new Animated.Value(0.15)).current;
  const warmth = useRef(new Animated.Value(0)).current;
  const phaseRef = useRef(live.phase);
  phaseRef.current = live.phase;
  const mutedRef = useRef(live.muted);
  mutedRef.current = live.muted;
  const lastTarget = useRef(-1);

  // Energy follows your voice while you talk and Salcara's voice while it talks.
  useEffect(() => {
    let last = 0;
    const drive = (source: 'mic' | 'out') => ({ value }: { value: number }) => {
      const phase = phaseRef.current;
      const wanted = phase === 'speaking' ? 'out' : 'mic';
      if (source !== wanted || mutedRef.current) return;
      const now = Date.now();
      if (now - last < 40) return;
      const floor = phase === 'hearing' ? 0.3 : phase === 'speaking' ? 0.35 : 0.12;
      const target = Math.min(1, floor + value * 0.85);
      // Tiny changes are invisible but each one starts a new animation.
      if (Math.abs(target - lastTarget.current) < 0.03) return;
      last = now;
      lastTarget.current = target;
      Animated.timing(energy, { toValue: target, duration: 110, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    };
    const micId = live.micLevel.addListener(drive('mic'));
    const outId = live.outLevel.addListener(drive('out'));
    return () => { live.micLevel.removeListener(micId); live.outLevel.removeListener(outId); };
  }, [energy, live.micLevel, live.outLevel]);

  // Phase changes glide the colour temperature; thinking pulses, system voice gets a synthetic pulse.
  useEffect(() => {
    const target = live.phase === 'speaking' ? 1 : live.phase === 'thinking' ? 0.55 : 0;
    lastTarget.current = -1;
    Animated.timing(warmth, { toValue: target, duration: 650, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }).start();
    if (reduced) return undefined;
    if (live.phase === 'thinking' || (live.phase === 'speaking' && live.syntheticVoice)) {
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(energy, { toValue: live.phase === 'thinking' ? 0.5 : 0.7, duration: live.phase === 'thinking' ? 700 : 420, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(energy, { toValue: live.phase === 'thinking' ? 0.25 : 0.4, duration: live.phase === 'thinking' ? 700 : 520, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]));
      loop.start();
      return () => loop.stop();
    }
    if (live.phase === 'listening' || live.phase === 'connecting') {
      Animated.timing(energy, { toValue: 0.15, duration: 500, useNativeDriver: true }).start();
    }
    return undefined;
  }, [live.phase, live.syntheticVoice, energy, warmth, reduced]);

  return { energy, warmth };
}

/** The full key-visual entrance plays on the first Live of each app launch; later ones get a shorter cut. */
let introPlayed = false;

function LiveStage({ active, enter, onClose, onOpenSettings }: { active: boolean; enter: Animated.Value; onClose: () => void; onOpenSettings: () => void }) {
  const styles = useStyles();
  const live = useVoiceConversation(active);
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [introMode] = useState<IntroMode>(() => {
    const mode: IntroMode = reduced ? 'none' : introPlayed ? 'short' : 'full';
    introPlayed = true;
    return mode;
  });
  // The Live controls fade in as the entrance hands over; until then taps skip the entrance.
  const ui = useRef(new Animated.Value(introMode === 'none' ? 1 : 0)).current;
  const [revealed, setRevealed] = useState(introMode === 'none');
  const reveal = useCallback(() => {
    setRevealed(true);
    Animated.timing(ui, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [ui]);
  const { energy, warmth } = useLiveEnergy(live, reduced);
  const breathe = useLoop(1800, !reduced);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);

  useEffect(() => {
    if (!live.notice) return undefined;
    const timer = setTimeout(live.dismissNotice, 5000);
    return () => clearTimeout(timer);
  }, [live.notice, live.dismissNotice]);

  const tap = (event: { nativeEvent: { locationX: number; pageY: number } }) => {
    if (live.phase !== 'speaking' && live.phase !== 'thinking') return;
    const id = Date.now();
    setRipples((items) => [...items, { id, x: event.nativeEvent.locationX, y: event.nativeEvent.pageY }]);
    live.interrupt();
  };

  const rise = enter.interpolate({ inputRange: [0, 1], outputRange: [height * 0.35, 0] });
  const captionOpacity = enter.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1] });
  const assistant = live.assistantText.length > 150 ? `…${live.assistantText.slice(-150)}` : live.assistantText;
  const canInterrupt = live.phase === 'speaking' || live.phase === 'thinking';
  const interruptPop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(interruptPop, { toValue: canInterrupt ? 1 : 0, damping: 14, stiffness: 220, useNativeDriver: true }).start();
  }, [canInterrupt, interruptPop]);
  const micRing = useMemo(() => live.micLevel, [live.micLevel]);

  return <Animated.View style={[styles.stage, { opacity: enter }]}>
    {/* The entrance (tap to skip) sits at the back: the Live layers stay invisible and untouchable until it hands over,
        after which only its starfield and particles remain as the stage. */}
    <LiveBackdrop mode={introMode} onReveal={reveal} phase={live.phase} energy={energy} />
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: ui.interpolate({ inputRange: [0, 1], outputRange: [0, 0.4] }), transform: [{ translateY: rise }] }]}>
      <Aurora phase={live.phase} energy={energy} warmth={warmth} muted={live.muted || live.phase === 'error'} />
    </Animated.View>
    {revealed ? <Pressable accessibilityLabel="打断" style={StyleSheet.absoluteFill} onPress={tap} /> : null}
    {ripples.map((ripple) => <Ripple key={ripple.id} x={ripple.x} y={ripple.y} onDone={() => setRipples((items) => items.filter((item) => item.id !== ripple.id))} />)}

    <Animated.View style={[StyleSheet.absoluteFill, { opacity: ui }]} pointerEvents={revealed ? 'box-none' : 'none'}>
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']} pointerEvents="box-none">
      <View style={styles.top} pointerEvents="box-none">
        <MotionPressable accessibilityRole="button" accessibilityLabel="收起" scaleTo={0.88} onPress={onClose} style={styles.topButton}>
          <Icon name="chevronDown" size={24} color="#FFFFFF" />
        </MotionPressable>
        <View style={styles.pill}>
          <Animated.View style={[styles.liveDot, { opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }]} />
          <Text style={styles.pillText} numberOfLines={1}>Live{live.engineLabel ? ` · ${live.engineLabel}` : ''}</Text>
        </View>
        <MotionPressable accessibilityRole="button" accessibilityLabel="语音设置" scaleTo={0.88} onPress={onOpenSettings} style={styles.topButton}>
          <Icon name="settings" size={21} color="#FFFFFF" />
        </MotionPressable>
      </View>

      {live.notice ? <View style={styles.notice} pointerEvents="none"><Text style={styles.noticeText} numberOfLines={2}>{live.notice}</Text></View> : null}

      <Animated.View style={[styles.captions, { opacity: captionOpacity }]} pointerEvents="none">
        <View style={styles.statusRow}>
          <View style={styles.mark}><LogoArt size={22} /></View>
          <Text style={styles.status}>{live.muted ? '已静音，点麦克风继续' : PHASE_TEXT[live.phase]}</Text>
          {(live.phase === 'thinking' || live.phase === 'connecting') && !live.muted ? <Dots /> : null}
        </View>
        {live.phase === 'error' ? <Text style={styles.assistant}>{live.error}</Text> : <>
          {live.userText ? <Text style={styles.user} numberOfLines={3}>{live.userText}</Text> : null}
          {assistant ? <Text style={[styles.assistant, live.phase !== 'speaking' && styles.assistantDone]}>{assistant}</Text> : null}
          {!live.userText && !assistant && live.phase === 'listening' ? <Text style={styles.hint}>试试说：“帮我想个周末计划”{'\n'}或者“画一只在月亮上钓鱼的猫”</Text> : null}
        </>}
      </Animated.View>

      <Animated.View style={[styles.controls, { transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) }] }]} pointerEvents="box-none">
        {live.phase === 'error' ? <>
          <RoundButton label="重试" icon="regenerate" tone="light" onPress={live.retry} />
          <RoundButton label="语音设置" icon="settings" onPress={onOpenSettings} />
          <RoundButton label="结束" icon="close" tone="danger" onPress={onClose} />
        </> : <>
          <RoundButton label={live.muted ? '已静音' : '麦克风'} icon={live.muted ? 'micOff' : 'mic'} tone={live.muted ? 'light' : 'glass'} onPress={live.toggleMute} ring={live.muted ? undefined : micRing} />
          <Animated.View style={{ opacity: interruptPop, transform: [{ scale: interruptPop.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }} pointerEvents={canInterrupt ? 'auto' : 'none'}>
            <RoundButton label="打断" icon="stop" onPress={live.interrupt} />
          </Animated.View>
          <RoundButton label="结束" icon="close" tone="danger" onPress={onClose} />
        </>}
      </Animated.View>
    </SafeAreaView>
    </Animated.View>
  </Animated.View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  stage: { ...StyleSheet.absoluteFill, backgroundColor: STAGE, overflow: 'hidden' },
  safe: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 6 },
  topButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  pill: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.08)', marginHorizontal: 10 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#7CC6FF' },
  pillText: { color: 'rgba(255,255,255,0.9)', fontSize: 13.5, fontWeight: '600', flexShrink: 1 },
  notice: { alignSelf: 'center', marginTop: 12, maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.1)' },
  noticeText: { color: 'rgba(255,255,255,0.85)', fontSize: 12.5, textAlign: 'center' },
  captions: { flex: 1, justifyContent: 'flex-end', paddingLeft: 26, paddingRight: 96, paddingBottom: 30, gap: 12 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 22, height: 22 },
  status: { color: 'rgba(255,255,255,0.62)', fontSize: 14, fontWeight: '500' },
  user: { color: 'rgba(255,255,255,0.58)', fontSize: 17, lineHeight: 25 },
  assistant: { color: '#FFFFFF', fontSize: 22, lineHeight: 32, fontWeight: '500', letterSpacing: -0.3, textShadowColor: 'rgba(6,9,23,0.6)', textShadowRadius: 12 },
  assistantDone: { color: 'rgba(255,255,255,0.78)' },
  hint: { color: 'rgba(255,255,255,0.45)', fontSize: 17, lineHeight: 27 },
  controls: { flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'flex-start', paddingBottom: 18, paddingHorizontal: 16 },
  buttonSlot: { alignItems: 'center', gap: 8, width: 84 },
  button: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  buttonRing: { position: 'absolute', top: 0, left: 10, width: 64, height: 64, borderRadius: 32, borderWidth: 2, borderColor: '#7CC6FF' },
  buttonLight: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(27,33,80,0.12)', shadowColor: '#1B2150', shadowOpacity: 0.1, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 3 },
  buttonLabel: { color: 'rgba(255,255,255,0.72)', fontSize: 12.5 },
  ripple: { position: 'absolute', width: 120, height: 120, borderRadius: 60, backgroundColor: '#FFFFFF' },
}));
