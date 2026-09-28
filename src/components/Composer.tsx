import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import type { DocumentAttachment, ReferenceImage } from '../domain';
import { brandGradient, colors, shadow } from '../theme';
import { Icon } from './Icon';
import { FileCard } from './MessageBubble';
import { MotionPressable, useReducedMotion } from './MotionPressable';

export interface DictationControls {
  state: 'idle' | 'preparing' | 'listening' | 'transcribing';
  level: Animated.Value;
  startedAt: number;
  onStart: () => void;
  onStop: () => void;
  onCancel: () => void;
}

export function Composer({ value, onChangeText, images, documents, hasMask, busy, onSend, onStop, onOpenAttach, onRemoveImage, onRemoveDocument, onEditMask, inputRef, placeholder, dictation, onOpenLive, research = false, onClearResearch, tone = 'cool' }: {
  value: string; onChangeText: (value: string) => void;
  dictation?: DictationControls; onOpenLive?: () => void;
  /** Deep research is on for the next message. */
  research?: boolean; onClearResearch?: () => void;
  /** The chat space uses warm colours. */
  tone?: 'cool' | 'warm';
  images: ReferenceImage[]; documents: DocumentAttachment[]; hasMask: boolean; busy: boolean;
  onSend: () => void; onStop: () => void; onOpenAttach: () => void;
  onRemoveImage: (id: string) => void; onRemoveDocument: (id: string) => void; onEditMask: () => void;
  inputRef?: React.RefObject<TextInput | null>; placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const ready = Boolean(value.trim() || images.length || documents.length);
  const active = ready || busy;
  const sendAnim = useRef(new Animated.Value(active ? 1 : 0)).current;
  const focusAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.spring(sendAnim, { toValue: active ? 1 : 0, damping: 15, stiffness: 260, useNativeDriver: true }).start(); }, [active, sendAnim]);
  useEffect(() => { Animated.timing(focusAnim, { toValue: focused ? 1 : 0, duration: 200, useNativeDriver: false }).start(); }, [focused, focusAnim]);
  const hasTray = images.length > 0 || documents.length > 0;
  const dictating = Boolean(dictation && dictation.state !== 'idle');
  const showLive = !busy && !ready && Boolean(onOpenLive);
  const warmTone = tone === 'warm';
  const gradient = warmTone ? WARM_GRADIENT : undefined;

  return <View style={styles.wrap}>
    <Animated.View style={[styles.card, warmTone && { backgroundColor: '#FFFFFF', shadowColor: '#2B2F7A' }, { borderColor: focusAnim.interpolate({ inputRange: [0, 1], outputRange: warmTone ? ['#DCE2F6', '#B9B6FA'] : [colors.border, colors.glow] }) }]}>
      {hasTray && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tray} keyboardShouldPersistTaps="handled">
        {images.map((image, index) => <View key={image.id} style={styles.thumbWrap}>
          <Image source={{ uri: image.uri }} style={styles.thumb} />
          {index === 0 && <Pressable accessibilityRole="button" accessibilityLabel={hasMask ? '修改涂抹区域' : '涂抹要修改的区域'} hitSlop={8} onPress={onEditMask} style={[styles.maskButton, hasMask && styles.maskActive]}>
            <Icon name="brush" size={11} color={hasMask ? '#fff' : colors.text} strokeWidth={2} />
            <Text style={[styles.maskText, hasMask && { color: '#fff' }]}>{hasMask ? '已涂抹' : '涂抹'}</Text>
          </Pressable>}
          <Pressable accessibilityLabel="移除图片" hitSlop={8} onPress={() => onRemoveImage(image.id)} style={styles.remove}><Icon name="close" size={11} color="#fff" strokeWidth={2.4} /></Pressable>
        </View>)}
        {documents.map((doc) => <View key={doc.id} style={{ width: 210 }}><FileCard name={doc.name} mimeType={doc.mimeType} size={doc.size} onRemove={() => onRemoveDocument(doc.id)} /></View>)}
      </ScrollView>}
      {research && !dictating ? <View style={styles.modes}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭深度研究" hitSlop={8} onPress={onClearResearch} style={styles.mode}>
          <Icon name="telescope" size={14} color={colors.primaryDeep} strokeWidth={1.9} />
          <Text style={styles.modeText}>深度研究</Text>
          <Icon name="close" size={12} color={colors.primaryDeep} strokeWidth={2.2} />
        </Pressable>
      </View> : null}
      {dictating && dictation ? <DictationBar dictation={dictation} gradient={gradient} /> : null}
      <View style={[styles.row, dictating && { display: 'none' }]}>
        <MotionPressable accessibilityRole="button" accessibilityLabel="添加图片或文件" scaleTo={0.88} hitSlop={5} onPress={onOpenAttach} style={[styles.plus, warmTone && { backgroundColor: '#E9E8FF' }]}>
          <Icon name="plus" size={21} color={colors.text} strokeWidth={1.8} />
        </MotionPressable>
        <TextInput
          ref={inputRef}
          accessibilityLabel="消息"
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder ?? '想聊点什么，或画点什么？'}
          placeholderTextColor={colors.subtle}
          multiline
          maxLength={8000}
          textAlignVertical="center"
          style={styles.input}
        />
        {dictation ? <MotionPressable accessibilityRole="button" accessibilityLabel="语音输入" scaleTo={0.86} hitSlop={5} onPress={dictation.onStart} style={styles.mic}>
          <Icon name="mic" size={21} color={colors.textSecondary} strokeWidth={1.8} />
        </MotionPressable> : null}
        {showLive ? <MotionPressable accessibilityRole="button" accessibilityLabel="语音对话" scaleTo={0.86} hitSlop={5} onPress={onOpenLive}>
          <View style={styles.send}>
            <SendGradient colors={gradient} />
            <View style={StyleSheet.absoluteFill}><View style={styles.center}><Icon name="waveform" size={19} color="#FFFFFF" strokeWidth={2.1} /></View></View>
          </View>
        </MotionPressable> : <MotionPressable accessibilityRole="button" accessibilityLabel={busy ? '停止' : '发送'} disabled={!busy && !ready} onPress={busy ? onStop : onSend} scaleTo={0.86} hitSlop={5}>
          <View style={styles.send}>
            <View style={[StyleSheet.absoluteFill, styles.sendIdle]} />
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: sendAnim, transform: [{ scale: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }]}>
              {busy ? <View style={styles.sendBusy} /> : <SendGradient colors={gradient} />}
            </Animated.View>
            <Icon name={busy ? 'stop' : 'arrowUp'} size={busy ? 16 : 19} color={active ? '#FFFFFF' : colors.faint} strokeWidth={2.1} />
          </View>
        </MotionPressable>}
      </View>
    </Animated.View>
  </View>;
}

