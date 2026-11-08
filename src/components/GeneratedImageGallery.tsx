import React, { useEffect, useId, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

import type { ChatMessage, GeneratedImage } from '../domain';
import { MAX_GENERATED_IMAGES, messageGeneratedImages } from '../generated-images';
import { colors, themed } from '../theme';
import { Icon } from './Icon';
import { useReducedMotion } from './MotionPressable';

type Props = {
  message: ChatMessage;
  fresh: boolean;
  onPreview: (uri: string, images?: readonly GeneratedImage[]) => void;
  onEdit?: (uri: string) => void;
  onShare?: (uri: string) => void;
  onRetryImage?: (imageId: string, failedUri?: string) => void;
  onStop?: () => void;
  downloading?: boolean;
  /** The existing message toolbar uses the currently selected image. */
  renderActions?: (uri: string | null) => React.ReactNode;
};

function ratioFromSize(size: string): number {
  const match = size?.match(/^(\d+)x(\d+)$/);
  const ratio = match ? Number(match[1]) / Number(match[2]) : 1;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** One image stays prominent; every result retains its own progress and error. */
export function GeneratedImageGallery(props: Props) {
  const images = messageGeneratedImages(props.message).slice(0, MAX_GENERATED_IMAGES);
  // A regeneration reuses the message and image IDs. A completely new pending
  // batch has no delivered artifacts; a download retry retains its remote URL.
  const preparing = props.message.status === 'pending' && images.every((image) => image.status === 'pending' && !image.uri && !image.remoteUrl);
  const [batch, setBatch] = useState({ preparing, serial: 0 });
  let serial = batch.serial;
  if (batch.preparing !== preparing) {
    serial += preparing ? 1 : 0;
    setBatch({ preparing, serial });
  }
  return <ImageGalleryContent key={`${props.message.id}:${serial}`} {...props} images={images} />;
}

function ImageGalleryContent({ message, images, fresh, onPreview, onEdit, onShare, onRetryImage, onStop, downloading, renderActions }: Props & { images: GeneratedImage[] }) {
  const styles = useStyles();
  const { width: windowWidth } = useWindowDimensions();
  const [availableWidth, setAvailableWidth] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const [measured, setMeasured] = useState<{ uri: string; ratio: number } | null>(null);
  const [unreadable, setUnreadable] = useState<Record<string, string>>({});
  const thumbnails = useRef<ScrollView>(null);
  const firstComplete = images.find((image) => image.status === 'complete' && image.uri);
  const firstCompleteId = firstComplete?.id;
  const selected = images.find((image) => image.id === selection)
    ?? firstComplete
    ?? images[0];
  const index = images.findIndex((image) => image.id === selected?.id);
  const uri = selected?.status === 'complete' ? selected.uri : null;
  const failedToLoad = Boolean(uri && selected && unreadable[selected.id] === uri);
  const usableUri = failedToLoad ? null : uri;
  const failed = selected?.status === 'error' || failedToLoad;
  const pending = selected?.status === 'pending';
  const multiple = images.length > 1;
  const width = Math.max(1, Math.min(availableWidth || Math.max(1, windowWidth - 40), 520));
  // Batches lay their results out as a grid under the selected image (ChatGPT-style).
  const gap = 6;
  const columns = width >= 360 ? 5 : 4;
  const thumbnailSize = Math.max(44, Math.floor((width - gap * (columns - 1)) / columns));
  const mainWidth = width;
  const ratio = uri && measured?.uri === uri ? measured.ratio : ratioFromSize(message.size);
  const height = Math.max(failed ? 220 : pending ? 144 : 1, Math.min(mainWidth / ratio, multiple ? 420 : 520));
  const working = message.status === 'pending' && images.some((image) => image.status === 'pending');
  const done = images.filter((image) => image.status === 'complete' && image.uri).length;

  useEffect(() => {
    // Pin the first success once. Later arrivals must not steal either the
    // automatic preview or a thumbnail the user explicitly chose while pending.
    if (firstCompleteId) setSelection((current) => current ?? firstCompleteId);
  }, [firstCompleteId]);
  useEffect(() => {
    if (!uri) return;
    let active = true;
    Image.getSize(uri, (w, h) => {
      if (active && w > 0 && h > 0 && Number.isFinite(w / h)) setMeasured({ uri, ratio: w / h });
    }, () => undefined);
    return () => { active = false; };
  }, [uri]);

  if (!selected) return null;
  const retry = () => {
    // Keep the old file marked unreadable until a replacement URI arrives.
    onRetryImage?.(selected.id, failedToLoad && uri ? uri : undefined);
  };
  return <View testID="generated-image-gallery" style={styles.gallery} onLayout={(event) => {
    const next = Math.floor(event.nativeEvent.layout.width);
    if (next > 0 && next !== availableWidth) setAvailableWidth(next);
  }}>
    {working && multiple ? <View style={styles.batchHead} accessibilityLiveRegion="polite">
      <Icon name="sparkle" size={14} color={colors.primary} />
      <Text style={styles.batchTitle}>正在生成 {images.length} 张图片</Text>
      <Text style={styles.batchCount}>{done} / {images.length}</Text>
    </View> : null}
    {working && multiple ? <View style={[styles.batchTrack, { width }]}><BatchProgress value={images.length ? done / images.length : 0} width={width} /></View> : null}
    <View style={[styles.row, { width, gap: 8 }]}>
      <View testID="generated-image-stage" style={[styles.stage, { width: mainWidth, height, borderRadius: width < 320 ? 14 : 16 }]}>
        {usableUri ? <ImageArtwork key={`${message.id}:${selected.id}:${usableUri}`} uri={usableUri} width={mainWidth} height={height}
          fresh={fresh && Date.now() - message.createdAt - (message.elapsedMs ?? 0) < 8000}
          label={multiple ? `查看第 ${index + 1} 张大图` : '查看大图'} onPreview={(value) => onPreview(value, images.map((image) => unreadable[image.id] === image.uri ? { ...image, status: 'error' } : image))}
          onError={() => setUnreadable((current) => ({ ...current, [selected.id]: usableUri }))} />
          : <View style={styles.status} accessibilityLiveRegion="polite">
            {pending ? <ActivityIndicator color={colors.primary} /> : <Icon name="alert" size={24} color={colors.danger} />}
            <Text style={styles.statusTitle}>{pending ? downloading ? '正在取回图片' : '正在绘制' : failedToLoad ? '图片无法显示' : selected.remoteUrl ? '图片未下载' : '生成失败'}</Text>
            {failed && selected.error ? <ScrollView style={styles.errorDetail} contentContainerStyle={styles.errorDetailContent} nestedScrollEnabled>
              <Text selectable style={styles.errorText}>{selected.error}</Text>
            </ScrollView> : null}
            {failed && selected.remoteUrl && onRetryImage ? <Pressable accessibilityRole="button" accessibilityLabel={`重新下载第 ${index + 1} 张图片`} onPress={retry} style={styles.retry}>
              <Icon name="download" size={16} color={colors.primary} /><Text style={styles.retryText}>重新下载</Text>
            </Pressable> : null}
          </View>}
        {multiple ? <View pointerEvents="none" style={styles.counter}><Text style={styles.counterText}>{index + 1} / {images.length}</Text></View> : null}
        {usableUri && (onEdit || onShare) ? <View pointerEvents="box-none" style={styles.overlayActions}>
          {onEdit ? <Pressable accessibilityRole="button" accessibilityLabel="编辑当前图片" onPress={() => onEdit(usableUri)} style={({ pressed }) => [styles.edit, pressed && styles.pressed]}>
            <View style={styles.editSurface}><Text style={styles.editText}>编辑</Text></View>
          </Pressable> : <View />}
          {onShare ? <Pressable accessibilityRole="button" accessibilityLabel="分享当前图片" onPress={() => onShare(usableUri)} style={({ pressed }) => [styles.share, pressed && styles.pressed]}>
            <View style={styles.shareSurface}><Icon name="share" size={18} color="#FFFFFF" /></View>
          </Pressable> : null}
        </View> : null}
      </View>
      {multiple ? <ScrollView ref={thumbnails} testID="generated-image-thumbnails" style={{ width, maxWidth: width, flexGrow: 0 }} scrollEnabled={false}
        contentContainerStyle={[styles.thumbnails, { gap }]} showsVerticalScrollIndicator={false} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {images.map((image, position) => {
          const broken = image.status === 'error' || Boolean(image.uri && unreadable[image.id] === image.uri);
          const complete = image.status === 'complete' && image.uri && !broken;
          return <Pressable key={image.id} accessibilityRole="button" accessibilityLabel={`第 ${position + 1} 张图片`}
            accessibilityHint={complete ? '已生成' : broken ? image.remoteUrl ? '图片未下载' : '生成失败' : '生成中'} accessibilityState={{ selected: selected.id === image.id }}
            onPress={() => setSelection(image.id)}
            style={({ pressed }) => [styles.thumbnail, { width: thumbnailSize, height: thumbnailSize }, selected.id === image.id && styles.thumbnailSelected, pressed && styles.pressed]}>
            {complete ? <Image source={{ uri: image.uri! }} style={styles.thumbnailImage} resizeMode="cover" />
              : image.status === 'pending' ? <Developing size={thumbnailSize} seed={position} />
                : <Icon name="alert" size={18} color={colors.danger} />}
          </Pressable>;
        })}
      </ScrollView> : null}
    </View>
    {working ? <View style={styles.progress}>
      <Text style={styles.progressText}>{done} / {images.length} 已完成</Text>
      {onStop ? <Pressable accessibilityRole="button" accessibilityLabel="停止绘制" onPress={onStop} style={styles.stop}><Text style={styles.stopText}>停止</Text></Pressable> : null}
    </View> : null}
    {!working && message.imageCount && images.length > message.imageCount
      ? <Text style={styles.progressText}>请求 {message.imageCount} 张 · 返回 {images.length} 张</Text> : null}
    {renderActions?.(usableUri)}
  </View>;
}

/** A thin brand-gradient bar for batch progress. */
function BatchProgress({ value, width }: { value: number; width: number }) {
  const id = `batch-progress-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const filled = Math.max(6, Math.round(width * Math.min(1, Math.max(0, value))));
  return <Svg width={width} height={3}>
    <Defs><LinearGradient id={id} x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#7CC6FF" /><Stop offset="0.5" stopColor="#3D7BFA" /><Stop offset="1" stopColor="#A68BF7" /></LinearGradient></Defs>
    <Rect x={0} y={0} width={filled} height={3} rx={1.5} fill={`url(#${id})`} />
  </Svg>;
}

/** A result still being drawn: a soft, blurred colour field that slowly breathes. */
function Developing({ size, seed }: { size: number; seed: number }) {
  const reduced = useReducedMotion();
  const id = `developing-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    if (reduced) return undefined;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.55, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduced, pulse]);
  const palette = [['#F2A065', '#F7C6D9'], ['#9FD8C8', '#B9C4FA'], ['#A68BF7', '#7CC6FF'], ['#F4A6CE', '#FFD9BD']][seed % 4];
  return <Animated.View accessible={false} style={[StyleSheet.absoluteFill, { opacity: pulse }]}>
    <Svg width={size} height={size}><Defs>
      <RadialGradient id={`${id}a`} cx="38%" cy="42%" r="60%"><Stop offset="0" stopColor={palette[0]} stopOpacity="0.9" /><Stop offset="1" stopColor={palette[0]} stopOpacity="0" /></RadialGradient>
      <RadialGradient id={`${id}b`} cx="68%" cy="66%" r="60%"><Stop offset="0" stopColor={palette[1]} stopOpacity="0.9" /><Stop offset="1" stopColor={palette[1]} stopOpacity="0" /></RadialGradient>
    </Defs><Rect width={size} height={size} fill={`url(#${id}a)`} /><Rect width={size} height={size} fill={`url(#${id}b)`} /></Svg>
  </Animated.View>;
}

/** Keep the existing soft reveal, including the light sweep on a fresh result. */
function ImageArtwork({ uri, width, height, fresh, label, onPreview, onError }: {
  uri: string; width: number; height: number; fresh: boolean; label: string;
  onPreview: (uri: string) => void; onError: () => void;
}) {
  const reduced = useReducedMotion();
  // Image IDs repeat across messages, and SVG paint servers share a document namespace on web.
  const id = `image-artwork-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const active = useRef(true);
  const [develop] = useState(() => fresh && !reduced);
  const reveal = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const band = Math.max(width, height) * 0.5;
  const orb = Math.max(width, height) * 0.95;
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; reveal.stopAnimation(); sweep.stopAnimation(); };
  }, [reveal, sweep]);
  const onLoad = () => {
    if (!active.current) return;
    if (reduced) { reveal.setValue(1); return; }
    if (!develop) { Animated.timing(reveal, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(); return; }
    Animated.parallel([
      Animated.timing(reveal, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.sequence([Animated.delay(360), Animated.timing(sweep, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true })]),
    ]).start();
  };
  return <>
    {develop ? <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {(['#8CCBFF', '#B9A2FF', '#FBC2DF'] as const).map((color, index) => <View key={color} style={{ position: 'absolute', left: width * [0.2, 0.8, 0.45][index] - orb / 2, top: height * [0.2, 0.65, 0.9][index] - orb / 2 }}>
        <Svg width={orb} height={orb}><Defs><RadialGradient id={`orb${index}${id}`} cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor={color} stopOpacity="0.95" /><Stop offset="1" stopColor={color} stopOpacity="0" /></RadialGradient></Defs><Circle cx={orb / 2} cy={orb / 2} r={orb / 2} fill={`url(#orb${index}${id})`} /></Svg>
      </View>)}
    </View> : null}
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: reveal, transform: [{ scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [develop ? 1.06 : 0.98, 1] }) }] }]}>
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={label} onPress={() => onPreview(uri)} style={StyleSheet.absoluteFill}>
        <Image testID="generated-image-main" source={{ uri }} resizeMode="contain" style={StyleSheet.absoluteFill} onLoad={onLoad} onError={() => { if (active.current) onError(); }} />
      </Pressable>
    </Animated.View>
    {develop ? <Animated.View pointerEvents="none" style={{ position: 'absolute', top: -height * 0.25, height: height * 1.5, width: band,
      opacity: sweep.interpolate({ inputRange: [0, 0.15, 0.85, 1], outputRange: [0, 1, 1, 0] }),
      transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-band * 1.2, width + band * 0.2] }) }, { rotate: '18deg' }],
    }}><Svg width={band} height={height * 1.5}><Defs><LinearGradient id={`sweep${id}`} x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} /><Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.38} /><Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} /></LinearGradient></Defs><Rect width={band} height={height * 1.5} fill={`url(#sweep${id})`} /></Svg></Animated.View> : null}
  </>;
}

