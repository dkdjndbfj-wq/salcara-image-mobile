import * as Clipboard from 'expo-clipboard';
import React, { memo, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import type { ChatMessage } from '../domain';
import { attachmentKind } from '../document-inputs';
import type { RequestPhase } from '../state/AppContext';
import { colors } from '../theme';
import { LivingMark } from './Brand';
import { Icon, type IconName } from './Icon';
import { MessageContent } from './MessageContent';
import { Appear, useReducedMotion } from './MotionPressable';
import { showToast } from './ui';

type Props = {
  message: ChatMessage;
  phase: RequestPhase;
  elapsedSeconds: number;
  isLast: boolean;
  onStop: () => void;
  onRetry: (message: ChatMessage) => void;
  onPreview: (uri: string) => void;
  onSave: (uri: string) => void;
  onShare: (uri: string) => void;
};

export const MessageBubble = memo(function MessageBubble(props: Props) {
  return <Appear distance={14} duration={360}>{props.message.role === 'user' ? <UserMessage {...props} /> : <AssistantMessage {...props} />}</Appear>;
});

function UserMessage({ message, onPreview }: Props) {
  const docs = message.documents ?? [];
  const single = message.references.length === 1;
  return <View style={styles.userWrap}>
    {message.references.length > 0 && <View style={styles.userImages}>
      {message.references.map((reference, index) => <Pressable key={reference.id} accessibilityLabel="查看图片" onPress={() => onPreview(reference.uri)} style={styles.userImageFrame}>
        <Image source={{ uri: reference.uri }} style={single ? styles.userImageLarge : styles.userImage} />
        {index === 0 && message.maskUri ? <View style={styles.maskBadge}><Icon name="brush" size={11} color="#fff" strokeWidth={2} /></View> : null}
      </Pressable>)}
    </View>}
    {docs.length > 0 && <View style={styles.userDocs}>{docs.map((doc) => <FileCard key={doc.id} name={doc.name} mimeType={doc.mimeType} size={doc.size} />)}</View>}
    {message.prompt && !isPlaceholderPrompt(message) ? <View style={styles.userBubble}><Text selectable style={styles.userText}>{message.prompt}</Text></View> : null}
  </View>;
}

export function FileCard({ name, mimeType, size, onRemove }: { name: string; mimeType: string; size: number; onRemove?: () => void }) {
  const kind = attachmentKind(name, mimeType);
  const tint = kind === 'pdf' ? '#F2555A' : kind === 'office' ? colors.primary : kind === 'text' ? '#12A150' : '#8A94A6';
  return <View style={styles.fileCard}>
    <View style={[styles.fileIcon, { backgroundColor: tint }]}><Icon name={docIcon(name, mimeType)} size={17} color="#fff" strokeWidth={1.9} /></View>
    <View style={{ flexShrink: 1, flex: onRemove ? 1 : undefined }}>
      <Text style={styles.fileName} numberOfLines={1}>{name}</Text>
      <Text style={styles.fileMeta}>{fileLabel(name)} · {formatSize(size)}</Text>
    </View>
    {onRemove && <Pressable accessibilityLabel={`移除 ${name}`} hitSlop={10} onPress={onRemove} style={styles.fileRemove}><Icon name="close" size={14} color={colors.textMuted} strokeWidth={2} /></Pressable>}
  </View>;
}

function AssistantMessage({ message, phase, elapsedSeconds, isLast, onStop, onRetry: retryMessage, onPreview, onSave, onShare }: Props) {
  const onRetry = () => retryMessage(message);
  const pending = message.status === 'pending';
  const imageJob = Boolean(message.preparedPrompt) && (message.mode === 'generate' || message.mode === 'edit');
  const text = message.text?.trim() ?? '';
  const streaming = pending && !imageJob && Boolean(text);
  const failed = message.status === 'error' || message.status === 'interrupted';
  const stopped = message.status === 'cancelled';
  return <View style={styles.assistantWrap}>
    {pending && !text && !imageJob && <Thinking label={phase === 'downloading' ? '正在取回图片' : '正在思考'} />}
    {text ? <MessageContent text={text} streaming={streaming} /> : null}
    {imageJob && pending && <DrawingCanvas message={message} seconds={elapsedSeconds} onStop={onStop} downloading={phase === 'downloading'} />}
    {message.imageUri ? <ImageResult message={message} onPreview={onPreview} /> : null}
    {failed && <View style={styles.errorCard}>
      <Icon name="alert" size={18} color={colors.danger} />
      <Text selectable style={styles.errorText}>{message.error || '这次没有完成'}</Text>
      <Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8} style={styles.retry}><Text style={styles.retryText}>{message.remoteImageUrl ? '重新下载' : imageJob ? '重新绘制' : '重试'}</Text></Pressable>
    </View>}
    {stopped && <View style={styles.stoppedRow}><Text style={styles.stoppedText}>已停止</Text><Pressable accessibilityRole="button" onPress={onRetry} hitSlop={8}><Text style={styles.retryText}>重新生成</Text></Pressable></View>}
    {!pending && !failed && !stopped && <Actions message={message} text={text} emphasized={isLast} onRetry={onRetry} onSave={onSave} onShare={onShare} />}
  </View>;
}