const BARS = 26;

/** Live waveform: bars follow the microphone level with a gentle travelling shimmer. */
function LevelBars({ level, dim }: { level: Animated.Value; dim: boolean }) {
  const reduced = useReducedMotion();
  const wave = useRef(new Animated.Value(0)).current;
  const smooth = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const id = level.addListener(({ value }) => {
      Animated.timing(smooth, { toValue: value, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    });
    return () => level.removeListener(id);
  }, [level, smooth]);
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.timing(wave, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [reduced, wave]);
  return <View style={[styles.bars, dim && { opacity: 0.35 }]}>
    {Array.from({ length: BARS }, (_, index) => {
      const bell = Math.sin(Math.PI * (index + 0.5) / BARS);
      const phase = index / BARS;
      const shimmer = wave.interpolate({
        inputRange: [0, phase, Math.min(1, phase + 0.15), 1],
        outputRange: [0, 0, 0.18 * bell, 0],
        extrapolate: 'clamp',
      });
      const scale = Animated.add(Animated.add(0.14, shimmer), Animated.multiply(smooth, 0.25 + 0.75 * bell));
      return <Animated.View key={index} style={[styles.bar, { transform: [{ scaleY: scale }] }]} />;
    })}
  </View>;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const seconds = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  return <Text style={styles.elapsed}>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</Text>;
}

