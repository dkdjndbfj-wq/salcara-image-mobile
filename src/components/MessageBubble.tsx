import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { ChatMessage } from '../domain';
import { colors, radius, spacing } from '../theme';

export function MessageBubble({
  message,
  elapsedSeconds,
  onCancel,
  onRetry,
  onSave,
  onShare,
  onReuse,
  onPreview,
}: {
  message: ChatMessage;
  elapsedSeconds: number;
  onCancel: () => void;
  onRetry: () => void;
  onSave: () => void;
  onShare: () => void;
  onReuse: () => void;
  onPreview: () => void;
}) {
  const [actualSize, setActualSize] = useState<string | null>(null);
  const [imageRatio, setImageRatio] = useState(() => ratioFromSize(message.size));
  const window = useWindowDimensions();

  useEffect(() => {
    setActualSize(null);
    setImageRatio(ratioFromSize(message.size));
  }, [message.imageUri, message.size]);

  const imageLayout = fitImageCard(imageRatio, window.width - spacing.lg * 2, Math.min(window.height * 0.62, 560));
  if (message.role === 'user') {
    return (
      <View style={styles.userWrap}>
        {message.references.length > 0 && (
          <View style={styles.referenceRow}>
            {message.references.map((reference, index) => (
              <View key={reference.id} style={styles.referenceItem}>
                <Image source={{ uri: reference.uri }} style={styles.referenceImage} />
                {index === 0 && <Text style={styles.referenceTag}>主图</Text>}
              </View>
            ))}
          </View>
        )}
        <View style={styles.userBubble}><Text style={styles.userText}>{message.prompt}</Text></View>
      </View>
    );
  }

  if (message.status === 'pending') {
    return (
      <View style={styles.assistantBlock}>
        <View style={styles.progressCard}>
          <ActivityIndicator color={colors.primaryStrong} />
          <View style={styles.progressText}><Text style={styles.progressTitle}>{message.mode === 'edit' ? '正在编辑图片' : '正在生成图片'}</Text><Text style={styles.meta}>已等待 {formatDuration(elapsedSeconds)} · 最长 10 分钟</Text></View>
          <Pressable onPress={onCancel} style={styles.cancelButton}><Text style={styles.cancelText}>取消</Text></Pressable>
        </View>
      </View>
    );
  }

  if (message.status !== 'complete' || !message.imageUri) {
    return (
      <View style={styles.assistantBlock}>
        <View style={styles.errorCard}>
          <Ionicons name="alert-circle-outline" size={22} color={colors.danger} />
          <View style={styles.progressText}>
            <Text style={styles.errorTitle}>{statusTitle(message.status)}</Text>
            <Text style={styles.errorText}>{message.error ?? '生成未完成'}</Text>
          </View>
        </View>
        <Pressable onPress={onRetry} style={styles.retryButton}><Ionicons name="refresh" size={17} color={colors.primaryStrong} /><Text style={styles.retryText}>{message.remoteImageUrl ? '重新下载' : '手动重试'}</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.assistantBlock}>
      <Pressable onPress={onPreview} style={[styles.imageCard, imageLayout]}>
        <Image
          source={{ uri: message.imageUri }}
          style={styles.resultImage}
          resizeMode="contain"
          onLoad={(event) => {
            const { width, height } = event.nativeEvent.source;
            if (width && height) {
              setActualSize(`${Math.round(width)}x${Math.round(height)}`);
              setImageRatio(width / height);
            }
          }}
        />
      </Pressable>
      <Text style={styles.meta}>{message.model} · {message.quality} · 请求 {message.size}{actualSize && actualSize !== message.size ? ` · 实际 ${actualSize}` : ''}{message.elapsedMs ? ` · ${formatDuration(Math.round(message.elapsedMs / 1000))}` : ''}</Text>
      {actualSize && actualSize !== message.size && (
        <View style={styles.sizeWarning}>
          <Ionicons name="information-circle-outline" size={16} color={colors.warningText} />
          <Text style={styles.sizeWarningText}>上游未按请求尺寸返回，图片未在手机端缩放</Text>
        </View>
      )}
      <View style={styles.actions}>
        <Action icon="download-outline" label="保存" onPress={onSave} />
        <Action icon="share-outline" label="分享" onPress={onShare} />
        <Action icon="images-outline" label="作为参考图" onPress={onReuse} />
      </View>
    </View>
  );
}

function Action({ icon, label, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.action}><Ionicons name={icon} size={17} color={colors.textMuted} /><Text style={styles.actionText}>{label}</Text></Pressable>;
}

function statusTitle(status: ChatMessage['status']): string {
  if (status === 'cancelled') return '已取消';
  if (status === 'interrupted') return '生成已中断';
  return '生成失败';
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}分${seconds.toString().padStart(2, '0')}秒` : `${seconds}秒`;
}

function ratioFromSize(size: string): number {
  const match = size.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return 1;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 1;
}

function fitImageCard(ratio: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const heightAtFullWidth = maxWidth / safeRatio;
  if (heightAtFullWidth <= maxHeight) return { width: maxWidth, height: heightAtFullWidth };
  return { width: maxHeight * safeRatio, height: maxHeight };
}

const styles = StyleSheet.create({
  userWrap: { alignItems: 'flex-end', paddingHorizontal: spacing.lg, gap: spacing.sm },
  userBubble: { maxWidth: '84%', backgroundColor: colors.blueSurface, borderRadius: radius.lg, borderBottomRightRadius: 5, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  userText: { color: colors.text, fontSize: 15, lineHeight: 22 },
  referenceRow: { maxWidth: '90%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 },
  referenceItem: { width: 58, height: 58, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surface },
  referenceImage: { width: 58, height: 58 },
  referenceTag: { position: 'absolute', left: 3, bottom: 3, color: '#fff', backgroundColor: 'rgba(17,24,39,.7)', borderRadius: 4, paddingHorizontal: 4, fontSize: 9 },
  assistantBlock: { alignItems: 'flex-start', paddingHorizontal: spacing.lg, gap: spacing.sm },
  progressCard: { width: '100%', minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.md },
  progressText: { flex: 1, gap: 4 },
  progressTitle: { color: colors.text, fontWeight: '700' },
  meta: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  sizeWarning: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 6, borderRadius: radius.sm, backgroundColor: colors.warningSurface },
  sizeWarningText: { color: colors.warningText, fontSize: 11, lineHeight: 16 },
  cancelButton: { minHeight: 34, paddingHorizontal: 12, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.surface },
  cancelText: { color: colors.textMuted, fontWeight: '600', fontSize: 12 },
  errorCard: { width: '100%', flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md, backgroundColor: colors.dangerSurface, borderRadius: radius.lg, padding: spacing.md },
  errorTitle: { color: colors.danger, fontWeight: '700' },
  errorText: { color: colors.text, lineHeight: 19, fontSize: 13 },
  retryButton: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.primary },
  retryText: { color: colors.primaryStrong, fontWeight: '700', fontSize: 12 },
  imageCard: { overflow: 'hidden', borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  resultImage: { width: '100%', height: '100%' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  action: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  actionText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
});
