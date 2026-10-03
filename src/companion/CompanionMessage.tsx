import React, { memo, useEffect, useRef, useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Animated, Easing, Image, Pressable, StyleSheet, Text, View, type AccessibilityActionEvent, type AccessibilityActionInfo, type GestureResponderEvent } from 'react-native';

import type { ChatMessage } from '../domain';
import { AgentActivity } from '../components/AgentTrace';
import { Icon } from '../components/Icon';
import { showToast } from '../components/ui';
import { DrawingCanvas, ImageResult } from '../components/MessageBubble';
import { MessageContent } from '../components/MessageContent';
import { useReducedMotion } from '../components/MotionPressable';
import type { RequestPhase } from '../state/AppContext';
import type { Character } from '../memorybox/types';
import { CharacterAvatar } from './CharacterAvatar';
import { isPoke } from './reactions';
import { warm } from './theme';
import { themed } from '../theme';

import { useLiveText } from '../state/live-text';
type Props = {
  message: ChatMessage;
  character: Character;
  phase: RequestPhase;
  elapsedSeconds: number;
  isLast: boolean;
  /** Arrived just now: gets a springy entrance instead of appearing in place. */
  fresh: boolean;
  /** Show a time label above (first message after a pause). */
  timeLabel: string | null;
  reaction: string | undefined;
  onStop: () => void;
  onRetry: (message: ChatMessage) => void;
  onPreview: (uri: string) => void;
  onLongPress: (message: ChatMessage, pageY: number) => void;
  onReact: (message: ChatMessage, emoji: string | null) => void;
  onPoke: () => void;
  onOpenTrail: (message: ChatMessage) => void;
};

/** One tap after another within this many ms counts as a double tap. */
const DOUBLE_TAP_MS = 260;

/** Single vs double tap on the same target: the single action waits briefly so a double tap can win. */
export function useTaps(onDouble: () => void, onSingle?: () => void) {
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return () => {
    const now = Date.now();
    if (now - last.current < DOUBLE_TAP_MS) {
      last.current = 0;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      onDouble();
      return;
    }
    last.current = now;
    if (onSingle) timer.current = setTimeout(() => { timer.current = null; onSingle(); }, DOUBLE_TAP_MS);
  };
}

/** One message in a character's thread: starlight bubbles, avatar, reactions, “想起了 N 件事”. */
export const CompanionMessage = memo(function CompanionMessage(props: Props) {
  const styles = useStyles();
  const { message, timeLabel } = props;
  if (message.role === 'user' && isPoke(message.prompt)) return <PokeLine {...props} />;
  return <Entrance fresh={props.fresh} side={message.role === 'user' ? 'right' : 'left'}>
    {timeLabel ? <Text style={styles.time}>{timeLabel}</Text> : null}
    {message.role === 'user' ? <UserRow {...props} /> : <CharacterRow {...props} />}
  </Entrance>;
});

/** Springy arrival for new messages: yours pops out of the composer, TA's out of the avatar. */
function Entrance({ fresh, side, children }: { fresh: boolean; side: 'left' | 'right'; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const animate = fresh && !reduced;
  const value = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (!animate) return;
    Animated.spring(value, { toValue: 1, damping: 13, stiffness: 190, mass: 0.8, useNativeDriver: true }).start();
  }, [animate, value]);
  if (!animate) return <View>{children}</View>;
  return <Animated.View style={{
    opacity: value.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }),
    transform: [
      { translateX: value.interpolate({ inputRange: [0, 1], outputRange: [side === 'right' ? 26 : -18, 0] }) },
      { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) },
      { scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] }) },
    ],
  }}>{children}</Animated.View>;
}

