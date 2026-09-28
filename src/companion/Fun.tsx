import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Easing, Modal, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { Icon, type IconName } from '../components/Icon';
import { MotionPressable, useReducedMotion } from '../components/MotionPressable';
import { REACTIONS } from './reactions';
import { warm } from './theme';

/** Small moments of delight for the chat space: ambient light, emoji rain, the long-press reaction menu. */

let seed = 0;

function Glow({ color, size, opacity }: { color: string; size: number; opacity: number }) {
  const id = useRef(`funGlow${(seed += 1)}`).current;
  return <Svg width={size} height={size}>
    <Defs>
      <RadialGradient id={id} cx="50%" cy="50%" r="50%">
        <Stop offset="0" stopColor={color} stopOpacity={opacity} />
        <Stop offset="1" stopColor={color} stopOpacity={0} />
      </RadialGradient>
    </Defs>
    <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
  </Svg>;
}

/** Two soft lights drifting slowly behind the thread, tinted by the character. Rests while covered (`paused`) or in the background. */
export function AmbientLight({ color, paused = false }: { color: string; paused?: boolean }) {
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const drift = useRef(new Animated.Value(0)).current;
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    if (reduced || paused || !foreground) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(drift, { toValue: 1, duration: 9000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(drift, { toValue: 0, duration: 9000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [drift, reduced, paused, foreground]);
  const size = width * 1.1;
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <Animated.View style={{ position: 'absolute', left: -size * 0.45, top: height * 0.08, transform: [{ translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [0, width * 0.12] }) }, { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, height * 0.06] }) }] }}>
      <Glow color={color} size={size} opacity={0.16} />
    </Animated.View>
    <Animated.View style={{ position: 'absolute', right: -size * 0.5, top: height * 0.45, transform: [{ translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [0, -width * 0.1] }) }, { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, -height * 0.05] }) }] }}>
      <Glow color="#7CC6FF" size={size} opacity={0.14} />
    </Animated.View>
  </View>;
}

/** Emoji falling across the screen for special words (生日快乐, 晚安, 爱你…). */
export function EmojiRain({ emoji, onDone }: { emoji: string[]; onDone: () => void }) {
  const { width, height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const drops = useMemo(() => {
    let state = Math.floor(Math.random() * 1e9);
    const random = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
    return Array.from({ length: 26 }, (_, index) => ({
      key: index, emoji: emoji[index % emoji.length], x: random() * (width - 30), size: 20 + random() * 18,
      start: random() * 0.45, speed: 0.5 + random() * 0.35, sway: (random() - 0.5) * 60, spin: (random() - 0.5) * 240,
    }));
  }, [emoji, width]);
  // Parents pass a fresh onDone each render: read it from a ref so a re-render doesn't restart the rain.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const animation = Animated.timing(progress, { toValue: 1, duration: 3200, easing: Easing.linear, useNativeDriver: true });
    animation.start(({ finished }) => { if (finished) done.current(); });
    return () => animation.stop();
  }, [progress]);
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    {drops.map((drop) => {
      const end = Math.min(1, drop.start + drop.speed);
      return <Animated.Text key={drop.key} style={{
        position: 'absolute', left: drop.x, top: -40, fontSize: drop.size,
        opacity: progress.interpolate({ inputRange: [0, drop.start, drop.start + 0.04, end - 0.08, end, 1], outputRange: [0, 0, 1, 1, 0, 0], extrapolate: 'clamp' }),
        transform: [
          { translateY: progress.interpolate({ inputRange: [0, drop.start, end, 1], outputRange: [0, 0, height + 60, height + 60], extrapolate: 'clamp' }) },
          { translateX: progress.interpolate({ inputRange: [drop.start, (drop.start + end) / 2, end], outputRange: [0, drop.sway, 0], extrapolate: 'clamp' }) },
          { rotate: progress.interpolate({ inputRange: [drop.start, end], outputRange: ['0deg', `${drop.spin}deg`], extrapolate: 'clamp' }) },
        ],
      }}>{drop.emoji}</Animated.Text>;
    })}
  </View>;
}

export type MenuAction = { icon: IconName; label: string; onPress: () => void; danger?: boolean };

/**
 * Long-press menu: a row of reactions springs out near your finger, with the actions under it.
 */
export function MessageMenu({ visible, y, current, actions, onReact, onClose }: {
  visible: boolean; y: number; current: string | undefined; actions: MenuAction[]; onReact: (emoji: string | null) => void; onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const progress = useRef(new Animated.Value(0)).current;
  const pops = useRef(REACTIONS.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (!visible) return;
    progress.setValue(0);
    pops.forEach((pop) => pop.setValue(0));
    Animated.spring(progress, { toValue: 1, damping: 18, stiffness: 260, useNativeDriver: true }).start();
    Animated.stagger(35, pops.map((pop) => Animated.spring(pop, { toValue: 1, damping: 9, stiffness: 280, useNativeDriver: true }))).start();
  }, [visible, progress, pops]);
  const menuHeight = 64 + actions.length * 50 + 16;
  const top = Math.max(60, Math.min(height - menuHeight - 40, y - 90));
  return <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
    <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]} />
    <Pressable accessibilityLabel="关闭" style={StyleSheet.absoluteFill} onPress={onClose} />
    <Animated.View style={[styles.menu, { top, opacity: progress, transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }]}>
      <View style={styles.reactions}>
        {REACTIONS.map((emoji, index) => <Animated.View key={emoji} style={{ transform: [{ scale: pops[index] }, { translateY: pops[index].interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }}>
          <MotionPressable scaleTo={0.8} accessibilityRole="button" accessibilityLabel={`回应 ${emoji}`} onPress={() => onReact(current === emoji ? null : emoji)}
            style={[styles.reaction, current === emoji && styles.reactionOn]}>
            <Text style={styles.reactionText}>{emoji}</Text>
          </MotionPressable>
        </Animated.View>)}
      </View>
      <View style={styles.actions}>
        {actions.map((action, index) => <Pressable key={action.label} accessibilityRole="button" onPress={action.onPress}
          style={({ pressed }) => [styles.action, index > 0 && styles.actionDivider, pressed && { backgroundColor: warm.surface }]}>
          <Text style={[styles.actionText, action.danger && { color: '#E5484D' }]}>{action.label}</Text>
          <Icon name={action.icon} size={19} color={action.danger ? '#E5484D' : warm.textSecondary} />
        </Pressable>)}
      </View>
    </Animated.View>
  </Modal>;
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(27,33,80,0.18)' },
  menu: { position: 'absolute', left: 24, right: 24, gap: 10 },
  reactions: {
    alignSelf: 'center', flexDirection: 'row', gap: 4, padding: 6, borderRadius: 30, backgroundColor: '#FFFFFF',
    shadowColor: '#2B2F7A', shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 10,
  },
  reaction: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  reactionOn: { backgroundColor: warm.accentSoft },
  reactionText: { fontSize: 27 },
  actions: {
    alignSelf: 'center', width: 240, borderRadius: 20, overflow: 'hidden', backgroundColor: '#FFFFFF',
    shadowColor: '#2B2F7A', shadowOpacity: 0.16, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 10,
  },
  action: { height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  actionDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: warm.border },
  actionText: { color: warm.text, fontSize: 15.5 },
});
