import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import { Icon } from '../components/Icon';
import { Dots, PHASE_TEXT, Ripple, RoundButton, useLiveEnergy, useLoop } from '../components/LiveMode';
import { MotionPressable, useReducedMotion } from '../components/MotionPressable';
import type { Character } from '../memorybox/types';
import { useVoiceConversation } from '../voice/useVoiceConversation';
import { CharacterAvatar } from './CharacterAvatar';
import { warm } from './theme';

/**
 * Live with a chat character: a bright, airy call screen built around the character's own avatar.
 * Rings ripple out while either of you talks, the avatar sways with the voice, an orbit spins while TA thinks.
 * It is deliberately a different room from the assistant's cinematic Live.
 */

let seed = 0;

function Blob({ color, size, x, y, drift, range }: { color: string; size: number; x: number; y: number; drift: Animated.Value; range: number }) {
  const id = useRef(`companionBlob${(seed += 1)}`).current;
  return <Animated.View pointerEvents="none" style={{
    position: 'absolute', left: x - size / 2, top: y - size / 2,
    transform: [
      { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [-range, range] }) },
      { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [range * 0.6, -range * 0.6] }) },
    ],
  }}>
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id={id} cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={color} stopOpacity={0.55} />
          <Stop offset="0.6" stopColor={color} stopOpacity={0.16} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
    </Svg>
  </Animated.View>;
}

/** One ring that keeps rippling outward while `active`. */
function Wave({ size, color, delay, active }: { size: number; color: string; delay: number; active: boolean }) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) { Animated.timing(value, { toValue: 0, duration: 400, useNativeDriver: true }).start(); return undefined; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: 1800, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
    ]));
    const timer = setTimeout(() => loop.start(), delay);
    return () => { clearTimeout(timer); loop.stop(); };
  }, [active, delay, value]);
  return <Animated.View pointerEvents="none" style={{
    position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 2, borderColor: color,
    opacity: value.interpolate({ inputRange: [0, 0.1, 1], outputRange: [0, 0.55, 0] }),
    transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 1.85] }) }],
  }} />;
}

export function CompanionLive({ visible, character, paused = false, onClose, onOpenSettings }: {
  visible: boolean; character: Character; paused?: boolean; onClose: () => void; onOpenSettings: () => void;
}) {
  const [mounted, setMounted] = useState(visible);
  const [session, setSession] = useState(false);
  const enter = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (visible) {
      setMounted(true);
      setSession(true);
      Animated.spring(enter, { toValue: 1, damping: 18, stiffness: 120, useNativeDriver: true }).start();
    } else if (mounted) {
      setSession(false);
      Animated.timing(enter, { toValue: 0, duration: reduced ? 0 : 260, easing: Easing.in(Easing.cubic), useNativeDriver: true }).start(() => setMounted(false));
    }
  }, [visible, enter, mounted, reduced]);
  if (!mounted) return null;
  return <Modal visible transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
    <StatusBar style="dark" />
    <Stage character={character} active={session && !paused} enter={enter} onClose={onClose} onOpenSettings={onOpenSettings} />
  </Modal>;
}

