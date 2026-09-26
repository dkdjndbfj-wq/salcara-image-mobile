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
  deleteConversationRecord, deleteEmptyConversations, deleteProviderRecord, getActiveProviderId, getSetting, listReferencedFileNames,
  initializeDatabase, insertConversation, insertMessage, listConversations, listMessages, listProviders,
  reassignConversations, setSetting, updateConversation, updateMessage, upsertProvider,
} from '../storage/database';
import { deleteLocalFile, downloadPng, RemoteImageDownloadError, sweepUnreferencedFiles } from '../storage/files';
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
  /** Sent from voice conversation: the reply is spoken, so the model answers briefly without Markdown. */
  voice?: boolean;
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
  /** The open conversation has a reply in progress. */
  busy: boolean;
  /** Any conversation has a reply in progress (drawing can continue in the background). */
  anyBusy: boolean;
  /** Conversations with a reply in progress, for the drawer indicator. */
  runningConversationIds: string[];
  phase: RequestPhase;
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
  /** Saves a finished spoken exchange (realtime voice model) into the open conversation. */
  recordVoiceExchange: (userText: string, assistantText: string) => Promise<void>;
}

interface RunInfo { phase: RequestPhase; startedAt: number }
interface RunHandle {
  controller: AbortController;
  startedAt: number;
  /** Settles when the run has fully finished (final state written). */
  done: Promise<void>;
  finish: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);
