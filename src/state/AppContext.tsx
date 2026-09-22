import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { editImage, generateImage, normalizeError } from '../api/image-api';
import { prepareImagePrompt, sendChat } from '../api/chat-api';
import { validateAttachments } from '../document-inputs';
import type {
  AspectRatio,
  ChatMessage,
  ChatApi,
  Conversation,
  DocumentAttachment,
  ProviderProfile,
  Quality,
  ReferenceImage,
  ResolutionTier,
} from '../domain';
import { createConversationTitle, createId, latestCompletedImage, sizeFor } from '../domain-utils';
import { createReferenceFromGenerated } from '../image-inputs';
import {
  deleteConversationRecord,
  deleteProviderRecord,
  getActiveProviderId,
  initializeDatabase,
  insertConversation,
  insertMessage,
  listConversations,
  listMessages,
  listProviders,
  setActiveProviderId,
  updateConversation,
  updateMessage,
  upsertProvider,
} from '../storage/database';
import { deleteLocalFile, downloadPng, RemoteImageDownloadError } from '../storage/files';
import { deleteProviderKey, getProviderKey } from '../storage/secure-keys';

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const KEEP_AWAKE_TAG = 'salcara-generation';

type ProviderSettings = {
  model?: string;
  quality?: Quality;
  aspectRatio?: AspectRatio;
  resolutionTier?: ResolutionTier;
  chatModel?: string;
  chatApi?: ChatApi;
  analysisProviderId?: string | null;
};

