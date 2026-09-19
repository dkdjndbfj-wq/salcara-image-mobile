import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  FadeIn,
  FadeInDown,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import type { ChatMessage, ReferenceImage } from '../domain';
import { createReferenceFromGenerated, pickFromFiles, pickFromGallery, takePhoto } from '../image-inputs';
import { useApp } from '../state/AppContext';
import { deleteLocalFile, saveToGallery, shareImage } from '../storage/files';
import { colors, radius, spacing } from '../theme';
import { ConversationDrawer } from '../components/ConversationDrawer';
import { MaskEditor } from '../components/MaskEditor';
import { MessageBubble } from '../components/MessageBubble';
import { ProviderManager } from '../components/ProviderManager';
import { ReferenceTray } from '../components/ReferenceTray';
import { SettingsSheet } from '../components/SettingsSheet';
import { IconButton, Sheet } from '../components/ui';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function ChatScreen() {
  const app = useApp();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [maskUri, setMaskUri] = useState<string | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [providersVisible, setProvidersVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [attachmentsVisible, setAttachmentsVisible] = useState(false);
  const [maskVisible, setMaskVisible] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const sendScale = useSharedValue(1);
  const transparentProgress = useSharedValue(app.activeConversation?.transparent ? 1 : 0);

  useEffect(() => {
    transparentProgress.value = withTiming(app.activeConversation?.transparent ? 1 : 0, { duration: 180 });
  }, [app.activeConversation?.transparent, transparentProgress]);

  const transparentAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(transparentProgress.value, [0, 1], [colors.background, colors.blueSurface]),
    borderColor: interpolateColor(transparentProgress.value, [0, 1], [colors.border, colors.primary]),
  }));
  const sendAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: sendScale.value }] }));

  useEffect(() => {
    if (app.ready && app.providers.length === 0) setProvidersVisible(true);
  }, [app.ready, app.providers.length]);

  useEffect(() => {
    if (app.messages.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, [app.messages.length]);

  if (!app.ready) {
    return <SafeAreaView style={styles.loading}><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.loadingText}>正在准备本地数据…</Text></SafeAreaView>;
  }

  const addReferences = async (source: 'gallery' | 'camera' | 'files') => {
    try {
      const remaining = 4 - references.length;
      if (remaining <= 0) throw new Error('一次最多使用 4 张参考图');
      setAttachmentsVisible(false);
      const selected = source === 'gallery' ? await pickFromGallery(remaining) : source === 'camera' ? await takePhoto() : await pickFromFiles(remaining);
      setReferences((current) => [...current, ...selected].slice(0, 4));
    } catch (error) {
      Alert.alert('无法添加图片', error instanceof Error ? error.message : '请选择 PNG、JPEG 或 WebP 图片');
    }
  };

  const changeReferences = (next: ReferenceImage[]) => {
    const firstChanged = references[0]?.id !== next[0]?.id;
    for (const removed of references.filter((item) => !next.some((candidate) => candidate.id === item.id))) deleteLocalFile(removed.uri);
    setReferences(next);
    if (firstChanged && maskUri) {
      deleteLocalFile(maskUri);
      setMaskUri(null);
    }
  };

  const send = () => {
    const text = prompt.trim();
    if (!app.activeProvider) {
      setProvidersVisible(true);
      return;
    }
    if (!app.activeProvider.model || !app.activeProvider.quality || !app.activeProvider.aspectRatio || !app.activeProvider.resolutionTier) {
      setSettingsVisible(true);
      return;
    }
    if (!text) {
      Alert.alert('还没有图片描述', '请先输入你希望生成或修改的内容。');
      return;
    }
    if (app.generating) {
      Alert.alert('正在生成', '请等待当前请求完成，或先取消。');
      return;
    }
    const sentReferences = references;
    const sentMask = maskUri;
    setPrompt('');
    setReferences([]);
    setMaskUri(null);
    void app.sendPrompt(text, sentReferences, sentMask).catch((error) => {
      setPrompt(text);
      setReferences(sentReferences);
      setMaskUri(sentMask);
      Alert.alert('无法发送', error instanceof Error ? error.message : '请检查服务商设置');
    });
  };

  const reuseImage = async (uri: string) => {
    try {
      if (references.length >= 4) throw new Error('一次最多使用 4 张参考图');
      const reference = await createReferenceFromGenerated(uri);
      setReferences((current) => [...current, reference]);
      setPreviewUri(null);
    } catch (error) {
      Alert.alert('无法用作参考图', error instanceof Error ? error.message : '图片读取失败');
    }
  };

  const handleImageAction = async (action: 'save' | 'share', uri: string) => {
    try {
      if (action === 'save') {
        await saveToGallery(uri);
        Alert.alert('已保存', '图片已保存到系统相册。');
      } else {
        await shareImage(uri);
      }
    } catch (error) {
      Alert.alert(action === 'save' ? '保存失败' : '分享失败', error instanceof Error ? error.message : '请稍后再试');
    }
  };

  const transparent = app.activeConversation?.transparent ?? false;
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton icon="menu" label="打开会话" onPress={() => setDrawerVisible(true)} />
        <Pressable style={styles.headerInfo} onPress={() => setProvidersVisible(true)}>
          <Text style={styles.providerName} numberOfLines={1}>{app.activeProvider?.name ?? '添加服务商'}</Text>
          <Text style={styles.modelName} numberOfLines={1}>{app.activeProvider?.model ?? '尚未配置模型'}</Text>
        </Pressable>
        <IconButton icon="options-outline" label="生成设置" onPress={() => app.activeProvider ? setSettingsVisible(true) : setProvidersVisible(true)} />
      </View>

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {app.messages.length === 0 ? (
          <Animated.View entering={FadeIn.duration(280)} style={styles.emptyState}>
            <View style={styles.logo}><Ionicons name="sparkles" size={30} color={colors.primaryStrong} /></View>
            <Text style={styles.emptyTitle}>描述你想看到的画面</Text>
            <Text style={styles.emptyText}>{app.activeProvider ? '直接输入提示词，或添加最多四张参考图。生成参数可随时切换。' : '先添加一个 OpenAI 兼容服务商，再开始生成图片。'}</Text>
            {!app.activeProvider && <Pressable style={styles.setupButton} onPress={() => setProvidersVisible(true)}><Text style={styles.setupText}>添加服务商</Text></Pressable>}
          </Animated.View>
        ) : (
          <FlatList
            ref={listRef}
            data={app.messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Animated.View entering={FadeInDown.duration(230).springify().damping(18)}>
                <MessageBubble
                  message={item}
                  elapsedSeconds={app.elapsedSeconds}
                  onCancel={app.cancelGeneration}
                  onRetry={() => void app.retryMessage(item)}
                  onSave={() => item.imageUri && void handleImageAction('save', item.imageUri)}
                  onShare={() => item.imageUri && void handleImageAction('share', item.imageUri)}
                  onReuse={() => item.imageUri && void reuseImage(item.imageUri)}
                  onPreview={() => setPreviewUri(item.imageUri)}
                />
              </Animated.View>
            )}
          />
        )}

        <View style={styles.composerWrap}>
          <ReferenceTray images={references} onChange={changeReferences} onEditMask={() => setMaskVisible(true)} hasMask={Boolean(maskUri)} />
          <View style={styles.quickSettings}>
            <AnimatedPressable style={[styles.transparent, transparentAnimatedStyle]} disabled={!app.activeProvider} onPress={() => void app.toggleTransparent()}>
              <Ionicons name="layers-outline" size={17} color={transparent ? colors.primaryStrong : colors.textMuted} />
              <Text style={[styles.transparentText, transparent && styles.transparentTextActive]}>透明背景</Text>
            </AnimatedPressable>
            {app.activeProvider?.quality && app.activeProvider.aspectRatio && app.activeProvider.resolutionTier && (
              <Pressable onPress={() => setSettingsVisible(true)} style={styles.settingsSummary}>
                <Text style={styles.settingsText}>{app.activeProvider.quality} · {app.activeProvider.aspectRatio} · {app.activeProvider.resolutionTier}</Text>
              </Pressable>
            )}
          </View>
          {transparent && <Text style={styles.compatibilityHint}>已请求透明 PNG，实际透明能力由服务商决定。</Text>}
          <View style={styles.composer}>
            <IconButton icon="add" label="添加参考图" disabled={references.length >= 4} onPress={() => setAttachmentsVisible(true)} />
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder={references.length ? '描述如何修改图片…' : '描述你想生成的图片…'}
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={4000}
              style={styles.input}
            />
            <AnimatedPressable
              accessibilityLabel="发送"
              disabled={app.generating}
              onPress={send}
              onPressIn={() => { sendScale.value = withSpring(0.9, { damping: 16, stiffness: 260 }); }}
              onPressOut={() => { sendScale.value = withSpring(1, { damping: 14, stiffness: 220 }); }}
              style={[styles.send, sendAnimatedStyle, app.generating && styles.disabled]}
            >
              <Ionicons name="arrow-up" size={22} color="#fff" />
            </AnimatedPressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <ConversationDrawer visible={drawerVisible} onClose={() => setDrawerVisible(false)} onOpenProviders={() => { setDrawerVisible(false); setProvidersVisible(true); }} />
      <ProviderManager visible={providersVisible} onClose={() => setProvidersVisible(false)} />
      <SettingsSheet visible={settingsVisible} onClose={() => setSettingsVisible(false)} />
      <Sheet visible={attachmentsVisible} title="添加参考图" onClose={() => setAttachmentsVisible(false)} scroll={false}>
        <View style={styles.attachmentOptions}>
          <AttachmentOption icon="images-outline" title="从相册选择" subtitle="PNG、JPEG 或 WebP" onPress={() => void addReferences('gallery')} />
          <AttachmentOption icon="camera-outline" title="拍照" subtitle="使用相机拍摄主图" onPress={() => void addReferences('camera')} />
          <AttachmentOption icon="folder-open-outline" title="从文件选择" subtitle="仅支持图片文件" onPress={() => void addReferences('files')} />
        </View>
      </Sheet>
      <MaskEditor visible={maskVisible} image={references[0] ?? null} onCancel={() => setMaskVisible(false)} onConfirm={(uri) => { if (maskUri && maskUri !== uri) deleteLocalFile(maskUri); setMaskUri(uri); setMaskVisible(false); }} />
      <Modal visible={Boolean(previewUri)} transparent animationType="fade" onRequestClose={() => setPreviewUri(null)} statusBarTranslucent>
        <View style={styles.preview}>
          <Pressable onPress={() => setPreviewUri(null)} style={styles.previewClose}><Ionicons name="close" size={26} color="#fff" /></Pressable>
          {previewUri && <Image source={{ uri: previewUri }} style={styles.previewImage} resizeMode="contain" />}
          {previewUri && <Pressable style={styles.previewReuse} onPress={() => void reuseImage(previewUri)}><Ionicons name="images-outline" size={18} color="#fff" /><Text style={styles.previewReuseText}>作为参考图</Text></Pressable>}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function AttachmentOption({ icon, title, subtitle, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; title: string; subtitle: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.attachmentRow}><View style={styles.attachmentIcon}><Ionicons name={icon} size={23} color={colors.primaryStrong} /></View><View><Text style={styles.attachmentTitle}>{title}</Text><Text style={styles.attachmentSubtitle}>{subtitle}</Text></View></Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: colors.background },
  loadingText: { color: colors.textMuted },
  header: { minHeight: 66, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, gap: spacing.md, borderBottomWidth: 1, borderColor: colors.border },
  headerInfo: { flex: 1, alignItems: 'center', gap: 2 },
  providerName: { color: colors.text, fontWeight: '700', fontSize: 15 },
  modelName: { color: colors.textMuted, fontSize: 11, maxWidth: '92%' },
  body: { flex: 1 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xxl, gap: spacing.md },
  logo: { width: 68, height: 68, borderRadius: 22, backgroundColor: colors.blueSurface, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  emptyText: { color: colors.textMuted, fontSize: 14, lineHeight: 22, textAlign: 'center' },
  setupButton: { minHeight: 44, paddingHorizontal: spacing.xl, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: colors.primary },
  setupText: { color: '#fff', fontWeight: '700' },
  messages: { paddingVertical: spacing.xl, gap: spacing.xl },
  composerWrap: { backgroundColor: colors.background, borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.sm },
  quickSettings: { minHeight: 34, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  transparent: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  transparentActive: { backgroundColor: colors.blueSurface, borderColor: colors.primary },
  transparentText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  transparentTextActive: { color: colors.primaryStrong },
  settingsSummary: { minHeight: 34, justifyContent: 'center', paddingHorizontal: 9 },
  settingsText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  compatibilityHint: { color: colors.textMuted, fontSize: 11, paddingHorizontal: spacing.md },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, paddingHorizontal: spacing.md },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, color: colors.text, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 10, fontSize: 15, backgroundColor: colors.surface },
  send: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  disabled: { opacity: 0.45 },
  attachmentOptions: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  attachmentRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: 1, borderColor: colors.border },
  attachmentIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSurface },
  attachmentTitle: { color: colors.text, fontWeight: '700', fontSize: 15 },
  attachmentSubtitle: { color: colors.textMuted, marginTop: 3, fontSize: 12 },
  preview: { flex: 1, backgroundColor: 'rgba(10,15,24,0.96)', alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '82%' },
  previewClose: { position: 'absolute', right: spacing.lg, top: 52, zIndex: 2, width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,.14)' },
  previewReuse: { position: 'absolute', bottom: 42, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.pill, backgroundColor: colors.primaryStrong },
  previewReuseText: { color: '#fff', fontWeight: '700' },
});