function Stage({ character, active, enter, onClose, onOpenSettings }: {
  character: Character; active: boolean; enter: Animated.Value; onClose: () => void; onOpenSettings: () => void;
}) {
  const live = useVoiceConversation(active);
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const { energy } = useLiveEnergy(live, reduced);
  const driftA = useLoop(5200, !reduced);
  const driftB = useLoop(6800, !reduced, 600);
  const breathe = useLoop(2200, !reduced);
  const orbit = useRef(new Animated.Value(0)).current;
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const color = character.color;
  const avatar = Math.min(width * 0.44, 180);
  const talking = live.phase === 'speaking' || live.phase === 'hearing';
  const thinking = live.phase === 'thinking' || live.phase === 'connecting';

  useEffect(() => {
    if (reduced || !thinking) { orbit.stopAnimation(); return undefined; }
    const loop = Animated.loop(Animated.timing(orbit, { toValue: 1, duration: 1600, easing: Easing.linear, useNativeDriver: true }));
    orbit.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [thinking, reduced, orbit]);
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
  const assistant = live.assistantText.length > 180 ? `…${live.assistantText.slice(-180)}` : live.assistantText;
  const canInterrupt = live.phase === 'speaking' || live.phase === 'thinking';
  const status = live.muted ? '已静音，点麦克风继续' : live.phase === 'speaking' ? `${character.name} 正在说…` : live.phase === 'thinking' ? `${character.name} 在想` : PHASE_TEXT[live.phase];

  return <Animated.View style={[styles.stage, { opacity: enter }]}>
    {/* Airy background tinted with the character's colour, with slow drifting light. */}
    <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id="companionLiveBg" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#F8F9FF" />
          <Stop offset="0.55" stopColor="#EEF0FF" />
          <Stop offset="1" stopColor={color} stopOpacity={0.32} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width={width} height={height} fill="url(#companionLiveBg)" />
    </Svg>
    <Blob color={color} size={width * 1.1} x={width * 0.15} y={height * 0.28} drift={driftA} range={width * 0.08} />
    <Blob color="#7CC6FF" size={width * 0.9} x={width * 0.95} y={height * 0.55} drift={driftB} range={width * 0.1} />
    <Blob color="#A68BF7" size={width * 0.8} x={width * 0.3} y={height * 0.9} drift={driftA} range={width * 0.06} />

    <Pressable accessibilityLabel="打断" style={StyleSheet.absoluteFill} onPress={tap} />
    {ripples.map((ripple) => <Ripple key={ripple.id} x={ripple.x} y={ripple.y} color={color} onDone={() => setRipples((items) => items.filter((item) => item.id !== ripple.id))} />)}

    <SafeAreaView style={styles.safe} edges={['top', 'bottom']} pointerEvents="box-none">
      <View style={styles.top} pointerEvents="box-none">
        <MotionPressable accessibilityRole="button" accessibilityLabel="收起" scaleTo={0.88} onPress={onClose} style={styles.topButton}>
          <Icon name="chevronDown" size={24} color={warm.text} />
        </MotionPressable>
        <View style={styles.pill}>
          <Animated.View style={[styles.liveDot, { backgroundColor: color, opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }]} />
          <Text style={styles.pillText} numberOfLines={1}>Live{live.engineLabel ? ` · ${live.engineLabel}` : ''}</Text>
        </View>
        <MotionPressable accessibilityRole="button" accessibilityLabel="语音设置" scaleTo={0.88} onPress={onOpenSettings} style={styles.topButton}>
          <Icon name="settings" size={21} color={warm.text} />
        </MotionPressable>
      </View>
      {live.notice ? <View style={styles.notice} pointerEvents="none"><Text style={styles.noticeText} numberOfLines={2}>{live.notice}</Text></View> : null}

      {/* The avatar: pops in, breathes while listening, sways with the voice, orbit while thinking. */}
      <View style={styles.center} pointerEvents="none">
        <View style={[styles.avatarStage, { width: avatar * 2, height: avatar * 2 }]}>
          <Animated.View style={{
            position: 'absolute', opacity: energy.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.95] }),
            transform: [{ scale: energy.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.35] }) }],
          }}>
            <Svg width={avatar * 1.9} height={avatar * 1.9}>
              <Defs>
                <RadialGradient id="companionHalo" cx="50%" cy="50%" r="50%">
                  <Stop offset="0.45" stopColor={color} stopOpacity={0.45} />
                  <Stop offset="1" stopColor={color} stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle cx={avatar * 0.95} cy={avatar * 0.95} r={avatar * 0.95} fill="url(#companionHalo)" />
            </Svg>
          </Animated.View>
          {[0, 600, 1200].map((delay) => <Wave key={delay} size={avatar} color={color} delay={delay} active={talking && !reduced} />)}
          <Animated.View style={{ position: 'absolute', width: avatar * 1.34, height: avatar * 1.34, opacity: thinking ? 1 : 0, transform: [{ rotate: orbit.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }}>
            {[0, 1, 2].map((index) => <View key={index} style={[styles.orbitDot, {
              backgroundColor: index === 0 ? color : index === 1 ? '#7CC6FF' : '#A68BF7', width: 10 - index * 2, height: 10 - index * 2,
              left: avatar * 0.67 + Math.cos((index * 2.1)) * avatar * 0.62 - 5, top: avatar * 0.67 + Math.sin((index * 2.1)) * avatar * 0.62 - 5,
            }]} />)}
          </Animated.View>
          <Animated.View style={{
            transform: [
              { scale: Animated.multiply(
                enter.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
                Animated.add(energy.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1.08] }), breathe.interpolate({ inputRange: [0, 1], outputRange: [0, 0.02] })),
              ) },
              { rotate: energy.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['0deg', '-2deg', '2deg'] }) },
            ],
          }}>
            <View style={[styles.avatarShadow, { borderRadius: avatar / 2, shadowColor: color }]}>
              <CharacterAvatar character={character} size={avatar} ring />
            </View>
          </Animated.View>
        </View>
        <Text style={styles.name}>{character.name}</Text>
        <View style={styles.statusRow}>
          <Text style={styles.status}>{status}</Text>
          {(live.phase === 'thinking' || live.phase === 'connecting') && !live.muted ? <Dots color={warm.muted} /> : null}
        </View>
      </View>

      <Animated.View style={[styles.captions, { opacity: enter.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 0, 1] }) }]} pointerEvents="none">
        {live.phase === 'error' ? <Text style={styles.assistant}>{live.error}</Text> : <>
          {live.userText ? <Text style={styles.user} numberOfLines={2}>{live.userText}</Text> : null}
          {assistant ? <Text style={[styles.assistant, live.phase !== 'speaking' && styles.assistantDone]} numberOfLines={5}>{assistant}</Text> : null}
          {!live.userText && !assistant && live.phase === 'listening' ? <Text style={styles.hint}>直接开口，像打电话一样和 {character.name} 聊天</Text> : null}
        </>}
      </Animated.View>

      <Animated.View style={[styles.controls, { transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) }] }]} pointerEvents="box-none">
        {live.phase === 'error' ? <>
          <RoundButton theme="light" label="重试" icon="regenerate" tone="light" onPress={live.retry} />
          <RoundButton theme="light" label="语音设置" icon="settings" onPress={onOpenSettings} />
          <RoundButton theme="light" label="挂断" icon="close" tone="danger" onPress={onClose} />
        </> : <>
          <RoundButton theme="light" accent={color} label={live.muted ? '已静音' : '麦克风'} icon={live.muted ? 'micOff' : 'mic'} tone={live.muted ? 'light' : 'glass'} onPress={live.toggleMute} ring={live.muted ? undefined : live.micLevel} />
          <View style={{ opacity: canInterrupt ? 1 : 0.35 }} pointerEvents={canInterrupt ? 'auto' : 'none'}>
            <RoundButton theme="light" label="打断" icon="stop" onPress={live.interrupt} />
          </View>
          <RoundButton theme="light" label="挂断" icon="close" tone="danger" onPress={onClose} />
        </>}
      </Animated.View>
    </SafeAreaView>
  </Animated.View>;
}

