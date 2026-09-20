import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { editImage, generateImage, normalizeError } from '../api/image-api';
import type {
  AspectRatio,
  ChatMessage,
  Conversation,
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
  model: string;
  quality: Quality;
  aspectRatio: AspectRatio;
  resolutionTier: ResolutionTier;
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
        setActiveConversationId(latestConversation.id);
        setMessages(await listMessages(latestConversation.id));
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
    setActiveProviderIdState(providerId);
    await setActiveProviderId(providerId);
    const latest = (await listConversations()).find((conversation) => conversation.providerId === providerId);
    setActiveConversationId(latest?.id ?? null);
    setMessages(latest ? await listMessages(latest.id) : []);
  }, []);

  const updateActiveProviderSettings = useCallback(
    async (settings: ProviderSettings) => {
      if (!activeProvider) throw new Error('请先添加服务商');
      const updated: ProviderProfile = { ...activeProvider, ...settings, updatedAt: Date.now() };
      await upsertProvider(updated);
      setProviders((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    },
    [activeProvider],
  );

  const startConversation = useCallback(async () => {
    if (!activeProvider) throw new Error('请先添加服务商');
    const now = Date.now();
    const conversation: Conversation = {
      id: createId(),
      title: '新会话',
      providerId: activeProvider.id,
      transparent: false,
      createdAt: now,
      updatedAt: now,
    };
    await insertConversation(conversation);
    await refreshConversations();
    setActiveConversationId(conversation.id);
    setMessages([]);
  }, [activeProvider, refreshConversations]);

  const selectConversation = useCallback(
    async (conversationId: string) => {
      const conversation = conversations.find((item) => item.id === conversationId);
      if (!conversation) return;
      if (conversation.providerId !== activeProviderIdState) {
        setActiveProviderIdState(conversation.providerId);
        await setActiveProviderId(conversation.providerId);
      }
      setActiveConversationId(conversationId);
      setMessages(await listMessages(conversationId));
    },
    [conversations, activeProviderIdState],
  );

  const removeConversation = useCallback(
    async (conversationId: string) => {
      const removedMessages = await deleteConversationRecord(conversationId);
      for (const message of removedMessages) {
        deleteLocalFile(message.imageUri);
        deleteLocalFile(message.maskUri);
        message.references.forEach((reference) => deleteLocalFile(reference.uri));
      }
      const next = await refreshConversations();
      if (conversationId === activeConversationId) {
        const latest = next.find((conversation) => conversation.providerId === activeProviderIdState);
        setActiveConversationId(latest?.id ?? null);
        setMessages(latest ? await listMessages(latest.id) : []);
      }
    },
    [refreshConversations, activeConversationId, activeProviderIdState],
  );

  const removeProvider = useCallback(
    async (providerId: string) => {
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
    async (assistantMessage: ChatMessage, prompt: string, references: ReferenceImage[], maskUri?: string | null) => {
      const provider = providers.find((item) => item.id === assistantMessage.providerId);
      if (!provider) throw new Error('服务商配置已不存在');

      const controller = new AbortController();
      abortControllerRef.current = controller;
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      requestStartedAtRef.current = Date.now();
      setElapsedSeconds(0);
      setGenerating(true);
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      try {
        let imageUri: string;
        if (assistantMessage.remoteImageUrl) {
          imageUri = await downloadPng(assistantMessage.remoteImageUrl, controller.signal);
        } else {
          const apiKey = await getProviderKey(provider.id);
          if (!apiKey) throw new Error('没有找到该服务商的 API 密钥');
          const common = {
            baseUrl: provider.baseUrl,
            apiKey,
            model: assistantMessage.model,
            prompt,
            quality: assistantMessage.quality,
            size: assistantMessage.size,
            transparent: assistantMessage.transparent,
            signal: controller.signal,
          };
          imageUri = references.length
            ? await editImage({ ...common, references, maskUri })
            : await generateImage(common);
        }
        const completed: ChatMessage = {
          ...assistantMessage,
          status: 'complete',
          imageUri,
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
          ...assistantMessage,
          status: cancelled ? 'cancelled' : 'error',
          error: cancelled ? '请求已取消或超过 10 分钟' : normalized.message,
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
        await deactivateKeepAwake(KEEP_AWAKE_TAG);
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
    ) => {
      const provider = activeProvider;
      if (!provider) throw new Error('请先添加服务商');
      if (!provider.model || !provider.quality || !provider.aspectRatio || !provider.resolutionTier) {
        throw new Error('请先选择模型、画质、比例和清晰度');
      }
      if (!prompt.trim()) throw new Error('请输入图片描述');
      if (generating) throw new Error('当前图片尚未生成完成');

      let requestReferences = references;
      if (continueFromPrevious && requestReferences.length === 0 && activeConversation) {
        const previousResult = latestCompletedImage(messages);
        if (previousResult?.imageUri) {
          requestReferences = [await createReferenceFromGenerated(previousResult.imageUri)];
        }
      }

      let conversation = activeConversation;
      const now = Date.now();
      if (!conversation || conversation.providerId !== provider.id) {
        conversation = {
          id: createId(),
          title: createConversationTitle(prompt),
          providerId: provider.id,
          transparent: false,
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
        };
        await updateConversation(conversation);
      }
      await refreshConversations();

      const size = sizeFor(provider.aspectRatio, provider.resolutionTier);
      const baseMessage = {
        conversationId: conversation.id,
        prompt: prompt.trim(),
        mode: requestReferences.length ? ('edit' as const) : ('generate' as const),
        providerId: provider.id,
        model: provider.model,
        quality: provider.quality,
        size,
        transparent: conversation.transparent,
        references: requestReferences,
        maskUri: maskUri ?? null,
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
      await executeRequest(assistantMessage, prompt.trim(), requestReferences, maskUri);
    },
    [activeProvider, activeConversation, generating, messages, refreshConversations, executeRequest],
  );

  const retryMessage = useCallback(
    async (message: ChatMessage) => {
      if (generating) throw new Error('当前图片尚未生成完成');
      const pending: ChatMessage = { ...message, status: 'pending', error: null, imageUri: null, elapsedMs: null };
      await updateMessage(pending);
      setMessages((current) => current.map((item) => (item.id === pending.id ? pending : item)));
      await executeRequest(pending, pending.prompt, pending.references, pending.maskUri);
    },
    [generating, executeRequest],
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
