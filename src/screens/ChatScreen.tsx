import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAgents } from '../agent/agents';
import type { CustomAgent, GeneratedFile, PhoneAction } from '../agent/types';
import { MemoryBoxSettingsSheet } from '../companion/MemoryBoxSettingsSheet';
import { SpaceSwitch } from '../companion/SpaceSwitch';
import { AboutSheet } from '../components/AboutSheet';
import { AgentAvatar } from '../components/AgentsSheet';
import { FilePreviewSheet } from '../components/FilePreviewSheet';
import { PersonalizationSheet } from '../components/PersonalizationSheet';
import { ToolsSheet } from '../components/ToolsSheet';
import { AppSettingsSheet } from '../components/AppSettingsSheet';
import { BrandMark, GradientText, LivingMark } from '../components/Brand';
import { useLaunchRevealed } from '../components/LaunchIntro';
import { LiveMode } from '../components/LiveMode';
import { VoiceSettingsSheet } from '../components/VoiceSettingsSheet';
import { useDictation } from '../voice/useDictation';
import { Icon } from '../components/Icon';
import { Composer } from '../components/Composer';
import { ConversationDrawer } from '../components/ConversationDrawer';
import { ImagePreview } from '../components/ImagePreview';
import { MaskEditor } from '../components/MaskEditor';
import { MessageBubble } from '../components/MessageBubble';
import { ModelSwitcher } from '../components/ModelSwitcher';
import { Onboarding } from '../components/Onboarding';
import { NetworkDiagnostics } from '../components/NetworkDiagnostics';
import { ProviderManager } from '../components/ProviderManager';
import { Appear, AppDialog, IconButton, MotionPressable, PrimaryButton, Sheet, showToast, ToastHost, dismissKeyboardAndBlur, type DialogAction, type IconName } from '../components/ui';
import { UpdateManager } from '../components/UpdateManager';
import { isImageAttachment, pickAnyFiles, validateAttachments } from '../document-inputs';
import type { ChatMessage, DocumentAttachment, ReferenceImage } from '../domain';
import { pickFromFiles, pickFromGallery, prepareReferenceForMask, prepareReferenceFromAttachment, takePhoto } from '../image-inputs';
import { useApp, useElapsedSeconds } from '../state/AppContext';
import { getSetting, setSetting } from '../storage/database';
import { useVoiceSettings } from '../voice/settings';
import { deleteLocalFile, saveToGallery, shareImage } from '../storage/files';
import { colors, prettyModel, radius, shadow } from '../theme';

type Dialog = { title: string; message: string; actions?: DialogAction[]; icon?: IconName };

/** Quick tools under the inspiration grid. */
const SUGGESTIONS: { icon: IconName; title: string; hint: string; prompt?: string; action?: 'files' | 'gallery' | 'camera' | 'research'; draw?: boolean }[] = [
  { icon: 'telescope', title: '深度研究', hint: '多轮搜索，写成带来源的报告', action: 'research' },
  { icon: 'wand', title: '改一张照片', hint: '换背景、换风格、局部重绘', action: 'gallery', draw: true },
  { icon: 'file', title: '读懂文件', hint: '总结要点、提炼数据', action: 'files' },
  { icon: 'scan', title: '拍照提问', hint: '拍一张照片来问我', action: 'camera' },
  { icon: 'lightbulb', title: '一起想点子', hint: '周末去哪儿玩更有意思', prompt: '帮我策划一个轻松有趣的周末：' },
];

const ONBOARDING_KEY = 'onboarding_done';

