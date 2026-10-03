import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, AppState, Easing, Image, Modal, PanResponder, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { Icon } from '../components/Icon';
import { useReducedMotion } from '../components/ui';
import { colors, desk, themed, useDesk } from '../theme';
import { effortLabel, reportedEfforts, type Effort } from './effort';
import type { ModelCapability } from './client';
import { buildModelPresentation } from './model-presentation';
import { hapticEffort, hapticModelCommit, hapticModelTick } from './haptics';
import { clampOrbitCenter, orbitCenterAfterSwipe, orbitNodes, snapOrbitCenter } from './model-orbit';

/** Decorative provider mark only; it never parses or submits IDs. */
const FAMILIES = [
  { color: '#10A37F', letter: 'G', test: /^(gpt|o\d|codex|chatgpt)/i },
  { color: '#D97757', letter: 'C', test: /^claude/i },
  { color: '#111827', letter: 'X', test: /^grok/i },
  { color: '#4285F4', letter: 'G', test: /^(gemini|gemma)/i },
  { color: '#4D6BFE', letter: 'D', test: /^deepseek/i },
  { color: '#615CED', letter: 'Q', test: /^(qwen|qwq)/i },
  { color: '#3859FF', letter: 'Z', test: /^glm/i },
  { color: '#16191E', letter: 'K', test: /^(kimi|moonshot)/i },
];
export function ModelDot({ model, size = 18 }: { model: string; size?: number }) {
  const styles = useStyles();
  const name = model.split('/').pop() ?? model;
  const family = FAMILIES.find((item) => item.test.test(name));
  return <View style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: family?.color ?? '#8A93A9' }]}>
    <Text style={[styles.dotText, { fontSize: size * 0.5 }]}>{family?.letter ?? (name[0] ?? '?').toUpperCase()}</Text>
  </View>;
}
export interface PopoverAnchor { x: number; y: number }
export const MODEL_HOLD_STEP_MS = 850;
export const ORBIT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
/**
 * One hue per thinking level, never a blend of two brand colours. Higher levels
 * are deeper, glow wider and pulse more often from the core; Low stays still.
 */
export const EFFORT_FIELDS = [
  { id: 'low', hue: '#8CC8FF', ink: '#3A7FD6', wash: '#F6FAFF', glow: 0.34, rings: 0, period: 0 },
  { id: 'medium', hue: '#5C93FF', ink: '#2F66E0', wash: '#F1F5FF', glow: 0.42, rings: 1, period: 3400 },
  { id: 'high', hue: '#5B6BFA', ink: '#3F4BD8', wash: '#EFF0FF', glow: 0.52, rings: 2, period: 2600 },
  { id: 'xhigh', hue: '#6E58F0', ink: '#4F37CF', wash: '#F1EEFF', glow: 0.7, rings: 3, period: 2000 },
  { id: 'max', hue: '#7B4FE6', ink: '#5A2FC6', wash: '#F3EDFE', glow: 0.7, rings: 4, period: 1650 },
  { id: 'ultra', hue: '#8747DC', ink: '#6526BA', wash: '#F4ECFD', glow: 0.78, rings: 5, period: 1350 },
] as const;
/** Angular spacing of model labels on the orbit, in degrees. */
const ORBIT_STEP = 44;

/** Rings that leave the core and fade; count and tempo rise with the level. */
function EffortPulse({ rings, period, hue, size, reduced }: { rings: number; period: number; hue: string; size: number; reduced: boolean }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    pulse.setValue(0);
    if (!rings || reduced) return undefined;
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: period, easing: Easing.linear, useNativeDriver: true }));
    loop.start(); return () => loop.stop();
  }, [rings, period, reduced, pulse]);
  if (!rings) return null;
  return <>{Array.from({ length: rings }, (_, index) => {
    const phase = reduced ? Animated.add(pulse, (index + 1) / (rings + 1)) : Animated.modulo(Animated.add(pulse, index / rings), 1);
    return <Animated.View key={index} pointerEvents="none" style={{
      position: 'absolute', width: size, height: size, borderRadius: size / 2, borderWidth: 1 + rings * 0.25, borderColor: hue,
      opacity: phase.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.5, 0], extrapolate: 'clamp' }),
      transform: [{ scale: phase.interpolate({ inputRange: [0, 1], outputRange: [0.18, 1], extrapolate: 'clamp' }) }],
    }} />;
  })}</>;
}
type Preview = { id: string; effort?: Effort };
type Hold = Preview & { step: number; cancelled: boolean };

