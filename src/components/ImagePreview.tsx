import { Ionicons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { colors, radius, spacing } from '../theme';

const MIN_SCALE = 1;
const MAX_SCALE = 5;

export function ImagePreview({ uri, onClose, onReuse }: { uri: string | null; onClose: () => void; onReuse: (uri: string) => void }) {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

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
      translateX.value = savedX.value + event.translationX;
      translateY.value = savedY.value + event.translationY;
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

  return (
    <Modal visible={Boolean(uri)} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.preview}>
        <View style={styles.topBar}>
          <Pressable accessibilityLabel="关闭预览" onPress={onClose} style={styles.iconButton}><Ionicons name="close" size={25} color="#fff" /></Pressable>
          <View style={styles.tip}><Ionicons name="expand-outline" size={15} color="#D7E9FF" /><Text style={styles.tipText}>双指缩放 · 拖动查看 · 双击复位</Text></View>
          <View style={styles.iconSpacer} />
        </View>
        <GestureDetector gesture={gesture}>
          <Animated.View style={styles.imageStage}>
            {uri && <Animated.Image source={{ uri }} style={[styles.previewImage, imageStyle]} resizeMode="contain" />}
          </Animated.View>
        </GestureDetector>
        {uri && (
          <Pressable style={({ pressed }) => [styles.previewReuse, pressed && styles.pressed]} onPress={() => onReuse(uri)}>
            <Ionicons name="images-outline" size={18} color="#fff" />
            <Text style={styles.previewReuseText}>作为参考图</Text>
          </Pressable>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  preview: { flex: 1, backgroundColor: 'rgba(10,15,24,0.98)', alignItems: 'center' },
  topBar: { width: '100%', minHeight: 104, paddingTop: 44, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 2 },
  iconButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.14)' },
  iconSpacer: { width: 44 },
  tip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, minHeight: 34, borderRadius: radius.pill, backgroundColor: 'rgba(78,168,255,.14)' },
  tipText: { color: '#D7E9FF', fontSize: 11, fontWeight: '600' },
  imageStage: { flex: 1, width: '100%', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  previewReuse: { minHeight: 44, marginBottom: 34, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.pill, backgroundColor: colors.primaryStrong },
  previewReuseText: { color: '#fff', fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