export function ChatScreen() {
  const app = useApp();
  const revealed = useLaunchRevealed();
  // First install only: decided once when the app is ready (upgrades with services already set up skip it).
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  useEffect(() => {
    if (!app.ready || onboarding !== null) return;
    let alive = true;
    void getSetting(ONBOARDING_KEY).catch(() => '1').then((done) => { if (alive) setOnboarding(!done && app.providers.length === 0); });
    return () => { alive = false; };
  }, [app.ready, app.providers.length, onboarding]);
  const finishOnboarding = useCallback(() => { setOnboarding(false); void setSetting(ONBOARDING_KEY, '1').catch(() => undefined); }, []);
  const voiceSettings = useVoiceSettings();
  const voiceReady = Boolean((voiceSettings.inputEngine === 'local' && voiceSettings.localModel) || voiceSettings.transcribeProviderId || voiceSettings.ttsProviderId || voiceSettings.realtimeProviderId);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const followRef = useRef(true);
  const draggingRef = useRef(false);
  /** After switching conversations, jump to the end instantly instead of animating through history. */
  const instantScrollRef = useRef(true);
  const lastFollowRef = useRef(0);
  const elapsedSeconds = useElapsedSeconds();
  const [prompt, setPrompt] = useState('');
  const [images, setImages] = useState<ReferenceImage[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [maskUri, setMaskUri] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [settings, setSettings] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [liveOpen, setLiveOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsTab, setModelsTab] = useState<'chat' | 'image'>('chat');
  const [about, setAbout] = useState(false);
  const [network, setNetwork] = useState(false);
  const [maskOpen, setMaskOpen] = useState(false);
  const [preparingMask, setPreparingMask] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [updateToken, setUpdateToken] = useState(0);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [research, setResearch] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [personalOpen, setPersonalOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<GeneratedFile | null>(null);
  const [memoryBoxOpen, setMemoryBoxOpen] = useState(false);
  const agents = useAgents();
  const activeAgent = agents.find((agent) => agent.id === app.activeAgentId) ?? null;

  const report = useCallback((title: string, error: unknown, icon: IconName = 'alert') =>
    setDialog({ title, message: error instanceof Error ? error.message : '请稍后再试', icon }), []);
  // Stable callbacks keep memoized message rows from re-rendering on every tick.
  const { retry: retryMessage, stop } = app;
  const onRetry = useCallback((message: ChatMessage) => void retryMessage(message).catch((error) => report('无法重试', error)), [retryMessage, report]);
  const dictation = useDictation({
    providers: app.providers, chatProvider: app.chatProvider, onText: setPrompt,
    onError: (error) => report('语音输入没有完成', error, 'mic'),
  });
  const { state: dictationState, cancel: cancelDictation } = dictation;
  useEffect(() => {
    if (dictationState === 'idle') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { cancelDictation(); return true; });
    return () => sub.remove();
  }, [dictationState, cancelDictation]);
  const sendMessage = app.send;
  const followUp = useCallback((text: string) => {
    followRef.current = true;
    setShowJump(false);
    void sendMessage({ text }).catch((error) => report('没有发送出去', error));
  }, [sendMessage, report]);
  const userMessageAction = useCallback((message: ChatMessage) => setDialog({
    title: '这条消息', message: message.prompt.length > 80 ? `${message.prompt.slice(0, 80)}…` : message.prompt, icon: 'chat',
    actions: [
      { label: '复制', tone: 'secondary', onPress: () => { setDialog(null); void Clipboard.setStringAsync(message.prompt).then(() => showToast('已复制')); } },
      { label: '编辑后重新发送', tone: 'primary', onPress: () => { setDialog(null); setPrompt(message.prompt); setTimeout(() => inputRef.current?.focus(), 80); } },
    ],
  }), []);
  const { runAction: runPhoneAction, dismissAction: dismissPhoneAction, newChat: startChat } = app;
  const onRunAction = useCallback((message: ChatMessage, action: PhoneAction) => void runPhoneAction(message, action.id).catch((error) => report('操作没有完成', error, 'bolt')), [runPhoneAction, report]);
  const onDismissAction = useCallback((message: ChatMessage, action: PhoneAction) => void dismissPhoneAction(message, action.id), [dismissPhoneAction]);
  const startAgent = useCallback((agent: CustomAgent) => {
    try { dismissKeyboardAndBlur(); startChat(agent.id); } catch (error) { report('稍等一下', error, 'hourglass'); }
  }, [startChat, report]);
  const openLive = () => {
    dismissKeyboardAndBlur();
    if (app.busy) { showToast('等这条回复完成后再开始 Live', 'hourglass'); return; }
    if (!app.chatProvider) {
      setDialog({ title: 'Live 需要对话模型', message: 'Live 语音对话会用你的对话模型来理解和回答。请先在“API 管理”里添加一个能对话的 API。', icon: 'waveform', actions: [
        { label: '稍后', tone: 'secondary', onPress: () => setDialog(null) },
        { label: '添加 API', tone: 'primary', onPress: () => { setDialog(null); setProvidersOpen(true); } },
      ] });
      return;
    }
    setLiveOpen(true);
  };
  const saveImage = useCallback((uri: string) => void saveToGallery(uri).then(() => showToast('已保存到相册')).catch((error) => report('保存失败', error)), [report]);
  const share = useCallback((uri: string) => void shareImage(uri).catch((error) => report('分享失败', error)), [report]);


  // Each conversation keeps its own unsent draft (text + attachments), like a mail app.
  const draftRef = useRef({ prompt, images, documents, maskUri, research });
  draftRef.current = { prompt, images, documents, maskUri, research };
  const drafts = useRef(new Map<string, typeof draftRef.current>());
  const draftKey = useRef(app.activeConversationId ?? 'new');
  useEffect(() => {
    followRef.current = true;
    setShowJump(false);
    const next = app.activeConversationId ?? 'new';
    if (next === draftKey.current) return;
    instantScrollRef.current = true;
    const current = draftRef.current;
    if (current.prompt.trim() || current.images.length || current.documents.length || current.maskUri || current.research) drafts.current.set(draftKey.current, current);
    else drafts.current.delete(draftKey.current);
    const restored = drafts.current.get(next);
    drafts.current.delete(next);
    draftKey.current = next;
    setPrompt(restored?.prompt ?? '');
    setImages(restored?.images ?? []);
    setDocuments(restored?.documents ?? []);
    setMaskUri(restored?.maskUri ?? null);
    setResearch(restored?.research ?? false);
  }, [app.activeConversationId]);

  // Where the answering model changes mid-conversation, a small divider says who answers from here on.
  const modelSwitches = useMemo(() => {
    const switches = new Map<string, string>();
    let previous: string | null = null;
    for (const message of app.messages) {
      if (message.role !== 'assistant' || !message.analysisModel) continue;
      if (previous && previous !== message.analysisModel) switches.set(message.id, prettyModel(message.analysisModel));
      previous = message.analysisModel;
    }
    return switches;
  }, [app.messages]);
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
    const sent = { text, images, documents, maskUri, research: research && Boolean(app.chatProvider) };
    followRef.current = true;
    setShowJump(false);
    setPrompt(''); setImages([]); setDocuments([]); setMaskUri(null); setResearch(false);
    draftRef.current = { prompt: '', images: [], documents: [], maskUri: null, research: false };
    void app.send(sent).catch((error) => {
      setPrompt(text); setImages(sent.images); setDocuments(sent.documents); setMaskUri(sent.maskUri); setResearch(sent.research);
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


  const toggleResearch = () => {
    setAttachOpen(false);
    if (!app.chatProvider) { report('深度研究需要对话模型', new Error('请先在“API 管理”里添加一个能对话的 API。'), 'telescope'); return; }
    setResearch((value) => !value);
    setTimeout(() => inputRef.current?.focus(), 120);
  };
  const applySuggestion = (item: typeof SUGGESTIONS[number]) => {
    if (item.action === 'research') { if (!research) toggleResearch(); else setTimeout(() => inputRef.current?.focus(), 60); return; }
    if (item.action === 'gallery' && item.draw) setPrompt('把这张照片换成');
    if (item.action === 'files') { void addFiles(); return; }
    if (item.action === 'gallery') { void addImages('gallery'); return; }
    if (item.action === 'camera') { void addImages('camera'); return; }
    setPrompt(item.prompt ?? '');
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const lastId = app.messages[app.messages.length - 1]?.id;
  const engine = prettyModel(app.chatProvider?.chatModel ?? app.imageProvider?.model);
  const secondary = app.chatProvider && app.imageProvider && app.imageProvider.id !== app.chatProvider.id ? app.imageProvider : undefined;
  const isDraft = !app.activeConversationId && app.messages.length === 0 && !app.activeAgentId;
  const connected = app.providers.length > 0;
  const covered = drawer || settings || liveOpen || providersOpen || voiceOpen || modelsOpen || agentsOpen || personalOpen || toolsOpen || memoryBoxOpen || about || network;
  const headerTitle = app.activeConversation?.title || activeAgent?.name || 'Salcara';
  const headerModel = activeAgent && headerTitle !== activeAgent.name ? [activeAgent.name, engine].filter(Boolean).join(' · ') : engine;

  if (onboarding) {
    return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Onboarding key={revealed ? 'shown' : 'intro'} chatProvider={app.chatProvider} imageProvider={app.imageProvider} voiceReady={voiceReady}
        onConnect={() => setProvidersOpen(true)} onVoice={() => setVoiceOpen(true)} onFinish={finishOnboarding} />
      <ProviderManager visible={providersOpen} onClose={() => setProvidersOpen(false)} />
      <VoiceSettingsSheet visible={voiceOpen} onClose={() => setVoiceOpen(false)} />
      <ToastHost />
    </SafeAreaView>;
  }

  if (onboarding === null && !connected) return <View style={styles.screen} />;

  if (!connected) {
    return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <Welcome key={revealed ? 'shown' : 'intro'} onStart={() => setProvidersOpen(true)} />
      <ProviderManager visible={providersOpen} onClose={() => setProvidersOpen(false)} />
      <ToastHost />
    </SafeAreaView>;
  }

  return <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
    <View style={styles.header}>
      <IconButton icon="menu" label="打开侧边栏" onPress={() => setDrawer(true)} />
      <SpaceSwitch space="assistant" onSwitch={app.switchSpace} />
      <MotionPressable scaleTo={0.96} accessibilityRole="button" accessibilityLabel={`${headerTitle}${engine ? `，${engine}` : ''}，切换模型`} onPress={() => setModelsOpen(true)} wrapperStyle={styles.titleWrap} style={styles.titleButton}>
        {activeAgent ? <AgentAvatar agent={activeAgent} size={24} /> : null}
        <View style={styles.titleText}>
          <Text style={styles.title} numberOfLines={1}>{headerTitle}</Text>
          {headerModel ? <Text style={styles.engine} numberOfLines={1}>{headerModel}</Text> : null}
        </View>
        <Icon name="chevronDown" size={14} color={colors.subtle} strokeWidth={2} />
      </MotionPressable>
      <IconButton icon="compose" label="新对话" disabled={isDraft} onPress={newChat} />
    </View>

    <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {app.messages.length === 0
        ? activeAgent
          ? <AgentHome key={activeAgent.id} agent={activeAgent} onStarter={(text) => { setPrompt(text); setTimeout(() => inputRef.current?.focus(), 60); }} />
          : <Home key={`${app.activeConversationId ?? 'draft'}${revealed ? '' : ':intro'}`} canDraw={Boolean(app.imageProvider)} onSuggestion={applySuggestion} covered={covered} />
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
              // While the user holds the list, never pull it back down.
              if (!draggingRef.current) followRef.current = near;
              if (near === showJump) setShowJump(!near);
            }}
            onScrollBeginDrag={() => { draggingRef.current = true; followRef.current = false; }}
            onScrollEndDrag={(event) => {
              draggingRef.current = false;
              const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
              followRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 40;
            }}
            scrollEventThrottle={64}
            onContentSizeChange={() => {
              if (!followRef.current) return;
              if (instantScrollRef.current) {
                instantScrollRef.current = false;
                listRef.current?.scrollToEnd({ animated: false });
                return;
              }
              const now = Date.now();
              if (now - lastFollowRef.current < 120) return;
              lastFollowRef.current = now;
              listRef.current?.scrollToEnd({ animated: true });
            }}
            renderItem={({ item }) => <>{modelSwitches.has(item.id) && <View style={styles.switchRow} accessibilityRole="text">
              <View style={styles.switchLine} />
              <Text style={styles.switchText} numberOfLines={1}>以下由 {modelSwitches.get(item.id)} 回答 · 前文已同步</Text>
              <View style={styles.switchLine} />
            </View>}<MessageBubble
              message={item}
              phase={item.id === lastId ? app.phase : 'idle'}
              elapsedSeconds={item.id === lastId && item.preparedPrompt ? elapsedSeconds : 0}
              isLast={item.id === lastId}
              onStop={stop}
              onRetry={onRetry}
              onPreview={setPreviewUri}
              onSave={saveImage}
              onShare={share}
              onFollowUp={followUp}
              onUserMessageAction={userMessageAction}
              onRunAction={onRunAction}
              onDismissAction={onDismissAction}
              onOpenFile={setPreviewFile}
            /></>}
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
        placeholder={dictation.state !== 'idle' ? '正在听…' : research ? '想研究什么问题？' : images.length ? '想怎么处理这张图？' : documents.length ? '想从文件里了解什么？' : activeAgent ? `给 ${activeAgent.name} 发消息` : undefined}
        research={research}
        onClearResearch={() => setResearch(false)}
        dictation={{
          state: dictation.state, level: dictation.level, startedAt: dictation.startedAt,
          onStart: () => { void dictation.start(prompt); }, onStop: () => { void dictation.stop(); }, onCancel: dictation.cancel,
        }}
        onOpenLive={openLive}
      />
    </KeyboardAvoidingView>

    <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)}>
      <View style={styles.attachRow}>
        <AttachTile icon="camera" label="相机" onPress={() => void addImages('camera')} />
        <AttachTile icon="image" label="照片" onPress={() => void addImages('gallery')} />
        <AttachTile icon="paperclip" label="文件" onPress={() => void addImages('files')} />
      </View>
      <Text style={styles.attachHint}>最多 4 张图片和 4 个文件 · 支持 PDF、Word、Excel、PPT 与代码</Text>
      <View style={styles.toolRows}>
        <ToolRow icon="telescope" title="深度研究" detail="先列计划，多轮搜索阅读，写成带来源的报告" active={research} onPress={toggleResearch} />
      </View>
    </Sheet>
    <ConversationDrawer visible={drawer} onClose={() => setDrawer(false)} onNewChat={newChat} onOpenSettings={() => setSettings(true)}
      onOpenAgents={() => setAgentsOpen(true)} onStartAgent={startAgent} />
    <AppSettingsSheet visible={settings} onClose={() => setSettings(false)}
      onOpenProviders={() => setProvidersOpen(true)} onOpenModels={(tab) => { setModelsTab(tab ?? 'chat'); setModelsOpen(true); }}
      onOpenNetwork={() => setNetwork(true)} onOpenAbout={() => setAbout(true)} onCheckUpdates={() => setUpdateToken((value) => value + 1)}
      onOpenVoice={() => setVoiceOpen(true)} onOpenPersonalization={() => setPersonalOpen(true)} onOpenTools={() => setToolsOpen(true)} onOpenAgents={() => setAgentsOpen(true)}
      onOpenMemoryBox={() => setMemoryBoxOpen(true)} />
    <MemoryBoxSettingsSheet visible={memoryBoxOpen} onClose={() => setMemoryBoxOpen(false)} />
    <PersonalizationSheet visible={personalOpen} onClose={() => setPersonalOpen(false)} />
    <ToolsSheet visible={toolsOpen} onClose={() => setToolsOpen(false)} />
    <FilePreviewSheet file={previewFile} onClose={() => setPreviewFile(null)} />
    <LiveMode visible={liveOpen} paused={voiceOpen} onClose={() => setLiveOpen(false)} onOpenSettings={() => setVoiceOpen(true)} />
    <VoiceSettingsSheet visible={voiceOpen} onClose={() => setVoiceOpen(false)} />
    <ProviderManager visible={providersOpen} onClose={() => setProvidersOpen(false)} />
    <ModelSwitcher visible={modelsOpen} initialTab={modelsTab} onClose={() => { setModelsOpen(false); setModelsTab('chat'); }} onManageProviders={() => setProvidersOpen(true)} />
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

function Home({ canDraw, onSuggestion, covered = false }: {
  canDraw: boolean; covered?: boolean;
  onSuggestion: (item: typeof SUGGESTIONS[number]) => void;
}) {
  const { width } = useWindowDimensions();
  const items = SUGGESTIONS.filter((item) => canDraw || !item.draw);
  return <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={styles.home} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
      <Appear distance={8}><LivingMark size={34} active={!covered} /></Appear>
      <Appear delay={90} distance={12}><GradientText text={greeting()} fontSize={34} width={Math.min(width - 56, 360)} /></Appear>
      <Appear delay={170} distance={12}><Text style={styles.homeSubtitle}>{canDraw ? '想聊点什么，\n或者让我画点什么？' : '今天想聊点什么？'}</Text></Appear>
    </ScrollView>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.suggestions} keyboardShouldPersistTaps="handled">
      {items.map((item, index) => <Appear key={item.title} delay={260 + index * 60} distance={10}>
        <MotionPressable scaleTo={0.96} accessibilityRole="button" accessibilityLabel={item.title} onPress={() => onSuggestion(item)} style={styles.suggestion}>
          <Icon name={item.icon} size={17} color={colors.primary} />
          <Text style={styles.suggestionTitle}>{item.title}</Text>
        </MotionPressable>
      </Appear>)}
    </ScrollView>
  </View>;
}

/** Home of a custom agent: who it is and a few ways to start. */
function AgentHome({ agent, onStarter }: { agent: CustomAgent; onStarter: (text: string) => void }) {
  return <ScrollView contentContainerStyle={styles.agentHome} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}>
    <Appear distance={10}><AgentAvatar agent={agent} size={76} /></Appear>
    <Appear delay={80} distance={10}><Text style={styles.agentHomeName}>{agent.name}</Text></Appear>
    {agent.description ? <Appear delay={140} distance={10}><Text style={styles.agentHomeDetail}>{agent.description}</Text></Appear> : null}
    <View style={styles.starters}>
      {agent.starters.map((starter, index) => <Appear key={`${index}-${starter}`} delay={200 + index * 60} distance={8}>
        <MotionPressable scaleTo={0.97} accessibilityRole="button" accessibilityLabel={starter} onPress={() => onStarter(starter)} style={styles.starter}>
          <Text style={styles.starterText}>{starter}</Text>
        </MotionPressable>
      </Appear>)}
    </View>
  </ScrollView>;
}

