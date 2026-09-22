import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { ChatMessage } from '../domain';
import { attachmentKind } from '../document-inputs';
import { colors, radius, spacing } from '../theme';

export function MessageBubble({
  message,
  elapsedSeconds,
  requestStage,
  onCancel,
  onRetry,
  onSave,
  onShare,
  onReuse,
  onPreview,
}: {
  message: ChatMessage;
  elapsedSeconds: number;
  requestStage?: string;
  onCancel: () => void;
  onRetry: () => void;
  onSave: () => void;
  onShare: () => void;
  onReuse: () => void;
  onPreview: () => void;
}) {
  const [actualSize, setActualSize] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
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
        {!!message.documents?.length && <View style={styles.referenceRow}>{message.documents.map((document) => <View key={document.id} style={styles.document}><Ionicons name={fileIcon(document.name, document.mimeType)} size={16} color={colors.primaryStrong} /><View style={styles.documentTextWrap}><Text numberOfLines={2} style={styles.documentText}>{document.name}</Text><Text style={styles.documentKind}>{fileKindLabel(document.name, document.mimeType)}</Text></View></View>)}</View>}
        {!!message.prompt && <View style={styles.userBubble}><Text selectable style={styles.userText}>{message.prompt}</Text></View>}
      </View>
    );
  }

  if (message.status === 'pending') {
    return (
      <View style={styles.assistantBlock}>
        <View style={styles.progressCard}>
          <ActivityIndicator color={colors.primaryStrong} />
          <View style={styles.progressText}><Text style={styles.progressTitle}>{requestStage || (message.mode === 'chat' ? '正在回答' : message.mode === 'edit' ? '正在编辑图片' : '正在生成图片')}</Text><Text style={styles.meta}>已等待 {formatDuration(elapsedSeconds)} · 最长 10 分钟</Text></View>
          <Pressable onPress={onCancel} style={styles.cancelButton}><Text style={styles.cancelText}>取消</Text></Pressable>
        </View>
      </View>
    );
  }

  if (message.status === 'complete' && message.mode === 'chat' && message.text) {
    return <View style={styles.assistantBlock}>
      <View style={styles.assistantIdentity}><View style={styles.assistantAvatar}><Ionicons name="sparkles" size={13} color={colors.primaryStrong} /></View><Text style={styles.assistantLabel}>Salcara AI</Text></View>
      <Text selectable style={styles.answer}>{message.text}</Text>
      <Text style={styles.meta}>{message.model}{message.elapsedMs ? ` · ${formatDuration(Math.round(message.elapsedMs / 1000))}` : ''}</Text>
      <Action icon="copy-outline" label={copied ? '已复制' : '复制回答'} onPress={() => void Clipboard.setStringAsync(message.text!).then(() => setCopied(true)).catch(() => setCopied(false))} />
    </View>;
  }

  if (message.status !== 'complete' || !message.imageUri) {
    return (
      <View style={styles.assistantBlock}>
        <View style={styles.errorCard}>
          <Ionicons name="alert-circle-outline" size={22} color={colors.danger} />
          <View style={styles.progressText}>
            <Text style={styles.errorTitle}>{statusTitle(message.status, Boolean(message.remoteImageUrl))}</Text>
            <Text selectable style={styles.errorText}>{message.error ?? '请求未完成'}</Text>
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
      {message.preparedPrompt && <>
        <Action icon="document-text-outline" label={showAnalysis ? '收起文件解析结果' : '查看文件解析后的提示词'} onPress={() => setShowAnalysis((value) => !value)} />
        {showAnalysis && <Text selectable style={styles.analysis}>{message.preparedPrompt}</Text>}
      </>}
    </View>
  );
}

function Action({ icon, label, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.action}><Ionicons name={icon} size={17} color={colors.textMuted} /><Text style={styles.actionText}>{label}</Text></Pressable>;
}

function statusTitle(status: ChatMessage['status'], hasRemoteImage = false): string {
  if (hasRemoteImage && status === 'error') return '图片已生成，但下载失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'interrupted') return '请求已中断';
  return '请求失败';
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
  userText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  answer: { color: colors.text, fontSize: 15, lineHeight: 23, paddingVertical: 4 },
  analysis: { color: colors.textMuted, fontSize: 13, lineHeight: 21, padding: 12, backgroundColor: colors.surface, borderRadius: radius.md },
  document: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', borderRadius: radius.md, padding: 10, backgroundColor: colors.surface },
  documentTextWrap: { flexShrink: 1, gap: 2 },
  documentText: { color: colors.text, fontSize: 12 },
  documentKind: { color: colors.textMuted, fontSize: 10 },
  referenceRow: { maxWidth: '90%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 },
  referenceItem: { width: 58, height: 58, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.surface },
  referenceImage: { width: 58, height: 58 },
  referenceTag: { position: 'absolute', left: 3, bottom: 3, color: '#fff', backgroundColor: 'rgba(17,24,39,.7)', borderRadius: 4, paddingHorizontal: 4, fontSize: 9 },
  assistantBlock: { alignItems: 'flex-start', paddingHorizontal: spacing.lg, gap: spacing.sm },
  assistantIdentity: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  assistantAvatar: { width: 25, height: 25, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSurface },
  assistantLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
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

function fileIcon(name: string, mimeType: string): React.ComponentProps<typeof Ionicons>['name'] {
  switch (attachmentKind(name, mimeType)) {
    case 'image': return 'image-outline';
    case 'pdf': return 'document-text-outline';
    case 'office': return 'briefcase-outline';
    case 'archive': return 'archive-outline';
    case 'text': return 'code-slash-outline';
    default: return 'attach-outline';
  }
}

function fileKindLabel(name: string, mimeType: string): string {
  const kind = attachmentKind(name, mimeType);
  return kind === 'office' ? '办公文件' : kind === 'archive' ? '压缩包目录' : kind === 'text' ? '文本 / 代码' : kind === 'pdf' ? 'PDF 文档' : kind === 'image' ? '图片' : '文件附件';
}
