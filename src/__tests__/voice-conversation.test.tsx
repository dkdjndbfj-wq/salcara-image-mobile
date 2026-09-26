import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { ChatMessage, Conversation, ProviderProfile } from '../domain';

let mockMessages: ChatMessage[] = [];
let mockConversations: Conversation[] = [];
const mockAgent = jest.fn();

jest.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `vc-${++next}` }; });
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('../api/chat-api', () => ({ runAgentTurn: (...args: unknown[]) => mockAgent(...args), VOICE_INSTRUCTIONS: '语音' }));
jest.mock('../api/image-api', () => ({ generateImage: jest.fn(), editImage: jest.fn(), normalizeError: (error: unknown) => error }));
jest.mock('../document-inputs', () => ({ validateAttachments: () => undefined }));
jest.mock('../image-inputs', () => ({ createReferenceFromGenerated: jest.fn() }));
jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: async () => undefined, deactivateKeepAwake: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => 'key', deleteProviderKey: async () => undefined }));
jest.mock('../storage/files', () => ({ downloadPng: jest.fn(), deleteLocalFile: () => undefined, RemoteImageDownloadError: class extends Error {} }));
jest.mock('../voice/models', () => ({ refreshModels: async () => undefined, isInstalled: () => true, modelDirectory: () => 'file:///models/p/' }));
jest.mock('../voice/settings', () => {
  const settings = {
    inputEngine: 'local', localModel: 'paraformer-bilingual', transcribeProviderId: null, transcribeModel: 'm', mirror: 'hf-mirror',
    conversationEngine: 'cascade', realtimeProviderId: null, realtimeModel: 'r', realtimeVoice: 'marin',
    speechOutput: 'system', ttsProviderId: null, ttsModel: 't', ttsVoice: 'marin',
  };
  return { loadVoiceSettings: async () => settings, voiceSettings: () => settings };
});
jest.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
jest.mock('../voice/useDictation', () => ({
  ensureMicPermission: async () => undefined,
  joinText: (base: string, addition: string) => `${base}${addition}`,
}));
jest.mock('../storage/database', () => ({
  initializeDatabase: async () => undefined,
  deleteEmptyConversations: async () => undefined,
  getActiveProviderId: async () => null,
  getSetting: async () => null,
  setSetting: async () => undefined,
  listProviders: async () => [{ id: 'chat', name: '对话', baseUrl: 'https://api.example', model: null, quality: null, aspectRatio: null, resolutionTier: null, chatModel: 'claude-x', chatApi: 'anthropic', createdAt: 1, updatedAt: 1 }] as ProviderProfile[],
  upsertProvider: async () => undefined,
  deleteProviderRecord: async () => undefined,
  reassignConversations: async () => undefined,
  listConversations: async () => [...mockConversations],
  insertConversation: async (conversation: Conversation) => { mockConversations.push(conversation); },
  updateConversation: async () => undefined,
  deleteConversationRecord: async () => [],
  listMessages: async (id: string) => mockMessages.filter((item) => item.conversationId === id),
  insertMessage: async (message: ChatMessage) => { mockMessages.push(message); },
  updateMessage: async (message: ChatMessage) => { mockMessages = mockMessages.map((item) => item.id === message.id ? message : item); },
}));

import { AppProvider } from '../state/AppContext';
import { setVoiceNativeForTesting } from '../voice/native';
import { useVoiceConversation } from '../voice/useVoiceConversation';

type Listener = (payload: never) => void;
const listeners: Record<string, Set<Listener>> = {};
const emit = (name: string, payload: unknown) => listeners[name]?.forEach((listener) => (listener as (p: unknown) => void)(payload));
const spoken: Array<{ text: string; id: string }> = [];
const calls: string[] = [];
const fake = {
  engineAvailable: () => true,
  prepareRecognizer: jest.fn(async () => true),
  releaseRecognizer: () => undefined,
  startCapture: jest.fn(async () => true),
  stopCapture: async () => ({ uri: null }),
  cancelCapture: () => { calls.push('cancelCapture'); },
  setMuted: jest.fn(),
  playerStart: () => undefined, playerWrite: () => undefined, playerEnd: () => undefined,
  playerStop: () => { calls.push('playerStop'); }, playerRelease: () => undefined,
  speak: (text: string, id: string) => { spoken.push({ text, id }); },
  stopSpeaking: () => { calls.push('stopSpeaking'); },
  endConversationAudio: () => undefined,
  deleteFile: () => true,
  addListener: (name: string, listener: Listener) => { (listeners[name] ??= new Set()).add(listener); return { remove: () => listeners[name].delete(listener) }; },
};

let live: ReturnType<typeof useVoiceConversation>;
function Probe({ active }: { active: boolean }) { live = useVoiceConversation(active); return null; }

beforeEach(() => {
  mockMessages = []; mockConversations = []; spoken.length = 0; calls.length = 0;
  Object.keys(listeners).forEach((key) => delete listeners[key]);
  mockAgent.mockReset();
  setVoiceNativeForTesting(fake as never);
});
afterAll(() => setVoiceNativeForTesting(undefined));

