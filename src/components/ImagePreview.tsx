import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { retainCachedAttachment } from '../remote/attachment-cache-policy';
import { useManagedImage } from '../remote/useManagedImage';
import { ManagedImage } from '../remote/ManagedImage';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import type { GeneratedImage } from '../domain';
import { themed } from '../theme';
import { ToolbarMenu } from '../remote/WorkbenchToolbar';
import { Icon } from './Icon';
import { ToastHost } from './ui';
import { SafeAreaView } from 'react-native-safe-area-context';

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const SWIPE_DISTANCE = 48;
const SWIPE_HORIZONTAL_RATIO = 1.4;
const SWIPE_SCALE_TOLERANCE = 0.01;

export type ImageViewState = { uri: string; scale: number; x: number; y: number };
type Props = {
  uri: string | null;
  images?: readonly GeneratedImage[];
  onSelect?: (uri: string) => void;
  onClose: () => void;
  onSave?: (uri: string) => void;
  onShare?: (uri: string) => void;
  /** Offered by conversation image viewers, after opening a concrete image. */
  onOpenCanvas?: (uri: string, view: ImageViewState) => void;
  initialView?: ImageViewState;
  pendingAction?: 'save' | 'share' | null;
};

export function ImagePreview({ uri, images, onSelect, onClose, onSave, onShare, onOpenCanvas, initialView, pendingAction }: Props) {
  useEffect(() => retainCachedAttachment(uri ?? undefined), [uri]);
  const styles = useStyles();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const stageWidth = useSharedValue(1);
  const stageHeight = useSharedValue(1);
  const imageWidth = useSharedValue(0);
  const imageHeight = useSharedValue(0);
  const pinching = useSharedValue(false);
  const swipeAllowed = useSharedValue(false);
  const scopeVersion = useSharedValue(0);
  const swipeVersion = useSharedValue(0);
  // Preserve gallery positions while excluding unavailable results from navigation.
  const index = uri ? images?.findIndex((image) => image.uri === uri) ?? -1 : -1;
  const previousUri = index >= 0 ? images?.slice(0, index).reverse().find((image) => image.status === 'complete' && image.uri && image.uri !== uri)?.uri : null;
  const nextUri = index >= 0 ? images?.slice(index + 1).find((image) => image.status === 'complete' && image.uri && image.uri !== uri)?.uri : null;
  const multiple = index >= 0 && (images?.length ?? 0) > 1;
  // A new array instance with the same slots is harmless. URI, order, or status
  // changes invalidate queued gestures, including A -> B -> A transitions.
  const batchSignature = JSON.stringify(images?.map((image) => [image.id, image.status, image.uri ?? null]) ?? []);
  const scope = useMemo(() => ({ uri, batchSignature }), [uri, batchSignature]);
  const [menuScope, setMenuScope] = useState<typeof scope | null>(null);
  const [toolbarWidth, setToolbarWidth] = useState(0);
  const wideToolbar = toolbarWidth >= 600;
  const menuAnchor = useRef<View>(null);
  const menuOpenScope = useRef<typeof scope | null>(null), menuDismissScope = useRef<typeof scope | null>(null);
  const menuDismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeScope = useRef<typeof scope | null>(null);
  const version = useRef(0);
  const requestedScope = useRef<typeof scope | null>(null);
  const select = useRef(onSelect);
  useLayoutEffect(() => { select.current = onSelect; }, [onSelect]);
  useLayoutEffect(() => {
    activeScope.current = scope;
    menuOpenScope.current = null; menuDismissScope.current = null;
    requestedScope.current = null;
    scopeVersion.value = ++version.current;
    swipeAllowed.value = false;
    return () => {
      clearTimeout(menuDismissTimer.current);
      if (activeScope.current === scope) activeScope.current = null;
      scopeVersion.value = ++version.current;
      swipeAllowed.value = false;
    };
  }, [scope, scopeVersion, swipeAllowed]);
  const selectAdjacent = useCallback((direction: -1 | 1, expectedVersion?: number) => {
    if (!uri || activeScope.current !== scope || requestedScope.current === scope || !select.current) return;
    if (expectedVersion !== undefined && (expectedVersion !== version.current || pinching.value
      || scale.value > MIN_SCALE + SWIPE_SCALE_TOLERANCE || savedScale.value > MIN_SCALE + SWIPE_SCALE_TOLERANCE)) return;
    const target = direction === -1 ? previousUri : nextUri;
    if (!target) return;
    // Until the controlled URI updates, repeated native callbacks cannot advance twice.
    requestedScope.current = scope;
    select.current(target);
  }, [uri, scope, previousUri, nextUri, pinching, scale, savedScale]);
  const close = () => {
    if (activeScope.current !== scope) return;
    setMenuScope(null);
    menuOpenScope.current = null; menuDismissScope.current = null;
    clearTimeout(menuDismissTimer.current);
    activeScope.current = null;
    scopeVersion.value = ++version.current;
    swipeAllowed.value = false;
    onClose();
  };
  const dismissMenu = () => {
    if (activeScope.current !== scope) return;
    menuOpenScope.current = null;
    // RNWeb can notify both nested Modals for one Escape keyup. Keep this
    // dismissal owned by the menu until that event dispatch has completed.
    menuDismissScope.current = scope;
    clearTimeout(menuDismissTimer.current);
    menuDismissTimer.current = setTimeout(() => { if (menuDismissScope.current === scope) menuDismissScope.current = null; }, 0);
    setMenuScope(null);
  };
  const requestClose = () => {
    if (menuOpenScope.current === scope || menuDismissScope.current === scope || menuScope === scope) { dismissMenu(); return; }
    close();
  };
  const measuredUri = useRef<string | null>(null);
  const initialPosition = useRef(initialView);
  const preview = useManagedImage(uri, 'preview');
  const shown = preview.uri;
  const zoom = (delta: number) => {
    if (!uri || activeScope.current !== scope) return;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, savedScale.value + delta));
    savedScale.value = next;
    scale.value = withSpring(next, { damping: 24, overshootClamping: true });
    translateX.value = withSpring(0); translateY.value = withSpring(0);
  };

  const boundedTransform = () => {
    'worklet';
    // The image is contained inside the stage. Letterboxing must not become
    // draggable space, otherwise a wide or tall image can disappear offscreen.
    const fit = imageWidth.value > 0 && imageHeight.value > 0
      ? Math.min(stageWidth.value / imageWidth.value, stageHeight.value / imageHeight.value) : 0;
    const width = fit ? imageWidth.value * fit : stageWidth.value;
    const height = fit ? imageHeight.value * fit : stageHeight.value;
    const zoom = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale.value));
    const boundX = Math.max(0, (width * zoom - stageWidth.value) / 2);
    const boundY = Math.max(0, (height * zoom - stageHeight.value) / 2);
    return { scale: zoom, x: Math.max(-boundX, Math.min(boundX, translateX.value)), y: Math.max(-boundY, Math.min(boundY, translateY.value)) };
  };
  const constrainPosition = () => {
    'worklet';
    const position = boundedTransform();
    translateX.value = position.x; translateY.value = position.y;
  };

  useLayoutEffect(() => {
    if (!uri) return;
    const restore = initialPosition.current?.uri === uri ? initialPosition.current : undefined;
    const restoredScale = restore && Number.isFinite(restore.scale) ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, restore.scale)) : 1;
    scale.value = restoredScale;
    savedScale.value = restoredScale;
    translateX.value = restore && Number.isFinite(restore.x) ? restore.x : 0;
    translateY.value = restore && Number.isFinite(restore.y) ? restore.y : 0;
    initialPosition.current = undefined;
    pinching.value = false;
    if (measuredUri.current !== uri) {
      measuredUri.current = uri;
      imageWidth.value = 0;
      imageHeight.value = 0;
    }
  }, [uri, scale, savedScale, translateX, translateY, pinching, imageWidth, imageHeight]);

  const pinch = Gesture.Pinch()
    .enabled(Boolean(uri))
    .onStart(() => {
      cancelAnimation(scale);
      cancelAnimation(translateX);
      cancelAnimation(translateY);
      constrainPosition();
      savedScale.value = scale.value;
      pinching.value = true;
      swipeAllowed.value = false;
    })
    .onUpdate((event) => {
      scale.value = Math.max(MIN_SCALE, Math.min(MAX_SCALE, savedScale.value * event.scale));
      constrainPosition();
    })
    .onFinalize(() => {
      if (!pinching.value) return;
      pinching.value = false;
      savedScale.value = scale.value;
      constrainPosition();
    });

  const pan = Gesture.Pan()
    .enabled(Boolean(uri))
    .averageTouches(true)
    .onBegin((event) => {
      swipeVersion.value = scopeVersion.value;
      swipeAllowed.value = event.numberOfPointers === 1 && !pinching.value
        && scale.value <= MIN_SCALE + SWIPE_SCALE_TOLERANCE && savedScale.value <= MIN_SCALE + SWIPE_SCALE_TOLERANCE;
    })
    .onTouchesDown((event) => {
      if (event.numberOfTouches > 1) swipeAllowed.value = false;
    })
    .onStart(() => {
      cancelAnimation(translateX);
      cancelAnimation(translateY);
      constrainPosition();
    })
    .onChange((event) => {
      if (event.numberOfPointers !== 1 || pinching.value || scale.value > MIN_SCALE + SWIPE_SCALE_TOLERANCE
        || savedScale.value > MIN_SCALE + SWIPE_SCALE_TOLERANCE) swipeAllowed.value = false;
      if (scale.value <= 1) return;
      translateX.value += event.changeX;
      translateY.value += event.changeY;
      constrainPosition();
    })
    .onEnd((event, success) => {
      const allowed = swipeAllowed.value;
      swipeAllowed.value = false;
      if (!success || !allowed || swipeVersion.value !== scopeVersion.value || pinching.value || event.numberOfPointers > 1
        || scale.value > MIN_SCALE + SWIPE_SCALE_TOLERANCE || savedScale.value > MIN_SCALE + SWIPE_SCALE_TOLERANCE) return;
      const horizontal = Math.abs(event.translationX);
      const vertical = Math.abs(event.translationY);
      if (!Number.isFinite(horizontal) || !Number.isFinite(vertical) || horizontal < SWIPE_DISTANCE || horizontal < vertical * SWIPE_HORIZONTAL_RATIO) return;
      runOnJS(selectAdjacent)(event.translationX < 0 ? 1 : -1, swipeVersion.value);
    })
    .onFinalize(() => {
      swipeAllowed.value = false;
    });

  const doubleTap = Gesture.Tap().enabled(Boolean(uri)).numberOfTaps(2).onEnd((_event, success) => {
    if (!success) return;
    swipeAllowed.value = false;
    const zoomed = scale.value > 1;
    scale.value = withSpring(zoomed ? 1 : 2.4, { damping: 18, stiffness: 210, overshootClamping: true });
    savedScale.value = zoomed ? 1 : 2.4;
    translateX.value = withSpring(0);
    translateY.value = withSpring(0);
  });

  const gesture = Gesture.Simultaneous(pinch, pan, doubleTap);
  const imageStyle = useAnimatedStyle(() => {
    // Scale and translation springs can advance at different rates; constrain
    // each rendered frame as well as the gesture's next starting position.
    const position = boundedTransform();
    return { transform: [{ translateX: position.x }, { translateY: position.y }, { scale: position.scale }] };
  });

  return <Modal visible={Boolean(uri)} transparent animationType="fade" onRequestClose={requestClose} statusBarTranslucent>
    <GestureHandlerRootView style={styles.modalRoot}>
      <StatusBar style="light" />
      <SafeAreaView style={styles.preview}>
        <View testID="image-preview-toolbar" style={styles.topBar} onLayout={event=>setToolbarWidth(event.nativeEvent.layout.width)}>
            <Pressable accessibilityRole="button" accessibilityLabel="关闭预览" onPress={close} style={styles.glass}><Icon name="close" size={18} color="#fff" /></Pressable>
            {multiple ? <Pressable accessibilityRole="button" accessibilityLabel="上一张图片" accessibilityState={{disabled:!previousUri||!onSelect}} disabled={!previousUri||!onSelect} onPress={()=>selectAdjacent(-1)} style={[styles.glass,(!previousUri||!onSelect)&&styles.navigationDisabled]}><Icon name="chevronLeft" size={18} color="#fff"/></Pressable> : null}
            <View style={styles.titleBlock}>
              {multiple ? <Text numberOfLines={1} accessibilityLiveRegion="polite" accessibilityLabel={`第 ${index + 1} 张，共 ${images!.length} 张`} style={styles.pageNumber}>{index + 1} / {images!.length}</Text> : <Text numberOfLines={1} style={styles.pageNumber}>图片预览</Text>}
              {pendingAction ? <Text numberOfLines={1} accessibilityLiveRegion="polite" style={styles.pendingText}>{pendingAction === 'save' ? '保存中…' : '分享中…'}</Text> : null}
            </View>
            {multiple ? <Pressable accessibilityRole="button" accessibilityLabel="下一张图片" accessibilityState={{disabled:!nextUri||!onSelect}} disabled={!nextUri||!onSelect} onPress={()=>selectAdjacent(1)} style={[styles.glass,(!nextUri||!onSelect)&&styles.navigationDisabled]}><Icon name="chevronRight" size={18} color="#fff"/></Pressable> : null}
            {wideToolbar ? <View style={styles.zoomGroup}><Pressable accessibilityRole="button" accessibilityLabel="缩小图片" style={styles.glass} onPress={()=>zoom(-.5)}><Icon name="zoomOut" size={18} color="#fff"/></Pressable><Pressable accessibilityRole="button" accessibilityLabel="放大图片" style={styles.glass} onPress={()=>zoom(.5)}><Icon name="zoomIn" size={18} color="#fff"/></Pressable></View> : null}
            {onOpenCanvas ? <Pressable accessibilityRole="button" accessibilityLabel="打开图片画布" onPress={() => {
              if (!uri || activeScope.current !== scope) return;
              activeScope.current = null;
              scopeVersion.value = ++version.current;
              swipeAllowed.value = false;
              onOpenCanvas(uri, { uri, ...boundedTransform() });
            }} style={wideToolbar?styles.canvasButton:styles.glass}><Icon name="imageCanvas" size={18} color="#fff"/>{wideToolbar?<Text style={styles.canvasText}>画布</Text>:null}</Pressable> : null}
            <Pressable ref={menuAnchor} collapsable={false} accessibilityRole="button" accessibilityLabel="图片更多操作" accessibilityState={{expanded:menuScope===scope}} onPress={()=>{if(activeScope.current!==scope)return;menuOpenScope.current=scope;menuDismissScope.current=null;clearTimeout(menuDismissTimer.current);setMenuScope(scope);}} style={styles.glass}><Icon name="more" size={18} color="#fff"/></Pressable>
        </View>
        <GestureDetector gesture={gesture}>
          <Animated.View testID="image-preview-stage" style={styles.imageStage} onLayout={(event) => {
            const { width, height } = event.nativeEvent.layout;
            if (width <= 0 || height <= 0) return;
            stageWidth.value = width; stageHeight.value = height; constrainPosition();
          }}>
            {shown && <Animated.Image key={shown} testID="image-preview-image" source={{ uri: shown }} style={[styles.previewImage, imageStyle]} resizeMode="contain" onLoad={(event) => {
              if (activeScope.current !== scope || !uri || shown !== preview.uri) return;
              const loaded = event.nativeEvent as { source?: { width: number; height: number }; target?: { naturalWidth: number; naturalHeight: number } };
              const width = loaded.source?.width ?? loaded.target?.naturalWidth;
              const height = loaded.source?.height ?? loaded.target?.naturalHeight;
              if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
              imageWidth.value = width; imageHeight.value = height; constrainPosition();
            }} />}
            {preview.error ? <Text accessibilityRole="alert" style={{color:'#fff',padding:24,textAlign:'center'}}>{preview.error}</Text> : preview.loading ? <ActivityIndicator color="#fff" /> : null}
          </Animated.View>
        </GestureDetector>
        {images && images.length > 1 && onSelect ? <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filmstrip} contentContainerStyle={styles.filmstripContent}>
          {images.map((image, position) => {
            const ready = image.status === 'complete' && Boolean(image.uri);
            const current = position === index;
            return <Pressable key={image.id} accessibilityRole="button" accessibilityLabel={`查看第 ${position + 1} 张`} accessibilityState={{ selected: current, disabled: !ready }}
              disabled={!ready} onPress={() => { if (image.uri && activeScope.current === scope) onSelect(image.uri); }}
              style={[styles.film, current && styles.filmCurrent, !ready && { opacity: 0.35 }]}>
              {ready ? <ManagedImage uri={image.uri!} style={styles.filmImage} resizeMode="cover" /> : <ActivityIndicator size="small" color="#fff" />}
            </Pressable>;
          })}
        </ScrollView> : null}
        <ToolbarMenu visible={Boolean(uri)&&menuScope===scope} anchorRef={menuAnchor} onClose={dismissMenu} label="图片操作" testID="image-preview-menu" actions={[
          ...(!wideToolbar?[
            {label:'放大图片',icon:'zoomIn' as const,onPress:()=>zoom(.5)},
            {label:'缩小图片',icon:'zoomOut' as const,onPress:()=>zoom(-.5)},
          ]:[]),
          ...(onSave?[{label:'保存图片',icon:'download' as const,disabled:!uri||Boolean(pendingAction),onPress:()=>{if(uri&&activeScope.current===scope)onSave(uri);}}]:[]),
          ...(onShare?[{label:'分享图片',icon:'share' as const,disabled:!uri||Boolean(pendingAction),onPress:()=>{if(uri&&activeScope.current===scope)onShare(uri);}}]:[]),
          {label:'重置缩放',icon:'fitFrame',onPress:()=>{if(activeScope.current!==scope)return;savedScale.value=1;scale.value=withSpring(1);translateX.value=withSpring(0);translateY.value=withSpring(0);}},
        ]}/>
      </SafeAreaView>
      <ToastHost />
    </GestureHandlerRootView>
  </Modal>;
}
const useStyles = themed(() => StyleSheet.create({
  modalRoot: { flex: 1 }, preview: { flex: 1, backgroundColor: '#05080F', alignItems: 'center' },
  topBar: { width: '100%', minHeight: 56, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap:4, zIndex: 2 },
  zoomGroup: { flexDirection: 'row', gap: 4 },
  titleBlock:{flex:1,minWidth:0,alignItems:'center',gap:2},pendingText:{fontSize:11,color:'#bbb'},
  canvasButton: { minHeight: 44, flexShrink:0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, borderRadius: 8 },
  canvasText: { color: '#fff', fontSize: 12, fontWeight: '500' },
  navigationDisabled: { opacity: 0.25 },
  pageNumber: { minWidth: 40, color: '#fff', textAlign: 'center', fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  glass: { width: 44, height: 44, flexShrink:0, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  imageStage: { flex: 1, width: '100%', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  filmstrip: { flexGrow: 0, width: '100%', marginVertical: 8 },
  filmstripContent: { paddingHorizontal: 16, gap: 6 },
  film: { width: 46, height: 46, borderRadius: 11, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', opacity: 0.6 },
  filmCurrent: { opacity: 1, borderWidth: 2, borderColor: '#FFFFFF' },
  filmImage: { width: '100%', height: '100%' },
}));