/** Ticks every second during a reply; kept separate so the whole app doesn't re-render each second. */
const ElapsedContext = createContext(0);

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
  const [runs, setRuns] = useState<Record<string, RunInfo>>({});
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  /** One in-flight reply per conversation; different conversations run independently. */
  const runsRef = useRef(new Map<string, RunHandle>());
  /** Latest in-memory copy of messages touched this session (streamed text is not persisted until done). */
  const liveRef = useRef(new Map<string, ChatMessage>());
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeConversationId;

  const chatProvider = useMemo(() => pickChat(providers, chatProviderId), [providers, chatProviderId]);
  const imageProvider = useMemo(() => pickImage(providers, imageProviderId), [providers, imageProviderId]);
  const activeRun = activeConversationId ? runs[activeConversationId] : undefined;
  const busy = Boolean(activeRun);
  const phase: RequestPhase = activeRun?.phase ?? 'idle';
  const runningConversationIds = useMemo(() => Object.keys(runs), [runs]);
  const anyBusy = runningConversationIds.length > 0;
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
      // Tidy files left behind by discarded drafts or interrupted runs (in the background).
      void (async () => {
        try { sweepUnreferencedFiles(await listReferencedFileNames()); } catch { /* best effort, never blocks startup */ }
      })();
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

  const activeStartedAt = activeRun?.startedAt ?? 0;
  useEffect(() => {
    if (!activeStartedAt) { setElapsedSeconds(0); return; }
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - activeStartedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [activeStartedAt]);

  const setRunPhase = useCallback((conversationId: string, next: RequestPhase) => {
    setRuns((current) => (current[conversationId] && current[conversationId].phase !== next
      ? { ...current, [conversationId]: { ...current[conversationId], phase: next } }
      : current));
  }, []);

  /** Claims the conversation's slot synchronously, so a double tap can't start two replies. */
  const beginRun = useCallback((conversationId: string) => {
    if (runsRef.current.has(conversationId)) throw new Error('请先等待或停止当前回复');
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const run: RunHandle = { controller: new AbortController(), startedAt: Date.now(), done, finish };
    const first = runsRef.current.size === 0;
    runsRef.current.set(conversationId, run);
    setRuns((current) => ({ ...current, [conversationId]: { phase: 'thinking', startedAt: run.startedAt } }));
    if (first) void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
    return run;
  }, []);

  const endRun = useCallback((conversationId: string, run: RunHandle) => {
    run.finish();
    if (runsRef.current.get(conversationId) !== run) return;
    runsRef.current.delete(conversationId);
    setRuns((current) => { const next = { ...current }; delete next[conversationId]; return next; });
    if (runsRef.current.size === 0) {
      try { void Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => undefined); } catch { /* already released */ }
    }
  }, []);

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
    // Idempotent: tapping “新对话” repeatedly always lands on the same blank
    // draft. Nothing is written until a message is sent.
    setActiveConversationId(null);
    activeIdRef.current = null;
    setMessages([]);
    messagesRef.current = [];
  }, []);

  const openConversation = useCallback(async (conversationId: string) => {
    // Load first, then switch: a message sent in between must see the full history.
    // A reply still running in that conversation shows its live (unsaved) text.
    const loaded = (await listMessages(conversationId)).map((item) => liveRef.current.get(item.id) ?? item);
    setMessages(loaded);
    messagesRef.current = loaded;
    setActiveConversationId(conversationId);
    activeIdRef.current = conversationId;
  }, []);

  const deleteConversation = useCallback(async (conversationId: string) => {
    const run = runsRef.current.get(conversationId);
    if (run) {
      // Let the aborted run write its final state first, so files it just
      // produced are deleted with the rows instead of being orphaned.
      run.controller.abort();
      await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    const removed = await deleteConversationRecord(conversationId);
    removed.forEach((message) => liveRef.current.delete(message.id));
    for (const message of removed) {
      deleteLocalFile(message.imageUri);
      deleteLocalFile(message.maskUri);
      message.references.forEach((reference) => deleteLocalFile(reference.uri));
      message.documents?.forEach((document) => deleteLocalFile(document.uri));
    }
    await refreshConversations();
    if (conversationId === activeIdRef.current) { setActiveConversationId(null); activeIdRef.current = null; setMessages([]); messagesRef.current = []; }
  }, [refreshConversations]);

  const renameConversation = useCallback(async (conversationId: string, title: string) => {
    const conversation = (await listConversations()).find((item) => item.id === conversationId);
    const clean = title.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!conversation || !clean) return;
    await updateConversation({ ...conversation, title: clean });
    await refreshConversations();
  }, [refreshConversations]);

  const removeProvider = useCallback(async (providerId: string) => {
    if (runsRef.current.size) throw new Error('请先等待或停止正在进行的回复');
    const remaining = (await listProviders()).filter((item) => item.id !== providerId);
    // Chat history is never deleted with a provider; new messages use whichever provider is selected.
    if (remaining[0]) await reassignConversations(providerId, remaining[0].id);
    await deleteProviderRecord(providerId);
    await deleteProviderKey(providerId);
    setProviders(remaining);
    await refreshConversations();
    if (chatProviderId === providerId) { const next = pickChat(remaining, null); setChatProviderId(next?.id ?? null); await setSetting(CHAT_PROVIDER_KEY, next?.id ?? null); }
    if (imageProviderId === providerId) { const next = pickImage(remaining, null); setImageProviderId(next?.id ?? null); await setSetting(IMAGE_PROVIDER_KEY, next?.id ?? null); }
  }, [chatProviderId, imageProviderId, deleteConversation, refreshConversations]);

  const commit = useCallback(async (message: ChatMessage, persist = true) => {
    // Kept for the session (not deleted on completion) so a conversation opened
    // while this write is in flight still sees the newest version.
    liveRef.current.set(message.id, message);
    if (persist) await updateMessage(message);
    // Only the open conversation is on screen; others pick up the saved row when reopened.
    if (message.conversationId !== activeIdRef.current) return;
    setMessages((current) => {
      const next = current.map((item) => (item.id === message.id ? message : item));
      messagesRef.current = next;
      return next;
    });
  }, []);

  /** Executes the paid image request described by a saved assistant message. */
  const drawImage = useCallback(async (message: ChatMessage, signal: AbortSignal): Promise<ChatMessage> => {
    if (message.remoteImageUrl) {
      setRunPhase(message.conversationId, 'downloading');
      const imageUri = await downloadPng(message.remoteImageUrl, signal);
      return { ...message, imageUri, remoteImageUrl: null };
    }
    const provider = (await listProviders()).find((item) => item.id === message.providerId);
    if (!provider) throw new Error('图片服务商已被删除，请在设置中重新选择');
    const apiKey = await getProviderKey(provider.id);
    if (!apiKey) throw new Error('没有找到图片服务商的 API 密钥');
    setRunPhase(message.conversationId, 'drawing');
    const common = {
      baseUrl: provider.baseUrl, apiKey, model: message.model, prompt: message.preparedPrompt || message.prompt,
      quality: message.quality, size: message.size, transparent: message.transparent, signal,
    };
    const imageUri = message.references.length
      ? await editImage({ ...common, references: message.references, maskUri: message.maskUri })
      : await generateImage(common);
    return { ...message, imageUri, remoteImageUrl: null };
  }, [setRunPhase]);

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

  const runTurn = useCallback(async (
    run: RunHandle,
    assistant: ChatMessage, userMessage: ChatMessage, history: ChatMessage[], mode: 'agent' | 'image-only' | 'image-retry', voice = false,
  ) => {
    const { controller, startedAt } = run;
    const conversationId = assistant.conversationId;
    // One budget for the conversation step and a fresh one for the paid drawing,
    // so a slow reply can't cut off an image the provider is already making.
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const armTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
    };
    armTimeout();
    let working = assistant;
    let lastPersist = Date.now();
    try {
      if (mode === 'agent') {
        const saved = (await listProviders()).find((item) => item.id === assistant.analysisProviderId && item.chatModel);
        const chat = saved ?? chatProvider;
        if (!chat?.chatModel) throw new Error('还没有可用的对话模型，请在设置中选择');
        const apiKey = await getProviderKey(chat.id);
        if (!apiKey) throw new Error('没有找到对话服务商的 API 密钥');
        const image = imageProvider;
        setRunPhase(conversationId, 'thinking');
        // Network chunks arrive in bursts; reveal them as a steady typewriter
        // that speeds up when it falls behind, like the big chat apps.
        let target = '';
        let shown = 0;
        let ticker: ReturnType<typeof setInterval> | null = null;
        const stopTicker = () => { if (ticker) { clearInterval(ticker); ticker = null; } };
        const tick = () => {
          const remaining = target.length - shown;
          if (remaining <= 0) { stopTicker(); return; }
          shown = Math.min(target.length, shown + Math.max(2, Math.ceil(remaining / 6)));
          const code = target.charCodeAt(shown - 1);
          if (code >= 0xd800 && code <= 0xdbff && shown < target.length) shown += 1; // keep emoji whole
          working = { ...working, text: target.slice(0, shown) };
          // Save progress now and then, so a killed app keeps what was already written.
          const persist = Date.now() - lastPersist > 1500;
          if (persist) lastPersist = Date.now();
          void commit(working, persist);
        };
        let result: Awaited<ReturnType<typeof runAgentTurn>>;
        try {
          result = await runAgentTurn({
            baseUrl: chat.baseUrl, apiKey, model: (saved && assistant.analysisModel) || chat.chatModel, api: chat.chatApi,
            history, prompt: userMessage.prompt, references: userMessage.references, documents: userMessage.documents,
            signal: controller.signal,
            toolMode: image ? 'native' : 'none', imageAvailable: Boolean(image), imageDefaults: describeImageDefaults(image), voice,
          }, (text) => {
            if (!text) return;
            // Text normally only grows; it can shrink when a hidden tool marker
            // is removed, and then never show more than the new text.
            if (!(text.length >= target.length && text.startsWith(target))) {
              let common = 0;
              const limit = Math.min(shown, text.length);
              while (common < limit && text.charCodeAt(common) === target.charCodeAt(common)) common += 1;
              shown = common;
            }
            target = text;
            setRunPhase(conversationId, 'writing');
            if (!ticker) { tick(); ticker = setInterval(tick, 40); }
          });
          // Let the typewriter finish the last few words instead of jumping.
          target = result.text;
          const drainUntil = Date.now() + 450;
          while (ticker && shown < target.length && Date.now() < drainUntil && !controller.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
        } finally {
          stopTicker();
        }
        working = { ...working, text: result.text || null };
        if (result.imageCall && image?.model) {
          working = await prepareImageJob(working, result.imageCall, result.images, userMessage, image);
          working = { ...working, status: 'pending' };
          // Saved before the paid request: a retry repeats only the image call.
          await commit(working);
          armTimeout();
          working = await drawImage(working, controller.signal);
        }
      } else {
        await commit(working);
        working = await drawImage(working, controller.signal);
      }
      working = { ...working, status: 'complete', error: null, elapsedMs: Date.now() - startedAt };
      await commit(working);
    } catch (error) {
      const cancelled = controller.signal.aborted && !timedOut;
      const imageJob = Boolean(working.preparedPrompt) && (working.mode === 'generate' || working.mode === 'edit');
      const message = timedOut
        ? imageJob
          ? '等待超过 10 分钟，已停止等待。图片可能仍在服务商处生成，请先查看服务商记录再重新绘制，以免重复扣费'
          : '等待超过 10 分钟，已停止等待，请稍后重试'
        : normalizeError(error).message;
      working = {
        ...working,
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? '已停止' : message,
        remoteImageUrl: error instanceof RemoteImageDownloadError ? error.remoteImageUrl : working.remoteImageUrl,
        elapsedMs: Date.now() - startedAt,
      };
      await commit(working);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }, [commit, drawImage, chatProvider, imageProvider, prepareImageJob, setRunPhase]);

  const send = useCallback(async ({ text, images = [], documents = [], maskUri = null, voice = false }: SendInput) => {
    const prompt = text.trim();
    if (!prompt && !images.length && !documents.length) throw new Error('请输入内容，或添加图片 / 文件');
    if (!chatProvider && !imageProvider) throw new Error('还没有连接 AI 服务，请先添加服务商');
    const activeId = activeIdRef.current;
    if (activeId && runsRef.current.has(activeId)) throw new Error('请先等待或停止当前回复');
    if (!chatProvider && documents.length) throw new Error('阅读文件需要对话模型，请在设置中添加对话服务商');
    if (!chatProvider && !prompt) throw new Error('请描述想要的图片');
    validateAttachments(documents, images);
    const now = Date.now();
    const owner = (chatProvider ?? imageProvider)!;
    const isDraft = !activeId;
    const conversationId = activeId ?? createId();
    const history = isDraft ? [] : messagesRef.current;
    // Claim the slot before any await; a draft becomes this conversation right away.
    const run = beginRun(conversationId);
    if (isDraft) { setActiveConversationId(conversationId); activeIdRef.current = conversationId; }
    try {
      if (isDraft) {
        const conversation: Conversation = {
          id: conversationId,
          title: createConversationTitle(prompt || documents[0]?.name || '图片对话'),
          providerId: owner.id, transparent: false, mode: 'auto', createdAt: now, updatedAt: now,
        };
        await insertConversation(conversation);
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
      liveRef.current.set(assistant.id, assistant);
      if (activeIdRef.current === conversationId) {
        setMessages((current) => { const next = [...current, userMessage, assistant]; messagesRef.current = next; return next; });
      }
      await runTurn(run, assistant, userMessage, history, mode, voice);
    } finally {
      endRun(conversationId, run);
    }
  }, [chatProvider, imageProvider, beginRun, endRun, prepareImageJob, refreshConversations, runTurn]);

  const recordVoiceExchange = useCallback(async (userText: string, assistantText: string) => {
    const prompt = userText.trim();
    const reply = assistantText.trim();
    if (!prompt && !reply) return;
    const owner = chatProvider ?? imageProvider;
    if (!owner) return;
    const now = Date.now();
    let conversationId = activeIdRef.current;
    if (!conversationId) {
      conversationId = createId();
      await insertConversation({
        id: conversationId, title: createConversationTitle(prompt || '语音对话'), providerId: owner.id,
        transparent: false, mode: 'auto', createdAt: now, updatedAt: now,
      });
      setActiveConversationId(conversationId);
      activeIdRef.current = conversationId;
    } else {
      const existing = (await listConversations()).find((item) => item.id === conversationId);
      if (existing) await updateConversation({ ...existing, updatedAt: now });
    }
    const base = {
      conversationId, quality: 'auto' as Quality, size: '', transparent: false, error: null, elapsedMs: null,
      remoteImageUrl: null, imageUri: null, status: 'complete' as const, mode: 'chat' as const, providerId: owner.id,
      references: [], documents: [], maskUri: null,
    };
    const userMessage: ChatMessage = { ...base, id: createId(), role: 'user', prompt: prompt || '（语音）', model: '', createdAt: now };
    const assistant: ChatMessage = { ...base, id: createId(), role: 'assistant', prompt: prompt || '（语音）', model: '', text: reply || null, createdAt: now + 1 };
    await insertMessage(userMessage);
    await insertMessage(assistant);
    if (activeIdRef.current === conversationId) {
      setMessages((current) => { const next = [...current, userMessage, assistant]; messagesRef.current = next; return next; });
    }
    await refreshConversations();
  }, [chatProvider, imageProvider, refreshConversations]);

  const retry = useCallback(async (message: ChatMessage) => {
    const all = messagesRef.current;
    const index = all.findIndex((item) => item.id === message.id);
    const userMessage = all[index - 1];
    if (index < 1 || userMessage?.role !== 'user') throw new Error('找不到这条回复对应的提问');
    const conversationId = message.conversationId;
    const run = beginRun(conversationId);
    try {
      const imageJob = Boolean(message.preparedPrompt && (message.mode === 'generate' || message.mode === 'edit'));
      const reset: ChatMessage = {
        ...message, status: 'pending', error: null, imageUri: null, elapsedMs: null,
        ...(imageJob ? {} : { text: null }),
      };
      await commit(reset);
      // A saved image job is repeated as-is: no second charge for the conversation step.
      await runTurn(run, reset, userMessage, all.slice(0, index - 1), imageJob ? 'image-retry' : 'agent');
      // A regenerated result replaces the old one: delete files nothing refers to any more.
      const latest = liveRef.current.get(message.id);
      if (latest && latest.status === 'complete') {
        const keep = new Set([latest.imageUri, latest.maskUri, ...latest.references.map((item) => item.uri), ...userMessage.references.map((item) => item.uri), userMessage.maskUri]);
        const previous = [message.imageUri, ...message.references.map((item) => item.uri)];
        previous.forEach((uri) => { if (uri && !keep.has(uri)) deleteLocalFile(uri); });
      }
    } finally {
      endRun(conversationId, run);
    }
  }, [beginRun, commit, endRun, runTurn]);

  /** Stops the reply in the open conversation only. */
  const stop = useCallback(() => {
    const id = activeIdRef.current;
    if (id) runsRef.current.get(id)?.controller.abort();
  }, []);

  const value = useMemo<AppContextValue>(() => ({
    ready, providers, chatProvider, imageProvider, conversations, activeConversationId, activeConversation, messages,
    busy, anyBusy, runningConversationIds, phase, reloadProviders, selectChatProvider, selectImageProvider, updateProvider, removeProvider,
    newChat, openConversation, deleteConversation, renameConversation, send, stop, retry, recordVoiceExchange,
  }), [ready, providers, chatProvider, imageProvider, conversations, activeConversationId, activeConversation, messages,
    busy, anyBusy, runningConversationIds, phase, reloadProviders, selectChatProvider, selectImageProvider, updateProvider, removeProvider,
    newChat, openConversation, deleteConversation, renameConversation, send, stop, retry, recordVoiceExchange]);

  return <AppContext.Provider value={value}><ElapsedContext.Provider value={elapsedSeconds}>{children}</ElapsedContext.Provider></AppContext.Provider>;
}

export function useElapsedSeconds(): number {
  return useContext(ElapsedContext);
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
