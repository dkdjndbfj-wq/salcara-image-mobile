import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { runPhoneAction } from '../agent/actions';
import { loadAgents } from '../agent/agents';
import { deleteGeneratedFile } from '../agent/files';
import type { ImageToolCall } from '../agent/image-tool';
import { compactConversation, deleteConversationSummary, loadConversationSummary, type SummaryModel } from '../agent/conversation-summary';
import { fitHistory, historyBudget, summaryInstruction } from '../agent/context-window';
import { labelConversationImages, type LabeledImage } from '../agent/labels';
import { loadMemories } from '../agent/memory';
import { DEFAULT_AGENT_SETTINGS, loadAgentSettings } from '../agent/settings';
import { createToolbox } from '../agent/toolbox';
import { emptyTrace, hasTraceContent, traceFileUris, type AgentTrace, type PhoneAction } from '../agent/types';
import { runAgentTurn } from '../api/chat-api';
import { deleteServiceSecrets, migrateSpeechServices } from '../api/services';
import { loadVoiceSettings, updateVoiceSettings } from '../voice/settings';
import { buildCompanionContext, personaPrompt } from '../memorybox/context';
import { normalizeCharacter, type CharacterDraft } from '../memorybox/characters';
import { catchUpAll, configureMemoryPipeline, forgetTurnsFrom, scheduleMemoryWork } from '../memorybox/pipeline';
import { retrieve } from '../memorybox/search';
import { embeddingModelOf, embeddingProvider, embedTexts, loadMemoryBoxSettings } from '../memorybox/settings';
import { deleteCharacterRecords, listAboutUserNotes, loadBox, loadCharacters, reloadMemoryStore, saveCharacter, touchNotes, updateCharacter } from '../memorybox/store';
import type { BackupProgress } from '../storage/backup';
import { createCompanionToolbox } from '../memorybox/tools';
import { tagErrorStage, withStagePrefix } from '../api/error-stage';
import { editImages, generateImages, IMAGE_TASK_FAILED, normalizeError, type ImageTaskRef } from '../api/image-api';
import { validateAttachments } from '../document-inputs';
import type { AspectRatio, ChatMessage, Conversation, GeneratedImage, ProviderProfile, Quality, ReferenceImage, ResolutionTier } from '../domain';
import { generatedImageSlotMapping, messageGeneratedImages, normalizeGeneratedImages, validateImageCount } from '../generated-images';
import { createConversationTitle, createId, sizeFor } from '../domain-utils';
import { createReferenceFromGenerated, previewDataUrl } from '../image-inputs';
import {
  deleteConversationRecord, deleteEmptyConversations, deleteMessageRecords, deleteMessagesFrom, deleteProviderRecord, getActiveProviderId, getSetting, listReferencedFileNames,
  initializeDatabase, insertConversation, insertMessage, listConversations, listMessages, listProviders, listRecentMessages,
  reassignConversations, setSetting, updateConversation, updateMessage, upsertProvider,
} from '../storage/database';
import { deleteLocalFile, downloadPng, RemoteImageDownloadError, sweepUnreferencedFiles } from '../storage/files';
import { deleteProviderKey, getProviderKey } from '../storage/secure-keys';
import { clearLiveText, setLiveText } from './live-text';
import { describeImageDefaults, faithfulPrompt, deleteMessageFiles, imageCountFromPrompt, pickChat, pickImage } from './app-helpers';
import type { AppContextValue, ProviderPatch, RequestPhase, SendInput, Space } from './app-types';

// The types and helpers live in their own modules; existing imports from here keep working.
export type { AppContextValue, ProviderPatch, RequestPhase, SendInput, Space } from './app-types';
export { describeImageDefaults, faithfulPrompt } from './app-helpers';

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const KEEP_AWAKE_TAG = 'salcara-generation';
const CHAT_PROVIDER_KEY = 'chat_provider_id';
const IMAGE_PROVIDER_KEY = 'image_provider_id';

interface TurnOptions { voice?: boolean; research?: boolean; agentId?: string | null; characterId?: string | null }

const SPACE_KEY = 'space';
/** Chat-space threads are endless: only the newest page is kept in memory. */
const PAGE_SIZE = 60;

interface RunInfo { phase: RequestPhase; startedAt: number }
interface RunHandle {
  controller: AbortController;
  startedAt: number;
  /** Settles when the run has fully finished (final state written). */
  done: Promise<void>;
  finish: () => void;
}

function withImageResults(message: ChatMessage, images: GeneratedImage[]): ChatMessage {
  const results = normalizeGeneratedImages(images);
  return { ...message, generatedImages: results, imageUri: results.find((image) => image.status === 'complete' && image.uri)?.uri ?? null,
    remoteImageUrl: results.length === 1 && !results[0].uri ? results[0].remoteUrl ?? null : null };
}

function finishedImageStatus(message: ChatMessage): Pick<ChatMessage, 'status' | 'error'> {
  const images = messageGeneratedImages(message);
  return images.length && !images.some((image) => image.status === 'complete' && image.uri)
    ? { status: 'error', error: images.find((image) => image.error)?.error || '没有取得图片' }
    : { status: 'complete', error: null };
}

