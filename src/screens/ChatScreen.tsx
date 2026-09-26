import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AboutSheet } from '../components/AboutSheet';
import { AppSettingsSheet } from '../components/AppSettingsSheet';
import { BrandMark, GradientText, LivingMark } from '../components/Brand';
import { Icon } from '../components/Icon';
import { Composer } from '../components/Composer';
import { ConversationDrawer } from '../components/ConversationDrawer';
import { ImagePreview } from '../components/ImagePreview';
import { MaskEditor } from '../components/MaskEditor';
import { MessageBubble } from '../components/MessageBubble';
import { ModelSwitcher } from '../components/ModelSwitcher';
import { NetworkDiagnostics } from '../components/NetworkDiagnostics';
import { ProviderManager } from '../components/ProviderManager';
import { Appear, AppDialog, IconButton, MotionPressable, PrimaryButton, Sheet, showToast, ToastHost, dismissKeyboardAndBlur, type DialogAction, type IconName } from '../components/ui';
import { UpdateManager } from '../components/UpdateManager';
import { isImageAttachment, pickAnyFiles, validateAttachments } from '../document-inputs';
import type { ChatMessage, DocumentAttachment, ReferenceImage } from '../domain';
import { pickFromFiles, pickFromGallery, prepareReferenceForMask, prepareReferenceFromAttachment, takePhoto } from '../image-inputs';
import { useApp } from '../state/AppContext';
import { deleteLocalFile, saveToGallery, shareImage } from '../storage/files';
import { colors, prettyModel, shadow } from '../theme';

type Dialog = { title: string; message: string; actions?: DialogAction[]; icon?: IconName };

const SUGGESTIONS: { icon: IconName; title: string; hint: string; prompt?: string; action?: 'files' | 'gallery'; draw?: boolean }[] = [
  { icon: 'palette', title: '创作一幅画', hint: '晨光里在云上打盹的橘猫', prompt: '画一只在云朵上打盹的橘猫，晨光，柔和水彩风格', draw: true },
  { icon: 'file', title: '读懂一份文件', hint: '总结要点、提炼数据', action: 'files' },
  { icon: 'scan', title: '看图解答', hint: '拍一张照片来问我', action: 'gallery' },
  { icon: 'lightbulb', title: '一起想点子', hint: '周末去哪儿玩更有意思', prompt: '帮我策划一个轻松有趣的周末：' },
  { icon: 'wand', title: '改一张照片', hint: '换背景、换风格、局部重绘', action: 'gallery', draw: true },
];

