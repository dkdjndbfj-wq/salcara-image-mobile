import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Icon } from '../components/Icon';
import { colors, desk, themed, useDesk } from '../theme';
import { effortLabel, type Effort } from './effort';
import { hapticEffort } from './haptics';
import { EFFORT_FIELDS } from './ModelPopover';

/** Horizontal distance (px) that moves the selection by one level. */
export const SCRUB_STEP = 34;
/** Press-and-hold time before horizontal scrubbing starts. */
export const SCRUB_HOLD_MS = 260;

export type ScrubLevel = Effort | '';
export type ScrubEvent = { phase: 'start' | 'move' | 'end' | 'cancel'; index: number };

type TouchLike = { nativeEvent: { pageX?: number; touches?: ArrayLike<{ pageX: number }>; changedTouches?: ArrayLike<{ pageX: number }> } };
const touchX = (event: TouchLike) => event.nativeEvent.pageX ?? event.nativeEvent.touches?.[0]?.pageX ?? event.nativeEvent.changedTouches?.[0]?.pageX;
const inkFor = (level: ScrubLevel) => EFFORT_FIELDS.find(field => field.id === level)?.ink ?? desk.muted;

/**
 * Composer chip for thinking effort. Tap keeps the accessible list; press and
 * hold, then slide left/right, to scrub through levels. Release commits.
 */
