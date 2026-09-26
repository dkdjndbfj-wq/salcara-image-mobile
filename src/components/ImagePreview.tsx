import React, { useEffect } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { colors, radius } from '../theme';
import { Icon } from './Icon';
import { SafeAreaView } from 'react-native-safe-area-context';

const MIN_SCALE = 1;
const MAX_SCALE = 5;

export function ImagePreview({ uri, onClose, onSave, onShare }: { uri: string | null; onClose: () => void; onSave?: (uri: string) => void; onShare?: (uri: string) => void }) {
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
          <Pressable accessibilityLabel="关闭预览" onPress={onClose} style={styles.glass}><Icon name="close" size={20} color="#fff" strokeWidth={2} /></Pressable>
          <View style={styles.zoomGroup}>
            <Pressable accessibilityLabel="缩小图片" style={styles.glass} onPress={() => zoom(-0.5)}><Icon name="minus" size={20} color="#fff" strokeWidth={2} /></Pressable>
            <Pressable accessibilityLabel="放大图片" style={styles.glass} onPress={() => zoom(0.5)}><Icon name="plus" size={20} color="#fff" strokeWidth={2} /></Pressable>
          </View>
        </View>
        <GestureDetector gesture={gesture}>
          <Animated.View style={styles.imageStage} onLayout={(event) => { stageWidth.value = event.nativeEvent.layout.width; stageHeight.value = event.nativeEvent.layout.height; }}>
            {uri && <Animated.Image source={{ uri }} style={[styles.previewImage, imageStyle]} resizeMode="contain" />}
          </Animated.View>
        </GestureDetector>
        {uri && <View style={styles.bottomBar}>
          {onSave && <Pressable accessibilityRole="button" style={({ pressed }) => [styles.action, styles.actionPrimary, pressed && { opacity: 0.85 }]} onPress={() => onSave(uri)}><Icon name="download" size={19} color={colors.text} strokeWidth={1.9} /><Text style={styles.actionTextDark}>保存</Text></Pressable>}
          {onShare && <Pressable accessibilityRole="button" style={({ pressed }) => [styles.action, pressed && { opacity: 0.85 }]} onPress={() => onShare(uri)}><Icon name="share" size={19} color="#fff" strokeWidth={1.9} /><Text style={styles.actionText}>分享</Text></Pressable>}
        </View>}
      </SafeAreaView>
    </GestureHandlerRootView>
  </Modal>;
}
const styles = StyleSheet.create({
  modalRoot: { flex: 1 }, preview: { flex: 1, backgroundColor: '#05080F', alignItems: 'center' },
  topBar: { width: '100%', minHeight: 60, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 2 },
  zoomGroup: { flexDirection: 'row', gap: 8 },
  glass: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.12)' },
  imageStage: { flex: 1, width: '100%', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  bottomBar: { width: '100%', paddingHorizontal: 20, paddingVertical: 14, flexDirection: 'row', gap: 10 },
  action: { flex: 1, height: 52, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.12)' },
  actionPrimary: { backgroundColor: '#FFFFFF' },
  actionText: { color: '#fff', fontSize: 15.5, fontWeight: '600' },
  actionTextDark: { color: colors.text, fontSize: 15.5, fontWeight: '600' },
});
