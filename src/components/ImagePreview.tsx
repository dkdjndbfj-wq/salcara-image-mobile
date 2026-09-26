import { Ionicons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { colors, radius, spacing } from '../theme';
import { SafeAreaView } from 'react-native-safe-area-context';

const MIN_SCALE = 1;
const MAX_SCALE = 5;

export function ImagePreview({ uri, onClose, onReuse, onSave, onShare }: { uri: string | null; onClose: () => void; onReuse: (uri: string) => void; onSave?: (uri: string) => void; onShare?: (uri: string) => void }) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);
  const stageWidth = useSharedValue(1);
  const stageHeight = useSharedValue(1);
  const zoom = (delta: number) => {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, savedScale.value + delta));
    savedScale.value = next;
    scale.value = withSpring(next, { damping: 24 });
    translateX.value = withSpring(0); translateY.value = withSpring(0); savedX.value = 0; savedY.value = 0;
  };

  useEffect(() => {
    scale.value = 1;
    savedScale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    savedX.value = 0;
    savedY.value = 0;
  }, [uri, scale, savedScale, translateX, translateY, savedX, savedY]);

  const pinch = Gesture.Pinch()
    .onUpdate((event) => {
      scale.value = Math.max(MIN_SCALE, Math.min(MAX_SCALE, savedScale.value * event.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1) {
        translateX.value = withSpring(0);
        translateY.value = withSpring(0);
        savedX.value = 0;
        savedY.value = 0;
      }
    });

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      if (scale.value <= 1) return;
      const boundX = stageWidth.value * (scale.value - 1) / 2;
      const boundY = stageHeight.value * (scale.value - 1) / 2;
      translateX.value = Math.max(-boundX, Math.min(boundX, savedX.value + event.translationX));
      translateY.value = Math.max(-boundY, Math.min(boundY, savedY.value + event.translationY));
    })
    .onEnd(() => {
      savedX.value = translateX.value;
      savedY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(() => {
    const zoomed = scale.value > 1;
    scale.value = withSpring(zoomed ? 1 : 2.4, { damping: 18, stiffness: 210 });
    savedScale.value = zoomed ? 1 : 2.4;
    if (zoomed) {
      translateX.value = withSpring(0);
      translateY.value = withSpring(0);
      savedX.value = 0;
      savedY.value = 0;
    }
  });

  const gesture = Gesture.Simultaneous(pinch, pan, doubleTap);
  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return <Modal visible={Boolean(uri)} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <GestureHandlerRootView style={styles.modalRoot}>
      <SafeAreaView style={styles.preview}>
        <View style={styles.topBar}>
          <Pressable accessibilityLabel="关闭预览" onPress={onClose} style={styles.iconButton}><Ionicons name="close" size={24} color={colors.text} /></Pressable>
          <Text style={styles.previewTitle}>图片预览</Text>
          {onShare && uri ? <Pressable accessibilityLabel="分享图片" onPress={() => onShare(uri)} style={styles.iconButton}><Ionicons name="share-outline" size={22} color={colors.text} /></Pressable> : <View style={styles.iconButton} />}
        </View>
        <GestureDetector gesture={gesture}>
          <Animated.View style={styles.imageStage} onLayout={(event) => { stageWidth.value = event.nativeEvent.layout.width; stageHeight.value = event.nativeEvent.layout.height; }}>
            {uri && <Animated.Image source={{ uri }} style={[styles.previewImage, imageStyle]} resizeMode="contain" />}
          </Animated.View>
        </GestureDetector>
        <View style={styles.zoomToolbar}>
          <Pressable accessibilityLabel="缩小图片" style={styles.iconButton} onPress={() => zoom(-0.5)}><Ionicons name="remove" size={22} color={colors.text} /></Pressable>
          <Text style={styles.tipText}>双指缩放 · 双击切换</Text>
          <Pressable accessibilityLabel="放大图片" style={styles.iconButton} onPress={() => zoom(0.5)}><Ionicons name="add" size={22} color={colors.text} /></Pressable>
        </View>
        {uri && <View style={styles.bottomBar}>
          {onSave && <Pressable style={styles.saveButton} onPress={() => onSave(uri)}><Ionicons name="download-outline" size={19} color={colors.text} /><Text style={styles.saveText}>保存图片</Text></Pressable>}
          <Pressable style={({ pressed }) => [styles.previewReuse, pressed && { opacity: 0.7 }]} onPress={() => onReuse(uri)}><Ionicons name="sparkles-outline" size={18} color="#fff" /><Text style={styles.previewReuseText}>引用创作</Text></Pressable>
        </View>}
      </SafeAreaView>
    </GestureHandlerRootView>
  </Modal>;
}
const styles = StyleSheet.create({
  modalRoot: { flex: 1 }, preview: { flex: 1, backgroundColor: colors.background, alignItems: 'center' },
  topBar: { width: '100%', minHeight: 60, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 2 },
  previewTitle: { fontSize: 16, color: colors.text, fontWeight: '600' },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  tipText: { color: colors.textMuted, fontSize: 12 },
  imageStage: { flex: 1, width: '100%', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  previewImage: { width: '100%', height: '100%' },
  previewReuse: { flex: 1, minHeight: 48, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 16, borderRadius: 14, backgroundColor: colors.primaryStrong },
  previewReuseText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  zoomToolbar: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 8 },
  bottomBar: { width: '100%', paddingHorizontal: 20, paddingBottom: 12, flexDirection: 'row', gap: 12 },
  saveButton: { flex: 1, minHeight: 48, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, borderRadius: 14 },
  saveText: { color: colors.text, fontSize: 14, fontWeight: '500' },
});