interface AppContextValue {
  ready: boolean;
  providers: ProviderProfile[];
  activeProvider: ProviderProfile | null;
  conversations: Conversation[];
  activeConversation: Conversation | null;
  messages: ChatMessage[];
  generating: boolean;
  elapsedSeconds: number;
  requestStage: string;
  composerMode: 'image' | 'chat';
  setComposerMode: (mode: 'image' | 'chat') => Promise<void>;
  reloadProviders: () => Promise<void>;
  activateProvider: (providerId: string) => Promise<void>;
  updateActiveProviderSettings: (settings: ProviderSettings) => Promise<void>;
  removeProvider: (providerId: string) => Promise<void>;
  startConversation: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  removeConversation: (conversationId: string) => Promise<void>;
  toggleTransparent: () => Promise<void>;
  sendPrompt: (
    prompt: string,
    references: ReferenceImage[],
    maskUri?: string | null,
    continueFromPrevious?: boolean,
    documents?: DocumentAttachment[],
  ) => Promise<void>;
  cancelGeneration: () => void;
  retryMessage: (message: ChatMessage) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [activeProviderIdState, setActiveProviderIdState] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [requestStage, setRequestStage] = useState('');
  // Salcara is a general assistant now. Image creation remains a deliberate
  // mode switch instead of being the default for every new conversation.
  const [composerMode, setComposerModeState] = useState<'image' | 'chat'>('chat');
  const requestLockRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestStartedAtRef = useRef(0);

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === activeProviderIdState) ?? null,
    [providers, activeProviderIdState],
  );
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  const refreshConversations = useCallback(async () => {
    const next = await listConversations();
    setConversations(next);
    return next;
  }, []);

  const reloadProviders = useCallback(async () => {
    const next = await listProviders();
    setProviders(next);
  }, []);

  useEffect(() => {
    void (async () => {
      await initializeDatabase();
      const [loadedProviders, loadedConversations, savedActiveProviderId] = await Promise.all([
        listProviders(),
        listConversations(),
        getActiveProviderId(),
      ]);
      setProviders(loadedProviders);
      setConversations(loadedConversations);
      const providerId = loadedProviders.some((provider) => provider.id === savedActiveProviderId)
        ? savedActiveProviderId
        : loadedProviders[0]?.id ?? null;
      setActiveProviderIdState(providerId);
      const latestConversation = loadedConversations.find((conversation) => conversation.providerId === providerId);
      if (latestConversation) {
        setComposerModeState(latestConversation.mode ?? 'chat');
        setActiveConversationId(latestConversation.id);
        setMessages(await listMessages(latestConversation.id));
      } else if (loadedProviders.find((item) => item.id === providerId)?.chatModel && !loadedProviders.find((item) => item.id === providerId)?.model) {
        setComposerModeState('chat');
      }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - requestStartedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [generating]);

  const activateProvider = useCallback(async (providerId: string) => {
    if (requestLockRef.current) throw new Error('请先等待或取消当前请求，再切换服务商');
    setActiveProviderIdState(providerId);
    await setActiveProviderId(providerId);
    const latest = (await listConversations()).find((conversation) => conversation.providerId === providerId);
    setActiveConversationId(latest?.id ?? null);
    setMessages(latest ? await listMessages(latest.id) : []);
    const profile = (await listProviders()).find((item) => item.id === providerId);
    setComposerModeState(latest?.mode ?? 'chat');
  }, []);

  const setComposerMode = useCallback(async (mode: 'image' | 'chat') => {
    if (requestLockRef.current) throw new Error('请先等待或取消当前请求');
    if (activeConversation) {
      await updateConversation({ ...activeConversation, mode, updatedAt: Date.now() });
      await refreshConversations();
    }
    setComposerModeState(mode);
  }, [activeConversation, refreshConversations]);

  const updateActiveProviderSettings = useCallback(
    async (settings: ProviderSettings) => {
      if (requestLockRef.current) throw new Error('请先等待或取消当前请求');
      if (!activeProvider) throw new Error('请先添加服务商');
      const updated: ProviderProfile = { ...activeProvider, ...settings, updatedAt: Date.now() };
      await upsertProvider(updated);
      setProviders((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    },
    [activeProvider],
  );

  const startConversation = useCallback(async () => {
    if (requestLockRef.current) throw new Error('请先等待或取消当前请求');
    if (!activeProvider) throw new Error('请先添加服务商');
    const now = Date.now();
    const conversation: Conversation = {
      id: createId(),
      title: '新会话',
      providerId: activeProvider.id,
      transparent: false,
      mode: composerMode,
      createdAt: now,
      updatedAt: now,
    };
    await insertConversation(conversation);
    await refreshConversations();
    setActiveConversationId(conversation.id);
    setMessages([]);
  }, [activeProvider, refreshConversations, composerMode]);

  const selectConversation = useCallback(
    async (conversationId: string) => {
      if (requestLockRef.current) throw new Error('请先等待或取消当前请求');
      const conversation = conversations.find((item) => item.id === conversationId);
      if (!conversation) return;
      if (conversation.providerId !== activeProviderIdState) {
        setActiveProviderIdState(conversation.providerId);
        await setActiveProviderId(conversation.providerId);
      }
      setActiveConversationId(conversationId);
      setMessages(await listMessages(conversationId));
      setComposerModeState(conversation.mode ?? 'chat');
    },
    [conversations, activeProviderIdState],
  );

  const removeConversation = useCallback(
    async (conversationId: string) => {
      if (requestLockRef.current) throw new Error('请先等待或取消当前请求');
      const removedMessages = await deleteConversationRecord(conversationId);
      for (const message of removedMessages) {
        deleteLocalFile(message.imageUri);
        deleteLocalFile(message.maskUri);
        message.references.forEach((reference) => deleteLocalFile(reference.uri));
        message.documents?.forEach((document) => deleteLocalFile(document.uri));
      }
      const next = await refreshConversations();
      if (conversationId === activeConversationId) {
        const latest = next.find((conversation) => conversation.providerId === activeProviderIdState);
        setActiveConversationId(latest?.id ?? null);
        setMessages(latest ? await listMessages(latest.id) : []);
        setComposerModeState(latest?.mode ?? 'chat');
      }
    },
    [refreshConversations, activeConversationId, activeProviderIdState, composerMode],
  );

  const removeProvider = useCallback(
    async (providerId: string) => {
      if (requestLockRef.current) throw new Error('请先等待或取消当前请求');
      const owned = conversations.filter((conversation) => conversation.providerId === providerId);
      for (const conversation of owned) await removeConversation(conversation.id);
      await deleteProviderRecord(providerId);
      await deleteProviderKey(providerId);
      const next = await listProviders();
      setProviders(next);
      const nextActive = activeProviderIdState === providerId ? next[0]?.id ?? null : activeProviderIdState;
      setActiveProviderIdState(nextActive);
      await setActiveProviderId(nextActive);
      setActiveConversationId(null);
      setMessages([]);
    },
    [conversations, removeConversation, activeProviderIdState],
  );

  const toggleTransparent = useCallback(async () => {
    if (requestLockRef.current) throw new Error('请先等待或取消当前请求');
    if (!activeConversation) {
      if (!activeProvider) throw new Error('请先添加服务商');
      const now = Date.now();
      const conversation: Conversation = {
        id: createId(),
        title: '新会话',
        providerId: activeProvider.id,
        transparent: true,
        createdAt: now,
        updatedAt: now,
      };
      await insertConversation(conversation);
      await refreshConversations();
      setActiveConversationId(conversation.id);
      setMessages([]);
      return;
    }
    const updated = { ...activeConversation, transparent: !activeConversation.transparent, updatedAt: Date.now() };
    await updateConversation(updated);
    await refreshConversations();
  }, [activeConversation, activeProvider, refreshConversations]);

  const executeRequest = useCallback(
    async (assistantMessage: ChatMessage, prompt: string, references: ReferenceImage[], maskUri?: string | null, history: ChatMessage[] = []) => {
      const provider = providers.find((item) => item.id === assistantMessage.providerId);
      if (!provider) throw new Error('服务商配置已不存在');

      const controller = new AbortController();
      abortControllerRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      requestStartedAtRef.current = Date.now();
      setElapsedSeconds(0);
      setGenerating(true);
      let workingMessage = assistantMessage;
      try {
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
        let imageUri: string | null = null;
        let text: string | null = null;
        if (assistantMessage.remoteImageUrl) {
          setRequestStage('正在下载已生成的图片');
          imageUri = await downloadPng(assistantMessage.remoteImageUrl, controller.signal);
        } else {
          const apiKey = await getProviderKey(provider.id);
          if (!apiKey) throw new Error('没有找到该服务商的 API 密钥');
          if (assistantMessage.mode === 'chat') {
            setRequestStage('正在理解内容并回答');
            text = await sendChat({
              baseUrl: provider.baseUrl, apiKey, model: assistantMessage.model,
              api: assistantMessage.requestApi ?? provider.chatApi,
              history, prompt, references, documents: assistantMessage.documents,
              signal: controller.signal,
            });
          } else {
          if (assistantMessage.documents?.length && !workingMessage.preparedPrompt) {
            const analyst = providers.find((item) => item.id === assistantMessage.analysisProviderId);
            if (!analyst || !assistantMessage.analysisModel) throw new Error('请先配置用于解析文件的对话服务商和模型');
            const analysisKey = await getProviderKey(analyst.id);
            if (!analysisKey) throw new Error('解析服务商的 API 密钥不存在');
            setRequestStage('正在解析附件并整理生图需求');
            const preparedPrompt = await prepareImagePrompt({
              baseUrl: analyst.baseUrl, apiKey: analysisKey, model: assistantMessage.analysisModel,
              api: assistantMessage.analysisApi ?? analyst.chatApi,
              history, prompt, references, documents: assistantMessage.documents,
              signal: controller.signal,
            });
            workingMessage = { ...workingMessage, preparedPrompt };
            // Persist the analysis before the paid image call so a manual retry
            // can reuse it without charging for the same document analysis again.
            await updateMessage(workingMessage);
            setMessages((current) => current.map((message) => message.id === workingMessage.id ? workingMessage : message));
          }
          setRequestStage(references.length ? '正在编辑图片' : '正在生成图片');
          const common = {
            baseUrl: provider.baseUrl,
            apiKey,
            model: assistantMessage.model,
            prompt: workingMessage.preparedPrompt || prompt,
            quality: assistantMessage.quality,
            size: assistantMessage.size,
            transparent: assistantMessage.transparent,
            signal: controller.signal,
          };
          imageUri = references.length
            ? await editImage({ ...common, references, maskUri })
            : await generateImage(common);
          }
        }
        const completed: ChatMessage = {
          ...workingMessage,
          status: 'complete',
          imageUri,
          text,
          remoteImageUrl: null,
          elapsedMs: Date.now() - requestStartedAtRef.current,
          error: null,
        };
        await updateMessage(completed);
        setMessages((current) => current.map((message) => (message.id === completed.id ? completed : message)));
      } catch (error) {
        const normalized = normalizeError(error);
        const cancelled = controller.signal.aborted;
        const failed: ChatMessage = {
          ...workingMessage,
          status: cancelled ? 'cancelled' : 'error',
          error: error instanceof RemoteImageDownloadError ? normalized.message : cancelled ? '请求已取消或超过 10 分钟' : normalized.message,
          remoteImageUrl:
            error instanceof RemoteImageDownloadError ? error.remoteImageUrl : assistantMessage.remoteImageUrl,
          elapsedMs: Date.now() - requestStartedAtRef.current,
        };
        await updateMessage(failed);
        setMessages((current) => current.map((message) => (message.id === failed.id ? failed : message)));
      } finally {
        clearTimeout(timeout);
        abortControllerRef.current = null;
        setGenerating(false);
        requestLockRef.current = false;
        setRequestStage('');
        try { await deactivateKeepAwake(KEEP_AWAKE_TAG); } catch { /* The activity may already have closed. */ }
      }
    },
    [providers],
  );

  const sendPrompt = useCallback(
    async (
      prompt: string,
      references: ReferenceImage[],
      maskUri?: string | null,
      continueFromPrevious = true,
      documents: DocumentAttachment[] = [],
    ) => {
      const provider = activeProvider;
      if (!provider) throw new Error('请先添加服务商');
      const isChat = composerMode === 'chat';
      const chatProvider = providers.find((item) => item.id === (provider.analysisProviderId || provider.id));
      if (!isChat && (!provider.model || !provider.quality || !provider.aspectRatio || !provider.resolutionTier)) {
        throw new Error('请先选择模型、画质、比例和清晰度');
      }
      if (isChat && !chatProvider?.chatModel) throw new Error('请在对话设置中选择已配置对话模型的服务商');
      if (!prompt.trim() && !references.length && !documents.length) throw new Error('请输入内容，或添加需要解析的图片 / 文件');
      if (requestLockRef.current) throw new Error('当前请求尚未完成');
      validateAttachments(documents, references);
      const analyst = documents.length && !isChat
        ? providers.find((item) => item.id === (provider.analysisProviderId || provider.id))
        : undefined;
      if (documents.length && !isChat && !analyst?.chatModel) throw new Error('文件辅助生图需要对话模型。请在生成设置中选择解析服务商。');
      requestLockRef.current = true;
      setGenerating(true);
      try {

      let requestReferences = references;
      if (!isChat && continueFromPrevious && requestReferences.length === 0 && activeConversation) {
        const previousResult = latestCompletedImage(messages);
        if (previousResult?.imageUri) {
          requestReferences = [await createReferenceFromGenerated(previousResult.imageUri)];
        }
      }
      validateAttachments(documents, requestReferences);

      let conversation = activeConversation;
      const now = Date.now();
      if (!conversation || conversation.providerId !== provider.id) {
        conversation = {
          id: createId(),
          title: createConversationTitle(prompt),
          providerId: provider.id,
          transparent: false,
          mode: composerMode,
          createdAt: now,
          updatedAt: now,
        };
        await insertConversation(conversation);
        setActiveConversationId(conversation.id);
      } else {
        conversation = {
          ...conversation,
          title: messages.length === 0 ? createConversationTitle(prompt) : conversation.title,
          updatedAt: now,
          mode: composerMode,
        };
        await updateConversation(conversation);
      }
      await refreshConversations();

      const size = !isChat && provider.aspectRatio && provider.resolutionTier ? sizeFor(provider.aspectRatio, provider.resolutionTier) : '';
      const baseMessage = {
        conversationId: conversation.id,
        prompt: prompt.trim() || '请分析所附资料。',
        mode: isChat ? ('chat' as const) : requestReferences.length ? ('edit' as const) : ('generate' as const),
        providerId: isChat ? chatProvider!.id : provider.id,
        model: (isChat ? chatProvider!.chatModel : provider.model)!,
        quality: provider.quality ?? 'auto',
        size,
        transparent: conversation.transparent,
        references: requestReferences,
        documents,
        requestApi: (isChat ? chatProvider!.chatApi : provider.chatApi) ?? 'chat-completions',
        analysisProviderId: analyst?.id ?? null,
        analysisModel: analyst?.chatModel ?? null,
        analysisApi: analyst?.chatApi ?? 'chat-completions',
        maskUri: isChat ? null : maskUri ?? null,
        error: null,
        elapsedMs: null,
        createdAt: now,
      };
      const userMessage: ChatMessage = {
        ...baseMessage,
        id: createId(),
        role: 'user',
        status: 'complete',
        imageUri: null,
        remoteImageUrl: null,
      };
      const assistantMessage: ChatMessage = {
        ...baseMessage,
        id: createId(),
        role: 'assistant',
        status: 'pending',
        imageUri: null,
        remoteImageUrl: null,
        createdAt: now + 1,
      };
      await insertMessage(userMessage);
      await insertMessage(assistantMessage);
      setMessages((current) => [...current, userMessage, assistantMessage]);
      await executeRequest(assistantMessage, prompt.trim() || '请分析所附资料。', requestReferences, isChat ? null : maskUri, messages);
      } finally {
        requestLockRef.current = false;
        setGenerating(false);
      }
    },
    [activeProvider, activeConversation, composerMode, providers, messages, refreshConversations, executeRequest],
  );

  const retryMessage = useCallback(
    async (message: ChatMessage) => {
      if (requestLockRef.current) throw new Error('当前请求尚未完成');
      requestLockRef.current = true;
      setGenerating(true);
      try {
      const pending: ChatMessage = { ...message, status: 'pending', error: null, imageUri: null, elapsedMs: null };
      await updateMessage(pending);
      setMessages((current) => current.map((item) => (item.id === pending.id ? pending : item)));
      const history = messages.filter((item) => item.createdAt < message.createdAt - 1);
      await executeRequest(pending, pending.prompt, pending.references, pending.maskUri, history);
      } finally {
        requestLockRef.current = false;
        setGenerating(false);
      }
    },
    [messages, executeRequest],
  );

  const cancelGeneration = useCallback(() => abortControllerRef.current?.abort(), []);

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      providers,
      activeProvider,
      conversations,
      activeConversation,
      messages,
      generating,
      elapsedSeconds,
      requestStage,
      composerMode,
      setComposerMode,
      reloadProviders,
      activateProvider,
      updateActiveProviderSettings,
      removeProvider,
      startConversation,
      selectConversation,
      removeConversation,
      toggleTransparent,
      sendPrompt,
      cancelGeneration,
      retryMessage,
    }),
    [
      ready,
      providers,
      activeProvider,
      conversations,
      activeConversation,
      messages,
      generating,
      elapsedSeconds,
      requestStage,
      composerMode,
      setComposerMode,
      reloadProviders,
      activateProvider,
      updateActiveProviderSettings,
      removeProvider,
      startConversation,
      selectConversation,
      removeConversation,
      toggleTransparent,
      sendPrompt,
      cancelGeneration,
      retryMessage,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