function ToolRow({ icon, title, detail, active = false, onPress }: { icon: IconName; title: string; detail: string; active?: boolean; onPress: () => void }) {
  return <MotionPressable scaleTo={0.98} accessibilityRole="button" accessibilityState={{ selected: active }} accessibilityLabel={title} onPress={onPress} style={[styles.toolRow, active && styles.toolRowActive]}>
    <View style={[styles.toolIcon, active && { backgroundColor: colors.primary }]}><Icon name={icon} size={19} color={active ? '#FFFFFF' : colors.textSecondary} /></View>
    <View style={{ flex: 1 }}>
      <Text style={styles.toolTitle}>{title}</Text>
      <Text style={styles.toolDetail} numberOfLines={1}>{detail}</Text>
    </View>
    {active ? <Icon name="check" size={18} color={colors.primary} strokeWidth={2.2} /> : <Icon name="chevronRight" size={17} color={colors.faint} />}
  </MotionPressable>;
}

function Welcome({ onStart }: { onStart: () => void }) {
  return <ScrollView contentContainerStyle={styles.welcome} showsVerticalScrollIndicator={false}>
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
  </ScrollView>;
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
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 6, paddingHorizontal: 12 },
  switchLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  switchText: { color: colors.subtle, fontSize: 11.5, letterSpacing: 0.2, maxWidth: '70%' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 4 },
  titleWrap: { flex: 1, flexShrink: 1 },
  titleButton: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', maxWidth: '100%', minHeight: 44, paddingHorizontal: 8, borderRadius: 20 },
  titleText: { flexShrink: 1 },
  title: { color: colors.text, fontSize: 15.5, lineHeight: 20, fontWeight: '600', letterSpacing: -0.3 },
  engine: { color: colors.subtle, fontSize: 12, lineHeight: 16 },
  body: { flex: 1 },
  messages: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28, gap: 26, width: '100%', maxWidth: 780, alignSelf: 'center' },
  jumpWrap: { position: 'absolute', bottom: 12, alignSelf: 'center' },
  jump: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, ...shadow.soft },
  home: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20, gap: 10 },
  homeSubtitle: { color: '#8A90A9', fontSize: 26, lineHeight: 35, fontWeight: '500', letterSpacing: -0.5 },
  suggestions: { paddingHorizontal: 12, gap: 8, paddingBottom: 4 },
  agentStrip: { marginHorizontal: -20, flexGrow: 0, marginTop: 6 },
  agentChips: { paddingHorizontal: 20, gap: 8 },
  agentChip: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 38, paddingLeft: 7, paddingRight: 14, borderRadius: 19, backgroundColor: colors.surface, maxWidth: 200 },
  agentChipText: { color: colors.textSecondary, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  agentHome: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 28, paddingVertical: 24, gap: 8 },
  agentHomeName: { color: colors.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.5, marginTop: 10 },
  agentHomeDetail: { color: colors.textMuted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  starters: { alignSelf: 'stretch', gap: 8, marginTop: 18 },
  starter: { paddingVertical: 13, paddingHorizontal: 16, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  starterText: { color: colors.textSecondary, fontSize: 14.5, lineHeight: 20 },
  toolRows: { paddingHorizontal: 18, gap: 8, marginTop: 6, marginBottom: 4 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 18, backgroundColor: colors.surface },
  toolRowActive: { backgroundColor: colors.primarySoft },
  toolIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  toolTitle: { color: colors.text, fontSize: 15, fontWeight: '500' },
  toolDetail: { color: colors.subtle, fontSize: 12.5, marginTop: 2 },
  suggestion: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 40, paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.surface },
  suggestionTitle: { color: colors.textSecondary, fontSize: 13.5, fontWeight: '500' },
  attachRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingTop: 8 },
  attachTile: { height: 96, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', gap: 10 },
  attachLabel: { color: colors.text, fontSize: 14, fontWeight: '500' },
  attachHint: { color: colors.subtle, fontSize: 12, textAlign: 'center', marginTop: 16, marginBottom: 6, paddingHorizontal: 24 },
  welcome: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 12 },
  welcomeCenter: { flexGrow: 1, justifyContent: 'center', paddingVertical: 24 },
  welcomeHalo: { width: 104, height: 104, marginBottom: 26 },
  welcomeTitle: { color: colors.text, fontSize: 40, fontWeight: '700', letterSpacing: -1.2 },
  welcomeTagline: { color: colors.textMuted, fontSize: 20, lineHeight: 30, marginTop: 10, letterSpacing: -0.3 },
  features: { marginTop: 36, gap: 16 },
  feature: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  featureIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  featureText: { flex: 1, color: colors.textSecondary, fontSize: 15.5 },
  welcomeNote: { color: colors.subtle, fontSize: 12, textAlign: 'center', marginTop: 14 },
});
