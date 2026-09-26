import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { ImageToolCall } from '../agent/image-tool';
import { runAgentTurn, type LabeledImage } from '../api/chat-api';
import { editImage, generateImage, normalizeError } from '../api/image-api';
import { validateAttachments } from '../document-inputs';
import type { AspectRatio, ChatMessage, Conversation, DocumentAttachment, ProviderProfile, Quality, ReferenceImage, ResolutionTier } from '../domain';
import { createConversationTitle, createId, sizeFor } from '../domain-utils';
import { createReferenceFromGenerated } from '../image-inputs';
import {
  deleteConversationRecord, deleteEmptyConversations, deleteProviderRecord, getActiveProviderId, getSetting,
  initializeDatabase, insertConversation, insertMessage, listConversations, listMessages, listProviders,
  reassignConversations, setSetting, updateConversation, updateMessage, upsertProvider,
} from '../storage/database';
import { deleteLocalFile, downloadPng, RemoteImageDownloadError } from '../storage/files';
import { deleteProviderKey, getProviderKey } from '../storage/secure-keys';

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const KEEP_AWAKE_TAG = 'salcara-generation';
const CHAT_PROVIDER_KEY = 'chat_provider_id';
const IMAGE_PROVIDER_KEY = 'image_provider_id';

export type ProviderPatch = Partial<Pick<ProviderProfile, 'model' | 'quality' | 'aspectRatio' | 'resolutionTier' | 'chatModel' | 'chatApi' | 'name' | 'baseUrl'>>;
export type RequestPhase = 'idle' | 'thinking' | 'writing' | 'drawing' | 'downloading';

export interface SendInput {
  text: string;
  images?: ReferenceImage[];
  documents?: DocumentAttachment[];
  maskUri?: string | null;
}

interface AppContextValue {
  ready: boolean;
  providers: ProviderProfile[];
  /** Provider + model used for conversation, vision, files and deciding when to draw. */
  chatProvider: ProviderProfile | null;
  /** Provider + model + defaults used when the assistant draws. */
  imageProvider: ProviderProfile | null;
  conversations: Conversation[];
  /** null means an unsaved new chat. It only becomes a row after the first message. */
  activeConversationId: string | null;
  activeConversation: Conversation | null;
  messages: ChatMessage[];
  busy: boolean;
  phase: RequestPhase;
  elapsedSeconds: number;
  reloadProviders: () => Promise<void>;
  selectChatProvider: (providerId: string, model?: string) => Promise<void>;
  selectImageProvider: (providerId: string, patch?: ProviderPatch) => Promise<void>;
  updateProvider: (providerId: string, patch: ProviderPatch) => Promise<void>;
  removeProvider: (providerId: string) => Promise<void>;
  newChat: () => void;
  openConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  send: (input: SendInput) => Promise<void>;
  stop: () => void;
  retry: (message: ChatMessage) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

function pickChat(providers: ProviderProfile[], id: string | null): ProviderProfile | null {
  return providers.find((item) => item.id === id && item.chatModel) ?? providers.find((item) => item.chatModel) ?? null;
}
function pickImage(providers: ProviderProfile[], id: string | null): ProviderProfile | null {
  return providers.find((item) => item.id === id && item.model) ?? providers.find((item) => item.model) ?? null;
}

export function describeImageDefaults(provider: ProviderProfile | null): string {
  if (!provider) return '';
  return [`模型 ${provider.model}`, provider.aspectRatio && `比例 ${provider.aspectRatio}`, provider.resolutionTier && `清晰度 ${provider.resolutionTier}`, provider.quality && `画质 ${provider.quality}`].filter(Boolean).join('，');
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [chatProviderId, setChatProviderId] = useState<string | null>(null);
  const [imageProviderId, setImageProviderId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<RequestPhase>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const lockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeConversationId;

  const chatProvider = useMemo(() => pickChat(providers, chatProviderId), [providers, chatProviderId]);
  const imageProvider = useMemo(() => pickImage(providers, imageProviderId), [providers, imageProviderId]);
  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeConversationId) ?? null,
    [conversations, activeConversationId],
  );