function Actions({ message, text, emphasized, onRetry, onSave, onShare }: { message: ChatMessage; text: string; emphasized: boolean; onRetry: () => void; onSave: (uri: string) => void; onShare: (uri: string) => void }) {
  const copy = () => void Clipboard.setStringAsync(text || message.preparedPrompt || '').then(() => showToast(text ? '已复制' : '已复制作图描述'));
  return <View style={[styles.actions, !emphasized && { opacity: 0.6 }]}>
    {message.imageUri ? <ActionIcon icon="download" label="保存到相册" onPress={() => onSave(message.imageUri!)} /> : null}
    {message.imageUri ? <ActionIcon icon="share" label="分享" onPress={() => onShare(message.imageUri!)} /> : null}
    {(text || message.preparedPrompt) ? <ActionIcon icon="copy" label="复制" onPress={copy} /> : null}
    <ActionIcon icon="regenerate" label="重新生成" onPress={onRetry} />
  </View>;
}

function ActionIcon({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} style={({ pressed }) => [styles.actionIcon, pressed && { backgroundColor: colors.surfaceStrong }]}>
    <Icon name={icon} size={18} color={colors.textMuted} />
  </Pressable>;
}

/** Living brand mark plus a softly pulsing label. */
function Thinking({ label }: { label: string }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduced, pulse]);
  return <View style={styles.thinking} accessibilityLabel={label}>
    <LivingMark size={20} />
    <Animated.Text style={[styles.thinkingText, { opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }]}>{label}…</Animated.Text>
  </View>;
}

/** Aurora placeholder: soft colour fields drifting while the image is drawn. */
function DrawingCanvas({ message, seconds, onStop, downloading }: { message: ChatMessage; seconds: number; onStop: () => void; downloading: boolean }) {
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const drift = useRef(new Animated.Value(0)).current;
  const ratio = ratioFromSize(message.size);
  const cardWidth = Math.min(width - 40, 400);
  const cardHeight = Math.min(cardWidth / ratio, 460);
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(drift, { toValue: 1, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(drift, { toValue: 0, duration: 3200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduced, drift]);
  const blob = (color: string, size: number, x: [number, number], y: [number, number]) => <Animated.View pointerEvents="none" style={{
    position: 'absolute', left: -size / 2, top: -size / 2, width: size, height: size,
    transform: [
      { translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [x[0] * cardWidth, x[1] * cardWidth] }) },
      { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [y[0] * cardHeight, y[1] * cardHeight] }) },
    ],
  }}><SoftOrb color={color} size={size} /></Animated.View>;
  const orb = Math.max(cardWidth, cardHeight) * 0.95;
  return <View style={{ gap: 12 }}>
    <View style={[styles.canvas, { width: cardWidth, height: cardHeight }]}>
      {blob('#8CCBFF', orb, [0.2, 0.55], [0.25, 0.1])}
      {blob('#B9A2FF', orb * 0.9, [0.85, 0.5], [0.55, 0.85])}
      {blob('#FBC2DF', orb * 0.75, [0.35, 0.8], [0.95, 0.6])}
      {blob('#FFE0C6', orb * 0.5, [0.7, 0.25], [0.2, 0.45])}
      <View style={styles.canvasGlass} />
    </View>
    <View style={styles.drawingCaption}>
      <LivingMark size={16} />
      <Text style={styles.drawingText}>{downloading ? '正在取回图片' : message.mode === 'edit' ? '正在修改图片' : '正在绘制'}<Text style={styles.drawingSeconds}>  {formatElapsed(seconds)}</Text></Text>
      <Pressable accessibilityRole="button" accessibilityLabel="停止绘制" onPress={onStop} hitSlop={10} style={styles.stopLink}><Text style={styles.stopText}>停止</Text></Pressable>
    </View>
  </View>;
}