export function ChatScreen() {
  const app = useApp();
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const followRef = useRef(true);
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<ReferenceImage[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [maskUri, setMaskUri] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [settings, setSettings] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [about, setAbout] = useState(false);
  const [network, setNetwork] = useState(false);
  const [maskOpen, setMaskOpen] = useState(false);
  const [preparingMask, setPreparingMask] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [updateToken, setUpdateToken] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  const report = useCallback((title: string, error: unknown, icon: IconName = 'alert') =>
    setDialog({ title, message: error instanceof Error ? error.message : '请稍后再试', icon }), []);
  // Stable callbacks keep memoized message rows from re-rendering on every tick.
  const { retry: retryMessage, stop } = app;
  const onRetry = useCallback((message: ChatMessage) => void retryMessage(message).catch((error) => report('无法重试', error)), [retryMessage, report]);
  const saveImage = useCallback((uri: string) => void saveToGallery(uri).then(() => showToast('已保存到相册')).catch((error) => report('保存失败', error)), [report]);
  const share = useCallback((uri: string) => void shareImage(uri).catch((error) => report('分享失败', error)), [report]);


  // Drafts belong to the conversation they were written in.
  const draftRef = useRef({ images, documents, maskUri });
  draftRef.current = { images, documents, maskUri };
  useEffect(() => {
    followRef.current = true;
    setShowJump(false);
    const draft = draftRef.current;
    if (!draft.images.length && !draft.documents.length && !draft.maskUri) return;
    draft.images.forEach((item) => deleteLocalFile(item.uri));
    draft.documents.forEach((item) => deleteLocalFile(item.uri));
    deleteLocalFile(draft.maskUri);
    setImages([]); setDocuments([]); setMaskUri(null);
  }, [app.activeConversationId]);

  if (!app.ready) {
    return <SafeAreaView style={styles.loading}><BrandMark size={64} /></SafeAreaView>;
  }

  const addImages = async (source: 'gallery' | 'camera' | 'files') => {
    setAttachOpen(false);
    try {
      const remaining = 4 - images.length;
      if (remaining <= 0) throw new Error('一次最多添加 4 张图片');
      if (source === 'files') { await addFiles(); return; }
      const picked = source === 'gallery' ? await pickFromGallery(remaining) : await takePhoto();
      try { validateAttachments(documents, [...images, ...picked]); } catch (error) { picked.forEach((item) => deleteLocalFile(item.uri)); throw error; }
      setImages((current) => [...current, ...picked].slice(0, 4));
    } catch (error) { report('无法添加图片', error, 'image'); }
  };

  const addFiles = async () => {
    try {
      const picked = await pickAnyFiles(4 - documents.length);
      const imageFiles = picked.filter(isImageAttachment);
      const converted: ReferenceImage[] = [];
      try { for (const item of imageFiles) converted.push(await prepareReferenceFromAttachment(item)); }
      catch (error) { picked.forEach((item) => deleteLocalFile(item.uri)); converted.forEach((item) => deleteLocalFile(item.uri)); throw error; }
      const docs = picked.filter((item) => !isImageAttachment(item));
      try { validateAttachments([...documents, ...docs], [...images, ...converted]); }
      catch (error) { picked.forEach((item) => deleteLocalFile(item.uri)); converted.forEach((item) => deleteLocalFile(item.uri)); throw error; }
      imageFiles.forEach((item) => deleteLocalFile(item.uri));
      setImages((current) => [...current, ...converted].slice(0, 4));
      setDocuments((current) => [...current, ...docs]);
    } catch (error) { report('无法添加文件', error, 'file'); }
  };

  const removeImage = (id: string) => {
    const target = images.find((item) => item.id === id);
    if (!target) return;
    if (images[0]?.id === id && maskUri) { deleteLocalFile(maskUri); setMaskUri(null); }
    deleteLocalFile(target.uri);
    setImages((current) => current.filter((item) => item.id !== id));
  };
  const removeDocument = (id: string) => {
    const target = documents.find((item) => item.id === id);
    deleteLocalFile(target?.uri);
    setDocuments((current) => current.filter((item) => item.id !== id));
  };

  const openMask = async () => {
    const primary = images[0];
    if (!primary || preparingMask) return;
    try {
      setPreparingMask(true);
      const prepared = await prepareReferenceForMask(primary);
      if (prepared.uri !== primary.uri) {
        setImages((current) => [prepared, ...current.slice(1)]);
        deleteLocalFile(primary.uri);
        if (maskUri) { deleteLocalFile(maskUri); setMaskUri(null); }
      }
      setMaskOpen(true);
    } catch (error) { report('无法打开涂抹', error, 'brush'); }
    finally { setPreparingMask(false); }
  };

  const send = () => {
    if (!app.providers.length) { setProvidersOpen(true); return; }
    const text = prompt.trim();
    if (!text && !images.length && !documents.length) return;
    const sent = { text, images, documents, maskUri };
    followRef.current = true;
    setShowJump(false);
    setPrompt(''); setImages([]); setDocuments([]); setMaskUri(null);
    draftRef.current = { images: [], documents: [], maskUri: null };
    void app.send(sent).catch((error) => {
      setPrompt(text); setImages(sent.images); setDocuments(sent.documents); setMaskUri(sent.maskUri);
      report('没有发送出去', error);
    });
  };

  const newChat = () => {
    try {
      dismissKeyboardAndBlur();
      app.newChat();
      setTimeout(() => inputRef.current?.focus(), 250);
    } catch (error) { report('稍等一下', error, 'hourglass'); }
  };


  const useSuggestion = (item: typeof SUGGESTIONS[number]) => {
    if (item.action === 'gallery' && item.draw) setPrompt('把这张照片换成');
    if (item.action === 'files') { void addFiles(); return; }
    if (item.action === 'gallery') { void addImages('gallery'); return; }
    setPrompt(item.prompt ?? '');
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const lastId = app.messages[app.messages.length - 1]?.id;
  const engine = prettyModel(app.chatProvider?.chatModel ?? app.imageProvider?.model);
  const secondary = app.chatProvider && app.imageProvider && app.imageProvider.id !== app.chatProvider.id ? app.imageProvider : undefined;
  const isDraft = !app.activeConversationId && app.messages.length === 0;
  const connected = app.providers.length > 0;

  if (!connected) {
    return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Welcome onStart={() => setProvidersOpen(true)} />
      <ProviderManager visible={providersOpen} onClose={() => setProvidersOpen(false)} />
      <ToastHost />
    </SafeAreaView>;
  }

  return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
    <View style={styles.header}>
      <IconButton icon="menu" label="打开侧边栏" onPress={() => setDrawer(true)} />
      <MotionPressable scaleTo={0.96} accessibilityRole="button" accessibilityLabel="切换模型" onPress={() => setModelsOpen(true)} wrapperStyle={styles.titleWrap} style={styles.titleButton}>
        <Text style={styles.title}>Salcara</Text>
        {engine ? <Text style={styles.engine} numberOfLines={1}>{engine}</Text> : null}
        <Icon name="chevronRight" size={15} color={colors.subtle} strokeWidth={2} />
      </MotionPressable>
      <IconButton icon="compose" label="新对话" disabled={app.busy || isDraft} onPress={newChat} />
    </View>

    <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {app.messages.length === 0
        ? <Home key={app.activeConversationId ?? 'draft'} canDraw={Boolean(app.imageProvider)} onSuggestion={useSuggestion} />
        : <View style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            data={app.messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            showsVerticalScrollIndicator={false}
            onScroll={(event) => {
              const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
              const near = contentSize.height - layoutMeasurement.height - contentOffset.y < 120;
              followRef.current = near;
              if (near === showJump) setShowJump(!near);
            }}
            scrollEventThrottle={64}
            onContentSizeChange={() => { if (followRef.current) listRef.current?.scrollToEnd({ animated: true }); }}
            renderItem={({ item }) => <MessageBubble
              message={item}
              phase={item.id === lastId ? app.phase : 'idle'}
              elapsedSeconds={item.id === lastId ? app.elapsedSeconds : 0}
              isLast={item.id === lastId}
              onStop={stop}
              onRetry={onRetry}
              onPreview={setPreviewUri}
              onSave={saveImage}
              onShare={share}
            />}
          />
          {showJump && <Appear style={styles.jumpWrap} distance={6}>
            <MotionPressable accessibilityRole="button" accessibilityLabel="回到底部" onPress={() => { followRef.current = true; setShowJump(false); listRef.current?.scrollToEnd({ animated: true }); }} style={styles.jump}>
              <Icon name="arrowDown" size={18} color={colors.text} />
            </MotionPressable>
          </Appear>}
        </View>}

      <Composer
        inputRef={inputRef}
        value={prompt}
        onChangeText={setPrompt}
        images={images}
        documents={documents}
        hasMask={Boolean(maskUri)}
        busy={app.busy}
        onSend={send}
        onStop={app.stop}
        onOpenAttach={() => { dismissKeyboardAndBlur(); setAttachOpen(true); }}
        onRemoveImage={removeImage}
        onRemoveDocument={removeDocument}
        onEditMask={() => void openMask()}
        placeholder={images.length ? '想怎么处理这张图？' : documents.length ? '想从文件里了解什么？' : undefined}
      />
    </KeyboardAvoidingView>

    <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)}>
      <View style={styles.attachRow}>
        <AttachTile icon="camera" label="相机" onPress={() => void addImages('camera')} />
        <AttachTile icon="image" label="照片" onPress={() => void addImages('gallery')} />
        <AttachTile icon="paperclip" label="文件" onPress={() => void addImages('files')} />
      </View>
      <Text style={styles.attachHint}>最多 4 张图片和 4 个文件 · 支持 PDF、Word、Excel、PPT 与代码</Text>
    </Sheet>
    <ConversationDrawer visible={drawer} onClose={() => setDrawer(false)} onNewChat={newChat} onOpenSettings={() => setSettings(true)} />
    <AppSettingsSheet visible={settings} onClose={() => setSettings(false)}
      onOpenProviders={() => setProvidersOpen(true)} onOpenModels={() => setModelsOpen(true)}
      onOpenNetwork={() => setNetwork(true)} onOpenAbout={() => setAbout(true)} onCheckUpdates={() => setUpdateToken((value) => value + 1)} />
    <ProviderManager visible={providersOpen} onClose={() => setProvidersOpen(false)} />
    <ModelSwitcher visible={modelsOpen} onClose={() => setModelsOpen(false)} onManageProviders={() => setProvidersOpen(true)} />
    <AboutSheet visible={about} onClose={() => setAbout(false)} onCheckUpdates={() => setUpdateToken((value) => value + 1)} />
    <NetworkDiagnostics visible={network} onClose={() => setNetwork(false)}
      providerId={(app.chatProvider ?? app.imageProvider)?.id ?? ''} baseUrl={(app.chatProvider ?? app.imageProvider)?.baseUrl ?? ''} api={app.chatProvider?.chatApi}
      secondaryProviderId={secondary?.id} secondaryBaseUrl={secondary?.baseUrl}
      imageUrl={[...app.messages].reverse().find((message) => message.remoteImageUrl)?.remoteImageUrl} />
    <MaskEditor visible={maskOpen} image={images[0] ?? null} onCancel={() => setMaskOpen(false)}
      onConfirm={(uri) => { if (maskUri && maskUri !== uri) deleteLocalFile(maskUri); setMaskUri(uri); setMaskOpen(false); }} />
    <ImagePreview uri={previewUri} onClose={() => setPreviewUri(null)} onSave={saveImage} onShare={share} />
    <AppDialog visible={Boolean(dialog)} title={dialog?.title ?? ''} message={dialog?.message} icon={dialog?.icon} actions={dialog?.actions} onClose={() => setDialog(null)} />
    <AppDialog visible={preparingMask} title="正在准备图片" message="马上就好…" icon="brush" actions={[{ label: '处理中', disabled: true }]} dismissible={false} onClose={() => undefined}><ActivityIndicator color={colors.primary} /></AppDialog>
    <UpdateManager manualCheckToken={updateToken} />
    <ToastHost />
  </SafeAreaView>;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
}

function Home({ canDraw, onSuggestion }: { canDraw: boolean; onSuggestion: (item: typeof SUGGESTIONS[number]) => void }) {
  const { width } = useWindowDimensions();
  const items = SUGGESTIONS.filter((item) => canDraw || !item.draw);
  return <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={styles.home} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
      <Appear distance={8}><LivingMark size={34} /></Appear>
      <Appear delay={90} distance={12}><GradientText text={greeting()} fontSize={34} width={Math.min(width - 56, 360)} /></Appear>
      <Appear delay={170} distance={12}><Text style={styles.homeSubtitle}>{canDraw ? '想聊点什么，\n或者让我画点什么？' : '今天想聊点什么？'}</Text></Appear>
    </ScrollView>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestions} keyboardShouldPersistTaps="handled">
      {items.map((item, index) => <Appear key={item.title} delay={260 + index * 60} distance={10}>
        <MotionPressable scaleTo={0.96} accessibilityRole="button" accessibilityLabel={item.title} onPress={() => onSuggestion(item)} style={styles.suggestion}>
          <Icon name={item.icon} size={20} color={colors.primary} />
          <Text style={styles.suggestionTitle}>{item.title}</Text>
          <Text style={styles.suggestionHint} numberOfLines={1}>{item.hint}</Text>
        </MotionPressable>
      </Appear>)}
    </ScrollView>
  </View>;
}