export function EffortScrubChip({ levels, value, disabled = false, onScrub }: {
  levels: readonly ScrubLevel[]; value: ScrubLevel; disabled?: boolean;
  onScrub: (event: ScrubEvent) => void;
}) {
  const dk = useDesk();
  const styles = useStyles();
  // A plain tap only explains the gesture; there is no separate list to pick from.
  const hint = useRef(new Animated.Value(0)).current;
  const showHint = () => {
    Animated.sequence([
      Animated.timing(hint, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.delay(1600),
      Animated.timing(hint, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
  };
  const state = useRef({ active: false, x: 0, start: 0, index: 0 });
  const props = useRef({ levels, value, onScrub }); props.current = { levels, value, onScrub };
  useEffect(() => () => { if (state.current.active) props.current.onScrub({ phase: 'cancel', index: state.current.index }); }, []);
  const index = Math.max(0, levels.indexOf(value));
  const begin = () => {
    if (disabled) return;
    const s = state.current; s.active = true; s.start = Math.max(0, props.current.levels.indexOf(props.current.value)); s.index = s.start;
    props.current.onScrub({ phase: 'start', index: s.index }); hapticEffort(props.current.levels[s.index] || 'low');
  };
  const finish = (phase: 'end' | 'cancel') => { const s = state.current; if (!s.active) return; s.active = false; props.current.onScrub({ phase, index: s.index }); };
  // Raw touch events keep flowing to this wrapper while the Pressable holds the gesture.
  return <View onTouchStart={(event) => { const x = touchX(event as unknown as TouchLike); if (x !== undefined) state.current.x = x; }}
    onTouchMove={(event) => {
      const s = state.current; const x = touchX(event as unknown as TouchLike); if (!s.active || x === undefined || !Number.isFinite(x)) return;
      const last = props.current.levels.length - 1;
      const next = Math.max(0, Math.min(last, s.start + Math.round((x - s.x) / SCRUB_STEP)));
      if (next !== s.index) { s.index = next; props.current.onScrub({ phase: 'move', index: next }); hapticEffort(props.current.levels[next] || 'low'); }
    }}
    onTouchEnd={() => finish('end')} onTouchCancel={() => finish('cancel')}>
    <Pressable testID="remote-effort-chip" accessibilityRole="button" accessibilityLabel={effortLabel(value)} accessibilityHint="长按后左右滑动调节思考程度"
      accessibilityState={{ disabled }} disabled={disabled} onPress={showHint} onLongPress={() => { hint.setValue(0); begin(); }} delayLongPress={SCRUB_HOLD_MS}
      pressRetentionOffset={{ top: 400, bottom: 400, left: 400, right: 400 }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (disabled) return;
        const next = Math.max(0, Math.min(levels.length - 1, index + (event.nativeEvent.actionName === 'increment' ? 1 : -1)));
        if (next !== index) { onScrub({ phase: 'start', index }); onScrub({ phase: 'end', index: next }); }
      }}
      style={({ pressed }) => [styles.chip, disabled && { opacity: 0.5 }, pressed && { transform: [{ scale: 0.94 }] }]}>
      <Icon name="lightbulb" size={13} color={value ? inkFor(value) : dk.muted} />
      <Text style={[styles.chipText, value ? { color: inkFor(value) } : null]} numberOfLines={1}>{effortLabel(value)}</Text>
    </Pressable>
    <Animated.View pointerEvents="none" style={[styles.tip, { opacity: hint, transform: [{ translateY: hint.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }]}>
      <Text style={styles.tipText}>按住，左右滑动调整</Text>
    </Animated.View>
  </View>;
}

/**
 * Frosted layer covering only the composer while scrubbing. The rest of the
 * conversation stays sharp. `texture` is an in-memory capture of the composer.
 */
export function EffortScrubOverlay({ levels, index, texture, reduced }: { levels: readonly ScrubLevel[]; index: number; texture?: string; reduced: boolean }) {
  const dk = useDesk();
  const styles = useStyles();
  const shift = useRef(new Animated.Value(index)).current;
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(appear, { toValue: 1, duration: reduced ? 0 : 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(); }, [appear, reduced]);
  useEffect(() => {
    if (reduced) shift.setValue(index);
    else Animated.spring(shift, { toValue: index, damping: 18, stiffness: 260, mass: 0.7, useNativeDriver: true }).start();
  }, [index, reduced, shift]);
  const level = levels[index] ?? '';
  const ink = inkFor(level);
  return <Animated.View testID="remote-effort-scrub" pointerEvents="none" style={[StyleSheet.absoluteFill, styles.overlay, { opacity: appear }]}>
    {texture ? <Image accessible={false} source={{ uri: texture }} blurRadius={20} resizeMode="stretch" style={StyleSheet.absoluteFill} /> : null}
    {Platform.OS === 'web' ? <View style={[StyleSheet.absoluteFill, { backdropFilter: 'blur(8px)' } as ViewStyle]} /> : null}
    <View style={[StyleSheet.absoluteFill, styles.tint]} />
    <Text style={styles.hint}>左右滑动调节思考 · 松手确认</Text>
    <View style={styles.rail}>
      <Animated.View style={[styles.track, { transform: [{ translateX: shift.interpolate({ inputRange: [0, Math.max(1, levels.length - 1)], outputRange: [0, -SLOT * Math.max(1, levels.length - 1)] }) }] }]}>
        {levels.map((item, i) => {
          const distance = shift.interpolate({ inputRange: [i - 2, i - 1, i, i + 1, i + 2], outputRange: [2, 1, 0, 1, 2], extrapolate: 'clamp' });
          return <Animated.View key={item || 'default'} style={[styles.slot, {
            opacity: distance.interpolate({ inputRange: [0, 1, 2], outputRange: [1, 0.42, 0.14] }),
            transform: [{ scale: distance.interpolate({ inputRange: [0, 1, 2], outputRange: [1, 0.78, 0.66] }) }],
          }]}><Text numberOfLines={1} style={[styles.label, { color: i === index ? ink : dk.muted }]}>{effortLabel(item)}</Text></Animated.View>;
        })}
      </Animated.View>
    </View>
    <View style={styles.dots}>{levels.map((item, i) => <View key={item || 'default'} style={[styles.dot, i <= index && i > 0 && { backgroundColor: ink }, i === index && styles.dotOn, i === index && { backgroundColor: ink }]} />)}</View>
  </Animated.View>;
}

const SLOT = 92;
const useStyles = themed((c, d) => StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 9, borderRadius: 14, backgroundColor: d.surface3, maxWidth: 150 },
  chipText: { color: d.text2, fontSize: 12, fontWeight: '500', flexShrink: 1 },
  tip: { position: 'absolute', bottom: 34, left: -14, width: 150, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, backgroundColor: 'rgba(17,26,51,0.88)' },
  tipText: { color: d.onInk, fontSize: 11.5, textAlign: 'center' },
  overlay: { borderRadius: 22, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', zIndex: 5 },
  tint: { backgroundColor: 'rgba(255,255,255,0.42)' },
  hint: { position: 'absolute', top: 10, fontSize: 10.5, letterSpacing: 0.4, color: d.muted },
  rail: { width: SLOT, height: 34, overflow: 'visible', alignItems: 'flex-start', justifyContent: 'center' },
  track: { flexDirection: 'row', alignItems: 'center' },
  slot: { width: SLOT, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 20, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2 },
  dots: { position: 'absolute', bottom: 12, flexDirection: 'row', gap: 4, alignItems: 'center' },
  dot: { width: 8, height: 3, borderRadius: 2, backgroundColor: d.line }, dotOn: { width: 16 },
}));
