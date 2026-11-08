import React, { useEffect, useRef } from 'react';
import { Animated, AppState, Easing, Image, Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
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
 * Composer chip for thinking effort. Tap advances one reported level; press
 * and hold, then slide left/right, for direct selection. Release commits once.
 */
export function EffortScrubChip({ levels, value, disabled = false, scopeKey = '', onScrub, appearance='default', onOpen, accessibilityLabel }: {
  levels: readonly ScrubLevel[]; value: ScrubLevel; disabled?: boolean; scopeKey?: string;
  onScrub: (event: ScrubEvent) => void;
  appearance?:'default'|'composer'; onOpen?:()=>void; accessibilityLabel?:string;
}) {
  const dk = useDesk();
  const styles = useStyles();
  // Keep the existing lightweight hint, without requiring a hidden gesture.
  const hint = useRef(new Animated.Value(0)).current;
  const showHint = () => {
    Animated.sequence([
      Animated.timing(hint, { toValue: 1, duration: 160, useNativeDriver: true }),
      Animated.delay(1600),
      Animated.timing(hint, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
  };
  const state = useRef({ active: false, touchValid: false, suppressPress: false, x: 0, start: 0, index: 0, epoch: 0 });
  // A gesture belongs to one exact model/catalog/credential context. A late
  // release after an API switch must not choose a level for the new owner.
  const signature = JSON.stringify([scopeKey, levels, value, disabled]);
  const owner = useRef({ signature, epoch: 0 });
  if (owner.current.signature !== signature) owner.current = { signature, epoch: owner.current.epoch + 1 };
  const epoch = owner.current.epoch;
  const props = useRef({ levels, value, onScrub }); props.current = { levels, value, onScrub };
  const foreground = () => AppState.currentState !== 'background' && AppState.currentState !== 'inactive';
  const finish = (phase: 'end' | 'cancel') => {
    const s = state.current;
    if (phase === 'cancel' && (s.touchValid || s.active)) s.suppressPress = true;
    s.touchValid = false;
    if (!s.active) return;
    s.active = false;
    props.current.onScrub({ phase: phase === 'end' && s.epoch === owner.current.epoch && foreground() ? 'end' : 'cancel', index: s.index });
  };
  useEffect(() => { finish('cancel'); }, [epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const subscription = AppState.addEventListener('change', next => { if (next !== 'active') finish('cancel'); });
    return () => { subscription.remove(); finish('cancel'); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const index = Math.max(0, levels.indexOf(value));
  const arm = (event: TouchLike) => {
    if (epoch !== owner.current.epoch) return;
    if (state.current.active && state.current.epoch === epoch) return;
    finish('cancel');
    if (disabled || !levels.length || !foreground()) return;
    const x = touchX(event);
    if (x !== undefined && Number.isFinite(x)) { state.current.x = x; state.current.touchValid = true; state.current.suppressPress = false; state.current.epoch = epoch; }
  };
  const begin = () => {
    if (disabled || epoch !== owner.current.epoch || state.current.active || !state.current.touchValid || !foreground()) return;
    const s = state.current; s.active = true; s.suppressPress = true; s.start = Math.max(0, props.current.levels.indexOf(props.current.value)); s.index = s.start;
    props.current.onScrub({ phase: 'start', index: s.index }); hapticEffort(props.current.levels[s.index]);
  };
  const step = (direction: number, wrap = false) => {
    if (disabled || epoch !== owner.current.epoch || !foreground() || !levels.length) return;
    const next = wrap ? (index + 1) % levels.length : Math.max(0, Math.min(levels.length - 1, index + direction));
    if (next !== index) {
      onScrub({ phase: 'start', index }); onScrub({ phase: 'end', index: next }); hapticEffort(levels[next]);
    }
  };
  // Raw touch events keep flowing to this wrapper while the Pressable holds the gesture.
  return <View testID="remote-effort-touch" onTouchStart={event => arm(event as unknown as TouchLike)}
    onTouchMove={(event) => {
      if (epoch !== owner.current.epoch) return;
      const s = state.current; const x = touchX(event as unknown as TouchLike); if (!s.active || x === undefined || !Number.isFinite(x)) return;
      if (s.epoch !== owner.current.epoch || !foreground()) { finish('cancel'); return; }
      const last = props.current.levels.length - 1;
      const next = Math.max(0, Math.min(last, s.start + Math.round((x - s.x) / SCRUB_STEP)));
      if (next !== s.index) { s.index = next; props.current.onScrub({ phase: 'move', index: next }); hapticEffort(props.current.levels[next]); }
    }}
    onTouchEnd={() => { if (epoch === owner.current.epoch) finish('end'); }} onTouchCancel={() => { if (epoch === owner.current.epoch) finish('cancel'); }}>
    <Pressable testID="remote-effort-chip" accessibilityRole="button" accessibilityLabel={accessibilityLabel??effortLabel(value)} accessibilityHint={onOpen?'选择推理强度，或长按左右滑动':'轻点切换，长按后左右滑动调节思考程度'}
      accessibilityState={{ disabled }} disabled={disabled} onPressIn={event => arm(event as unknown as TouchLike)} onPress={() => { if (!disabled && epoch === owner.current.epoch && foreground() && !state.current.suppressPress) { if(onOpen)onOpen();else{step(1, true); showHint();} } }} onLongPress={() => { hint.setValue(0); begin(); }} delayLongPress={SCRUB_HOLD_MS}
      pressRetentionOffset={{ top: 400, bottom: 400, left: 400, right: 400 }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        if (disabled || epoch !== owner.current.epoch || !foreground() || !['increment', 'decrement'].includes(event.nativeEvent.actionName)) return;
        step(event.nativeEvent.actionName === 'increment' ? 1 : -1);
      }}
      style={({ pressed }) => [styles.chip,appearance==='composer'&&styles.composerChip, disabled && { opacity: 0.5 }, pressed && { transform: [{ scale: 0.94 }] }]}>
      {appearance==='default'?<Icon name="lightbulb" size={13} color={value ? inkFor(value) : dk.muted} />:null}
      <Text style={[styles.chipText,appearance==='composer'?styles.composerChipText:value?{color:inkFor(value)}:null]} numberOfLines={1}>{appearance==='composer'&&!value?'默认':effortLabel(value)}</Text>
      {appearance==='composer'?<Icon name="chevronDown" size={12} color={colors.textMuted}/>:null}
    </Pressable>
    {appearance==='default'?<Animated.View pointerEvents="none" style={[styles.tip, { opacity: hint, transform: [{ translateY: hint.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }] }]}>
      <Text style={styles.tipText}>轻点切换 · 长按滑动</Text>
    </Animated.View>:null}
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
  const ink = colors.text;
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
  composerChip:{height:32,paddingHorizontal:5,borderRadius:8,backgroundColor:'transparent',gap:4,maxWidth:88},composerChipText:{color:c.textMuted,fontSize:12,fontWeight:'400'},
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