function Welcome({ onStart }: { onStart: () => void }) {
  return <View style={styles.welcome}>
    <View style={styles.welcomeCenter}>
      <Appear distance={10}><View style={styles.welcomeHalo}><BrandMark size={104} /></View></Appear>
      <Appear delay={120}><Text style={styles.welcomeTitle}>Salcara</Text></Appear>
      <Appear delay={200}><Text style={styles.welcomeTagline}>对话、理解与创作，{'\n'}都在一句话之间。</Text></Appear>
      <Appear delay={300} style={styles.features}>
        <Feature icon="chat" text="像朋友一样聊天，读懂图片和文件" />
        <Feature icon="sparkles" text="一句话生成图片，随口就能继续修改" />
        <Feature icon="lock" text="对话只保存在你的手机里" />
      </Appear>
    </View>
    <Appear delay={420}><PrimaryButton label="开始使用" onPress={onStart} /></Appear>
    <Text style={styles.welcomeNote}>需要一个兼容 OpenAI 或 Claude 的 API 服务</Text>
  </View>;
}

function Feature({ icon, text }: { icon: IconName; text: string }) {
  return <View style={styles.feature}>
    <View style={styles.featureIcon}><Icon name={icon} size={18} color={colors.primary} /></View>
    <Text style={styles.featureText}>{text}</Text>
  </View>;
}