function DictationBar({ dictation, gradient }: { dictation: DictationControls; gradient?: readonly string[] }) {
  const busy = dictation.state === 'transcribing' || dictation.state === 'preparing';
  const label = dictation.state === 'preparing' ? '正在加载语音模型…' : dictation.state === 'transcribing' ? '正在转成文字…' : null;
  return <View style={styles.row}>
    <MotionPressable accessibilityRole="button" accessibilityLabel="取消语音输入" scaleTo={0.86} hitSlop={5} onPress={dictation.onCancel} style={styles.plus}>
      <Icon name="close" size={18} color={colors.text} strokeWidth={2} />
    </MotionPressable>
    <View style={styles.dictation}>
      {label ? <Text style={styles.dictationLabel}>{label}</Text> : <LevelBars level={dictation.level} dim={false} />}
      {dictation.state === 'listening' ? <Elapsed since={dictation.startedAt} /> : null}
    </View>
    <MotionPressable accessibilityRole="button" accessibilityLabel="完成语音输入" scaleTo={0.86} hitSlop={5} disabled={busy} onPress={dictation.onStop}>
      <View style={styles.send}>
        <SendGradient colors={gradient} />
        <View style={StyleSheet.absoluteFill}><View style={styles.center}>
          {busy ? <ActivityIndicator color="#FFFFFF" size="small" /> : <Icon name="check" size={19} color="#FFFFFF" strokeWidth={2.4} />}
        </View></View>
      </View>
    </MotionPressable>
  </View>;
}

const WARM_GRADIENT = ['#7CC6FF', '#5B6CFF', '#8B6CF6'] as const;

function SendGradient({ colors: stops = brandGradient }: { colors?: readonly string[] }) {
  const id = stops === brandGradient ? 'sendGradient' : 'sendGradientWarm';
  return <Svg width={38} height={38}>
    <Defs>
      <LinearGradient id={id} x1="0" y1="0" x2="38" y2="38" gradientUnits="userSpaceOnUse">
        <Stop offset="0" stopColor={stops[0]} />
        <Stop offset="0.45" stopColor={stops[1]} />
        <Stop offset="1" stopColor={stops[2]} />
      </LinearGradient>
    </Defs>
    <Circle cx={19} cy={19} r={19} fill={`url(#${id})`} />
  </Svg>;
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8 },
  card: { backgroundColor: colors.card, borderRadius: 28, borderWidth: 1, ...shadow.soft },
  tray: { paddingHorizontal: 12, paddingTop: 12, gap: 8, alignItems: 'center' },
  thumbWrap: { width: 64, height: 64, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.surface },
  thumb: { width: 64, height: 64 },
  remove: { position: 'absolute', top: 5, right: 5, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(11,18,32,0.6)', alignItems: 'center', justifyContent: 'center' },
  maskButton: { position: 'absolute', left: 5, bottom: 5, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.94)' },
  maskActive: { backgroundColor: colors.primary },
  maskText: { fontSize: 10, fontWeight: '600', color: colors.text },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, paddingHorizontal: 8, paddingVertical: 8 },
  modes: { flexDirection: 'row', paddingHorizontal: 12, paddingTop: 10 },
  mode: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 28, paddingHorizontal: 11, borderRadius: 14, backgroundColor: colors.primarySoft },
  modeText: { color: colors.primaryDeep, fontSize: 13, fontWeight: '600' },
  plus: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceStrong },
  input: { flex: 1, minHeight: 38, maxHeight: 160, color: colors.text, paddingHorizontal: 6, paddingTop: 8, paddingBottom: 8, fontSize: 16, lineHeight: 22 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  sendIdle: { backgroundColor: colors.surfaceStrong, borderRadius: 19 },
  sendBusy: { flex: 1, backgroundColor: colors.text, borderRadius: 19 },
  mic: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dictation: { flex: 1, height: 38, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6 },
  dictationLabel: { flex: 1, color: colors.textMuted, fontSize: 14.5 },
  bars: { flex: 1, height: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bar: { width: 3, height: 30, borderRadius: 1.5, backgroundColor: colors.primary },
  elapsed: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'], minWidth: 34, textAlign: 'right' },
});