const useStyles = themed((c) => StyleSheet.create({
  gallery: { alignSelf: 'stretch', width: '100%', maxWidth: '100%', minWidth: 0, gap: 8 },
  row: { flexDirection: 'column', alignItems: 'flex-start', maxWidth: '100%' },
  batchHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  batchTitle: { flex: 1, color: c.text, fontSize: 14, fontWeight: '500' },
  batchCount: { color: c.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
  batchTrack: { height: 3, borderRadius: 1.5, overflow: 'hidden', backgroundColor: c.surfaceStrong },
  stage: { maxWidth: '100%', flexShrink: 1, overflow: 'hidden', backgroundColor: c.surface },
  thumbnails: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 1 },
  thumbnail: { flexShrink: 0, borderRadius: 12, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: c.surface },
  thumbnailSelected: { borderColor: c.text },
  thumbnailImage: { width: '100%', height: '100%', borderRadius: 10 },
  counter: { position: 'absolute', top: 8, left: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(15, 19, 30, 0.56)' },
  counterText: { color: '#FFFFFF', fontSize: 11, fontWeight: '600', fontVariant: ['tabular-nums'] },
  overlayActions: { position: 'absolute', bottom: 4, left: 4, right: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  edit: { minWidth: 44, minHeight: 44, padding: 4, alignItems: 'center', justifyContent: 'center' },
  editSurface: { minWidth: 52, minHeight: 36, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(29, 29, 37, 0.62)' },
  editText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  share: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  shareSurface: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(29, 29, 37, 0.62)' },
  pressed: { opacity: 0.75 },
  status: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 14, paddingTop: 34, gap: 9 },
  statusTitle: { fontSize: 13, color: c.textMuted, textAlign: 'center' },
  errorDetail: { maxHeight: 100, flexShrink: 1, alignSelf: 'stretch' },
  errorDetailContent: { alignItems: 'center' },
  errorText: { color: c.textMuted, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  retry: { minHeight: 44, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, borderRadius: 22, backgroundColor: c.primarySoft },
  retryText: { color: c.primary, fontSize: 12, fontWeight: '600' },
  progress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 28 },
  progressText: { color: c.subtle, fontSize: 12 },
  stop: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  stopText: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
}));