function AttachTile({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return <MotionPressable wrapperStyle={{ flex: 1 }} scaleTo={0.94} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.attachTile}>
    <Icon name={icon} size={26} color={colors.text} />
    <Text style={styles.attachLabel}>{label}</Text>
  </MotionPressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 4 },
  titleWrap: { flex: 1, flexShrink: 1 },
  titleButton: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', height: 40, paddingHorizontal: 8, borderRadius: 20 },
  title: { color: colors.text, fontSize: 18, fontWeight: '600', letterSpacing: -0.3 },
  engine: { color: colors.subtle, fontSize: 15, flexShrink: 1 },
  body: { flex: 1 },
  messages: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28, gap: 26, width: '100%', maxWidth: 780, alignSelf: 'center' },
  jumpWrap: { position: 'absolute', bottom: 12, alignSelf: 'center' },
  jump: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, ...shadow.soft },
  home: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 28, paddingBottom: 40, gap: 10 },
  homeSubtitle: { color: '#B3B8CE', fontSize: 30, lineHeight: 40, fontWeight: '500', letterSpacing: -0.6 },
  suggestions: { paddingHorizontal: 12, gap: 8, paddingBottom: 4 },
  suggestion: { width: 164, minHeight: 104, padding: 14, borderRadius: 20, backgroundColor: colors.surface, gap: 4 },
  suggestionTitle: { color: colors.text, fontSize: 14.5, fontWeight: '600', marginTop: 10 },
  suggestionHint: { color: colors.subtle, fontSize: 12.5 },
  attachRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingTop: 8 },
  attachTile: { height: 96, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', gap: 10 },
  attachLabel: { color: colors.text, fontSize: 14, fontWeight: '500' },
  attachHint: { color: colors.subtle, fontSize: 12, textAlign: 'center', marginTop: 16, marginBottom: 6, paddingHorizontal: 24 },
  welcome: { flex: 1, paddingHorizontal: 24, paddingBottom: 12 },
  welcomeCenter: { flex: 1, justifyContent: 'center' },
  welcomeHalo: { width: 104, height: 104, marginBottom: 26 },
  welcomeTitle: { color: colors.text, fontSize: 40, fontWeight: '700', letterSpacing: -1.2 },
  welcomeTagline: { color: colors.textMuted, fontSize: 20, lineHeight: 30, marginTop: 10, letterSpacing: -0.3 },
  features: { marginTop: 36, gap: 16 },
  feature: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  featureIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  featureText: { flex: 1, color: colors.textSecondary, fontSize: 15.5 },
  welcomeNote: { color: colors.subtle, fontSize: 12, textAlign: 'center', marginTop: 14 },
});