test('cascade: speech → chat model (voice style) → spoken sentence by sentence → listening again', async () => {
  // The Claude-only setup still works: recognition is on-device, speech output is the phone's voice.
  mockAgent.mockImplementation(async (request: { voice?: boolean }, onText?: (text: string) => void) => {
    expect(request.voice).toBe(true);
    onText?.('好呀！周六去湖边骑车。');
    return { text: '好呀！周六去湖边骑车。晚上吃火锅。', imageCall: null, images: new Map(), toolMode: 'native' };
  });
  await render(<AppProvider><Probe active /></AppProvider>);
  await waitFor(() => expect(live.phase).toBe('listening'));
  expect(fake.startCapture).toHaveBeenCalledWith(expect.objectContaining({ conversation: true, turnDetection: true, useRecognizer: true, sampleRate: 16000 }));
  expect(live.engine).toBe('cascade');

  await act(async () => { emit('onSpeech', { speaking: true }); emit('onTranscript', { text: '帮我想个周末', isFinal: false }); });
  expect(live.phase).toBe('hearing');
  expect(live.userText).toBe('帮我想个周末');
  await act(async () => { emit('onTranscript', { text: '帮我想个周末计划', isFinal: true }); });
  await waitFor(() => expect(mockAgent).toHaveBeenCalledTimes(1));
  expect(mockAgent.mock.calls[0][0].prompt).toBe('帮我想个周末计划');

  await waitFor(() => expect(spoken.map((item) => item.text)).toEqual(['好呀！', '周六去湖边骑车。', '晚上吃火锅。']));
  expect(live.phase).toBe('speaking');
  await act(async () => { spoken.forEach(({ id }) => emit('onSpeakDone', { id })); });
  await waitFor(() => expect(live.phase).toBe('listening'));
  // The exchange lives in the normal conversation history.
  expect(mockMessages.map((item) => item.role)).toEqual(['user', 'assistant']);
});

test('speaking over the reply interrupts it immediately', async () => {
  let release: () => void = () => undefined;
  mockAgent.mockImplementation((_request: unknown, onText?: (text: string) => void) => new Promise((resolve) => {
    onText?.('第一句话。第二句');
    release = () => resolve({ text: '第一句话。第二句。', imageCall: null, images: new Map(), toolMode: 'native' });
  }));
  await render(<AppProvider><Probe active /></AppProvider>);
  await waitFor(() => expect(live.phase).toBe('listening'));
  await act(async () => { emit('onTranscript', { text: '讲个故事', isFinal: true }); });
  await waitFor(() => expect(spoken).toHaveLength(1));
  expect(live.phase).toBe('speaking');
  await act(async () => { emit('onSpeech', { speaking: true }); });
  expect(live.phase).toBe('hearing');
  expect(calls).toEqual(expect.arrayContaining(['playerStop', 'stopSpeaking']));
  await act(async () => { release(); });
});

test('closing the session releases the microphone and audio', async () => {
  const view = await render(<AppProvider><Probe active /></AppProvider>);
  await waitFor(() => expect(live.phase).toBe('listening'));
  await act(async () => { view.rerender(<AppProvider><Probe active={false} /></AppProvider>); });
  expect(calls).toEqual(expect.arrayContaining(['cancelCapture', 'playerStop', 'stopSpeaking']));
});

test('closing Live while it is still connecting never opens the microphone', async () => {
  let loaded: () => void = () => undefined;
  fake.prepareRecognizer.mockImplementationOnce(() => new Promise<boolean>((resolve) => { loaded = () => resolve(true); }));
  fake.startCapture.mockClear();
  const view = await render(<AppProvider><Probe active /></AppProvider>);
  await waitFor(() => expect(fake.prepareRecognizer).toHaveBeenCalled());
  await act(async () => { view.rerender(<AppProvider><Probe active={false} /></AppProvider>); });
  await act(async () => { loaded(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(fake.startCapture).not.toHaveBeenCalled();
  expect(Object.values(listeners).every((set) => set.size === 0)).toBe(true);
});

test('returns to listening even when the voice finishes before the reply is marked final', async () => {
  let release: () => void = () => undefined;
  mockAgent.mockImplementation((_request: unknown, onText?: (text: string) => void) => new Promise((resolve) => {
    onText?.('好的。');
    release = () => resolve({ text: '好的。', imageCall: null, images: new Map(), toolMode: 'native' });
  }));
  await render(<AppProvider><Probe active /></AppProvider>);
  await waitFor(() => expect(live.phase).toBe('listening'));
  await act(async () => { emit('onTranscript', { text: '在吗', isFinal: true }); });
  await waitFor(() => expect(spoken).toHaveLength(1));
  // The phone finishes speaking first…
  await act(async () => { emit('onSpeakDone', { id: spoken[0].id }); });
  expect(live.phase).toBe('speaking');
  // …then the reply completes with nothing new to say.
  await act(async () => { release(); });
  await waitFor(() => expect(live.phase).toBe('listening'));
});
