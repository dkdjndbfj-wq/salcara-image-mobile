import {WorkbenchReveal} from './ConversationMotion';
import {MotionPressable} from '../components/MotionPressable';
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useDesk } from '../theme';
import { ManagedImage } from './ManagedImage';
import { ImageViewer } from './thread-extras';

export interface DraftImage { uri: string; name?: string }
export interface DraftImageStripProps {
  scopeKey: string;
  images: readonly DraftImage[];
  onRemove: (index: number) => void;
  disabled?: boolean;
  visible?: boolean;
}

/** Preview never mutates the draft. Removing requires its own explicit control. */
export function DraftImageStrip({ scopeKey, images, onRemove, disabled = false, visible = true }: DraftImageStripProps) {
  const d = useDesk(), token = useMemo(() => ({}), [scopeKey, visible]);
  const [preview, setPreview] = useState<{ owner: object; uri: string }>();
  const owner = useRef({ token, visible, disabled, images, onRemove });
  owner.current = { token, visible, disabled, images, onRemove };
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = () => mounted.current && owner.current.token === token && owner.current.visible;
  const shown = visible && preview?.owner === token && images.some(image => image.uri === preview.uri) ? preview.uri : null;
  if (!visible || !images.length) return null;
  return <View testID="draft-image-strip">
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.strip}>
      {images.map((image, index) => <WorkbenchReveal key={`${scopeKey}:${image.uri}:${index}`} style={styles.tile}>
        <MotionPressable scaleTo={0.97} accessibilityRole="button" accessibilityLabel={`预览待发送图片 ${index + 1}${image.name ? ` · ${image.name}` : ''}`} disabled={disabled}
          onPress={() => { if (current() && !owner.current.disabled && owner.current.images[index]?.uri === image.uri) setPreview({ owner: token, uri: image.uri }); }}
          style={[styles.preview, { backgroundColor: d.surface2, borderColor: d.line, opacity: disabled ? .6 : 1 }]}>
          <ManagedImage uri={image.uri} resizeMode="cover" style={styles.image} />
        </MotionPressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`移除待发送图片 ${index + 1}`} disabled={disabled} hitSlop={2}
          onPress={() => { if (!current() || owner.current.disabled || owner.current.images[index]?.uri !== image.uri) return; if (shown === image.uri) setPreview(undefined); owner.current.onRemove(index); }}
          style={[styles.remove, { backgroundColor: d.surface, borderColor: d.line, opacity: disabled ? .6 : 1 }]}><Icon name="close" size={12} color={d.muted} accent={d.muted} /></Pressable>
      </WorkbenchReveal>)}
    </ScrollView>
    <ImageViewer key={scopeKey} uri={shown} onClose={() => { if (current()) setPreview(undefined); }} />
  </View>;
}
const styles = StyleSheet.create({
  strip: { paddingHorizontal: 12, paddingVertical: 8, gap: 10 },
  tile: { width: 66, height: 66, paddingTop: 5, paddingRight: 5 },
  preview: { width: 60, height: 60, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  remove: { position: 'absolute', top: 0, right: 0, width: 26, height: 26, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
});