  const refreshConversations = useCallback(async () => {
    const next = await listConversations();
    setConversations(next);
    return next;
  }, []);

  const reloadProviders = useCallback(async () => {
    setProviders(await listProviders());
  }, []);

  useEffect(() => {
    void (async () => {
      await initializeDatabase();
      // Older builds persisted blank “新会话” rows. A new chat is now a draft
      // that only exists in memory, so remove any leftovers once.
      await deleteEmptyConversations();
      const [loadedProviders, loadedConversations, savedChat, savedImage, legacyActive] = await Promise.all([
        listProviders(), listConversations(), getSetting(CHAT_PROVIDER_KEY), getSetting(IMAGE_PROVIDER_KEY), getActiveProviderId(),
      ]);
      // Migrate the old “active provider + linked providers” model to two
      // global choices, which is what the user actually picks.
      const legacy = loadedProviders.find((item) => item.id === legacyActive);
      const chat = pickChat(loadedProviders, savedChat ?? legacy?.analysisProviderId ?? legacy?.id ?? null);
      const image = pickImage(loadedProviders, savedImage ?? legacy?.imageProviderId ?? legacy?.id ?? null);
      setProviders(loadedProviders);
      setConversations(loadedConversations);
      setChatProviderId(chat?.id ?? null);
      setImageProviderId(image?.id ?? null);
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const assertIdle = () => { if (lockRef.current) throw new Error('请先等待或停止当前回复'); };

  const updateProvider = useCallback(async (providerId: string, patch: ProviderPatch) => {
    const current = (await listProviders()).find((item) => item.id === providerId);
    if (!current) throw new Error('服务商配置已不存在');
    const updated: ProviderProfile = { ...current, ...patch, updatedAt: Date.now() };
    await upsertProvider(updated);
    setProviders((items) => items.map((item) => (item.id === updated.id ? updated : item)));
  }, []);

  const selectChatProvider = useCallback(async (providerId: string, model?: string) => {
    if (model) await updateProvider(providerId, { chatModel: model });
    setChatProviderId(providerId);
    await setSetting(CHAT_PROVIDER_KEY, providerId);
  }, [updateProvider]);

  const selectImageProvider = useCallback(async (providerId: string, patch?: ProviderPatch) => {
    if (patch && Object.keys(patch).length) await updateProvider(providerId, patch);
    setImageProviderId(providerId);
    await setSetting(IMAGE_PROVIDER_KEY, providerId);
  }, [updateProvider]);

  const newChat = useCallback(() => {
    assertIdle();
    // Idempotent: tapping “新对话” repeatedly always lands on the same blank
    // draft. Nothing is written until a message is sent.
    setActiveConversationId(null);
    setMessages([]);
  }, []);

  const openConversation = useCallback(async (conversationId: string) => {
    assertIdle();
    setActiveConversationId(conversationId);
    setMessages(await listMessages(conversationId));
  }, []);

  const deleteConversation = useCallback(async (conversationId: string) => {
    assertIdle();
    const removed = await deleteConversationRecord(conversationId);
    for (const message of removed) {
      deleteLocalFile(message.imageUri);
      deleteLocalFile(message.maskUri);
      message.references.forEach((reference) => deleteLocalFile(reference.uri));
      message.documents?.forEach((document) => deleteLocalFile(document.uri));
    }
    await refreshConversations();
    if (conversationId === activeIdRef.current) { setActiveConversationId(null); setMessages([]); }
  }, [refreshConversations]);

  const renameConversation = useCallback(async (conversationId: string, title: string) => {
    const conversation = (await listConversations()).find((item) => item.id === conversationId);
    const clean = title.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!conversation || !clean) return;
    await updateConversation({ ...conversation, title: clean });
    await refreshConversations();
  }, [refreshConversations]);

  const removeProvider = useCallback(async (providerId: string) => {
    assertIdle();
    const remaining = (await listProviders()).filter((item) => item.id !== providerId);
    if (remaining[0]) {
      await reassignConversations(providerId, remaining[0].id);
    } else {
      for (const conversation of await listConversations()) await deleteConversation(conversation.id);
    }
    await deleteProviderRecord(providerId);
    await deleteProviderKey(providerId);
    setProviders(remaining);
    await refreshConversations();
    if (chatProviderId === providerId) { const next = pickChat(remaining, null); setChatProviderId(next?.id ?? null); await setSetting(CHAT_PROVIDER_KEY, next?.id ?? null); }
    if (imageProviderId === providerId) { const next = pickImage(remaining, null); setImageProviderId(next?.id ?? null); await setSetting(IMAGE_PROVIDER_KEY, next?.id ?? null); }
  }, [chatProviderId, imageProviderId, deleteConversation, refreshConversations]);

  const commit = useCallback(async (message: ChatMessage, persist = true) => {
    if (persist) await updateMessage(message);
    setMessages((current) => current.map((item) => (item.id === message.id ? message : item)));
  }, []);

  /** Executes the paid image request described by a saved assistant message. */
  const drawImage = useCallback(async (message: ChatMessage, signal: AbortSignal): Promise<ChatMessage> => {
    if (message.remoteImageUrl) {
      setPhase('downloading');
      const imageUri = await downloadPng(message.remoteImageUrl, signal);
      return { ...message, imageUri, remoteImageUrl: null };
    }
    const provider = (await listProviders()).find((item) => item.id === message.providerId);
    if (!provider) throw new Error('图片服务商已被删除，请在设置中重新选择');
    const apiKey = await getProviderKey(provider.id);
    if (!apiKey) throw new Error('没有找到图片服务商的 API 密钥');
    setPhase('drawing');
    const common = {
      baseUrl: provider.baseUrl, apiKey, model: message.model, prompt: message.preparedPrompt || message.prompt,
      quality: message.quality, size: message.size, transparent: message.transparent, signal,
    };
    const imageUri = message.references.length
      ? await editImage({ ...common, references: message.references, maskUri: message.maskUri })
      : await generateImage(common);
    return { ...message, imageUri, remoteImageUrl: null };
  }, []);

  /** Turns a tool call into a saved, retryable image job on the assistant message. */
  const prepareImageJob = useCallback(async (
    message: ChatMessage, call: ImageToolCall, images: Map<string, LabeledImage>, userMessage: ChatMessage, provider: ProviderProfile,
  ): Promise<ChatMessage> => {
    const references: ReferenceImage[] = [];
    for (const label of call.referenceImages) {
      const image = images.get(label);
      if (!image || references.some((item) => item.uri === image.uri)) continue;
      const owned = userMessage.references.find((item) => item.uri === image.uri);
      // Earlier generated images get a private normalized copy so this job
      // keeps working even if the source conversation turn is edited later.
      references.push(owned ?? await createReferenceFromGenerated(image.uri));
      if (references.length >= 4) break;
    }
    const usesMask = Boolean(userMessage.maskUri) && references[0]?.uri === userMessage.references[0]?.uri;
    const ratio: AspectRatio = call.aspectRatio ?? provider.aspectRatio ?? '1:1';
    const tier: ResolutionTier = provider.resolutionTier ?? '1K';
    return {
      ...message,
      mode: references.length ? 'edit' : 'generate',
      providerId: provider.id,
      model: provider.model!,
      quality: (provider.quality ?? 'auto') as Quality,
      size: sizeFor(ratio, tier),
      transparent: call.transparent,
      preparedPrompt: call.prompt,
      references,
      maskUri: usesMask ? userMessage.maskUri : null,
    };
  }, []);

  const runTurn = useCallback(async (assistant: ChatMessage, userMessage: ChatMessage, history: ChatMessage[], mode: 'agent' | 'image-only' | 'image-retry') => {
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    setBusy(true);
    let working = assistant;
    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
      if (mode === 'agent') {
        const saved = (await listProviders()).find((item) => item.id === assistant.analysisProviderId && item.chatModel);
        const chat = saved ?? chatProvider;
        if (!chat?.chatModel) throw new Error('还没有可用的对话模型，请在设置中选择');
        const apiKey = await getProviderKey(chat.id);
        if (!apiKey) throw new Error('没有找到对话服务商的 API 密钥');
        const image = imageProvider;
        setPhase('thinking');
        let lastFlush = 0;
        let pendingText = '';
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flush = () => {
          flushTimer = null; lastFlush = Date.now();
          working = { ...working, text: pendingText };
          void commit(working, false);
        };
        const result = await runAgentTurn({
          baseUrl: chat.baseUrl, apiKey, model: (saved && assistant.analysisModel) || chat.chatModel, api: chat.chatApi,
          history, prompt: userMessage.prompt, references: userMessage.references, documents: userMessage.documents,
          signal: controller.signal,
          toolMode: image ? 'native' : 'none', imageAvailable: Boolean(image), imageDefaults: describeImageDefaults(image),
        }, (text) => {
          if (!text) return;
          pendingText = text;
          setPhase('writing');
          const wait = 60 - (Date.now() - lastFlush);
          if (wait <= 0) flush();
          else if (!flushTimer) flushTimer = setTimeout(flush, wait);
        });
        if (flushTimer) clearTimeout(flushTimer);
        working = { ...working, text: result.text || null };
        if (result.imageCall && image?.model) {
          working = await prepareImageJob(working, result.imageCall, result.images, userMessage, image);
          working = { ...working, status: 'pending' };
          // Saved before the paid request: a retry repeats only the image call.
          await commit(working);
          working = await drawImage(working, controller.signal);
        }
      } else {
        await commit(working);
        working = await drawImage(working, controller.signal);
      }
      working = { ...working, status: 'complete', error: null, elapsedMs: Date.now() - startedAtRef.current };
      await commit(working);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const normalized = normalizeError(error);
      working = {
        ...working,
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? '已停止' : normalized.message,
        remoteImageUrl: error instanceof RemoteImageDownloadError ? error.remoteImageUrl : working.remoteImageUrl,
        elapsedMs: Date.now() - startedAtRef.current,
      };
      await commit(working);
    } finally {
      clearTimeout(timeout);
      abortRef.current = null;
      setBusy(false);
      setPhase('idle');
      lockRef.current = false;
      try { await deactivateKeepAwake(KEEP_AWAKE_TAG); } catch { /* already released */ }
    }
  }, [commit, drawImage, chatProvider, imageProvider, prepareImageJob]);

  const send = useCallback(async ({ text, images = [], documents = [], maskUri = null }: SendInput) => {
    const prompt = text.trim();
    if (!prompt && !images.length && !documents.length) throw new Error('请输入内容，或添加图片 / 文件');
    if (!chatProvider && !imageProvider) throw new Error('还没有连接 AI 服务，请先添加服务商');
    if (lockRef.current) throw new Error('请先等待或停止当前回复');
    if (!chatProvider && documents.length) throw new Error('阅读文件需要对话模型，请在设置中添加对话服务商');
    if (!chatProvider && !prompt) throw new Error('请描述想要的图片');
    validateAttachments(documents, images);
    lockRef.current = true;
    setBusy(true);
    try {
      const now = Date.now();
      const owner = (chatProvider ?? imageProvider)!;
      let conversationId = activeIdRef.current;
      const history = conversationId ? messagesRef.current : [];
      if (!conversationId) {
        const conversation: Conversation = {
          id: createId(),
          title: createConversationTitle(prompt || documents[0]?.name || '图片对话'),
          providerId: owner.id, transparent: false, mode: 'auto', createdAt: now, updatedAt: now,
        };
        await insertConversation(conversation);
        conversationId = conversation.id;
        setActiveConversationId(conversation.id);
        activeIdRef.current = conversation.id;
      } else {
        const existing = (await listConversations()).find((item) => item.id === conversationId);
        if (existing) await updateConversation({ ...existing, updatedAt: now });
      }
      await refreshConversations();

      const base = {
        conversationId, prompt: prompt || (documents.length ? '请阅读并分析这些文件。' : '请看看这张图片。'),
        quality: 'auto' as Quality, size: '', transparent: false, error: null, elapsedMs: null,
        remoteImageUrl: null, imageUri: null, status: 'complete' as const,
      };
      const userMessage: ChatMessage = {
        ...base, id: createId(), role: 'user', mode: 'chat', providerId: owner.id,
        model: chatProvider?.chatModel ?? imageProvider?.model ?? '', references: images, documents, maskUri,
        createdAt: now,
      };
      let assistant: ChatMessage = {
        ...base, id: createId(), role: 'assistant', mode: 'chat', status: 'pending', providerId: owner.id,
        model: chatProvider?.chatModel ?? '', references: [], documents: [], maskUri: null, text: null,
        analysisProviderId: chatProvider?.id ?? null, analysisModel: chatProvider?.chatModel ?? null,
        analysisApi: chatProvider?.chatApi, requestApi: chatProvider?.chatApi, createdAt: now + 1,
      };
      let mode: 'agent' | 'image-only' = 'agent';
      if (!chatProvider) {
        // Image-only setup: every message is a drawing request.
        mode = 'image-only';
        assistant = await prepareImageJob(assistant, { prompt, referenceImages: images.map((_, index) => `图${index + 1}`), aspectRatio: null, transparent: /透明/.test(prompt) },
          new Map(images.map((image, index) => [`图${index + 1}`, { ...image, label: `图${index + 1}` }])), userMessage, imageProvider!);
        assistant = { ...assistant, status: 'pending' };
      }
      await insertMessage(userMessage);
      await insertMessage(assistant);
      setMessages((current) => [...(activeIdRef.current === conversationId ? current : []), userMessage, assistant]);
      await runTurn(assistant, userMessage, history, mode);
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }, [chatProvider, imageProvider, prepareImageJob, refreshConversations, runTurn]);

  const retry = useCallback(async (message: ChatMessage) => {
    if (lockRef.current) throw new Error('请先等待或停止当前回复');
    const all = messagesRef.current;
    const index = all.findIndex((item) => item.id === message.id);
    const userMessage = all[index - 1];
    if (index < 1 || userMessage?.role !== 'user') throw new Error('找不到这条回复对应的提问');
    lockRef.current = true;
    setBusy(true);
    try {
      const imageJob = Boolean(message.preparedPrompt && (message.mode === 'generate' || message.mode === 'edit'));
      const reset: ChatMessage = {
        ...message, status: 'pending', error: null, imageUri: null, elapsedMs: null,
        ...(imageJob ? {} : { text: null }),
      };
      await commit(reset);
      // A saved image job is repeated as-is: no second charge for the conversation step.
      await runTurn(reset, userMessage, all.slice(0, index - 1), imageJob ? 'image-retry' : 'agent');
    } finally {
      lockRef.current = false;
      setBusy(false);
    }
  }, [commit, runTurn]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const value = useMemo<AppContextValue>(() => ({
    ready, providers, chatProvider, imageProvider, conversations, activeConversationId, activeConversation, messages,
    busy, phase, elapsedSeconds, reloadProviders, selectChatProvider, selectImageProvider, updateProvider, removeProvider,
    newChat, openConversation, deleteConversation, renameConversation, send, stop, retry,
  }), [ready, providers, chatProvider, imageProvider, conversations, activeConversationId, activeConversation, messages,
    busy, phase, elapsedSeconds, reloadProviders, selectChatProvider, selectImageProvider, updateProvider, removeProvider,
    newChat, openConversation, deleteConversation, renameConversation, send, stop, retry]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
