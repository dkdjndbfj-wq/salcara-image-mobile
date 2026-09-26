import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
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

import type { ChatMessage, DocumentAttachment, ReferenceImage } from '../domain';
import { attachmentKind, isImageAttachment, pickAnyFiles, validateAttachments } from '../document-inputs';
import { latestCompletedImage } from '../domain-utils';
import { createReferenceFromGenerated, pickFromFiles, pickFromGallery, prepareReferenceForMask, prepareReferenceFromAttachment, takePhoto } from '../image-inputs';
import { useApp } from '../state/AppContext';
import { deleteLocalFile, saveToGallery, shareImage } from '../storage/files';
import { colors, radius, spacing } from '../theme';
import { creationRequestIntent, getCreationSkill, snapshotCreationSkill, type CreationSkillId } from '../creation-skills';
import { CreationSkillPicker } from '../components/CreationSkillPicker';
import { MotionPressable } from '../components/MotionPressable';
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
import { AppDialog, Chip, IconButton, Sheet, dismissKeyboardAndBlur, type DialogAction } from '../components/ui';


export function ChatScreen() {
  const app = useApp();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const followLatest = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [skillId, setSkillId] = useState<CreationSkillId | null>(null);
  const [skillsVisible, setSkillsVisible] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState<ReferenceImage[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const isChatOnly = app.composerMode === 'chat';
  const isImageOnly = app.composerMode === 'image';
  const isAuto = app.composerMode === 'auto';
  const imageProvider = app.providers.find((item) => item.id === app.activeProvider?.imageProviderId && item.model) || (app.activeProvider?.model ? app.activeProvider : app.providers.find((item) => item.model));
  const chatProvider = app.providers.find((item) => item.id === app.activeProvider?.analysisProviderId && item.chatModel) || (app.activeProvider?.chatModel ? app.activeProvider : app.providers.find((item) => item.chatModel));
  const diagnosticsProvider = isImageOnly ? imageProvider : chatProvider ?? imageProvider;
  const diagnosticsSecondary = isAuto && diagnosticsProvider?.id !== imageProvider?.id ? imageProvider : undefined;
  const [continueFromPrevious, setContinueFromPrevious] = useState(true);
  const [maskUri, setMaskUri] = useState<string | null>(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [providersVisible, setProvidersVisible] = useState(false);
  const [providerFocusId, setProviderFocusId] = useState<string | null>(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [settingsCapability, setSettingsCapability] = useState<'chat' | 'image'>('chat');
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
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardOpen(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    if (app.ready && app.providers.length === 0) setProvidersVisible(true);
  }, [app.ready, app.providers.length]);

  useEffect(() => {
    if (app.messages.length && followLatest.current) {
      const timer = setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
      return () => clearTimeout(timer);
    }
  }, [app.messages.length]);

  // A draft belongs to one conversation/provider. Never leak its private files into another.
  const draftRef = useRef({ references, documents, maskUri });
  const previousDraftOwner = useRef({ conversationId: app.activeConversation?.id, providerId: app.activeProvider?.id });
  draftRef.current = { references, documents, maskUri };
  useEffect(() => {
    const previous = previousDraftOwner.current;
    previousDraftOwner.current = { conversationId: app.activeConversation?.id, providerId: app.activeProvider?.id };
    setContinueFromPrevious(true);
    followLatest.current = true;
    // Toggling transparency can materialize an empty conversation. Keep its draft.
    if (!previous.conversationId && previous.providerId === app.activeProvider?.id) return;
    setSkillId(null);
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
    const sentSkillId = skillId;
    followLatest.current = true;
    setShowJump(false);
    setSkillId(null);
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
    void app.sendPrompt(text, sentReferences, sentMask, sentContinueFromPrevious, sentDocuments, sentSkillId).catch((error) => {
      setPrompt(text);
      setSkillId(sentSkillId);
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
      chooseSkill('reference-edit');
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
  const selectedSkill = getCreationSkill(skillId);
  const imageIntent = creationRequestIntent(prompt, references, documents, app.composerMode, snapshotCreationSkill(skillId)) !== 'chat';
  const showImageTools = !isChatOnly && (Boolean(selectedSkill) || imageIntent || isImageOnly || transparent);
  const continuingFromPrevious = Boolean(showImageTools && continueFromPrevious && references.length === 0 && previousResult?.imageUri);
  const title = app.activeConversation?.title?.trim() || 'Salcara';
  const modelLabel = (showImageTools ? imageProvider?.model : chatProvider?.chatModel) || '选择模型';
  const startNew = () => {
    dismissKeyboardAndBlur();
    void app.startConversation().then(() => {
      draftRef.current.references.forEach((item) => deleteLocalFile(item.uri));
      draftRef.current.documents.forEach((item) => deleteLocalFile(item.uri));
      deleteLocalFile(draftRef.current.maskUri);
      draftRef.current = { references: [], documents: [], maskUri: null };
      setPrompt(''); setReferences([]); setDocuments([]); setMaskUri(null); setSkillId(null);
    }).catch((error) => setDialog({ title: '暂时无法新建', message: error.message }));
  };
  const chooseSkill = (id: CreationSkillId | null) => {
    const apply = () => { setSkillId(id); setTimeout(() => inputRef.current?.focus(), 240); };
    if (id && isChatOnly) void app.setComposerMode('auto').then(apply).catch((error) => reportError('暂时无法选择技能', error));
    else apply();
  };
  const openModelSettings = (capability: 'chat' | 'image') => { setSettingsCapability(capability); setSettingsVisible(true); };
  const reportError = (title: string, error: unknown) => setDialog({ title, message: error instanceof Error ? error.message : '请稍后重试。' });
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton icon="menu-outline" label="打开会话" onPress={() => setDrawerVisible(true)} />
        <View style={styles.headerInfo}>
          <Text style={styles.providerName} numberOfLines={1}>{title}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="选择模型" style={styles.modelPicker} onPress={() => app.activeProvider ? openModelSettings(showImageTools ? 'image' : 'chat') : setProvidersVisible(true)}>
            <Text style={styles.modelName} numberOfLines={1}>{modelLabel}</Text>
            <Ionicons name="chevron-down" size={12} color={colors.textMuted} />
          </Pressable>
        </View>
        <IconButton icon="create-outline" label="新建会话" disabled={app.generating} onPress={startNew} />
      </View>

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0}>
        {app.messages.length === 0 ? (
          <ScrollView contentContainerStyle={styles.emptyScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
            <View style={styles.emptyState}>
              <View style={styles.logo}><Ionicons name="sparkles-outline" size={32} color={colors.primaryStrong} /></View>
              <Text style={styles.emptyEyebrow}>SALCARA AI</Text>
              <Text style={styles.emptyTitle}>有什么想法？</Text>
              <Text style={styles.emptyText}>聊聊问题，读懂文件，把灵感变成图片。</Text>
              {!keyboardOpen && <View style={styles.suggestions}>
                <Suggestion icon="chatbubble-ellipses-outline" title="聊聊想法" hint="梳理思路，找到答案" onPress={() => { setPrompt('帮我梳理一下思路：'); inputRef.current?.focus(); }} />
                <Suggestion icon="document-text-outline" title="解读文件" hint="总结、提取、分析" onPress={() => void addDocuments()} />
                <Suggestion icon="scan-outline" title="看懂图片" hint="从图片里寻找答案" onPress={() => { setPrompt('请分析这张图片。'); void addReferences('gallery'); }} />
                <Suggestion icon="color-palette-outline" title="创作图片" hint="选择一个创作技能" onPress={() => setSkillsVisible(true)} />
              </View>}
              {!app.activeProvider && <Pressable accessibilityRole="button" style={styles.setupButton} onPress={() => setProvidersVisible(true)}><Text style={styles.setupText}>连接你的 AI 服务</Text><Ionicons name="arrow-forward" size={16} color={colors.primaryStrong} /></Pressable>}
            </View>
          </ScrollView>
        ) : (
          <View style={styles.messageStage}>
            <FlatList
              ref={listRef}
              data={app.messages}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.messages}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              onScroll={(event) => {
                const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
                const near = contentSize.height - layoutMeasurement.height - contentOffset.y < 100;
                followLatest.current = near;
                setShowJump(!near);
              }}
              scrollEventThrottle={80}
              onContentSizeChange={() => { if (followLatest.current) listRef.current?.scrollToEnd({ animated: true }); }}
              renderItem={({ item }) => <MessageBubble
                message={item}
                elapsedSeconds={app.elapsedSeconds}
                requestStage={app.requestStage}
                onCancel={app.cancelGeneration}
                onRetry={() => void app.retryMessage(item).catch((error) => reportError('重试失败', error))}
                onSave={() => item.imageUri && void handleImageAction('save', item.imageUri)}
                onShare={() => item.imageUri && void handleImageAction('share', item.imageUri)}
                onReuse={() => item.imageUri && void reuseImage(item.imageUri)}
                onPreview={() => setPreviewUri(item.imageUri)}
              />}
            />
            {showJump && <Pressable accessibilityLabel="回到最新消息" style={styles.jump} onPress={() => { followLatest.current = true; listRef.current?.scrollToEnd({ animated: true }); setShowJump(false); }}><Ionicons name="arrow-down" size={20} color={colors.text} /></Pressable>}
          </View>
        )}

        <View style={styles.composerWrap}>
          <View style={styles.composerCard}>
            {continuingFromPrevious && previousResult?.imageUri && <View style={styles.continuationRow}>
              <Pressable style={styles.continuationChip} onPress={() => setPreviewUri(previousResult.imageUri)}>
                <Image source={{ uri: previousResult.imageUri }} style={styles.continuationImage} />
                <View style={styles.continuationTextWrap}><Text style={styles.continuationTitle}>接着上一张创作</Text><Text style={styles.continuationHint}>发送作图请求时用作参考</Text></View>
              </Pressable>
              <IconButton icon="close" label="本次不使用上一张" onPress={() => setContinueFromPrevious(false)} />
            </View>}
            <ReferenceTray images={references} onChange={changeReferences} onEditMask={() => void openMaskEditor()} hasMask={Boolean(maskUri)} allowMask={showImageTools} />
            {documents.length > 0 && <ScrollView horizontal style={styles.documentTray} contentContainerStyle={{ gap: 8 }} showsHorizontalScrollIndicator={false}>
              {documents.map((document) => <View key={document.id} style={styles.documentChip}>
                <Ionicons name={attachmentIcon(document.name, document.mimeType)} size={22} color={colors.primaryStrong} />
                <View style={styles.documentCopy}><Text numberOfLines={1} style={styles.documentName}>{document.name}</Text><Text style={styles.documentSize}>{(document.size / 1024 / 1024).toFixed(1)} MB</Text></View>
                <Pressable accessibilityLabel={'移除 ' + document.name} hitSlop={8} style={styles.removeDocument} onPress={() => { setDocuments((current) => current.filter((item) => item.id !== document.id)); deleteLocalFile(document.uri); }}><Ionicons name="close" size={16} color={colors.textMuted} /></Pressable>
              </View>)}
            </ScrollView>}
            {selectedSkill && <View style={styles.skillRow}>
              <Pressable style={styles.skillLabel} accessibilityRole="button" accessibilityLabel="更换创作技能" onPress={() => setSkillsVisible(true)}><Ionicons name={selectedSkill.icon} size={16} color={colors.primaryStrong} /><Text style={styles.skillText}>{selectedSkill.title}</Text><Ionicons name="chevron-down" size={12} color={colors.primaryStrong} /></Pressable>
              <Pressable accessibilityLabel="移除创作技能" hitSlop={8} style={styles.skillRemove} onPress={() => setSkillId(null)}><Ionicons name="close" size={15} color={colors.primaryStrong} /></Pressable>
            </View>}
            <TextInput
              ref={inputRef}
              accessibilityLabel="消息"
              value={prompt}
              onChangeText={setPrompt}
              placeholder={selectedSkill ? '描述你想创作的画面…' : '发消息，或描述你的想法…'}
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={4000}
              textAlignVertical="top"
              style={styles.input}
            />
            {showImageTools && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.imageTools}>
              <Pressable accessibilityRole="switch" accessibilityLabel="透明背景" accessibilityState={{ checked: transparent }} style={[styles.imageTool, transparent && styles.imageToolActive]} disabled={!app.activeProvider || app.generating} onPress={() => void app.toggleTransparent().catch((error) => reportError('无法切换透明背景', error))}><Ionicons name="layers-outline" size={15} color={transparent ? colors.primaryStrong : colors.textMuted} /><Text style={[styles.imageToolText, transparent && { color: colors.primaryStrong }]}>透明背景</Text></Pressable>
              <Pressable style={styles.imageTool} onPress={() => openModelSettings('image')}><Ionicons name="options-outline" size={15} color={colors.textMuted} /><Text style={styles.imageToolText}>{imageProvider?.quality && imageProvider.aspectRatio && imageProvider.resolutionTier ? [imageProvider.quality, imageProvider.aspectRatio, imageProvider.resolutionTier].join(' · ') : '图片参数'}</Text></Pressable>
            </ScrollView>}
            <View style={styles.composerToolbar}>
              <IconButton icon="add" label="添加图片或文件" disabled={app.generating} onPress={() => setAttachmentsVisible(true)} />
              <Pressable accessibilityRole="button" style={[styles.toolPill, selectedSkill && styles.toolPillActive]} onPress={() => { dismissKeyboardAndBlur(); setSkillsVisible(true); }}><Ionicons name="sparkles-outline" size={17} color={selectedSkill ? colors.primaryStrong : colors.textMuted} /><Text style={[styles.toolText, selectedSkill && { color: colors.primaryStrong }]}>技能</Text></Pressable>
              <View style={{ flex: 1 }} />
              <Pressable accessibilityRole="button" accessibilityLabel="更多发送选项" style={styles.moreTool} onPress={() => { dismissKeyboardAndBlur(); setRouteVisible(true); }}><Text style={styles.modeText}>{isAuto ? '自动' : isChatOnly ? '对话' : '图片'}</Text><Ionicons name="chevron-down" size={12} color={colors.textMuted} /></Pressable>
              <MotionPressable accessibilityRole="button" accessibilityLabel={app.generating ? '停止生成' : '发送'} disabled={!app.generating && !prompt.trim() && !references.length && !documents.length} onPress={app.generating ? app.cancelGeneration : send} style={[styles.send, !app.generating && !prompt.trim() && !references.length && !documents.length && styles.disabled]}><Ionicons name={app.generating ? 'stop' : 'arrow-up'} size={app.generating ? 17 : 22} color="#fff" /></MotionPressable>
            </View>
          </View>
          {!keyboardOpen && <Text style={styles.composerHint}>{selectedSkill ? '发送后先检查创作要求，再开始生成' : '图片与文件可直接添加到对话中'}</Text>}
        </View>
      </KeyboardAvoidingView>

      <ConversationDrawer visible={drawerVisible} onClose={() => setDrawerVisible(false)}
        onOpenProviders={() => { setDrawerVisible(false); setProvidersVisible(true); }}
        onOpenAbout={() => { setDrawerVisible(false); setAboutVisible(true); }}
        onOpenNetwork={() => { setDrawerVisible(false); setNetworkVisible(true); }}
        onOpenSettings={() => { setDrawerVisible(false); setAppSettingsVisible(true); }} />
      <ProviderManager visible={providersVisible} onClose={() => { setProvidersVisible(false); setProviderFocusId(null); }} focusProviderId={providerFocusId} />
      <SettingsSheet visible={settingsVisible} initialCapability={settingsCapability} onClose={() => setSettingsVisible(false)} onOpenProviders={(providerId) => { setProviderFocusId(providerId ?? null); setProvidersVisible(true); }} />
      <AboutSheet visible={aboutVisible} onClose={() => setAboutVisible(false)} onCheckUpdates={() => setUpdateCheckToken((value) => value + 1)} />
      <AppSettingsSheet visible={appSettingsVisible} onClose={() => setAppSettingsVisible(false)}
        onOpenProviders={() => { setAppSettingsVisible(false); setProvidersVisible(true); }}
        onOpenNetwork={() => { setAppSettingsVisible(false); setNetworkVisible(true); }}
        onOpenAbout={() => { setAppSettingsVisible(false); setAboutVisible(true); }}
        onCheckUpdates={() => { setAppSettingsVisible(false); setUpdateCheckToken((value) => value + 1); }} />
      <CreationSkillPicker visible={skillsVisible} selectedId={skillId} onSelect={chooseSkill} onClose={() => setSkillsVisible(false)} />
      <Sheet visible={routeVisible} title="发送选项" onClose={() => setRouteVisible(false)}>
        <View style={styles.routeOptions}>
          {([
            ['auto', '自动', '根据你的要求，在同一会话里对话与创作', 'sparkles-outline'],
            ['chat', '仅对话', '问答、图片理解和文件分析', 'chatbubbles-outline'],
            ['image', '直接创作图片', '明确作图时使用独立图片接口', 'image-outline'],
          ] as const).map(([mode, label, hint, icon]) => <Pressable key={mode} accessibilityRole="radio" accessibilityState={{ checked: app.composerMode === mode }} style={[styles.routeOption, app.composerMode === mode && styles.routeSelected]} onPress={() => void app.setComposerMode(mode).then(() => { if (mode === 'chat') setSkillId(null); setRouteVisible(false); }).catch((error) => reportError('暂时无法切换', error))}>
            <Ionicons name={icon} size={22} color={app.composerMode === mode ? colors.primaryStrong : colors.textMuted} /><View style={{ flex: 1, gap: 4 }}><Text style={styles.optionTitle}>{label}</Text><Text style={styles.optionHint}>{hint}</Text></View>{app.composerMode === mode && <Ionicons name="checkmark" size={20} color={colors.primaryStrong} />}
          </Pressable>)}
        </View>
      </Sheet>
      <Sheet visible={attachmentsVisible} title="添加到对话" onClose={() => setAttachmentsVisible(false)}>
        <View style={styles.attachmentOptions}>
          <AttachmentOption icon="images-outline" title="相册" subtitle="选择图片作为提问或创作的参考" onPress={() => void addReferences('gallery')} />
          <AttachmentOption icon="camera-outline" title="拍照" subtitle="拍下此刻看到的内容" onPress={() => void addReferences('camera')} />
          <AttachmentOption icon="folder-open-outline" title="文件" subtitle="PDF、Word、表格、代码及更多" onPress={() => void addDocuments()} />
          <Text style={styles.attachmentHint}>每个附件最多 20 MB，合计最多 30 MB</Text>
        </View>
      </Sheet>
      <MaskEditor visible={maskVisible} image={references[0] ?? null} onCancel={() => setMaskVisible(false)} onConfirm={(uri) => { if (maskUri && maskUri !== uri) deleteLocalFile(maskUri); setMaskUri(uri); setMaskVisible(false); }} />
      <ImagePreview uri={previewUri} onClose={() => setPreviewUri(null)} onReuse={(uri) => void reuseImage(uri)} onSave={(uri) => void handleImageAction('save', uri)} onShare={(uri) => void handleImageAction('share', uri)} />
      <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} icon={dialog?.icon} actions={dialog?.actions} onClose={() => setDialog(null)} />
      <AppDialog visible={preparingMask} title="正在准备蒙版" message="正在准备可编辑的原图…" icon="brush-outline" actions={[{ label: '处理中', disabled: true }]} dismissible={false} onClose={() => undefined}><ActivityIndicator color={colors.primaryStrong} /></AppDialog>
      <UpdateManager manualCheckToken={updateCheckToken} />
      <NetworkDiagnostics visible={networkVisible} onClose={() => setNetworkVisible(false)} providerId={diagnosticsProvider?.id ?? ''} baseUrl={diagnosticsProvider?.baseUrl ?? ''} api={diagnosticsProvider?.chatApi} secondaryProviderId={diagnosticsSecondary?.id} secondaryBaseUrl={diagnosticsSecondary?.baseUrl} secondaryApi={imageProvider?.chatApi} imageUrl={[...app.messages].reverse().find((message) => message.remoteImageUrl)?.remoteImageUrl} />
    </SafeAreaView>
  );
}

function Suggestion({ icon, title, hint, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; title: string; hint: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: colors.blueSurface }]}><Ionicons name={icon} size={21} color={colors.primaryStrong} /><Text style={styles.suggestionTitle}>{title}</Text><Text style={styles.suggestionHint}>{hint}</Text></Pressable>;
}
function AttachmentOption({ icon, title, subtitle, onPress }: { icon: React.ComponentProps<typeof Ionicons>['name']; title: string; subtitle: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.attachmentRow, pressed && { backgroundColor: colors.surface }]}><View style={styles.attachmentIcon}><Ionicons name={icon} size={24} color={colors.primaryStrong} /></View><View style={{ flex: 1, gap: 4 }}><Text style={styles.optionTitle}>{title}</Text><Text style={styles.optionHint}>{subtitle}</Text></View><Ionicons name="chevron-forward" size={17} color={colors.subtle} /></Pressable>;
}
function attachmentIcon(name: string, mimeType: string): React.ComponentProps<typeof Ionicons>['name'] {
  const kind = attachmentKind(name, mimeType);
  return kind === 'office' ? 'briefcase-outline' : kind === 'archive' ? 'archive-outline' : kind === 'text' ? 'code-slash-outline' : kind === 'pdf' ? 'document-text-outline' : 'attach-outline';
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, backgroundColor: colors.background },
  loadingLogo: { width: 80, height: 80, borderRadius: 24 }, loadingTitle: { color: colors.text, fontSize: 18, fontWeight: '600' }, loadingText: { color: colors.textMuted, fontSize: 13 },
  header: { height: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, gap: 8 },
  headerInfo: { flex: 1, alignItems: 'center', gap: 2 },
  providerName: { color: colors.text, fontWeight: '600', fontSize: 17, maxWidth: '96%' },
  modelPicker: { minHeight: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, maxWidth: '96%' },
  modelName: { color: colors.textMuted, fontSize: 11, flexShrink: 1 },
  body: { flex: 1 }, emptyScroll: { flexGrow: 1, justifyContent: 'center', paddingVertical: 28 }, emptyState: { alignItems: 'center', paddingHorizontal: 28, alignSelf: 'center', width: '100%', maxWidth: 450 },
  logo: { width: 64, height: 64, borderRadius: 22, backgroundColor: colors.blueSurface, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  emptyEyebrow: { color: colors.subtle, fontSize: 10, letterSpacing: 2.5, fontWeight: '600', marginBottom: 9 },
  emptyTitle: { color: colors.text, fontSize: 27, lineHeight: 36, fontWeight: '600', letterSpacing: -0.6 },
  emptyText: { color: colors.textMuted, fontSize: 13, lineHeight: 21, textAlign: 'center', marginTop: 10 },
  suggestions: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 32 },
  suggestion: { width: '48%', flexGrow: 1, minHeight: 103, borderRadius: 16, padding: 16, backgroundColor: colors.surface, gap: 6 },
  suggestionTitle: { color: colors.text, fontSize: 14, fontWeight: '500', marginTop: 2 }, suggestionHint: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  setupButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 20 }, setupText: { color: colors.primaryStrong, fontSize: 14, fontWeight: '600' },
  messageStage: { flex: 1 }, messages: { paddingTop: 24, paddingBottom: 28, gap: 26, width: '100%', maxWidth: 760, alignSelf: 'center' },
  jump: { position: 'absolute', bottom: 14, alignSelf: 'center', width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', elevation: 2 },
  composerWrap: { width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: 12, paddingBottom: 6, paddingTop: 6, backgroundColor: colors.background },
  composerCard: { backgroundColor: colors.surface, borderRadius: 24, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  composerHint: { textAlign: 'center', fontSize: 10, color: colors.subtle, paddingTop: 7, paddingBottom: 2 },
  input: { minHeight: 61, maxHeight: 150, color: colors.text, paddingHorizontal: 18, paddingTop: 17, paddingBottom: 10, fontSize: 15, lineHeight: 22 },
  composerToolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 7, paddingBottom: 7, gap: 3 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink, marginRight: 2 },
  disabled: { opacity: 0.25 }, toolPill: { height: 38, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 12 }, toolPillActive: { backgroundColor: colors.blueSurface }, toolText: { fontSize: 12, color: colors.textMuted },
  moreTool: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 10 }, modeText: { fontSize: 11, color: colors.textMuted },
  skillRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginLeft: 14, marginTop: 12, borderRadius: 10, backgroundColor: '#E4EFFC' }, skillLabel: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10 }, skillText: { color: colors.primaryStrong, fontSize: 12, fontWeight: '600' }, skillRemove: { height: 36, width: 32, alignItems: 'center', justifyContent: 'center' },
  imageTools: { paddingHorizontal: 14, paddingBottom: 5, gap: 7 }, imageTool: { minHeight: 34, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 10, backgroundColor: colors.background }, imageToolActive: { backgroundColor: '#E4EFFC' }, imageToolText: { fontSize: 11, color: colors.textMuted },
  continuationRow: { margin: 10, marginBottom: 0, paddingLeft: 6, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background, borderRadius: 14 }, continuationChip: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }, continuationImage: { width: 38, height: 38, borderRadius: 9 }, continuationTextWrap: { flex: 1, gap: 3 }, continuationTitle: { fontSize: 12, color: colors.text, fontWeight: '500' }, continuationHint: { fontSize: 10, color: colors.textMuted },
  documentTray: { flexGrow: 0, margin: 12, marginBottom: 0, maxHeight: 62 }, documentChip: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 9, borderRadius: 12, backgroundColor: colors.background }, documentCopy: { maxWidth: 156, gap: 3 }, documentName: { color: colors.text, fontSize: 12 }, documentSize: { fontSize: 10, color: colors.textMuted }, removeDocument: { width: 28, height: 34, alignItems: 'center', justifyContent: 'center' },
  routeOptions: { padding: 16, gap: 4 }, routeOption: { minHeight: 76, borderRadius: 16, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }, routeSelected: { backgroundColor: colors.blueSurface }, optionTitle: { color: colors.text, fontSize: 15, fontWeight: '500' }, optionHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  attachmentOptions: { paddingHorizontal: 20 }, attachmentRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 14 }, attachmentIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: colors.blueSurface, justifyContent: 'center', alignItems: 'center' }, attachmentHint: { fontSize: 11, color: colors.subtle, textAlign: 'center', paddingTop: 16 },
});