const AppContext = createContext<AppContextValue | null>(null);
/** Ticks every second during a reply; kept separate so the whole app doesn't re-render each second. */
const ElapsedContext = createContext(0);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [chatProviderId, setChatProviderId] = useState<string | null>(null);
  const [imageProviderId, setImageProviderId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [draftAgentId, setDraftAgentId] = useState<string | null>(null);
  const [space, setSpace] = useState<Space>('assistant');
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  /** Where each space was, so switching back returns to the same place. */
  const spacePlaces = useRef<Record<Space, string | null>>({ assistant: null, companion: null, remote: null });
  const spaceRef = useRef<Space>('assistant');
  spaceRef.current = space;
  const draftAgentRef = useRef<string | null>(null);
  draftAgentRef.current = draftAgentId;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runs, setRuns] = useState<Record<string, RunInfo>>({});
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  /** One in-flight reply per conversation; different conversations run independently. */
  const runsRef = useRef(new Map<string, RunHandle>());
  const chatProviderRefLate = useRef<ProviderProfile | null>(null);
  /** Latest in-memory copy of messages touched this session (streamed text is not persisted until done). */
  const liveRef = useRef(new Map<string, ChatMessage>());
  /** Progress and terminal snapshots must reach SQLite in the order they were published. */
  const messageWrites = useRef(new Map<string, Promise<void>>());
  const latestCommit = useRef(new Map<string, ChatMessage>());
  const deletedConversations = useRef(new Set<string>());
  const messageMutations = useRef(new Set<string>());
  const restoringBackup = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  const hasOlderRef = useRef(false);
  hasOlderRef.current = hasOlderMessages;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeConversationId;
  /** Guards async history loads: the latest user intent wins when rows resolve out of order. */
  const conversationOpenSeq = useRef(0);
  /** Prevents a slower refresh after rename/delete from repainting an older list. */
  const conversationRefreshSeq = useRef(0);

  const chatProvider = useMemo(() => pickChat(providers, chatProviderId), [providers, chatProviderId]);
  chatProviderRefLate.current = chatProvider;
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
  const activeAgentId = activeConversationId ? activeConversation?.agentId ?? null : draftAgentId;

  const refreshConversations = useCallback(async () => {
    const seq = (conversationRefreshSeq.current += 1);
    const next = await listConversations();
    if (seq === conversationRefreshSeq.current) setConversations(next);
    return next;
  }, []);

  const restoreBackup = useCallback(async (onProgress?: (progress: BackupProgress) => void) => {
    if (restoringBackup.current) throw new Error('正在恢复备份，请稍后');
    // Restored rows retain their IDs. Old runs and queued checkpoints must finish
    // before a deleted ID can safely belong to a restored conversation again.
    if (runsRef.current.size || messageWrites.current.size || messageMutations.current.size) throw new Error('请等待当前回复保存完成后再恢复备份');
    restoringBackup.current = true;
    try {
      // Loaded on first use: the picker and zip code are only needed here.
      const { pickAndRestoreBackup } = require('../storage/backup') as typeof import('../storage/backup');
      const result = await pickAndRestoreBackup(onProgress);
      if (!result) return null;
      const restored = await refreshConversations();
      restored.forEach((conversation) => deletedConversations.current.delete(conversation.id));
      await Promise.all([loadAgents(true), loadMemories(true), reloadMemoryStore()]).catch(() => undefined);
      return result;
    } finally { restoringBackup.current = false; }
  }, [refreshConversations]);

  const reloadProviders = useCallback(async () => {
    setProviders(await listProviders());
  }, []);

  useEffect(() => {
    void (async () => {
      await initializeDatabase();
      // Older builds persisted blank “新会话” rows. A new chat is now a draft
      // that only exists in memory, so remove any leftovers once.
      await deleteEmptyConversations();
      // Speech accounts from early 1.5 builds become ordinary services.
      await migrateSpeechServices(async (map) => {
        const current = await loadVoiceSettings();
        const moved = (ref: string | null) => (ref && map[ref] !== undefined ? map[ref] : ref?.startsWith('svc:') ? null : ref);
        await updateVoiceSettings({ transcribeProviderId: moved(current.transcribeProviderId), ttsProviderId: moved(current.ttsProviderId), realtimeProviderId: moved(current.realtimeProviderId) });
      }).catch(() => undefined);
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
      const savedSpace = await getSetting(SPACE_KEY).catch(() => null);
      if (savedSpace === 'companion' || savedSpace === 'remote') { setSpace(savedSpace); spaceRef.current = savedSpace; }
      setReady(true);
      // Memory work interrupted by a closed app continues in the background.
      void catchUpAll().catch(() => undefined);
    })();
  }, []);

  // The memory pipeline reads the current providers when it runs.
  const providersRef = useRef<ProviderProfile[]>([]);
  providersRef.current = providers;
  useEffect(() => {
    configureMemoryPipeline({ providers: () => providersRef.current, chatProvider: () => chatProviderRefLate.current });
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
    if (restoringBackup.current) throw new Error('正在恢复备份，请稍后再发送');
    if (deletedConversations.current.has(conversationId)) throw new Error('这条对话已删除，请新建对话');
    if (messageMutations.current.has(conversationId)) throw new Error('这条对话的消息正在更新');
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

  const newChat = useCallback((agentId: string | null = null) => {
    // Idempotent: tapping “新对话” repeatedly always lands on the same blank
    // draft. Nothing is written until a message is sent.
    conversationOpenSeq.current += 1;
    setHasOlderMessages(false);
    setDraftAgentId(agentId);
    draftAgentRef.current = agentId;
    setActiveConversationId(null);
    activeIdRef.current = null;
    setMessages([]);
    messagesRef.current = [];
  }, []);

  // Every conversation opens with its newest page; older messages load while scrolling up.
  // Sending and regenerating still give the model the whole history (fullHistory below).
  const openConversation = useCallback(async (conversationId: string, paged = true) => {
    const seq = (conversationOpenSeq.current += 1);
    // Load first, then switch: a message sent in between must see the full history.
    // A reply still running in that conversation shows its live (unsaved) text.
    const rows = paged ? await listRecentMessages(conversationId, PAGE_SIZE + 1) : await listMessages(conversationId);
    // A fast second tap, a new draft, or a space switch may have superseded this
    // read. Never let a slower database response repaint the newer conversation.
    if (seq !== conversationOpenSeq.current) return;
    const older = paged && rows.length > PAGE_SIZE;
    const loaded = (older ? rows.slice(1) : rows).map((item) => liveRef.current.get(item.id) ?? item);
    setMessages(loaded);
    messagesRef.current = loaded;
    setHasOlderMessages(older);
    setActiveConversationId(conversationId);
    activeIdRef.current = conversationId;
  }, []);

  const [jumpRequest, setJumpRequest] = useState<{ messageId: string; seq: number } | null>(null);
  const openMessage = useCallback(async (conversationId: string, messageId: string) => {
    const shown = activeIdRef.current === conversationId && messagesRef.current.some((item) => item.id === messageId);
    if (!shown) {
      const seq = (conversationOpenSeq.current += 1);
      // Loads from a few messages before the hit to the end; anything older loads while scrolling up as usual.
      const rows = await listMessages(conversationId);
      if (seq !== conversationOpenSeq.current) return;
      const index = rows.findIndex((item) => item.id === messageId);
      if (index < 0) { await openConversation(conversationId); return; }
      const start = Math.max(0, Math.min(index - 4, rows.length - PAGE_SIZE));
      const loaded = rows.slice(start).map((item) => liveRef.current.get(item.id) ?? item);
      setMessages(loaded);
      messagesRef.current = loaded;
      setHasOlderMessages(start > 0);
      hasOlderRef.current = start > 0;
      setActiveConversationId(conversationId);
      activeIdRef.current = conversationId;
    }
    setJumpRequest((current) => ({ messageId, seq: (current?.seq ?? 0) + 1 }));
  }, [openConversation]);

  /** The open conversation's whole history when only its newest page is loaded (null: the page already is everything). */
  const fullHistory = useCallback(async (conversationId: string, before?: number): Promise<ChatMessage[] | null> => {
    if (!hasOlderRef.current || activeIdRef.current !== conversationId) return null;
    const rows = (await listMessages(conversationId)).map((item) => liveRef.current.get(item.id) ?? item);
    return before === undefined ? rows : rows.filter((item) => item.createdAt < before);
  }, []);

  const loadOlderMessages = useCallback(async () => {
    const id = activeIdRef.current;
    const first = messagesRef.current[0];
    if (!id || !first) return;
    const rows = await listRecentMessages(id, PAGE_SIZE + 1, first.createdAt);
    if (activeIdRef.current !== id) return;
    const older = rows.length > PAGE_SIZE;
    const page = (older ? rows.slice(1) : rows).map((item) => liveRef.current.get(item.id) ?? item);
    setHasOlderMessages(older);
    setMessages((current) => { const next = [...page.filter((item) => !current.some((existing) => existing.id === item.id)), ...current]; messagesRef.current = next; return next; });
  }, []);

  // ——— Spaces and characters ———

  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const activeCharacterRef = useRef<string | null>(null);
  activeCharacterRef.current = activeCharacterId;

  const showConversation = useCallback(async (conversationId: string | null, paged: boolean) => {
    if (conversationId) { await openConversation(conversationId, paged).catch(() => undefined); return; }
    conversationOpenSeq.current += 1;
    setActiveConversationId(null); activeIdRef.current = null; setMessages([]); messagesRef.current = []; setHasOlderMessages(false);
  }, [openConversation]);

  const switchSpace = useCallback((next: Space) => {
    if (next === spaceRef.current) return;
    openSeq.current += 1; // a character still opening must not land in the other space
    conversationOpenSeq.current += 1;
    spacePlaces.current[spaceRef.current] = activeIdRef.current;
    setSpace(next);
    spaceRef.current = next;
    void setSetting(SPACE_KEY, next).catch(() => undefined);
    const target = spacePlaces.current[next];
    // Remote coding keeps its own state in the remote store; the assistant thread stays where it was.
    if (next === 'remote') return;
    if (next === 'assistant') { setActiveCharacterId(null); activeCharacterRef.current = null; void showConversation(target, true); }
    else void (async () => {
      const character = target ? (await loadCharacters()).find((item) => item.conversationId === target) : null;
      setActiveCharacterId(character?.id ?? null);
      activeCharacterRef.current = character?.id ?? null;
      await showConversation(character ? target : null, true);
    })();
  }, [showConversation]);

  const openSeq = useRef(0);
  const openChain = useRef<Promise<void>>(Promise.resolve());
  const threadsInFlight = useRef(new Map<string, Promise<string>>());

  /** A character's endless thread, created (with its greeting) the first time; concurrent calls share one creation. */
  const ensureThread = useCallback((characterId: string): Promise<string> => {
    const pending = threadsInFlight.current.get(characterId);
    if (pending) return pending;
    const job = (async () => {
      const character = (await loadCharacters()).find((item) => item.id === characterId);
      if (!character) throw new Error('这个角色已不存在');
      let conversationId = character.conversationId;
      const exists = conversationId ? (await listConversations()).some((item) => item.id === conversationId) : false;
      if (!conversationId || !exists) {
        const now = Date.now();
        conversationId = createId();
        await insertConversation({ id: conversationId, title: character.name, providerId: character.providerId ?? chatProvider?.id ?? '', transparent: false, mode: 'auto', kind: 'companion', characterId, createdAt: now, updatedAt: now });
        if (character.greeting.trim()) {
          await insertMessage({
            id: createId(), conversationId, role: 'assistant', prompt: '', mode: 'chat', status: 'complete', providerId: character.providerId ?? '', model: '',
            quality: 'auto', size: '', transparent: false, imageUri: null, remoteImageUrl: null, references: [], documents: [], maskUri: null,
            text: character.greeting.trim(), error: null, elapsedMs: null, createdAt: now,
          });
        }
        await updateCharacter(characterId, { conversationId, extractedUntil: 0, compactedUntil: 0, lastMessageAt: now });
      }
      return conversationId;
    })().finally(() => { threadsInFlight.current.delete(characterId); });
    threadsInFlight.current.set(characterId, job);
    return job;
  }, [chatProvider]);

  /** Opens a character's thread. Opens run one at a time and only the latest tap lands, so rapid taps can't mix two threads. */
  const openCharacter = useCallback(async (characterId: string) => {
    const seq = (openSeq.current += 1);
    const run = openChain.current.catch(() => undefined).then(async () => {
      if (seq !== openSeq.current) return;
      const conversationId = await ensureThread(characterId);
      if (seq !== openSeq.current) return;
      setActiveCharacterId(characterId);
      activeCharacterRef.current = characterId;
      await openConversation(conversationId, true);
    });
    openChain.current = run;
    await run;
  }, [ensureThread, openConversation]);

  const closeCharacter = useCallback(() => {
    openSeq.current += 1; // an open still loading must not land after “back”
    setActiveCharacterId(null);
    activeCharacterRef.current = null;
    void showConversation(null, false);
  }, [showConversation]);

  const createCharacter = useCallback(async (draft: CharacterDraft) => {
    const character = normalizeCharacter(draft);
    await saveCharacter(character);
    return character;
  }, []);

  const editCharacter = useCallback(async (id: string, draft: CharacterDraft) => {
    const existing = (await loadCharacters()).find((item) => item.id === id);
    if (!existing) throw new Error('这个角色已不存在');
    await saveCharacter(normalizeCharacter(draft, existing));
    if (existing.conversationId) {
      const conversation = (await listConversations()).find((item) => item.id === existing.conversationId);
      if (conversation && conversation.title !== draft.name.trim()) await updateConversation({ ...conversation, title: draft.name.trim() || conversation.title });
    }
  }, []);

  const deleteConversation = useCallback(async (conversationId: string) => {
    if (messageMutations.current.has(conversationId)) throw new Error('这条对话的消息正在更新');
    if (restoringBackup.current) throw new Error('正在恢复备份');
    messageMutations.current.add(conversationId);
    try {
    conversationOpenSeq.current += 1;
    const run = runsRef.current.get(conversationId);
    if (run) {
      // Let the aborted run write its final state first, so files it just
      // produced are deleted with the rows instead of being orphaned.
      run.controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([run.done, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
    }
    const removed = await deleteConversationRecord(conversationId);
    deletedConversations.current.add(conversationId);
    // A slow checkpoint can still be queued after the bounded wait above.
    const pending = [...latestCommit.current.values()].filter((message) => message.conversationId === conversationId);
    const discarded = [...removed, ...pending];
    void deleteConversationSummary(conversationId);
    void setSetting(`draft.assistant.${conversationId}`, null).catch(() => undefined);
    discarded.forEach((message) => { liveRef.current.delete(message.id); latestCommit.current.delete(message.id); clearLiveText(message.id); });
    await deleteMessageFiles(discarded);
    await refreshConversations();
    if (conversationId === activeIdRef.current) { setActiveConversationId(null); activeIdRef.current = null; setMessages([]); messagesRef.current = []; }
    } finally { messageMutations.current.delete(conversationId); }
  }, [refreshConversations]);

  const deleteCharacter = useCallback(async (id: string) => {
    const character = (await loadCharacters()).find((item) => item.id === id);
    if (character?.conversationId) await deleteConversation(character.conversationId);
    await deleteCharacterRecords(id);
    if (character?.avatarUri?.includes('/avatars/')) deleteLocalFile(character.avatarUri);
    if (activeCharacterRef.current === id) { setActiveCharacterId(null); activeCharacterRef.current = null; }
  }, [deleteConversation]);

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
    const removed = (await listProviders()).find((item) => item.id === providerId);
    await deleteProviderRecord(providerId);
    if (removed) await deleteServiceSecrets(removed); else await deleteProviderKey(providerId);
    // Voice functions that used it go back to following the chat service.
    const voice = await loadVoiceSettings();
    await updateVoiceSettings({
      ...(voice.transcribeProviderId === providerId ? { transcribeProviderId: null } : {}),
      ...(voice.ttsProviderId === providerId ? { ttsProviderId: null } : {}),
      ...(voice.realtimeProviderId === providerId ? { realtimeProviderId: null } : {}),
    });
    setProviders(remaining);
    await refreshConversations();
    if (chatProviderId === providerId) { const next = pickChat(remaining, null); setChatProviderId(next?.id ?? null); await setSetting(CHAT_PROVIDER_KEY, next?.id ?? null); }
    if (imageProviderId === providerId) { const next = pickImage(remaining, null); setImageProviderId(next?.id ?? null); await setSetting(IMAGE_PROVIDER_KEY, next?.id ?? null); }
  }, [chatProviderId, imageProviderId, deleteConversation, refreshConversations]);

  const commit = useCallback(async (message: ChatMessage, persist = true) => {
    const discarded = () => {
      if (!deletedConversations.current.has(message.conversationId)) return false;
      void deleteMessageFiles([message]).catch(() => undefined);
      return true;
    };
    if (discarded()) return;
    latestCommit.current.set(message.id, message);
    // A picture must be recoverable before it appears. Text/progress stays
    // immediate; a delayed image checkpoint may never repaint a newer snapshot.
    const previous = liveRef.current.get(message.id);
    const savedUris = new Set(previous ? messageGeneratedImages(previous).map((image) => image.uri) : []);
    const checkpointImage = persist && messageGeneratedImages(message).some((image) => image.uri && !savedUris.has(image.uri));
    const publish = () => {
      if (discarded()) return;
      if (latestCommit.current.get(message.id) !== message) return;
      liveRef.current.set(message.id, message);
      clearLiveText(message.id);
      if (message.conversationId === activeIdRef.current) {
        setMessages((current) => {
          const next = current.map((item) => (item.id === message.id ? message : item));
          messagesRef.current = next;
          return next;
        });
      }
    };
    if (!checkpointImage) publish();
    if (persist) {
      const previous = messageWrites.current.get(message.id);
      const write = (previous ?? Promise.resolve()).catch(() => undefined).then(() => { if (!discarded()) return updateMessage(message); });
      messageWrites.current.set(message.id, write);
      const clear = () => { if (messageWrites.current.get(message.id) === write) messageWrites.current.delete(message.id); };
      void write.then(clear, clear);
      await write;
    }
    if (checkpointImage) publish();
  }, []);

  /** Executes the paid image request described by a saved assistant message. */
  const drawImage = useCallback(async (message: ChatMessage, signal: AbortSignal, onImages?: (images: GeneratedImage[]) => Promise<void>): Promise<ChatMessage> => {
    const taskKey = `image_task:${message.id}`;
    const taskJson = await getSetting(taskKey);
    let savedTask: (ImageTaskRef & { fingerprint?: string; at?: number }) | null = null;
    if (taskJson) {
      try {
        const saved: unknown = JSON.parse(taskJson);
        if (!saved || typeof saved !== 'object' || !('url' in saved)) throw new Error('invalid task');
        savedTask = saved as ImageTaskRef & { fingerprint?: string; at?: number };
      } catch { throw new Error('已保存的图片任务信息无效，本次没有重新发起生成'); }
    }
    // Existing result URLs are already-paid artifacts. Resume only their downloads.
    // An unfinished accepted task takes precedence over a partial artifact list.
    if (!savedTask && message.generatedImages?.some((image) => image.uri || image.remoteUrl)) {
      let images = messageGeneratedImages(message);
      setRunPhase(message.conversationId, 'downloading');
      for (let index = 0; index < images.length; index += 1) {
        const item = images[index];
        if (item.uri || !item.remoteUrl) continue;
        let next: GeneratedImage;
        if (signal.aborted) next = { ...item, status: 'error', error: '图片下载已停止' };
        else {
          images = images.map((image, position) => position === index ? { ...item, status: 'pending', error: null } : image);
          await onImages?.(images);
          try { next = { ...item, uri: await downloadPng(item.remoteUrl, signal), remoteUrl: null, status: 'complete', error: null }; }
          catch (error) { next = { ...item, status: 'error', error: signal.aborted ? '图片下载已停止' : normalizeError(error).message }; }
        }
        images = images.map((image, position) => position === index ? next : image);
        await onImages?.(images);
      }
      return withImageResults(message, images);
    }
    if (!savedTask && message.remoteImageUrl) {
      setRunPhase(message.conversationId, 'downloading');
      const imageUri = await downloadPng(message.remoteImageUrl, signal).catch((error: unknown) => { throw tagErrorStage(error, 'drawing'); });
      return { ...message, imageUri, remoteImageUrl: null };
    }
    const provider = (await listProviders()).find((item) => item.id === message.providerId);
    if (!provider) throw new Error('图片服务商已被删除，请在设置中重新选择');
    const apiKey = await getProviderKey(provider.id);
    if (!apiKey) throw new Error('没有找到图片服务商的 API 密钥');
    setRunPhase(message.conversationId, 'drawing');
    const prompt = message.preparedPrompt || message.prompt;
    // An async task the provider already accepted for this exact job is resumed on retry instead of paid for again.
    const count = validateImageCount(message.imageCount);
    const legacyFingerprint = [provider.id, provider.baseUrl, message.model, prompt, message.size, message.quality, message.transparent, message.references.map((item) => item.uri).join(','), message.maskUri ?? ''].join('|');
    const fingerprint = count === 1 ? legacyFingerprint : `${legacyFingerprint}|count:${count}`;
    if (savedTask && savedTask.fingerprint !== fingerprint) throw new Error('已接受的图片任务与当前服务或参数不匹配，本次没有重新发起生成');
    const resumeTask: ImageTaskRef | null = savedTask ? {
      id: savedTask.id, url: savedTask.url,
      ...(savedTask.results ? { results: savedTask.results } : {}),
      ...(savedTask.terminal !== undefined ? { terminal: savedTask.terminal } : {}),
    } : null;
    let taskSaved = Boolean(resumeTask);
    const onTask = async (task: ImageTaskRef) => {
      if (deletedConversations.current.has(message.conversationId)) throw new Error('这条图片任务已删除');
      await setSetting(taskKey, JSON.stringify({ ...task, fingerprint, at: Date.now() }));
      if (deletedConversations.current.has(message.conversationId)) {
        await deleteMessageFiles([message]);
        throw new Error('这条图片任务已删除');
      }
      taskSaved = true;
    };
    const common = {
      baseUrl: provider.baseUrl, apiKey, model: message.model, prompt,
      quality: message.quality, size: message.size, transparent: message.transparent, count, signal, resumeTask, onTask, onImages,
      resultIds: messageGeneratedImages(message).map((image) => image.id),
    };
    let images: GeneratedImage[];
    try {
      images = message.references.length
        ? await editImages({ ...common, references: message.references, maskUri: message.maskUri })
        : await generateImages(common);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code && code === IMAGE_TASK_FAILED) await setSetting(taskKey, null);
      throw tagErrorStage(error, 'drawing');
    }
    if (taskSaved) await setSetting(taskKey, null);
    return withImageResults(message, images);
  }, [setRunPhase]);

  /** Turns a tool call into a saved, retryable image job on the assistant message. */
  const prepareImageJob = useCallback(async (
    message: ChatMessage, call: ImageToolCall, images: Map<string, LabeledImage>, userMessage: ChatMessage, provider: ProviderProfile,
  ): Promise<ChatMessage> => {
    const missing = call.referenceImages.find((label) => !images.has(label));
    if (missing) throw new Error(`所引用的图片“${missing}”当前不可用，本次没有发起生成`);
    const count = validateImageCount(call.count);
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
    const settings = await loadAgentSettings().catch(() => DEFAULT_AGENT_SETTINGS);
    // A redraw after the self-check is the model's correction, not the user's words again.
    const redraw = Boolean(message.agent?.drafts?.length);
    const prompt = settings.imagePrompt === 'enhance' || redraw ? call.prompt : faithfulPrompt(userMessage.prompt, call.prompt);
    const ratio: AspectRatio = call.aspectRatio ?? provider.aspectRatio ?? '1:1';
    const tier: ResolutionTier = provider.resolutionTier ?? '1K';
    return {
      ...message,
      mode: references.length ? 'edit' : 'generate',
      providerId: provider.id,
      model: provider.model!,
      quality: (provider.quality ?? 'auto') as Quality,
      size: sizeFor(ratio, tier, provider.model),
      transparent: call.transparent,
      preparedPrompt: prompt,
      imageCount: count,
      generatedImages: count > 1 ? Array.from({ length: count }, (_, index) => ({ id: `image-${index + 1}`, uri: null, status: 'pending' as const })) : [],
      references,
      maskUri: usesMask ? userMessage.maskUri : null,
    };
  }, []);

  const runTurn = useCallback(async (
    run: RunHandle,
    assistant: ChatMessage, userMessage: ChatMessage, history: ChatMessage[], mode: 'agent' | 'image-only' | 'image-retry', options: TurnOptions = {},
  ) => {
    const { controller, startedAt } = run;
    const conversationId = assistant.conversationId;
    const voice = Boolean(options.voice);
    // One budget for each conversation step and a fresh one for each paid drawing,
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
    let summaryModel: SummaryModel | null = null;
    /** The picture a redraw in progress would replace; put back if the redraw doesn't finish. */
    let replacedImages: GeneratedImage[] | null = null;
    const checkpointImages = async (images: GeneratedImage[]) => {
      working = withImageResults(working, images);
      await commit(working);
    };
    try {
      if (mode === 'agent') {
        const saved = (await listProviders()).find((item) => item.id === assistant.analysisProviderId && (item.chatModel || assistant.analysisModel));
        const chat = saved ?? chatProvider;
        const model = (saved && assistant.analysisModel) || chat?.chatModel;
        if (!chat || !model) throw new Error('还没有可用的对话模型，请在设置中选择');
        const apiKey = await getProviderKey(chat.id);
        if (!apiKey) throw new Error('没有找到对话服务商的 API 密钥');
        const image = imageProvider?.model ? imageProvider : null;
        setRunPhase(conversationId, 'thinking');
        const [settings, memories, agents] = await Promise.all([
          loadAgentSettings().catch(() => DEFAULT_AGENT_SETTINGS),
          loadMemories().catch(() => []),
          options.agentId ? loadAgents().catch(() => []) : Promise.resolve([]),
        ]);
        const agent = options.agentId ? agents.find((item) => item.id === options.agentId) ?? null : null;
        working = { ...working, agent: { ...emptyTrace(), ...(options.research ? { research: true } : {}), ...(agent ? { agentName: agent.name } : {}) } };

        // Network chunks arrive in bursts; reveal them as a steady typewriter
        // that speeds up when it falls behind, like the big chat apps.
        let target = '';
        let shown = 0;
        let ticker: ReturnType<typeof setInterval> | null = null;
        const stopTicker = () => { if (ticker) { clearInterval(ticker); ticker = null; } };
        const tick = () => {
          if (controller.signal.aborted || working.status !== 'pending') { stopTicker(); return; }
          const remaining = target.length - shown;
          if (remaining <= 0) { stopTicker(); return; }
          shown = Math.min(target.length, shown + Math.max(2, Math.ceil(remaining / 6)));
          const code = target.charCodeAt(shown - 1);
          if (code >= 0xd800 && code <= 0xdbff && shown < target.length) shown += 1; // keep emoji whole
          working = { ...working, text: target.slice(0, shown) };
          // Each step only re-renders the bubble being written (live-text.ts). The message
          // list and the saved copy follow now and then, so a killed app keeps what was written.
          if (Date.now() - lastPersist > 1200) { lastPersist = Date.now(); void commit(working, true).catch(() => undefined); }
          else setLiveText(working.id, working.text ?? null);
        };
        const updateTrace = (update: (trace: AgentTrace) => AgentTrace) => {
          if (controller.signal.aborted || working.status !== 'pending') return;
          working = { ...working, agent: update(working.agent ?? emptyTrace()) };
          lastPersist = Date.now();
          // Progress resets the budget: a long research turn is fine as long as each step moves.
          armTimeout();
          void commit(working).catch(() => undefined);
        };

        // Images the model can refer to, plus any it draws during this turn.
        // Filled once the history for this model is known (the same history the request uses, so 图N match).
        let labeled = new Map<string, LabeledImage>();
        let nextLabel = 1;
        const drawForTool = async (call: ImageToolCall, { preview }: { preview: boolean }) => {
          if (!image) throw new Error('还没有可用的图片服务');
          // A redraw keeps the first picture as a draft of this turn.
          if (working.imageUri) {
            const trace = working.agent ?? emptyTrace();
            replacedImages = messageGeneratedImages(working);
            working = { ...working, imageUri: null, generatedImages: [], agent: { ...trace, drafts: [...(trace.drafts ?? []), ...replacedImages.flatMap((image) => image.uri ? [image.uri] : [])] } };
          }
          const job = await prepareImageJob(working, call, labeled, userMessage, image);
          working = { ...job, text: working.text, agent: working.agent, status: 'pending' };
          // Saved before the paid request: a retry repeats only the image call.
          await commit(working);
          armTimeout();
          const drawn = await drawImage(working, controller.signal, checkpointImages);
          working = withImageResults(working, messageGeneratedImages(drawn));
          if (working.imageUri) replacedImages = null;
          await commit(working);
          const labels: string[] = [];
          const previews: string[] = [];
          for (const image of messageGeneratedImages(working)) {
            if (!image.uri || image.status !== 'complete') continue;
            const label = `图${nextLabel++}`;
            labels.push(label);
            labeled.set(label, { label, uri: image.uri, name: `${label}.png`, mimeType: 'image/png', size: 0 });
            if (preview) { try { previews.push(await previewDataUrl(image.uri)); } catch { /* the result remains usable without a model preview */ } }
          }
          if (!labels.length) throw new Error(finishedImageStatus(working).error || '没有取得图片');
          setRunPhase(conversationId, 'thinking');
          armTimeout();
          const results = messageGeneratedImages(working);
          return { label: labels.join('、'), preview: previews[0], previews, partial: results.some((image) => image.status === 'error'),
            slotMapping: generatedImageSlotMapping(results, (uri) => [...labeled.values()].find((image) => image.uri === uri)?.label) };
        };
        // Chat space: the character's persona, memory box and recent turns; assistant space: tools and agents.
        const character = options.characterId ? (await loadCharacters()).find((item) => item.id === options.characterId) ?? null : null;
        let toolkit: Awaited<ReturnType<typeof createToolbox>>['toolkit'];
        let instructions: string[];
        let persona: string | undefined;
        let modelHistory = history;
        let summaryNote: string | null = null;
        if (!character) {
          // Endless conversations: raw turns sized to this model, older ones carried by the rolling summary.
          summaryModel = { baseUrl: chat.baseUrl, apiKey, model, api: chat.chatApi };
          const budget = historyBudget(model);
          let summary = await loadConversationSummary(conversationId);
          let fit = fitHistory(history, summary, budget);
          if (fit.dropped > 0) {
            // A smaller model than before (or a very long backlog): catch the summary up first, briefly.
            setRunPhase(conversationId, 'thinking');
            summary = await Promise.race([
              compactConversation(conversationId, summaryModel, { force: true, signal: controller.signal, maxChunks: 4 }).catch(() => summary),
              new Promise<typeof summary>((resolve) => setTimeout(() => resolve(summary), 45_000)),
            ]) ?? summary;
            if (controller.signal.aborted) throw new Error('已停止');
            fit = fitHistory(history, summary, budget);
          }
          modelHistory = fit.history;
          summaryNote = summaryInstruction(summary, fit.dropped);
        }
        if (character) {
          const boxSettings = await loadMemoryBoxSettings();
          const embedder = embeddingProvider(providers, boxSettings, chat);
          const lastReply = [...history].reverse().find((item) => item.role === 'assistant' && item.text);
          const query = `${userMessage.prompt}\n${lastReply?.text?.slice(0, 300) ?? ''}`;
          const [box, recent, queryVectors] = await Promise.all([
            boxSettings.enabled ? loadBox(character.id) : Promise.resolve({ notes: [], links: [] }),
            // Newest turns first (summaries may lag behind; then only the most recent raw turns matter).
            listRecentMessages(conversationId, 80, userMessage.createdAt),
            boxSettings.enabled && character.memoryMode !== 'off' ? embedTexts(embedder, embeddingModelOf(embedder), [query], controller.signal) : Promise.resolve(null),
          ]);
          const context = buildCompanionContext({
            character: boxSettings.enabled ? character : { ...character, coreMemory: '' }, notes: box.notes, links: box.links, query,
            queryEmbedding: queryVectors?.[0], embeddingModel: embeddingModelOf(embedder),
            recent: recent.filter((item) => item.id !== userMessage.id && item.id !== assistant.id), memoryOn: boxSettings.enabled && character.memoryMode !== 'off',
          });
          if (!boxSettings.enabled) context.history = recent.filter((item) => item.id !== userMessage.id && item.id !== assistant.id);
          modelHistory = fitHistory(context.history, null, historyBudget(model)).history;
          persona = personaPrompt(character);
          const companion = await createCompanionToolbox({
            character, conversationId, api: chat.chatApi ?? 'chat-completions', baseUrl: chat.baseUrl, settings, boxSettings,
            imageAvailable: Boolean(image), voice, embeddings: embedder, drawImage: drawForTool, updateTrace,
          });
          toolkit = companion.toolkit;
          instructions = [...context.instructions, ...companion.instructions];
          if (context.recalled.length) {
            working = { ...working, agent: { ...(working.agent ?? emptyTrace()), recalled: context.recalled } };
            void touchNotes(character.id, context.recalled.map((item) => item.id)).catch(() => undefined);
          }
        } else {
          const assistantBox = await createToolbox({
            api: chat.chatApi ?? 'chat-completions', baseUrl: chat.baseUrl, settings, conversationId,
            imageAvailable: Boolean(image), voice, research: Boolean(options.research), agent, memories,
            drawImage: drawForTool, updateTrace,
          });
          toolkit = assistantBox.toolkit;
          instructions = summaryNote ? [...assistantBox.instructions, summaryNote] : assistantBox.instructions;
          // Read-only: what the user told their chat characters about themselves.
          const boxSettings = await loadMemoryBoxSettings().catch(() => null);
          if (boxSettings?.enabled && boxSettings.shareWithAssistant && (!agent || agent.capabilities.includes('memory'))) {
            const facts = await listAboutUserNotes().catch(() => []);
            const hits = retrieve(facts, [], { query: userMessage.prompt, limit: 6 });
            if (hits.length) instructions = [...instructions, `用户在聊天空间里提到过的关于自己的事（只读参考，可能过时，不要提及来源）：\n${hits.map((hit) => `- ${hit.note.title}：${hit.note.content}`).join('\n')}`];
          }
        }
        labeled = new Map(labelConversationImages(modelHistory, userMessage.references).map((item) => [item.label, item]));
        nextLabel = labeled.size + 1;
        const showText = (text: string) => {
          if (controller.signal.aborted || working.status !== 'pending') return;
          // Text normally only grows; it shrinks when a hidden marker or a
          // pre-tool remark is removed, and then never shows more than the new text.
          if (!(text.length >= target.length && text.startsWith(target))) {
            let common = 0;
            const limit = Math.min(shown, text.length);
            while (common < limit && text.charCodeAt(common) === target.charCodeAt(common)) common += 1;
            shown = common;
            if (!text) { working = { ...working, text: null }; void commit(working, false); }
          }
          target = text;
          if (!text) return;
          setRunPhase(conversationId, 'writing');
          if (!ticker) { tick(); ticker = setInterval(tick, 40); }
        };
        let result: Awaited<ReturnType<typeof runAgentTurn>>;
        try {
          result = await runAgentTurn({
            baseUrl: chat.baseUrl, apiKey, model, api: chat.chatApi,
            history: modelHistory, prompt: userMessage.prompt, references: userMessage.references, documents: userMessage.documents,
            signal: controller.signal,
            toolMode: toolkit.specs.length || toolkit.nativeSearch ? 'native' : 'none', imageAvailable: Boolean(image), imageDefaults: describeImageDefaults(image), imagePrompt: settings.imagePrompt, voice,
            toolkit, extraInstructions: instructions, suggestions: settings.suggestions && !voice && !character, persona,
          }, showText);
          // Let the typewriter finish the last few words instead of jumping.
          target = result.text;
          const drainUntil = Date.now() + 450;
          while (ticker && shown < target.length && Date.now() < drainUntil && !controller.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
        } finally {
          stopTicker();
        }
        const trace = working.agent ?? emptyTrace();
        const finished: AgentTrace = { ...trace, ...(result.suggestions?.length && settings.suggestions && !voice && !character ? { suggestions: result.suggestions } : {}) };
        working = { ...working, text: result.text || null, agent: hasTraceContent(finished) || finished.research || finished.agentName ? finished : null };
        // A model that only returns the call (no toolkit execution) is still drawn.
        if (result.imageCall && image && !working.imageUri && !working.preparedPrompt) {
          working = await prepareImageJob(working, result.imageCall, result.images, userMessage, image);
          working = { ...working, status: 'pending' };
          await commit(working);
          armTimeout();
          const drawn = await drawImage(working, controller.signal, checkpointImages);
          working = withImageResults(working, messageGeneratedImages(drawn));
        }
        if (!working.text && !working.imageUri && !working.agent?.files?.length && !working.agent?.actions?.length) {
          working = { ...working, text: '这一轮没有得到文字回答。可以点“重新生成”再试一次。' };
        }
      } else {
        await commit(working);
        const drawn = await drawImage(working, controller.signal, checkpointImages);
        working = withImageResults(working, messageGeneratedImages(drawn));
        // A retried drawing inside an agent turn: its failed step is now done.
        if (working.agent && working.imageUri) {
          const partial = messageGeneratedImages(working).some((image) => image.status === 'error');
          working = { ...working, agent: { ...working.agent, steps: working.agent.steps.map((step) => (step.kind === 'image' && step.status === 'error' ? { ...step, status: 'done' as const, error: undefined, detail: partial ? '部分图片已取得' : '已生成' } : step)) } };
        }
      }
      working = { ...working, ...finishedImageStatus(working), elapsedMs: Date.now() - startedAt };
      await commit(working);
      // Fold old turns into the rolling summary in the background (rarely needs a call).
      if (summaryModel) void compactConversation(conversationId, summaryModel).catch(() => undefined);
    } catch (error) {
      const cancelled = controller.signal.aborted && !timedOut;
      const imageJob = Boolean(working.preparedPrompt) && (working.mode === 'generate' || working.mode === 'edit') && !working.imageUri;
      const message = timedOut
        ? imageJob
          ? '等待超过 10 分钟，已停止等待。图片可能仍在服务商处生成，请先查看服务商记录再重新绘制，以免重复扣费'
          : '等待超过 10 分钟，已停止等待，请稍后重试'
        : withStagePrefix(normalizeError(error).message, error);
      if (replacedImages && !working.imageUri && mode === 'agent' && !(error instanceof RemoteImageDownloadError)) {
        // A redraw that was stopped or failed: the turn keeps the picture it already had.
        // The async tool callback populates this snapshot; control-flow analysis cannot see that assignment.
        const kept = replacedImages as GeneratedImage[];
        const previous = working.agent ?? emptyTrace();
        const drafts = previous.drafts ?? [];
        const keptUris = new Set(kept.map((image) => image.uri));
        const now = Date.now();
        working = {
          ...withImageResults(working, kept), remoteImageUrl: null, status: 'complete', error: null, elapsedMs: now - startedAt,
          agent: {
            ...previous, drafts: drafts.filter((uri) => !keptUris.has(uri)),
            steps: [...previous.steps.map((step) => (step.status === 'running' ? { ...step, status: 'error' as const, error: cancelled ? '已停止' : '未完成', endedAt: now } : step)),
              { id: createId(), kind: 'image' as const, title: cancelled ? '已停止重画，保留了之前的图片' : '重画没有完成，保留了之前的图片', status: 'error' as const, error: cancelled ? '已停止' : message, startedAt: now, endedAt: now }],
          },
        };
        await commit(working);
        return;
      }
      const trace = working.agent;
      if (working.imageUri) {
        // The picture was already delivered; a failure in the follow-up (e.g. self-check) must not
        // turn it into an error whose retry would pay for the image again.
        working = {
          ...working, generatedImages: messageGeneratedImages(working).map((image) => image.status === 'pending'
            ? { ...image, status: 'error' as const, error: cancelled ? '已停止' : message } : image), status: 'complete', error: null, elapsedMs: Date.now() - startedAt,
          agent: trace ? { ...trace, steps: [...trace.steps.map((step) => (step.status === 'running' ? { ...step, status: 'error' as const, error: '未完成', endedAt: Date.now() } : step)),
            { id: createId(), kind: 'check' as const, title: cancelled ? '已停止后续处理，图片已保留' : '画完后的检查没有完成，图片已保留', status: 'error' as const, error: cancelled ? '已停止' : message, startedAt: Date.now(), endedAt: Date.now() }] } : trace,
        };
        await commit(working);
        return;
      }
      working = {
        ...working,
        generatedImages: messageGeneratedImages(working).map((image) => image.status === 'pending'
          ? { ...image, status: 'error' as const, error: cancelled ? '已停止' : message } : image),
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? '已停止' : message,
        remoteImageUrl: error instanceof RemoteImageDownloadError ? error.remoteImageUrl : working.remoteImageUrl,
        elapsedMs: Date.now() - startedAt,
        ...(trace ? { agent: { ...trace, steps: trace.steps.map((step) => (step.status === 'running' ? { ...step, status: 'error' as const, error: cancelled ? '已停止' : '未完成', endedAt: Date.now() } : step)) } } : {}),
      };
      await commit(working);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }, [commit, drawImage, chatProvider, imageProvider, prepareImageJob, providers, setRunPhase]);

  /** The chat model a turn uses now: the agent's / character's own choice, else the one selected in the app. */
  const chatFor = useCallback((preferred: { providerId?: string | null; model?: string | null } | null) => {
    const own = preferred?.providerId ? providers.find((item) => item.id === preferred.providerId && (preferred.model || item.chatModel)) ?? null : null;
    return { chat: own ?? chatProvider, chatModel: own ? (preferred?.model || own.chatModel) : chatProvider?.chatModel };
  }, [chatProvider, providers]);

  const send = useCallback(async ({ text, images = [], documents = [], maskUri = null, voice = false, research = false }: SendInput) => {
    const prompt = text.trim();
    if (!prompt && !images.length && !documents.length) throw new Error('请输入内容，或添加图片 / 文件');
    if (!chatProvider && !imageProvider) throw new Error('还没有添加 API，请先在“设置 → API 管理”里添加');
    const activeId = activeIdRef.current;
    // The chat space writes only into the open character's thread; it must never start (or append to) an assistant chat.
    if (spaceRef.current === 'companion' && (!activeId || !activeCharacterRef.current)) throw new Error('还没有打开聊天伙伴的对话，请返回列表重新进入后再发');
    if (activeId && runsRef.current.has(activeId)) throw new Error('请先等待或停止当前回复');
    if (!chatProvider && documents.length) throw new Error('阅读文件需要对话模型，请在设置中添加对话服务商');
    if (!chatProvider && !prompt) throw new Error('请描述想要的图片');
    validateAttachments(documents, images);
    const now = Date.now();
    const owner = (chatProvider ?? imageProvider)!;
    const isDraft = !activeId;
    const conversationId = activeId ?? createId();
    const history = isDraft ? [] : messagesRef.current;
    const draftAgent = isDraft ? draftAgentRef.current : null;
    // Claim the slot before any await; a draft becomes this conversation right away.
    const run = beginRun(conversationId);
    if (isDraft) { setActiveConversationId(conversationId); activeIdRef.current = conversationId; }
    try {
      let agentId: string | null = draftAgent;
      let characterId: string | null = null;
      if (isDraft) {
        const conversation: Conversation = {
          id: conversationId,
          title: createConversationTitle(prompt || documents[0]?.name || '图片对话'),
          providerId: owner.id, transparent: false, mode: 'auto', agentId: draftAgent, createdAt: now, updatedAt: now,
        };
        await insertConversation(conversation);
        setDraftAgentId(null);
        draftAgentRef.current = null;
      } else {
        const existing = (await listConversations()).find((item) => item.id === conversationId);
        agentId = existing?.agentId ?? null;
        characterId = existing?.kind === 'companion' ? existing.characterId ?? null : null;
        if (existing) await updateConversation({ ...existing, updatedAt: now });
      }
      await refreshConversations();
      const turnHistory = isDraft ? history : (await fullHistory(conversationId)) ?? history;
      // A custom agent or a chat character may prefer its own chat provider and model.
      const agent = agentId ? (await loadAgents().catch(() => [])).find((item) => item.id === agentId) ?? null : null;
      const character = characterId ? (await loadCharacters().catch(() => [])).find((item) => item.id === characterId) ?? null : null;
      // The chat space uses the same model as the assistant; only a custom agent may bring its own.
      const { chat, chatModel } = chatFor(agent);
      if (character) void updateCharacter(character.id, { lastMessageAt: now }).catch(() => undefined);

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
        model: chatModel ?? '', references: [], documents: [], maskUri: null, text: null,
        analysisProviderId: chat?.id ?? null, analysisModel: chatModel ?? null,
        analysisApi: chat?.chatApi, requestApi: chat?.chatApi, createdAt: now + 1,
        ...(research && chatProvider ? { agent: { ...emptyTrace(), research: true } } : {}),
      };
      let mode: 'agent' | 'image-only' = 'agent';
      if (!chatProvider) {
        // Image-only setup: every message is a drawing request.
        mode = 'image-only';
        assistant = await prepareImageJob(assistant, { prompt, count: imageCountFromPrompt(prompt), referenceImages: images.map((_, index) => `图${index + 1}`), aspectRatio: null, transparent: /透明/.test(prompt) },
          new Map(images.map((image, index) => [`图${index + 1}`, { ...image, label: `图${index + 1}` }])), userMessage, imageProvider!);
        assistant = { ...assistant, status: 'pending' };
      }
      await insertMessage(userMessage);
      await insertMessage(assistant);
      liveRef.current.set(assistant.id, assistant);
      if (activeIdRef.current === conversationId) {
        setMessages((current) => { const next = [...current, userMessage, assistant]; messagesRef.current = next; return next; });
      }
      await runTurn(run, assistant, userMessage, turnHistory, mode, { voice, research, agentId, characterId });
      if (characterId) void scheduleMemoryWork(characterId).catch(() => undefined);
    } finally {
      endRun(conversationId, run);
    }
  }, [chatProvider, imageProvider, providers, beginRun, endRun, fullHistory, prepareImageJob, refreshConversations, runTurn]);

  const recordVoiceExchange = useCallback(async (userText: string, assistantText: string) => {
    const prompt = userText.trim();
    const reply = assistantText.trim();
    if (!prompt && !reply) return;
    const owner = chatProvider ?? imageProvider;
    if (!owner) return;
    // A character's voice chat belongs in its thread; never start an assistant conversation for it.
    if (spaceRef.current === 'companion' && (!activeIdRef.current || !activeCharacterRef.current)) return;
    const now = Date.now();
    let conversationId = activeIdRef.current;
    if (!conversationId) {
      conversationId = createId();
      await insertConversation({
        id: conversationId, title: createConversationTitle(prompt || '语音对话'), providerId: owner.id,
        transparent: false, mode: 'auto', agentId: draftAgentRef.current, createdAt: now, updatedAt: now,
      });
      setDraftAgentId(null);
      draftAgentRef.current = null;
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
    const characterId = activeCharacterRef.current;
    if (characterId) void scheduleMemoryWork(characterId).catch(() => undefined);
  }, [chatFor, chatProvider, imageProvider, refreshConversations]);

  const retry = useCallback(async (message: ChatMessage) => {
    const all = messagesRef.current;
    const index = all.findIndex((item) => item.id === message.id);
    const userMessage = all[index - 1];
    if (index < 1 || userMessage?.role !== 'user') throw new Error('找不到这条回复对应的提问');
    const conversationId = message.conversationId;
    const run = beginRun(conversationId);
    try {
      // A drawing that never arrived is repeated as-is (no new conversation step, no double charge).
      // An image that exists is regenerated with a fresh turn; image-only setups simply redraw.
      const savedJob = Boolean(message.preparedPrompt && (message.mode === 'generate' || message.mode === 'edit'));
      const acceptedTask = savedJob ? await getSetting(`image_task:${message.id}`) : null;
      const imageJob = savedJob && (Boolean(acceptedTask) || !message.imageUri || !message.analysisProviderId || !chatProvider);
      const conversation = (await listConversations()).find((item) => item.id === conversationId);
      const research = Boolean(message.agent?.research);
      const characterId = conversation?.kind === 'companion' ? conversation.characterId ?? null : null;
      // Regenerating answers with the model selected now (the user may have switched since).
      let current: { chat: ProviderProfile | null; chatModel?: string | null } | null = null;
      if (!imageJob) {
        const agent = conversation?.agentId ? (await loadAgents().catch(() => [])).find((item) => item.id === conversation.agentId) ?? null : null;
        current = chatFor(agent);
      }
      const retainedImages = imageJob && (acceptedTask || (message.status !== 'complete' && message.generatedImages?.some((image) => image.uri || image.remoteUrl)))
        ? messageGeneratedImages(message) : [];
      const reset: ChatMessage = {
        ...message, status: 'pending', error: null, imageUri: null, elapsedMs: null,
        generatedImages: acceptedTask
          ? retainedImages.map((image) => image.uri ? image : { ...image, status: 'pending' as const, error: null })
          : retainedImages,
        ...(imageJob ? {} : {
          ...(current?.chat && current.chatModel ? { analysisProviderId: current.chat.id, analysisModel: current.chatModel, model: current.chatModel, analysisApi: current.chat.chatApi, requestApi: current.chat.chatApi } : {}),
          text: null, agent: research ? { ...emptyTrace(), research: true } : null,
          mode: 'chat' as const, preparedPrompt: null, references: [], maskUri: null, remoteImageUrl: null, imageCount: 1,
        }),
      };
      await commit(reset);
      // A saved image job is repeated as-is: no second charge for the conversation step.
      const earlier = (await fullHistory(conversationId, userMessage.createdAt)) ?? all.slice(0, index - 1);
      await runTurn(run, reset, userMessage, earlier, imageJob ? 'image-retry' : 'agent', { research, agentId: conversation?.agentId ?? null, characterId });
      if (characterId) void scheduleMemoryWork(characterId).catch(() => undefined);
      // A regenerated result replaces the old one: delete files nothing refers to any more.
      const latest = liveRef.current.get(message.id) ?? messagesRef.current.find((item) => item.id === message.id);
      // A failed or stopped regenerate must not throw away the answer that was there.
      const hadAnswer = message.status === 'complete' && Boolean(message.text || message.imageUri || message.agent?.files?.length);
      if (latest && latest.status !== 'complete' && latest.status !== 'pending' && hadAnswer) {
        await commit(message);
        if (latest.status === 'error') throw new Error(`重新生成没有成功（${latest.error ?? '未知错误'}），已保留原来的回答`);
        return;
      }
      if (latest && latest.status === 'complete') {
        const keep = new Set([latest.imageUri, ...messageGeneratedImages(latest).map((image) => image.uri), latest.maskUri, ...latest.references.map((item) => item.uri), ...userMessage.references.map((item) => item.uri), userMessage.maskUri, ...traceFileUris(latest.agent)]);
        const previous = [...new Set([message.imageUri, ...messageGeneratedImages(message).map((image) => image.uri), ...message.references.map((item) => item.uri), ...traceFileUris(message.agent)])];
        previous.forEach((uri) => { if (uri && !keep.has(uri)) { deleteGeneratedFile(uri); deleteLocalFile(uri); } });
      }
    } finally {
      endRun(conversationId, run);
    }
  }, [beginRun, chatFor, chatProvider, commit, endRun, fullHistory, runTurn]);

  /** Retry exactly one already-paid artifact; never submit a new generation. */
  const retryImage = useCallback(async (message: ChatMessage, imageId: string, failedUri?: string) => {
    const run = beginRun(message.conversationId);
    try {
      const stored = (await listMessages(message.conversationId)).find((item) => item.id === message.id && item.role === 'assistant');
      if (!stored) throw new Error('这条图片消息已不存在');
      let working = liveRef.current.get(message.id) ?? stored;
      const images = messageGeneratedImages(working);
      const selected = images.find((image) => image.id === imageId);
      if (!selected?.remoteUrl || (selected.uri && selected.uri !== failedUri)) throw new Error('这张图片没有可重新下载的地址');
      const unreadableUri = selected.uri;
      const url = selected.remoteUrl;
      setRunPhase(message.conversationId, 'downloading');
      const replace = async (patch: Partial<GeneratedImage>, terminal = false) => {
        working = withImageResults(working, messageGeneratedImages(working).map((image) => image.id === imageId ? { ...image, ...patch } : image));
        working = { ...working, ...(terminal ? finishedImageStatus(working) : { status: 'pending' as const, error: null }) };
        await commit(working);
      };
      await replace({ status: 'pending', error: null });
      let uri: string;
      try { uri = await downloadPng(url, run.controller.signal); }
      catch (error) {
        await replace({ uri: null, status: 'error', error: run.controller.signal.aborted ? '图片下载已停止' : normalizeError(error).message }, true);
        if (unreadableUri) deleteLocalFile(unreadableUri);
        return;
      }
      await replace({ uri, remoteUrl: null, status: 'complete', error: null }, true);
      if (unreadableUri && unreadableUri !== uri) deleteLocalFile(unreadableUri);
    } finally { endRun(message.conversationId, run); }
  }, [beginRun, commit, endRun, setRunPhase]);

  /** Files that belonged to removed messages, except ones still in use (`keep`). */

  /** Removed turns that a rolling summary or a character's memory already took in are forgotten there too. */
  const forgetRemoved = useCallback(async (conversationId: string, since: number) => {
    const summary = await loadConversationSummary(conversationId).catch(() => null);
    if (summary && summary.until >= since) await deleteConversationSummary(conversationId).catch(() => undefined);
    const conversation = (await listConversations()).find((item) => item.id === conversationId);
    if (conversation?.kind === 'companion' && conversation.characterId) await forgetTurnsFrom(conversation.characterId, conversationId, since).catch(() => undefined);
  }, []);

  const editAndResend = useCallback(async (messageId: string, input: SendInput) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) throw new Error('这条消息已不在当前对话里');
    if (runsRef.current.has(conversationId)) throw new Error('请先等待或停止当前回复');
    const target = messagesRef.current.find((item) => item.id === messageId);
    if (!target || target.role !== 'user') throw new Error('只能编辑自己发出的消息');
    if (!input.text.trim() && !input.images?.length && !input.documents?.length) throw new Error('请输入内容，或添加图片 / 文件');
    if (!chatProvider && !imageProvider) throw new Error('还没有添加 API，请先在“设置 → API 管理”里添加');
    // The edited message and every turn after it go; the new message then sees exactly the history before it.
    const removed = await deleteMessagesFrom(conversationId, target.createdAt);
    removed.forEach((item) => { liveRef.current.delete(item.id); latestCommit.current.delete(item.id); });
    if (activeIdRef.current === conversationId) {
      const kept = messagesRef.current.filter((item) => item.createdAt < target.createdAt);
      setMessages(kept); messagesRef.current = kept;
    }
    await forgetRemoved(conversationId, target.createdAt);
    // Attachments carried over into the edited message stay; everything else of the removed turns is deleted.
    const keep = new Set<string | null | undefined>([...(input.images ?? []).map((item) => item.uri), ...(input.documents ?? []).map((item) => item.uri), input.maskUri]);
    try { await send(input); } finally { await deleteMessageFiles(removed, keep); }
  }, [chatProvider, imageProvider, forgetRemoved, send]);

  const deleteMessage = useCallback(async (messageId: string) => {
    const conversationId = activeIdRef.current;
    if (!conversationId) return;
    if (restoringBackup.current) throw new Error('正在恢复备份');
    if (messageMutations.current.has(conversationId)) throw new Error('这条对话的消息正在更新');
    // The run is claimed before its first database read; the visible message
    // may still look complete while a per-image retry is starting.
    if (runsRef.current.has(conversationId)) throw new Error('当前回复还在进行中，暂时不能删除消息');
    const all = messagesRef.current;
    const index = all.findIndex((item) => item.id === messageId);
    if (index < 0) return;
    const target = all[index];
    // A question goes together with its answer, so the model never sees an answer without its question.
    const answer = target.role === 'user' && all[index + 1]?.role === 'assistant' ? all[index + 1] : null;
    messageMutations.current.add(conversationId);
    try {
    const removed = await deleteMessageRecords(conversationId, [target.id, ...(answer ? [answer.id] : [])]);
    removed.forEach((item) => { liveRef.current.delete(item.id); latestCommit.current.delete(item.id); });
    const gone = new Set(removed.map((item) => item.id));
    if (activeIdRef.current === conversationId) {
      const kept = messagesRef.current.filter((item) => !gone.has(item.id));
      setMessages(kept); messagesRef.current = kept;
    }
    await forgetRemoved(conversationId, target.createdAt);
    await deleteMessageFiles(removed);
    } finally { messageMutations.current.delete(conversationId); }
  }, [forgetRemoved]);

  /** Changes one phone action card on a finished message. */
  const updateAction = useCallback(async (message: ChatMessage, actionId: string, patch: Partial<PhoneAction>) => {
    const latest = liveRef.current.get(message.id) ?? messagesRef.current.find((item) => item.id === message.id) ?? message;
    const trace = latest.agent;
    if (!trace?.actions?.some((action) => action.id === actionId)) return;
    await commit({ ...latest, agent: { ...trace, actions: trace.actions.map((action) => (action.id === actionId ? { ...action, ...patch } : action)) } });
  }, [commit]);

  const actionsInFlight = useRef(new Set<string>());
  const runAction = useCallback(async (message: ChatMessage, actionId: string) => {
    const latest = liveRef.current.get(message.id) ?? messagesRef.current.find((item) => item.id === message.id) ?? message;
    if (latest.status === 'pending') throw new Error('请等这条回复完成后再操作');
    const action = latest.agent?.actions?.find((item) => item.id === actionId);
    if (!action) throw new Error('这个操作已不存在');
    // A double tap must not set two alarms.
    if (action.status === 'done' || actionsInFlight.current.has(actionId)) return;
    actionsInFlight.current.add(actionId);
    try {
      await runPhoneAction(action);
      await updateAction(latest, actionId, { status: 'done', error: undefined });
    } catch (error) {
      const text = error instanceof Error ? error.message : '操作没有完成';
      await updateAction(latest, actionId, { status: 'failed', error: text });
      throw error instanceof Error ? error : new Error(text);
    } finally {
      actionsInFlight.current.delete(actionId);
    }
  }, [updateAction]);

  const dismissAction = useCallback(async (message: ChatMessage, actionId: string) => {
    const latest = liveRef.current.get(message.id) ?? messagesRef.current.find((item) => item.id === message.id) ?? message;
    if (latest.status === 'pending' || actionsInFlight.current.has(actionId)) return;
    await updateAction(latest, actionId, { status: 'dismissed' });
  }, [updateAction]);

  /** Stops the reply in the open conversation only. */
  const stop = useCallback(() => {
    const id = activeIdRef.current;
    if (id) runsRef.current.get(id)?.controller.abort();
  }, []);

  const value = useMemo<AppContextValue>(() => ({
    ready, providers, chatProvider, imageProvider, conversations, activeConversationId, activeConversation, messages,
    busy, anyBusy, runningConversationIds, phase, activeAgentId, reloadProviders, selectChatProvider, selectImageProvider, updateProvider, removeProvider,
    newChat, openConversation, openMessage, jumpRequest, restoreBackup, deleteConversation, renameConversation, send, stop, retry, retryImage, editAndResend, deleteMessage, recordVoiceExchange, runAction, dismissAction,
    space, switchSpace, activeCharacterId, openCharacter, closeCharacter, createCharacter, editCharacter, deleteCharacter, hasOlderMessages, loadOlderMessages,
  }), [ready, providers, chatProvider, imageProvider, conversations, activeConversationId, activeConversation, messages,
    busy, anyBusy, runningConversationIds, phase, activeAgentId, reloadProviders, selectChatProvider, selectImageProvider, updateProvider, removeProvider,
    newChat, openConversation, openMessage, jumpRequest, restoreBackup, deleteConversation, renameConversation, send, stop, retry, retryImage, editAndResend, deleteMessage, recordVoiceExchange, runAction, dismissAction,
    space, switchSpace, activeCharacterId, openCharacter, closeCharacter, createCharacter, editCharacter, deleteCharacter, hasOlderMessages, loadOlderMessages]);

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