function PokeLine({ message, fresh, character }: Props) {
  const styles = useStyles();
  const value = useRef(new Animated.Value(fresh ? 0 : 1)).current;
  useEffect(() => { if (fresh) Animated.spring(value, { toValue: 1, damping: 9, stiffness: 200, useNativeDriver: true }).start(); }, [fresh, value]);
  return <Animated.View style={[styles.poke, { opacity: value, transform: [{ scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }]}>
    <Text style={styles.pokeHand}>👋</Text>
    <Text style={styles.pokeText}>{message.prompt.replace(/^〔拍一拍〕/, '') || `你拍了拍「${character.name}」`}</Text>
  </Animated.View>;
}

/** The little emoji badge under a bubble; pops when it changes. */
function ReactionBadge({ emoji, align, onPress }: { emoji: string; align: 'left' | 'right'; onPress: () => void }) {
  const styles = useStyles();
  const pop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    pop.setValue(0);
    Animated.spring(pop, { toValue: 1, damping: 8, stiffness: 260, useNativeDriver: true }).start();
  }, [emoji, pop]);
  return <Animated.View style={[styles.badgeWrap, align === 'right' ? { left: -10 } : { right: -10 }, { transform: [{ scale: pop }] }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`回应 ${emoji}，点按取消`} hitSlop={8} onPress={onPress} style={styles.badge}>
      <Text style={styles.badgeText}>{emoji}</Text>
    </Pressable>
  </Animated.View>;
}

/** Hearts bursting out of a double-tapped bubble. */
function HeartBurst({ onDone }: { onDone: () => void }) {
  const styles = useStyles();
  const value = useRef(new Animated.Value(0)).current;
  // onDone is a new function on every render of the row; a ref keeps re-renders from restarting the burst.
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const animation = Animated.timing(value, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    animation.start(({ finished }) => { if (finished) done.current(); });
    return () => animation.stop();
  }, [value]);
  const small = [[-34, -46, 0.7], [30, -52, 0.6], [-6, -70, 0.5], [44, -20, 0.55], [-44, -14, 0.5]];
  return <View pointerEvents="none" style={styles.burst}>
    <Animated.Text style={[styles.burstHeart, {
      opacity: value.interpolate({ inputRange: [0, 0.15, 0.7, 1], outputRange: [0, 1, 1, 0] }),
      transform: [{ scale: value.interpolate({ inputRange: [0, 0.25, 0.4, 1], outputRange: [0.2, 1.35, 1, 1.1] }) }, { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, -18] }) }],
    }]}>❤️</Animated.Text>
    {small.map(([x, y, s], index) => <Animated.Text key={index} style={[styles.burstSmall, {
      opacity: value.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
      transform: [
        { translateX: value.interpolate({ inputRange: [0, 1], outputRange: [0, x] }) },
        { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [0, y] }) },
        { scale: value.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.2, s, s * 0.8] }) },
      ],
    }]}>💕</Animated.Text>)}
  </View>;
}

/** Double tap = ❤️ (again to remove), long press = reactions and actions. */
function useBubbleGestures(props: Props, body: string) {
  const { message, reaction, onReact, onLongPress, onRetry } = props;
  const [burst, setBurst] = useState(0);
  const like = () => {
    if (reaction === '❤️') { onReact(message, null); return; }
    onReact(message, '❤️');
    setBurst((value) => value + 1);
  };
  const tap = useTaps(like);
  // Screen readers: a double tap is the reader's own "activate", so the gestures are offered as actions.
  const actions: AccessibilityActionInfo[] = [
    { name: 'like', label: reaction === '❤️' ? '取消点赞' : '点赞' },
    { name: 'copy', label: '复制' },
    ...(message.role === 'assistant' && message.status !== 'pending' ? [{ name: 'regenerate', label: '重新回复' }] : []),
    { name: 'longpress', label: '更多操作' },
  ];
  const onAccessibilityAction = (event: AccessibilityActionEvent) => {
    switch (event.nativeEvent.actionName) {
      case 'like': like(); break;
      case 'copy': void Clipboard.setStringAsync(body).then(() => showToast('已复制')); break;
      case 'regenerate': onRetry(message); break;
      case 'longpress': onLongPress(message, 320); break;
    }
  };
  return {
    burst, clearBurst: () => setBurst(0),
    handlers: {
      onPress: tap, delayLongPress: 320, onLongPress: (event: GestureResponderEvent) => onLongPress(message, event.nativeEvent.pageY),
      accessibilityRole: 'text' as const, accessibilityHint: '可以在操作菜单里点赞、复制或查看更多', accessibilityActions: actions, onAccessibilityAction,
    },
  };
}

