import React, { useEffect, useRef, useState } from 'react';
import { Animated, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import type { DocumentAttachment, ReferenceImage } from '../domain';
import { brandGradient, colors, shadow } from '../theme';
import { Icon } from './Icon';
import { FileCard } from './MessageBubble';
import { MotionPressable } from './MotionPressable';

export function Composer({ value, onChangeText, images, documents, hasMask, busy, onSend, onStop, onOpenAttach, onRemoveImage, onRemoveDocument, onEditMask, inputRef, placeholder }: {
  value: string; onChangeText: (value: string) => void;
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

  return <View style={styles.wrap}>
    <Animated.View style={[styles.card, { borderColor: focusAnim.interpolate({ inputRange: [0, 1], outputRange: [colors.border, colors.glow] }) }]}>
      {hasTray && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tray} keyboardShouldPersistTaps="handled">
        {images.map((image, index) => <View key={image.id} style={styles.thumbWrap}>
          <Image source={{ uri: image.uri }} style={styles.thumb} />
          {index === 0 && <Pressable accessibilityRole="button" accessibilityLabel={hasMask ? '修改涂抹区域' : '涂抹要修改的区域'} onPress={onEditMask} style={[styles.maskButton, hasMask && styles.maskActive]}>
            <Icon name="brush" size={11} color={hasMask ? '#fff' : colors.text} strokeWidth={2} />
            <Text style={[styles.maskText, hasMask && { color: '#fff' }]}>{hasMask ? '已涂抹' : '涂抹'}</Text>
          </Pressable>}
          <Pressable accessibilityLabel="移除图片" hitSlop={8} onPress={() => onRemoveImage(image.id)} style={styles.remove}><Icon name="close" size={11} color="#fff" strokeWidth={2.4} /></Pressable>
        </View>)}
        {documents.map((doc) => <View key={doc.id} style={{ width: 210 }}><FileCard name={doc.name} mimeType={doc.mimeType} size={doc.size} onRemove={() => onRemoveDocument(doc.id)} /></View>)}
      </ScrollView>}
      <View style={styles.row}>
        <MotionPressable accessibilityRole="button" accessibilityLabel="添加图片或文件" disabled={busy} scaleTo={0.88} onPress={onOpenAttach} style={[styles.plus, busy && { opacity: 0.35 }]}>
          <Icon name="plus" size={21} color={colors.text} strokeWidth={1.8} />
        </MotionPressable>
        <TextInput
          ref={inputRef}
          accessibilityLabel="消息"
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder ?? '问问 Salcara，或让它画点什么'}
          placeholderTextColor={colors.subtle}
          multiline
          maxLength={8000}
          textAlignVertical="center"
          style={styles.input}
        />
        <MotionPressable accessibilityRole="button" accessibilityLabel={busy ? '停止' : '发送'} disabled={!busy && !ready} onPress={busy ? onStop : onSend} scaleTo={0.86}>
          <View style={styles.send}>
            <View style={[StyleSheet.absoluteFill, styles.sendIdle]} />
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: sendAnim, transform: [{ scale: sendAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }] }]}>
              {busy ? <View style={styles.sendBusy} /> : <SendGradient />}
            </Animated.View>
            <Icon name={busy ? 'stop' : 'arrowUp'} size={busy ? 16 : 19} color={active ? '#FFFFFF' : colors.faint} strokeWidth={2.1} />
          </View>
        </MotionPressable>
      </View>
    </Animated.View>
  </View>;
}

function SendGradient() {
  return <Svg width={38} height={38}>
    <Defs>
      <LinearGradient id="sendGradient" x1="0" y1="0" x2="38" y2="38" gradientUnits="userSpaceOnUse">
        <Stop offset="0" stopColor={brandGradient[0]} />
        <Stop offset="0.45" stopColor={brandGradient[1]} />
        <Stop offset="1" stopColor={brandGradient[2]} />
      </LinearGradient>
    </Defs>
    <Circle cx={19} cy={19} r={19} fill="url(#sendGradient)" />
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
  plus: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceStrong },
  input: { flex: 1, minHeight: 38, maxHeight: 160, color: colors.text, paddingHorizontal: 6, paddingTop: 8, paddingBottom: 8, fontSize: 16, lineHeight: 22 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  sendIdle: { backgroundColor: colors.surfaceStrong, borderRadius: 19 },
  sendBusy: { flex: 1, backgroundColor: colors.text, borderRadius: 19 },
});