const styles = StyleSheet.create({
  stage: { ...StyleSheet.absoluteFill, backgroundColor: '#F5F7FF', overflow: 'hidden' },
  safe: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 6 },
  topButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.7)' },
  pill: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.7)', marginHorizontal: 10 },
  liveDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { color: warm.textSecondary, fontSize: 13.5, fontWeight: '600', flexShrink: 1 },
  notice: { alignSelf: 'center', marginTop: 12, maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.85)' },
  noticeText: { color: warm.textSecondary, fontSize: 12.5, textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  avatarStage: { alignItems: 'center', justifyContent: 'center' },
  avatarShadow: { backgroundColor: '#FFFFFF', shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 12 },
  orbitDot: { position: 'absolute', borderRadius: 6 },
  name: { color: warm.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.4, marginTop: -8 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  status: { color: warm.muted, fontSize: 14.5, fontWeight: '500' },
  captions: { minHeight: 120, justifyContent: 'flex-end', paddingHorizontal: 30, paddingBottom: 22, gap: 10, alignItems: 'center' },
  user: { color: warm.muted, fontSize: 15.5, lineHeight: 22, textAlign: 'center' },
  assistant: { color: warm.text, fontSize: 21, lineHeight: 31, fontWeight: '500', textAlign: 'center', letterSpacing: -0.2 },
  assistantDone: { color: warm.textSecondary },
  hint: { color: warm.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  controls: { flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'flex-start', paddingBottom: 18, paddingHorizontal: 16 },
});