function UserRow(props: Props) {
  const styles = useStyles();
  const { message, onPreview, reaction, onReact } = props;
  const { burst, clearBurst, handlers } = useBubbleGestures(props, message.prompt);
  return <View style={styles.userWrap}>
    {message.references.length > 0 && <View style={styles.images}>
      {message.references.map((reference) => <Pressable key={reference.id} accessibilityLabel="查看图片" onPress={() => onPreview(reference.uri)} style={styles.imageFrame}>
        <Image source={{ uri: reference.uri }} style={message.references.length === 1 ? styles.imageLarge : styles.image} />
      </Pressable>)}
    </View>}
    {message.prompt && !(message.references.length && /^请看看这张图片。$/.test(message.prompt)) ? <View>
      <Pressable {...handlers} style={({ pressed }) => [styles.userBubble, pressed && { transform: [{ scale: 0.98 }] }]}>
        <View pointerEvents="none" style={styles.userSheen} />
        <Text selectable style={styles.userText}>{message.prompt}</Text>
      </Pressable>
      {reaction ? <ReactionBadge emoji={reaction} align="right" onPress={() => onReact(message, null)} /> : null}
      {burst ? <HeartBurst key={burst} onDone={clearBurst} /> : null}
    </View> : null}
  </View>;
}

function TalkingAvatar({ character, typing, onPoke }: { character: Character; typing: boolean; onPoke: () => void }) {
  const reduced = useReducedMotion();
  const bob = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!typing || reduced) { bob.setValue(0); return undefined; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(bob, { toValue: 1, duration: 420, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(bob, { toValue: 0, duration: 420, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [typing, reduced, bob]);
  const poke = useTaps(() => {
    shake.setValue(0);
    Animated.timing(shake, { toValue: 1, duration: 520, easing: Easing.linear, useNativeDriver: true }).start();
    onPoke();
  });
  return <Pressable accessibilityRole="button" accessibilityLabel={`双击拍一拍 ${character.name}`} onPress={poke} hitSlop={6}>
    <Animated.View style={{ transform: [
      { translateY: bob.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) },
      { rotate: shake.interpolate({ inputRange: [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1], outputRange: ['0deg', '-14deg', '12deg', '-10deg', '8deg', '-4deg', '0deg'] }) },
    ] }}>
      <CharacterAvatar character={character} size={34} />
    </Animated.View>
  </Pressable>;
}

function CharacterRow(props: Props) {
  const styles = useStyles();
  const { message, character, phase, elapsedSeconds, isLast, reaction, onStop, onRetry, onPreview, onReact, onPoke, onOpenTrail } = props;
  const pending = message.status === 'pending';
  const imageJob = Boolean(message.preparedPrompt) && (message.mode === 'generate' || message.mode === 'edit');
  const drawing = imageJob && pending && !message.imageUri;
  const text = useLiveText(message.id, message.text)?.trim() ?? '';
  const { burst, clearBurst, handlers } = useBubbleGestures(props, text);
  const failed = message.status === 'error' || message.status === 'interrupted';
  const stopped = message.status === 'cancelled';
  const trace = message.agent;
  const recalled = trace?.recalled ?? [];
  const running = trace?.steps.some((step) => step.status === 'running');
  return <View style={styles.row}>
    <TalkingAvatar character={character} typing={pending} onPoke={onPoke} />
    <View style={styles.column}>
      {trace?.steps.length ? <View style={styles.activity}><AgentActivity trace={trace} pending={pending} /></View> : null}
      {pending && !text && !drawing && !running ? <View style={styles.bubble}><TypingDots color={character.color} /></View> : null}
      {text ? <View>
        <Pressable {...handlers} style={({ pressed }) => [styles.bubble, pressed && { transform: [{ scale: 0.985 }] }]}>
          <MessageContent text={text} streaming={pending && !drawing} sources={trace?.sources} />
        </Pressable>
        {reaction ? <ReactionBadge emoji={reaction} align="left" onPress={() => onReact(message, null)} /> : null}
        {burst ? <HeartBurst key={burst} onDone={clearBurst} /> : null}
      </View> : null}
      {drawing ? <DrawingCanvas message={message} seconds={elapsedSeconds} onStop={onStop} downloading={phase === 'downloading'} /> : null}
      {message.imageUri ? <ImageResult message={message} fresh={isLast} onPreview={onPreview} /> : null}
      {failed ? <View style={styles.error}>
        <Icon name="alert" size={15} color={warm.accentDeep} />
        <Text style={styles.errorText} numberOfLines={3}>{message.error || '没有发出去'}</Text>
        <Pressable accessibilityRole="button" onPress={() => onRetry(message)} hitSlop={8}><Text style={styles.retry}>{imageJob ? '重新画' : '重试'}</Text></Pressable>
      </View> : null}
      {stopped ? <Pressable accessibilityRole="button" onPress={() => onRetry(message)} hitSlop={8}><Text style={styles.stopped}>已停止 · 重新回复</Text></Pressable> : null}
      {recalled.length > 0 && !pending ? <Pressable accessibilityRole="button" accessibilityLabel={`这次想起了 ${recalled.length} 件事，查看记忆线路`} onPress={() => onOpenTrail(message)}
        style={({ pressed }) => [styles.recall, pressed && { backgroundColor: warm.surfaceStrong }]}>
        <Icon name="memory" size={13} color={warm.accentDeep} />
        <Text style={styles.recallText}>想起了 {recalled.length} 件事</Text>
        <Icon name="chevronRight" size={12} color={warm.muted} strokeWidth={2} />
      </Pressable> : null}
    </View>
  </View>;
}

/** “对方正在输入” dots, in the character's colour. */
function TypingDots({ color }: { color: string }) {
  const styles = useStyles();
  const reduced = useReducedMotion();
  const values = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    if (reduced) return undefined;
    const loops = values.map((value, index) => Animated.loop(Animated.sequence([
      Animated.delay(index * 160),
      Animated.timing(value, { toValue: 1, duration: 360, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(value, { toValue: 0.3, duration: 360, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.delay((2 - index) * 160),
    ])));
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [reduced, values]);
  return <View style={styles.dots} accessibilityLabel="正在输入">
    {values.map((value, index) => <Animated.View key={index} style={[styles.dot, { backgroundColor: color, opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0.3, 1], outputRange: [0, -4] }) }, { scale: value.interpolate({ inputRange: [0.3, 1], outputRange: [0.85, 1.15] }) }] }]} />)}
  </View>;
}

