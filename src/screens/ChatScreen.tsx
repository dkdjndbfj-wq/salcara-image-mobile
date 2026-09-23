import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
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

import type { ChatMessage, DocumentAttachment, ReferenceImage } from '../domain';
import { attachmentKind, isImageAttachment, pickAnyFiles, validateAttachments } from '../document-inputs';
import { latestCompletedImage } from '../domain-utils';
import { createReferenceFromGenerated, pickFromFiles, pickFromGallery, prepareReferenceForMask, prepareReferenceFromAttachment, takePhoto } from '../image-inputs';
import { useApp } from '../state/AppContext';
import { deleteLocalFile, saveToGallery, shareImage } from '../storage/files';
import { colors, radius, spacing } from '../theme';
import { ConversationDrawer } from '../components/ConversationDrawer';
import { AboutSheet } from '../components/AboutSheet';
import { AppSettingsSheet } from '../components/AppSettingsSheet';
import { ImagePreview } from '../components/ImagePreview';
import { MaskEditor } from '../components/MaskEditor';
import { MessageBubble } from '../components/MessageBubble';
import { NetworkDiagnostics } from '../components/NetworkDiagnostics';
import { ProviderManager } from '../components/ProviderManager';
import { ReferenceTray } from '../components/ReferenceTray';
import { SettingsSheet } from '../components/SettingsSheet';
import { UpdateManager } from '../components/UpdateManager';
import { AppDialog, Chip, IconButton, Sheet, type DialogAction } from '../components/ui';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function ChatScreen() {
  const app = useApp();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const isChatOnly = app.composerMode === 'chat';
  const isImageOnly = app.composerMode === 'image';
  const isAuto = app.composerMode === 'auto';
  const imageProvider = app.activeProvider?.model ? app.activeProvider : app.providers.find((item) => item.model);
  const chatProvider = app.activeProvider?.chatModel
    ? app.activeProvider
    : (app.activeProvider?.analysisProviderId && app.providers.find((item) => item.id === app.activeProvider?.analysisProviderId && item.chatModel))
      || app.providers.find((item) => item.chatModel);
  const diagnosticsProvider = isImageOnly ? imageProvider : chatProvider ?? imageProvider;
  const diagnosticsSecondary = isAuto && diagnosticsProvider?.id !== imageProvider?.id ? imageProvider : undefined;
  const [continueFromPrevious, setContinueFromPrevious] = useState(true);
  const [maskUri, setMaskUri] = useState<string | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [providersVisible, setProvidersVisible] = useState(false);
  const [providerFocusId, setProviderFocusId] = useState<string | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [aboutVisible, setAboutVisible] = useState(false);
  const [appSettingsVisible, setAppSettingsVisible] = useState(false);
  const [networkVisible, setNetworkVisible] = useState(false);
  const [attachmentsVisible, setAttachmentsVisible] = useState(false);
  const [routeVisible, setRouteVisible] = useState(false);
  const [maskVisible, setMaskVisible] = useState(false);
  const [preparingMask, setPreparingMask] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [updateCheckToken, setUpdateCheckToken] = useState(0);
  const [dialog, setDialog] = useState<{ title: string; message: string; actions?: DialogAction[]; icon?: React.ComponentProps<typeof AppDialog>['icon'] } | null>(null);
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

  // A draft belongs to one conversation/provider. Never leak its private files into another.
  const draftRef = useRef({ references, documents, maskUri });
  const previousDraftOwner = useRef({ conversationId: app.activeConversation?.id, providerId: app.activeProvider?.id });
  draftRef.current = { references, documents, maskUri };
  useEffect(() => {
    const previous = previousDraftOwner.current;
    previousDraftOwner.current = { conversationId: app.activeConversation?.id, providerId: app.activeProvider?.id };
    setContinueFromPrevious(true);
    // Toggling transparency can materialize an empty conversation. Keep its draft.
    if (!previous.conversationId && previous.providerId === app.activeProvider?.id) return;
    setPrompt('');
    draftRef.current.references.forEach((item) => deleteLocalFile(item.uri));
    draftRef.current.documents.forEach((item) => deleteLocalFile(item.uri));
    deleteLocalFile(draftRef.current.maskUri);
    setReferences([]); setDocuments([]); setMaskUri(null);
  }, [app.activeConversation?.id, app.activeProvider?.id]);

  if (!app.ready) {
    return <SafeAreaView style={styles.loading}><Image source={require('../../assets/icon.png')} style={styles.loadingLogo} /><Text style={styles.loadingTitle}>Salcara AI</Text><Text style={styles.loadingText}>正在准备本地数据…</Text></SafeAreaView>;
  }

  const addReferences = async (source: 'gallery' | 'camera' | 'files') => {
    try {
      const remaining = 4 - references.length;
      if (remaining <= 0) throw new Error('一次最多使用 4 张参考图');
      setAttachmentsVisible(false);
      const selected = source === 'gallery' ? await pickFromGallery(remaining) : source === 'camera' ? await takePhoto() : await pickFromFiles(remaining);
      try { validateAttachments(documents, [...references, ...selected]); }
      catch (error) { selected.forEach((item) => deleteLocalFile(item.uri)); throw error; }
      setReferences((current) => [...current, ...selected].slice(0, 4));
    } catch (error) {
      setDialog({ title: '无法添加图片', message: error instanceof Error ? error.message : '请选择 PNG、JPEG 或 WebP 图片。', icon: 'image-outline' });
    }
  };

  const addDocuments = async () => {
    try {
      setAttachmentsVisible(false);
      const selected = await pickAnyFiles(4 - documents.length);
      // The general file picker may return images too. Promote those to the
      // normal reference tray so image previews, ordering and mask editing
      // remain identical to gallery/camera imports.
      const imageFiles = selected.filter(isImageAttachment);
      const selectedImages: ReferenceImage[] = [];
      try {
        for (const item of imageFiles) selectedImages.push(await prepareReferenceFromAttachment(item));
      } catch (error) {
        selected.forEach((item) => deleteLocalFile(item.uri));
        selectedImages.forEach((item) => deleteLocalFile(item.uri));
        throw error;
      }
      const selectedDocuments = selected.filter((item) => !isImageAttachment(item));
      try { validateAttachments([...documents, ...selectedDocuments], [...references, ...selectedImages]); }
      catch (error) { selected.forEach((item) => deleteLocalFile(item.uri)); selectedImages.forEach((item) => deleteLocalFile(item.uri)); throw error; }
      // The original imported image copies are no longer needed after the
      // normalizer creates a private reference file.
      imageFiles.forEach((item) => deleteLocalFile(item.uri));
      setReferences((current) => [...current, ...selectedImages].slice(0, 4));
      setDocuments((current) => [...current, ...selectedDocuments]);
    } catch (error) {
      setDialog({ title: '无法添加文件', message: error instanceof Error ? error.message : '文件读取失败。', icon: 'document-text-outline' });
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
    if (!text && !references.length && !documents.length) {
      setDialog({ title: '还没有内容', message: '请输入问题，或先添加图片 / 文件让 AI 分析。', icon: 'create-outline' });
      return;
    }
    if (app.generating) {
      setDialog({ title: '正在生成', message: '请等待当前请求完成，或先取消。', icon: 'hourglass-outline' });
      return;
    }
    const sentReferences = references;
    const sentDocuments = documents;
    const sentMask = maskUri;
    const sentContinueFromPrevious = continueFromPrevious;
    setPrompt('');
    setReferences([]);
    setDocuments([]);
    // Transfer ownership to the pending message before its conversation is created.
    draftRef.current = { references: [], documents: [], maskUri: null };
    setMaskUri(null);
    setContinueFromPrevious(true);
    void app.sendPrompt(text, sentReferences, sentMask, sentContinueFromPrevious, sentDocuments).catch((error) => {
      setPrompt(text);
      setReferences(sentReferences);
      setDocuments(sentDocuments);
      setMaskUri(sentMask);
      setContinueFromPrevious(sentContinueFromPrevious);
      setDialog({ title: '无法发送', message: error instanceof Error ? error.message : '请检查服务商设置。', icon: 'alert-circle-outline' });
    });
  };

  const reuseImage = async (uri: string) => {
    try {
      if (references.length >= 4) throw new Error('一次最多使用 4 张参考图');
      const reference = await createReferenceFromGenerated(uri);
      try { validateAttachments(documents, [...references, reference]); }
      catch (error) { deleteLocalFile(reference.uri); throw error; }
      setReferences((current) => [...current, reference]);
      setPreviewUri(null);
    } catch (error) {
      setDialog({ title: '无法用作参考图', message: error instanceof Error ? error.message : '图片读取失败。', icon: 'images-outline' });
    }
  };

  const handleImageAction = async (action: 'save' | 'share', uri: string) => {
    try {
      if (action === 'save') {
        await saveToGallery(uri);
        setDialog({ title: '图片已保存', message: '已保存到系统相册。', icon: 'checkmark-circle-outline' });
      } else {
        await shareImage(uri);
      }
    } catch (error) {
      setDialog({ title: action === 'save' ? '保存失败' : '分享失败', message: error instanceof Error ? error.message : '请稍后再试。', icon: 'alert-circle-outline' });
    }
  };

  const openMaskEditor = async () => {
    const primary = references[0];
    if (!primary || preparingMask) return;
    try {
      setPreparingMask(true);
      const prepared = await prepareReferenceForMask(primary);
      if (prepared.uri !== primary.uri) {
        setReferences((current) => [prepared, ...current.slice(1)]);
        deleteLocalFile(primary.uri);
        if (maskUri) deleteLocalFile(maskUri);
        setMaskUri(null);
      }
      setMaskVisible(true);
    } catch (error) {
      setDialog({ title: '无法打开蒙版编辑器', message: error instanceof Error ? error.message : '主图预处理失败。', icon: 'brush-outline' });
    } finally {
      setPreparingMask(false);
    }
  };

  const transparent = app.activeConversation?.transparent ?? false;
  const previousResult = latestCompletedImage(app.messages);
  const continuingFromPrevious = Boolean(!isChatOnly && continueFromPrevious && references.length === 0 && previousResult?.imageUri);
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton icon="menu" label="打开会话" onPress={() => setDrawerVisible(true)} />
        <Pressable style={styles.headerInfo} onPress={() => setProvidersVisible(true)}>
          <Text style={styles.providerName} numberOfLines={1}>Salcara AI</Text>
          <Text style={styles.modelName} numberOfLines={1}>{app.activeProvider ? isAuto ? `自动判断 · ${chatProvider?.chatModel ?? '对话模型'} / ${imageProvider?.model ?? '图片模型'}` : isChatOnly ? `对话 · ${chatProvider?.chatModel ?? '选择对话模型'}` : `图片创作 · ${imageProvider?.model ?? '选择生图模型'}` : '点击添加服务商'}</Text>
        </Pressable>
        <IconButton icon="options-outline" label={isChatOnly ? '对话设置' : isImageOnly ? '生成设置' : '模型设置'} onPress={() => app.activeProvider ? setSettingsVisible(true) : setProvidersVisible(true)} />
      </View>
      <Pressable style={styles.routeBar} onPress={() => setRouteVisible(true)} accessibilityRole="button" accessibilityLabel="选择发送方式">
        <Ionicons name={isAuto ? 'sparkles-outline' : isChatOnly ? 'chatbubbles-outline' : 'image-outline'} size={16} color={colors.primaryStrong} />
        <Text style={styles.routeBarText}>{isAuto ? '自动判断发送方式' : isChatOnly ? '仅对话' : '仅图片创作'}</Text>
        <Ionicons name="chevron-down" size={15} color={colors.textMuted} />
      </Pressable>

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        {app.messages.length === 0 ? (
          <Animated.View entering={FadeIn.duration(280)} style={styles.emptyState}>
            <View style={styles.logo}><Ionicons name="sparkles" size={30} color={colors.primaryStrong} /></View>
            <Text style={styles.emptyTitle}>{isImageOnly ? '开始图片创作' : '你好，我是 Salcara AI'}</Text>
            <Text style={styles.emptyText}>{app.activeProvider ? isAuto ? '一个会话里聊天、读文件、看图片和创作。只有明确要求出图时才调用图片 API。' : isChatOnly ? '可对话、分析图片和文件；当前不会调用图片生成接口。' : '输入画面描述，或添加参考图开始创作。' : '先添加服务商，再开始使用。'}</Text>
            {(isAuto || isChatOnly) && app.activeProvider && <View style={styles.suggestionList}>
              {[
                ['document-text-outline', '总结这份文件', '上传文件后自动分析'],
                ['image-outline', '分析这张图片', '图片只会作为对话上下文'],
                ['sparkles-outline', '生成一张图片', '明确写“生成 / 修改”即可'],
              ].map(([icon, title, hint]) => <Pressable key={title} style={styles.suggestion} onPress={() => { setPrompt(title === '分析这张图片' ? '请分析这张图片。' : title === '总结这份文件' ? '请总结这份文件。' : '生成一张图片：'); }}>
                <View style={styles.suggestionIcon}><Ionicons name={icon as React.ComponentProps<typeof Ionicons>['name']} size={17} color={colors.primaryStrong} /></View>
                <View style={styles.suggestionCopy}><Text style={styles.suggestionTitle}>{title}</Text><Text style={styles.suggestionHint}>{hint}</Text></View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </Pressable>)}
            </View>}
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
                  requestStage={app.requestStage}
                  onCancel={app.cancelGeneration}
                  onRetry={() => void app.retryMessage(item).catch((error) => setDialog({ title: '重试失败', message: error instanceof Error ? error.message : '请稍后再试。', icon: 'refresh-outline' }))}
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
          {continuingFromPrevious && previousResult?.imageUri && (
            <View style={styles.continuationRow}>
              <Pressable style={styles.continuationChip} onPress={() => setPreviewUri(previousResult.imageUri)}>
                <Image source={{ uri: previousResult.imageUri }} style={styles.continuationImage} />
                <View style={styles.continuationTextWrap}>
                  <Text style={styles.continuationTitle}>续改上一张</Text>
                  <Text style={styles.continuationHint}>本次会自动作为主图</Text>
                </View>
              </Pressable>
              <Pressable accessibilityLabel="本次不使用上一张" style={styles.continuationClose} onPress={() => setContinueFromPrevious(false)}>
                <Ionicons name="close" size={18} color={colors.textMuted} />
              </Pressable>
            </View>
          )}
          <ReferenceTray images={references} onChange={changeReferences} onEditMask={() => void openMaskEditor()} hasMask={Boolean(maskUri)} allowMask={!isChatOnly} />
          {documents.length > 0 && <ScrollView horizontal style={styles.documentTray} contentContainerStyle={{ gap: 8 }}>
            {documents.map((document) => <View key={document.id} style={styles.documentChip}>
              <Ionicons name={attachmentIcon(document.name, document.mimeType)} size={20} color={colors.primaryStrong} />
              <View style={{ maxWidth: 150 }}><Text numberOfLines={1} style={styles.documentName}>{document.name}</Text><Text style={styles.compatibilityHint}>{(document.size / 1024 / 1024).toFixed(1)} MB</Text></View>
              <Pressable accessibilityLabel={`移除 ${document.name}`} onPress={() => { setDocuments((current) => current.filter((item) => item.id !== document.id)); deleteLocalFile(document.uri); }}><Ionicons name="close" size={18} color={colors.textMuted} /></Pressable>
            </View>)}
          </ScrollView>}
          <View style={styles.quickSettings}>
            {!isChatOnly && <AnimatedPressable style={[styles.transparent, transparentAnimatedStyle]} disabled={!app.activeProvider || app.generating} onPress={() => void app.toggleTransparent().catch((error) => setDialog({ title: '无法切换透明背景', message: error instanceof Error ? error.message : '请稍后再试。' }))}>
              <Ionicons name="layers-outline" size={17} color={transparent ? colors.primaryStrong : colors.textMuted} />
              <Text style={[styles.transparentText, transparent && styles.transparentTextActive]}>透明背景</Text>
            </AnimatedPressable>}
            {app.activeProvider && (
              <Pressable onPress={() => setSettingsVisible(true)} style={styles.settingsSummary}>
                <Ionicons name="options-outline" size={15} color={colors.textMuted} />
                <Text style={styles.settingsText}>
                  {isAuto ? '自动判断 · 模型设置' : isChatOnly ? '模型与接口' : imageProvider?.quality && imageProvider.aspectRatio && imageProvider.resolutionTier
                    ? `${imageProvider.quality} · ${imageProvider.aspectRatio} · ${imageProvider.resolutionTier}`
                    : '设置生成参数'}
                </Text>
              </Pressable>
            )}
          </View>
          {!isChatOnly && transparent && <Text style={styles.compatibilityHint}>已请求透明 PNG，实际透明能力由服务商决定。</Text>}
          {isImageOnly && documents.length > 0 && <Text style={styles.compatibilityHint}>将通过 {chatProvider?.chatModel ? `${chatProvider.name} / ${chatProvider.chatModel}` : '待配置的对话模型'} 解析文件后生图；解析与生图分别计费。</Text>}
          {isAuto && documents.length > 0 && <Text style={styles.compatibilityHint}>发送后先判断：普通问题只分析文件；明确写“生成/修改图片”才会继续调用图片 API。</Text>}
          {(isChatOnly || isAuto) && (documents.length > 0 || references.length > 0) && <Text style={styles.compatibilityHint}>已选 {documents.length + references.length} 个附件 · 文本和办公文件优先本地提取</Text>}
          <View style={styles.composer}>
            <IconButton icon="add" label="添加图片或文件" disabled={app.generating} onPress={() => setAttachmentsVisible(true)} />
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder={isAuto ? '输入问题，或描述要生成 / 修改的图片…' : isChatOnly ? '输入问题，或让我分析附件…' : documents.length ? '描述如何根据文件生成图片…' : references.length || continuingFromPrevious ? '描述如何修改图片…' : '描述你想生成的图片…'}
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

      <ConversationDrawer
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        onOpenProviders={() => { setDrawerVisible(false); setProvidersVisible(true); }}
        onOpenAbout={() => { setDrawerVisible(false); setAboutVisible(true); }}
        onOpenNetwork={() => { setDrawerVisible(false); setNetworkVisible(true); }}
        onOpenSettings={() => { setDrawerVisible(false); setAppSettingsVisible(true); }}
      />
      <ProviderManager visible={providersVisible} onClose={() => { setProvidersVisible(false); setProviderFocusId(null); }} focusProviderId={providerFocusId} />
      <SettingsSheet visible={settingsVisible} onClose={() => setSettingsVisible(false)} onOpenProviders={(providerId) => { setProviderFocusId(providerId ?? null); setProvidersVisible(true); }} />
      <AboutSheet visible={aboutVisible} onClose={() => setAboutVisible(false)} onCheckUpdates={() => setUpdateCheckToken((value) => value + 1)} />
      <AppSettingsSheet visible={appSettingsVisible} onClose={() => setAppSettingsVisible(false)} />
      <Sheet visible={routeVisible} title="发送方式" onClose={() => setRouteVisible(false)}>
        <View style={styles.routeOptions}>
          <Text style={styles.routeTitle}>同一个对话里自动选择接口</Text>
          <Text style={styles.routeHint}>上传图片、PDF 或 Word 默认只做对话分析。明确要求生成或修改图片时，先由对话 API 确认并整理要求，再调用独立图片 API；图片本身不会自动触发生图。</Text>
          <View style={styles.routeChips}>
            {([
              ['auto', '自动判断（推荐）'],
              ['chat', '仅对话'],
              ['image', '仅图片创作'],
            ] as const).map(([mode, label]) => <Chip key={mode} label={label} selected={app.composerMode === mode} onPress={() => void app.setComposerMode(mode).then(() => setRouteVisible(false)).catch((error) => setDialog({ title: '暂时无法切换', message: error instanceof Error ? error.message : '请稍后再试。' }))} />)}
          </View>
        </View>
      </Sheet>
      <Sheet visible={attachmentsVisible} title="添加附件" onClose={() => setAttachmentsVisible(false)}>
        <View style={styles.attachmentOptions}>
          <AttachmentOption icon="images-outline" title="从相册选择" subtitle="PNG、JPEG 或 WebP" onPress={() => void addReferences('gallery')} />
          <AttachmentOption icon="camera-outline" title="拍照" subtitle="使用相机拍摄主图" onPress={() => void addReferences('camera')} />
          <AttachmentOption icon="folder-open-outline" title="从设备选择" subtitle="图片、PDF、Word、Excel、PPT、代码、压缩包等" onPress={() => void addDocuments()} />
          <Text style={styles.compatibilityHint}>每个附件不超过 20MB，合计不超过 30MB。常见文本和办公文件会在手机本地提取；压缩包只读取目录，不执行其中内容。</Text>
        </View>
      </Sheet>
      <MaskEditor visible={maskVisible} image={references[0] ?? null} onCancel={() => setMaskVisible(false)} onConfirm={(uri) => { if (maskUri && maskUri !== uri) deleteLocalFile(maskUri); setMaskUri(uri); setMaskVisible(false); }} />
      <ImagePreview uri={previewUri} onClose={() => setPreviewUri(null)} onReuse={(uri) => void reuseImage(uri)} />
      <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} icon={dialog?.icon} actions={dialog?.actions} onClose={() => setDialog(null)} />
      <AppDialog visible={preparingMask} title="正在准备蒙版" message="正在将主图安全转换为适合绘制的 PNG，请稍候。" icon="brush-outline" actions={[{ label: '处理中', disabled: true }]} dismissible={false} onClose={() => undefined}>
        <ActivityIndicator color={colors.primaryStrong} />
      </AppDialog>
      <UpdateManager manualCheckToken={updateCheckToken} />
      <NetworkDiagnostics
        visible={networkVisible}
        onClose={() => setNetworkVisible(false)}
        providerId={diagnosticsProvider?.id ?? ''}
        baseUrl={diagnosticsProvider?.baseUrl ?? ''}
        api={diagnosticsProvider?.chatApi}
        secondaryProviderId={diagnosticsSecondary?.id}
        secondaryBaseUrl={diagnosticsSecondary?.baseUrl}
        secondaryApi={imageProvider?.chatApi}
        imageUrl={[...app.messages].reverse().find((message) => message.remoteImageUrl)?.remoteImageUrl}
      />
    </SafeAreaView>
  );
}

function AttachmentOption({ icon, title, subtitle, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; title: string; subtitle: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.attachmentRow}><View style={styles.attachmentIcon}><Ionicons name={icon} size={23} color={colors.primaryStrong} /></View><View><Text style={styles.attachmentTitle}>{title}</Text><Text style={styles.attachmentSubtitle}>{subtitle}</Text></View></Pressable>;
}

function attachmentIcon(name: string, mimeType: string): React.ComponentProps<typeof Ionicons>['name'] {
  const kind = attachmentKind(name, mimeType);
  return kind === 'office' ? 'briefcase-outline' : kind === 'archive' ? 'archive-outline' : kind === 'text' ? 'code-slash-outline' : kind === 'pdf' ? 'document-text-outline' : 'attach-outline';
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, backgroundColor: colors.background },
  loadingLogo: { width: 108, height: 108, borderRadius: 30 },
  loadingTitle: { color: colors.text, fontSize: 19, fontWeight: '800' },
  loadingText: { color: colors.textMuted },
  header: { minHeight: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, gap: spacing.sm, borderBottomWidth: 1, borderColor: colors.border },
  headerInfo: { flex: 1, alignItems: 'center', gap: 2 },
  routeBar: { minHeight: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, borderBottomWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  routeBarText: { color: colors.primaryStrong, fontSize: 11, fontWeight: '700' },
  routeOptions: { padding: spacing.lg, gap: spacing.md },
  routeTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  routeHint: { color: colors.textMuted, fontSize: 12, lineHeight: 19 },
  routeChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  documentTray: { flexGrow: 0, marginHorizontal: spacing.md, marginTop: 8, maxHeight: 64 },
  documentChip: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: radius.md, backgroundColor: colors.blueSurface },
  documentName: { color: colors.text, fontSize: 12, fontWeight: '600' },
  providerName: { color: colors.text, fontWeight: '700', fontSize: 14 },
  modelName: { color: colors.textMuted, fontSize: 11, maxWidth: '92%' },
  body: { flex: 1 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg, gap: spacing.sm },
  logo: { width: 68, height: 68, borderRadius: 22, backgroundColor: colors.blueSurface, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '800', textAlign: 'center' },
  emptyText: { maxWidth: 330, color: colors.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  suggestionList: { width: '100%', maxWidth: 360, marginTop: spacing.sm, gap: 6 },
  suggestion: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  suggestionIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSurface },
  suggestionCopy: { flex: 1, gap: 2 },
  suggestionTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  suggestionHint: { color: colors.textMuted, fontSize: 10 },
  setupButton: { minHeight: 44, paddingHorizontal: spacing.xl, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, backgroundColor: colors.primary },
  setupText: { color: '#fff', fontWeight: '700' },
  messages: { paddingVertical: spacing.xl, gap: spacing.xl },
  composerWrap: { backgroundColor: colors.background, borderTopWidth: 1, borderColor: colors.border, paddingTop: spacing.sm, paddingBottom: spacing.sm, gap: spacing.sm },
  continuationRow: { paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  continuationChip: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: 5, paddingRight: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.blueSurface },
  continuationImage: { width: 38, height: 38, borderRadius: radius.sm, backgroundColor: colors.surface },
  continuationTextWrap: { flex: 1 },
  continuationTitle: { color: colors.primaryStrong, fontSize: 12, fontWeight: '700' },
  continuationHint: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  continuationClose: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  quickSettings: { minHeight: 34, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  transparent: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background },
  transparentActive: { backgroundColor: colors.blueSurface, borderColor: colors.primary },
  transparentText: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  transparentTextActive: { color: colors.primaryStrong },
  settingsSummary: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 5, justifyContent: 'center', paddingHorizontal: 9 },
  settingsText: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },
  compatibilityHint: { color: colors.textMuted, fontSize: 11, paddingHorizontal: spacing.md },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, paddingHorizontal: spacing.md },
  input: { flex: 1, minHeight: 44, maxHeight: 120, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, color: colors.text, paddingHorizontal: 14, paddingTop: 11, paddingBottom: 10, fontSize: 14, backgroundColor: colors.surface },
  send: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary },
  disabled: { opacity: 0.45 },
  attachmentOptions: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  attachmentRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: 1, borderColor: colors.border },
  attachmentIcon: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blueSurface },
  attachmentTitle: { color: colors.text, fontWeight: '700', fontSize: 14 },
  attachmentSubtitle: { color: colors.textMuted, marginTop: 3, fontSize: 12 },
});