/** Browsing/holding are local previews; only a valid press release commits. */
export function ModelPopover({ visible, value, fallback, models, loading, onRefresh, onSelect, onClose, apiName, onApi, catalogOnly, catalogReady = true, error,
  effort = '', effortLevels = [], modelCapabilities, selectionEnabled = true, backgroundUri, scopeKey = '', onFollowComputer, apiHeader, interactionBlocked = false }: {
  visible: boolean; anchor: PopoverAnchor | null; value: string; fallback: string; models: string[]; loading: boolean;
  onRefresh: () => void; onSelect: (model: string, effort?: Effort) => void; onClose: () => void;
  apiName?: string; onApi?: () => void; catalogOnly?: boolean; catalogReady?: boolean; error?: string;
  effort?: Effort | ''; effortLevels?: readonly Effort[]; selectionEnabled?: boolean; backgroundUri?: string; scopeKey?: string;
  modelCapabilities?: Record<string, ModelCapability>;
  onFollowComputer?: () => void;
  apiHeader?: ReactNode; interactionBlocked?: boolean;
}) {
  const dk = useDesk();
  const styles = useStyles();
  const { width, height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const current = value || fallback;
  const presentation = useMemo(() => buildModelPresentation(models), [models]);
  // Only the API catalog establishes a shared family. A saved/outside ID cannot
  // reclassify it or authorize a retired model in a managed catalog.
  const list = useMemo(() => catalogOnly ? catalogReady ? presentation.items : []
    : current && !presentation.items.some((item) => item.id === current) ? [{ id: current, label: current }, ...presentation.items] : presentation.items,
  [catalogOnly, catalogReady, current, presentation]);
  const signature = JSON.stringify(list);
  const levelsFor = (id: string) => {
    const reported = modelCapabilities ? reportedEfforts(modelCapabilities[id]) : effortLevels;
    const levels = ORBIT_EFFORTS.filter(level => reported.includes(level));
    // A model without a reported Low starts by following its interface default.
    return levels[0] === 'low' ? levels : [];
  };
  const levelSignature = JSON.stringify(modelCapabilities ?? effortLevels);
  const canSelect = selectionEnabled && !interactionBlocked;
  const [center, setCenter] = useState(0);
  const centerRef = useRef(center); centerRef.current = center;
  const [preview, setPreview] = useState<Preview | null>(null);
  const hold = useRef<Hold | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const active = useRef(visible);
  const lifecycle = useRef({ visible, scopeKey, signature, loading, selectionEnabled: canSelect, levels: levelSignature, epoch: 0 });
  const previous = lifecycle.current;
  if (previous.visible !== visible || previous.scopeKey !== scopeKey || previous.signature !== signature || previous.loading !== loading
    || previous.selectionEnabled !== canSelect || previous.levels !== levelSignature) {
    lifecycle.current = { visible, scopeKey, signature, loading, selectionEnabled: canSelect, levels: levelSignature, epoch: previous.epoch + 1 };
    if (!visible) active.current = false;
    else if (!previous.visible) active.current = true;
  }
  const epoch = lifecycle.current.epoch;
  const swipeStart = useRef(0);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const committed = useRef(false);
  const clearTimer = () => { if (timer.current !== undefined) clearTimeout(timer.current); timer.current = undefined; };
  const cancel = () => { clearTimer(); if (hold.current) hold.current.cancelled = true; setPreview(null); };
  const finish = () => { cancel(); active.current = false; onClose(); };
  const runtime = useRef({ list, levelsFor, visible, selectionEnabled: canSelect, loading, onSelect, epoch });
  runtime.current = { list, levelsFor, visible, selectionEnabled: canSelect, loading, onSelect, epoch };

  useEffect(() => {
    // Keep the cancelled press tombstone until a new physical/accessibility
    // activation starts; a stale touch release must not become a fresh choice.
    cancel(); committed.current = false;
    const index = list.findIndex((item) => item.id === current);
    const next = index >= 0 ? index : clampOrbitCenter(centerRef.current, list.length);
    centerRef.current = next; setCenter(next);
  }, [epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    mounted.current = true;
    const listener = AppState.addEventListener('change', (state) => { if (state !== 'active') cancel(); });
    return () => { listener.remove(); mounted.current = false; clearTimer(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const begin = (id: string) => {
    cancel(); committed.current = false;
    if (!active.current || !canSelect || loading || epoch !== runtime.current.epoch || AppState.currentState === 'background' || AppState.currentState === 'inactive') return;
    const availableLevels = runtime.current.levelsFor(id);
    const next: Hold = { id, step: 0, effort: availableLevels[0], cancelled: false };
    hold.current = next; setPreview({ id, effort: next.effort });
    if (next.effort) hapticEffort(next.effort); else hapticModelTick();
    const tick = () => {
      if (!mounted.current || !active.current || hold.current !== next || next.cancelled || epoch !== runtime.current.epoch) return;
      const currentLevels = runtime.current.levelsFor(id);
      if (next.step >= currentLevels.length - 1) return;
      next.step += 1; next.effort = currentLevels[next.step];
      setPreview({ id, effort: next.effort }); hapticEffort(next.effort);
      if (next.step < currentLevels.length - 1) timer.current = setTimeout(tick, MODEL_HOLD_STEP_MS);
    };
    if (availableLevels.length > 1) timer.current = setTimeout(tick, MODEL_HOLD_STEP_MS);
  };
  const select = (id: string) => {
    clearTimer();
    const state = runtime.current;
    if (!active.current || !state.visible || !state.selectionEnabled || state.loading || epoch !== state.epoch || committed.current || AppState.currentState === 'background' || AppState.currentState === 'inactive' || !state.list.some((item) => item.id === id)) return;
    const pressed = hold.current;
    if (pressed?.cancelled || (pressed && pressed.id !== id)) return;
    const strength = pressed?.effort ?? state.levelsFor(id)[0];
    committed.current = true; active.current = false; setPreview(null); hapticModelCommit();
    // Labels never become commands or saved preference IDs.
    if (strength) state.onSelect(id, strength); else state.onSelect(id);
  };
  const browse = (next: number) => {
    const count = runtime.current.list.length;
    if (count && snapOrbitCenter(next, count) !== snapOrbitCenter(centerRef.current, count)) hapticModelTick();
    centerRef.current = next; setCenter(next);
  };
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_, gesture) => Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderGrant: () => { cancel(); swipeStart.current = centerRef.current; },
    onPanResponderMove: (_, gesture) => browse(orbitCenterAfterSwipe(swipeStart.current, gesture.dx, width, runtime.current.list.length)),
    onPanResponderRelease: () => { cancel(); browse(snapOrbitCenter(centerRef.current, runtime.current.list.length)); },
    onPanResponderTerminate: () => { cancel(); browse(snapOrbitCenter(centerRef.current, runtime.current.list.length)); },
  }), [width]); // eslint-disable-line react-hooks/exhaustive-deps

  const fanHeight = Math.min(340, Math.max(220, height * 0.46));
  const nodes = orbitNodes({ width, height: fanHeight, center, count: list.length });
  const focused = list[snapOrbitCenter(center, list.length)];
  const displayed = preview ? list.find((item) => item.id === preview.id) : focused;
  const availableLevels = levelsFor(displayed?.id ?? '');
  // Low is the initial candidate, not an implicit persisted override. Cancelling
  // this page still leaves a legacy/default thread preference untouched.
  const displayedEffort = preview ? preview.effort : displayed?.id === current && effort && availableLevels.includes(effort as typeof ORBIT_EFFORTS[number]) ? effort : availableLevels.length ? 'low' : '';
  const fieldIndex = Math.max(0, ORBIT_EFFORTS.indexOf(displayedEffort as typeof ORBIT_EFFORTS[number]));
  const blends = useRef(EFFORT_FIELDS.map((_, index) => new Animated.Value(index === fieldIndex ? 1 : 0))).current;
  useEffect(() => {
    const animations = blends.map((weight, index) => Animated.timing(weight, { toValue: index === fieldIndex ? 1 : 0, duration: reduced ? 0 : 480, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }));
    const animation = Animated.parallel(animations); animation.start(); return () => animation.stop();
  }, [fieldIndex, reduced, blends]);
  const field = EFFORT_FIELDS[fieldIndex] ?? EFFORT_FIELDS[0];
  const originY = fanHeight - 74, arcRadius = width * (width < 360 ? 0.36 : 0.4);
  const arcSpan = 62 * Math.PI / 180;
  const arcLeft = width / 2 - arcRadius * Math.sin(arcSpan), arcY = originY - arcRadius * Math.cos(arcSpan);
  // Labels ride just outside the arc and turn with it, like text set along a dial.
  const labelRadius = arcRadius + 24, labelWidth = Math.min(156, width * 0.4);
  const placeOnArc = (index: number) => {
    const angle = (index - center) * ORBIT_STEP * Math.PI / 180;
    return { angle, x: width / 2 + Math.sin(angle) * labelRadius, y: originY - Math.cos(angle) * labelRadius,
      tickX: width / 2 + Math.sin(angle) * arcRadius, tickY: originY - Math.cos(angle) * arcRadius };
  };

  return <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={finish}>
    <View testID="remote-model-popover" style={styles.overlay} accessibilityViewIsModal>
      {backgroundUri ? <Image testID="remote-model-blur" source={{ uri: backgroundUri }} blurRadius={18} resizeMode="stretch" style={StyleSheet.absoluteFill} accessible={false} /> : null}
      {Platform.OS === 'web' ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backdropFilter: 'blur(14px)' } as ViewStyle]} /> : null}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {EFFORT_FIELDS.map((field, index) => <Animated.View key={field.id} style={[StyleSheet.absoluteFill, { opacity: blends[index] }]}>
          <Svg width="100%" height="100%">
            <Defs>
              <RadialGradient id={`orbit-core-${index}`} cx="50%" cy="100%" rx={`${62 + index * 9}%`} ry={`${34 + index * 6}%`}><Stop offset="0" stopColor={field.hue} stopOpacity={field.glow} /><Stop offset="0.55" stopColor={field.hue} stopOpacity={field.glow * 0.35} /><Stop offset="1" stopColor={field.hue} stopOpacity="0" /></RadialGradient>
              <LinearGradient id={`orbit-wash-${index}`} x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={field.wash} stopOpacity="1" /><Stop offset="1" stopColor={field.hue} stopOpacity={0.06 + index * 0.025} /></LinearGradient>
            </Defs>
            <Rect width="100%" height="100%" fill={`url(#orbit-wash-${index})`} fillOpacity={backgroundUri || Platform.OS === 'web' ? 0.78 : 1} />
            <Rect width="100%" height="100%" fill={`url(#orbit-core-${index})`} />
          </Svg>
        </Animated.View>)}
      </View>
      <Pressable testID="remote-model-backdrop" accessibilityRole="button" accessibilityLabel="收起模型选择" style={StyleSheet.absoluteFill} onPress={finish} />
      <SafeAreaView pointerEvents="box-none" style={styles.content}>
        {apiHeader ? <View testID="remote-api-header" style={styles.apiHeader} onTouchStart={cancel}>{apiHeader}</View> : <View pointerEvents="box-none" style={styles.top}>
          {onApi ? <Pressable accessibilityRole="button" accessibilityLabel="更换对话 API"
            onPress={() => { cancel(); onApi(); }} style={styles.apiRow}>
            <Icon name="key" size={14} color={dk.accentText} /><Text style={styles.apiText} numberOfLines={1}>API：{apiName || '跟随电脑'}</Text><Icon name="chevronRight" size={14} color={dk.muted} />
          </Pressable> : <View />}
          <Pressable accessibilityRole="button" accessibilityLabel="刷新模型列表" accessibilityState={{ disabled: loading }} hitSlop={10} onPress={() => { cancel(); onRefresh(); }} disabled={loading} style={styles.refresh}>
            {loading ? <ActivityIndicator size="small" color={dk.muted} /> : <Icon name="regenerate" size={17} color={dk.muted} />}
          </Pressable>
        </View>}
        {apiHeader ? <Pressable accessibilityRole="button" accessibilityLabel="刷新模型列表" accessibilityState={{ disabled: loading || interactionBlocked }} disabled={loading || interactionBlocked}
          onPress={() => { cancel(); onRefresh(); }} hitSlop={10} style={styles.headerRefresh}>{loading ? <ActivityIndicator size="small" color={dk.muted} /> : <Icon name="regenerate" size={17} color={dk.muted} />}</Pressable> : null}
        <View pointerEvents="none" style={[styles.hero, { top: Math.max(150, Math.min(280, height * 0.31)) }]}>
          <Text style={[styles.heroModel, height < 620 && { fontSize: 20, lineHeight: 24 }]} numberOfLines={height < 620 ? 2 : 3} accessibilityLabel={displayed?.id}>{selectionEnabled ? displayed?.label : '跟随电脑'}</Text>
          {selectionEnabled && availableLevels.length ? <><Text testID="remote-model-effort-preview" style={[styles.heroEffort, { color: field.ink }]}>{effortLabel(displayedEffort || '')}</Text>
            <View style={styles.tierDots}>{availableLevels.map(level => { const on = ORBIT_EFFORTS.indexOf(level) <= fieldIndex;
              return <View key={level} style={[styles.tierDot, on && { backgroundColor: field.ink, width: 18 }]} />; })}</View>
            {availableLevels.length > 1 ? <Text style={styles.holdHint}>{preview ? '松手确认' : '轻点使用 · 按住加深思考'}</Text> : null}</> : null}
          {error ? <Text style={styles.empty}>{error}</Text> : !list.length && !loading && selectionEnabled ? <Text style={styles.empty}>暂无可用模型</Text> : null}
        </View>
        <View testID="remote-model-orbit" {...pan.panHandlers} style={[styles.fan, { height: fanHeight }]}
          onTouchStart={(event) => { touchStart.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY }; }}
          onTouchMove={(event) => { const start = touchStart.current; if (start && Math.hypot(event.nativeEvent.pageX - start.x, event.nativeEvent.pageY - start.y) > 16) cancel(); }}
          onTouchEnd={clearTimer} onTouchCancel={cancel}>
          <Pressable accessible={false} style={StyleSheet.absoluteFill} onPress={finish} />
          <Svg pointerEvents="none" width={width} height={fanHeight} style={StyleSheet.absoluteFill}>
            <Defs><LinearGradient id="orbit-arc" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={field.hue} stopOpacity="0" /><Stop offset="0.5" stopColor={field.ink} stopOpacity="0.55" /><Stop offset="1" stopColor={field.hue} stopOpacity="0" />
            </LinearGradient></Defs>
            <Path d={`M ${arcLeft} ${arcY} A ${arcRadius} ${arcRadius} 0 0 1 ${width - arcLeft} ${arcY}`} fill="none" stroke="url(#orbit-arc)" strokeWidth={1.2 + fieldIndex * 0.25} />
            {nodes.map((node) => { const at = placeOnArc(node.index); const focus = Math.abs(node.index - center) < 0.35;
              return <Circle key={node.index} cx={at.tickX} cy={at.tickY} r={focus ? 3.5 : 2.2} fill={focus ? field.ink : field.hue} fillOpacity={node.opacity * (focus ? 1 : 0.7)} />; })}
          </Svg>
          <View pointerEvents="none" style={[styles.pulse, { left: width / 2, top: fanHeight - 81 }]}>
            <EffortPulse rings={field.rings} period={field.period} hue={field.ink} size={arcRadius * 2.3} reduced={reduced} />
          </View>
          {nodes.map((node) => {
            const item = list[node.index]; if (!item) return null;
            return <Pressable key={`${epoch}:${item.id}`} testID={`remote-model-node-${node.index}`} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityHint={item.id}
              accessible={node.interactive} importantForAccessibility={node.interactive ? 'auto' : 'no-hide-descendants'}
              accessibilityState={{ checked: current === item.id, disabled: !node.interactive || !canSelect || loading }} disabled={!node.interactive || !canSelect || loading}
              onPressIn={() => begin(item.id)} onPress={() => select(item.id)}
              accessibilityActions={[{ name: 'activate', label: '使用此模型' }]}
              onAccessibilityTap={() => { begin(item.id); select(item.id); }}
              onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'activate') { begin(item.id); select(item.id); } }}
              style={(() => { const at = placeOnArc(node.index); return [styles.node, { left: at.x - labelWidth / 2, top: at.y - 22, width: labelWidth, opacity: node.opacity, transform: [{ rotate: `${at.angle}rad` }] }]; })()}>
              <Text maxFontSizeMultiplier={1.25} numberOfLines={1} ellipsizeMode="middle" style={[styles.nodeLabel, Math.abs(node.index - center) < 0.35 && [styles.nodeCenter, { color: field.ink }]]}>{item.label}</Text>
            </Pressable>;
          })}
          {presentation.familyLabel ? <Text pointerEvents="none" style={styles.family}>{presentation.familyLabel}</Text> : null}
          {onFollowComputer ? <Pressable accessibilityRole="button" accessibilityLabel="使用电脑设置" onPress={() => { cancel(); active.current = false; onFollowComputer(); }} style={[styles.origin, { borderColor: field.hue }]}><Icon name="sparkle" size={21} color={field.ink} /></Pressable>
            : <View pointerEvents="none" style={[styles.origin, { borderColor: field.hue }]}><Icon name="sparkle" size={21} color={field.ink} /></View>}
          <View style={styles.position}>
            {list.length > 1 ? <Pressable accessibilityRole="button" accessibilityLabel="上一组模型" disabled={center <= 0} onPress={() => { cancel(); browse(Math.max(0, Math.round(center) - 1)); }} hitSlop={8}><Icon name="chevronLeft" size={14} color={center <= 0 ? dk.faint : dk.muted} /></Pressable> : null}
            <Text style={styles.positionText}>{list.length ? `${snapOrbitCenter(center, list.length) + 1} / ${list.length}` : '—'}</Text>
            {list.length > 1 ? <Pressable accessibilityRole="button" accessibilityLabel="下一组模型" disabled={center >= list.length - 1} onPress={() => { cancel(); browse(Math.min(list.length - 1, Math.round(center) + 1)); }} hitSlop={8}><Icon name="chevronRight" size={14} color={center >= list.length - 1 ? dk.faint : dk.muted} /></Pressable> : null}
          </View>
        </View>
      </SafeAreaView>
    </View>
  </Modal>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  overlay: { flex: 1 }, content: { flex: 1 },
  top: { marginTop: 48, marginHorizontal: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 },
  apiRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, minHeight: 42, maxWidth: '86%', borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.62)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)' },
  apiText: { flexShrink: 1, color: d.text2, fontSize: 13, fontWeight: '500' }, refresh: { minWidth: 32, minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  apiHeader: { position: 'absolute', top: 48, left: 0, right: 0, height: 110 }, headerRefresh: { position: 'absolute', top: 18, right: 22, minWidth: 32, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  hero: { position: 'absolute', left: 30, right: 30, alignItems: 'center', gap: 12 }, heroModel: { fontSize: 22, lineHeight: 28, fontWeight: '500', color: d.text2, textAlign: 'center' },
  heroEffort: { fontSize: 40, lineHeight: 48, color: d.text2, fontWeight: '300', letterSpacing: -0.5 }, tierDots: { flexDirection: 'row', gap: 5, alignItems: 'center' }, tierDot: { width: 10, height: 3, borderRadius: 2, backgroundColor: 'rgba(120,132,170,0.28)' },
  holdHint: { color: d.muted, fontSize: 11.5, letterSpacing: 0.3, marginTop: 2 }, pulse: { position: 'absolute', width: 0, height: 0, alignItems: 'center', justifyContent: 'center', overflow: 'visible' },
  fan: { position: 'absolute', bottom: 24, left: 0, right: 0 }, node: { position: 'absolute', height: 44, alignItems: 'center', justifyContent: 'center' },
  nodeLabel: { color: d.muted, fontSize: 13, lineHeight: 18, textAlign: 'center' }, nodeCenter: { color: d.text2, fontSize: 14, fontWeight: '500' },
  family: { position: 'absolute', bottom: 114, left: 30, right: 30, textAlign: 'center', color: d.muted, fontSize: 12, lineHeight: 17, fontWeight: '500' },
  origin: { position: 'absolute', bottom: 57, left: '50%', marginLeft: -24, width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.82)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' },
  position: { position: 'absolute', bottom: 22, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 20 }, positionText: { color: d.muted, fontSize: 11, lineHeight: 16 },
  empty: { color: d.muted, fontSize: 12.5, paddingVertical: 8 }, dot: { alignItems: 'center', justifyContent: 'center' }, dotText: { color: d.onInk, fontWeight: '800' },
}));