function SoftOrb({ color, size }: { color: string; size: number }) {
  const id = useRef(`orb${Math.random().toString(36).slice(2, 8)}`).current;
  return <Svg width={size} height={size}>
    <Defs>
      <RadialGradient id={id} cx="50%" cy="50%" r="50%">
        <Stop offset="0" stopColor={color} stopOpacity="0.95" />
        <Stop offset="1" stopColor={color} stopOpacity="0" />
      </RadialGradient>
    </Defs>
    <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
  </Svg>;
}

function ImageResult({ message, onPreview }: { message: ChatMessage; onPreview: (uri: string) => void }) {
  const { width } = useWindowDimensions();
  const [ratio, setRatio] = useState(() => ratioFromSize(message.size));
  const reveal = useRef(new Animated.Value(0)).current;
  const uri = message.imageUri!;
  useEffect(() => {
    let alive = true;
    Image.getSize(uri, (w, h) => { if (alive && w > 0 && h > 0) setRatio(w / h); }, () => undefined);
    return () => { alive = false; };
  }, [uri]);
  const maxWidth = Math.min(width - 40, 420);
  const cardHeight = Math.min(maxWidth / ratio, 520);
  const cardWidth = Math.min(maxWidth, cardHeight * ratio);
  return <Animated.View style={[styles.imageCard, { width: cardWidth, height: cardHeight, opacity: reveal, transform: [{ scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [0.97, 1] }) }] }]}>
    <Pressable accessibilityRole="imagebutton" accessibilityLabel="查看大图" onPress={() => onPreview(uri)} style={StyleSheet.absoluteFill}>
      <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover"
        onLoad={() => Animated.timing(reveal, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start()}
        onError={() => reveal.setValue(1)} />
    </Pressable>
  </Animated.View>;
}

function isPlaceholderPrompt(message: ChatMessage) {
  return (message.references.length > 0 || (message.documents?.length ?? 0) > 0) && /^请(?:阅读并分析这些文件|看看这张图片)。$/.test(message.prompt);
}
function ratioFromSize(size: string): number {
  const match = size?.match(/^(\d+)x(\d+)$/);
  return match ? Number(match[1]) / Number(match[2]) : 1;
}
function formatElapsed(seconds: number) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${seconds}s`;
}
function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function fileLabel(name: string) {
  const ext = name.split('.').pop();
  return ext && ext !== name ? ext.toUpperCase() : '文件';
}
export function docIcon(name: string, mimeType: string): IconName {
  const kind = attachmentKind(name, mimeType);
  return kind === 'archive' ? 'archive' : kind === 'text' ? 'code' : 'file';
}

const styles = StyleSheet.create({
  userWrap: { alignItems: 'flex-end', gap: 8, paddingLeft: 52 },
  userBubble: { maxWidth: '100%', backgroundColor: colors.userBubble, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22 },
  userText: { color: colors.text, fontSize: 16, lineHeight: 24 },
  userImages: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 },
  userImageFrame: { borderRadius: 18, overflow: 'hidden', backgroundColor: colors.surface },
  userImage: { width: 96, height: 96 },
  userImageLarge: { width: 180, height: 180 },
  maskBadge: { position: 'absolute', left: 8, bottom: 8, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  userDocs: { alignItems: 'flex-end', gap: 6 },
  fileCard: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 260, padding: 8, paddingRight: 14, borderRadius: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  fileIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  fileName: { color: colors.text, fontSize: 13.5, fontWeight: '500' },
  fileMeta: { color: colors.subtle, fontSize: 11.5, marginTop: 2 },
  fileRemove: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' },
  assistantWrap: { gap: 12, alignItems: 'flex-start' },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 28 },
  thinkingText: { color: colors.textMuted, fontSize: 15 },
  canvas: { borderRadius: 22, overflow: 'hidden', backgroundColor: '#F3F2FF' },
  canvasGlass: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(255,255,255,0.18)' },
  drawingCaption: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  drawingText: { color: colors.textSecondary, fontSize: 14.5, fontWeight: '500' },
  drawingSeconds: { color: colors.subtle, fontWeight: '400' },
  stopLink: { marginLeft: 'auto', paddingHorizontal: 12, height: 28, borderRadius: 14, backgroundColor: colors.surfaceStrong, justifyContent: 'center' },
  stopText: { color: colors.textSecondary, fontSize: 12.5, fontWeight: '600' },
  imageCard: { borderRadius: 22, overflow: 'hidden', backgroundColor: colors.surface },
  errorCard: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.dangerSurface },
  errorText: { flex: 1, minWidth: 160, color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  retry: { paddingHorizontal: 4 },
  retryText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  stoppedRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  stoppedText: { color: colors.subtle, fontSize: 14 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: -7, marginTop: -2 },
  actionIcon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});