const useStyles = themed((c, d) => StyleSheet.create({
  time: { alignSelf: 'center', color: warm.faint, fontSize: 12, marginBottom: 10, marginTop: 4 },
  userWrap: { alignItems: 'flex-end', gap: 6, paddingLeft: 56 },
  images: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 },
  imageFrame: { borderRadius: 18, overflow: 'hidden', backgroundColor: warm.surface },
  image: { width: 96, height: 96 },
  imageLarge: { width: 180, height: 180 },
  userBubble: {
    maxWidth: '100%', overflow: 'hidden', backgroundColor: warm.userBubble, paddingHorizontal: 15, paddingVertical: 10, borderRadius: 21, borderBottomRightRadius: 7,
    shadowColor: warm.userBubble, shadowOpacity: 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 3,
  },
  userSheen: { position: 'absolute', left: 0, right: 0, top: 0, height: '55%', backgroundColor: 'rgba(255,255,255,0.12)' },
  userText: { color: '#FFFFFF', fontSize: 16, lineHeight: 23 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, paddingRight: 40 },
  column: { flex: 1, alignItems: 'flex-start', gap: 8 },
  activity: { alignSelf: 'stretch', paddingTop: 4 },
  bubble: {
    maxWidth: '100%', backgroundColor: warm.card, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 21, borderTopLeftRadius: 7,
    borderWidth: StyleSheet.hairlineWidth, borderColor: warm.border, shadowColor: '#2B2F7A', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 }, elevation: 1,
  },
  badgeWrap: { position: 'absolute', bottom: -12 },
  badge: { minWidth: 30, height: 26, paddingHorizontal: 6, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: warm.card, borderWidth: 1.5, borderColor: warm.background, shadowColor: '#2B2F7A', shadowOpacity: 0.14, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  badgeText: { fontSize: 14 },
  burst: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  burstHeart: { position: 'absolute', fontSize: 44 },
  burstSmall: { position: 'absolute', fontSize: 18 },
  poke: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 28, borderRadius: 14, backgroundColor: warm.surfaceStrong, marginVertical: 2 },
  pokeHand: { fontSize: 14 },
  pokeText: { color: warm.muted, fontSize: 12.5 },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: warm.accentSoft, flexWrap: 'wrap' },
  errorText: { flexShrink: 1, color: warm.textSecondary, fontSize: 13 },
  retry: { color: warm.accentDeep, fontSize: 13.5, fontWeight: '600' },
  stopped: { color: warm.muted, fontSize: 13 },
  recall: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: warm.surface, marginTop: 4 },
  recallText: { color: warm.accentDeep, fontSize: 12, fontWeight: '500' },
  dots: { flexDirection: 'row', gap: 5, height: 22, alignItems: 'center', paddingHorizontal: 4 },
  dot: { width: 7, height: 7, borderRadius: 4 },
}));
