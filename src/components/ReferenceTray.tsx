import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import DraggableFlatList, { ScaleDecorator } from 'react-native-draggable-flatlist';

import type { ReferenceImage } from '../domain';
import { colors, radius, spacing } from '../theme';

export function ReferenceTray({
  images,
  onChange,
  onEditMask,
  hasMask,
}: {
  images: ReferenceImage[];
  onChange: (images: ReferenceImage[]) => void;
  onEditMask: () => void;
  hasMask: boolean;
}) {
  if (images.length === 0) return null;
  return (
    <View style={styles.wrapper}>
      <DraggableFlatList
        horizontal
        data={images}
        keyExtractor={(item) => item.id}
        onDragEnd={({ data }) => onChange(data)}
        contentContainerStyle={styles.list}
        showsHorizontalScrollIndicator={false}
        renderItem={({ item, drag, isActive, getIndex }) => {
          const index = getIndex() ?? 0;
          return (
            <ScaleDecorator>
              <Pressable onLongPress={drag} disabled={isActive} style={[styles.item, isActive && styles.dragging]}>
                <Image source={{ uri: item.uri }} style={{ width: 76, height: 76 }} />
                <View style={styles.tag}><Text style={styles.tagText}>{index === 0 ? '主图' : `参考 ${index}`}</Text></View>
                <Pressable accessibilityLabel="移除图片" style={styles.remove} onPress={() => onChange(images.filter((image) => image.id !== item.id))}>
                  <Ionicons name="close" size={14} color="#fff" />
                </Pressable>
              </Pressable>
            </ScaleDecorator>
          );
        }}
      />
      <Pressable style={[styles.maskButton, hasMask && styles.maskActive]} onPress={onEditMask}>
        <Ionicons name="brush-outline" size={18} color={hasMask ? colors.primaryStrong : colors.textMuted} />
        <Text style={[styles.maskText, hasMask && styles.maskTextActive]}>{hasMask ? '已加蒙版' : '编辑蒙版'}</Text>
      </Pressable>
      <Text style={styles.hint}>长按拖动排序；蒙版只作用于第一张主图。</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.sm, gap: spacing.sm },
  list: { paddingHorizontal: spacing.md, gap: spacing.sm },
  item: { width: 76, height: 76, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', backgroundColor: colors.surface },
  dragging: { opacity: 0.6 },
  tag: { position: 'absolute', left: 4, bottom: 4, backgroundColor: 'rgba(17,24,39,0.75)', borderRadius: 5, paddingHorizontal: 5, paddingVertical: 2 },
  tagText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  remove: { position: 'absolute', right: 4, top: 4, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(17,24,39,0.72)' },
  maskButton: { alignSelf: 'flex-start', marginLeft: spacing.md, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 34, paddingHorizontal: 11, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  maskActive: { backgroundColor: colors.blueSurface, borderColor: colors.primary },
  maskText: { color: colors.textMuted, fontWeight: '600', fontSize: 12 },
  maskTextActive: { color: colors.primaryStrong },
  hint: { color: colors.textMuted, fontSize: 11, marginHorizontal: spacing.md },
});
