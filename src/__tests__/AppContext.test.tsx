import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { ChatMessage, Conversation, ProviderProfile, ReferenceImage } from '../domain';

let mockProviders: ProviderProfile[] = [];
let mockConversations: Conversation[] = [];
let mockMessages: ChatMessage[] = [];
let mockSettings: Record<string, string> = {};
const mockOrder: string[] = [];
const mockAgent = jest.fn();
const mockGenerate = jest.fn();
const mockEdit = jest.fn();
const mockDownload = jest.fn();
const mockCopyGenerated = jest.fn();
const mockInsertConversation = jest.fn();
const mockDeleteEmpty = jest.fn();

jest.mock('../api/chat-api', () => ({ runAgentTurn: (...args: unknown[]) => mockAgent(...args) }));
jest.mock('../api/image-api', () => ({
  generateImage: (...args: unknown[]) => mockGenerate(...args),
  editImage: (...args: unknown[]) => mockEdit(...args),
  normalizeError: (error: unknown) => error instanceof Error ? error : new Error('请求失败'),
}));
jest.mock('../document-inputs', () => ({ validateAttachments: () => undefined }));
jest.mock('../image-inputs', () => ({ createReferenceFromGenerated: (...args: unknown[]) => mockCopyGenerated(...args) }));
jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: async () => undefined, deactivateKeepAwake: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => 'key', deleteProviderKey: async () => undefined }));
jest.mock('../storage/files', () => ({
  downloadPng: (...args: unknown[]) => mockDownload(...args),
  deleteLocalFile: () => undefined,
  RemoteImageDownloadError: class extends Error {
    remoteImageUrl: string;
    constructor(url: string) { super('图片下载失败'); this.remoteImageUrl = url; }
  },
}));
jest.mock('../storage/database', () => ({
  initializeDatabase: async () => undefined,
  deleteEmptyConversations: async () => { mockDeleteEmpty(); },
  getActiveProviderId: async () => null,
  getSetting: async (key: string) => mockSettings[key] ?? null,
  setSetting: async (key: string, value: string | null) => { if (value === null) delete mockSettings[key]; else mockSettings[key] = value; },
  listProviders: async () => [...mockProviders],
  upsertProvider: async (profile: ProviderProfile) => { mockProviders = mockProviders.map((item) => item.id === profile.id ? profile : item); },
  deleteProviderRecord: async (id: string) => { mockProviders = mockProviders.filter((item) => item.id !== id); },
  reassignConversations: async () => undefined,
  listConversations: async () => [...mockConversations].sort((a, b) => b.updatedAt - a.updatedAt),
  insertConversation: async (conversation: Conversation) => { mockInsertConversation(conversation); mockConversations.push(conversation); },
  updateConversation: async (conversation: Conversation) => { mockConversations = mockConversations.map((item) => item.id === conversation.id ? conversation : item); },
  deleteConversationRecord: async (id: string) => {
    const removed = mockMessages.filter((item) => item.conversationId === id);
    mockMessages = mockMessages.filter((item) => item.conversationId !== id);
    mockConversations = mockConversations.filter((item) => item.id !== id);
    return removed;
  },
  listMessages: async (id: string) => mockMessages.filter((item) => item.conversationId === id),
  insertMessage: async (message: ChatMessage) => { mockMessages.push(message); },
  updateMessage: async (message: ChatMessage) => {
    if (message.preparedPrompt && message.status === 'pending' && !message.imageUri) mockOrder.push('saved-image-job');
    mockMessages = mockMessages.map((item) => item.id === message.id ? message : item);
  },
}));

import { AppProvider, useApp } from '../state/AppContext';
import { RemoteImageDownloadError } from '../storage/files';

let app: ReturnType<typeof useApp>;
function Probe() { app = useApp(); return null; }
async function mount() {
  await render(<AppProvider><Probe /></AppProvider>);
  await waitFor(() => expect(app.ready).toBe(true));
}
const provider = (patch: Partial<ProviderProfile>): ProviderProfile => ({
  id: 'p', name: '服务', baseUrl: 'https://api.example', model: null, quality: null, aspectRatio: null, resolutionTier: null,
  chatModel: null, chatApi: 'chat-completions', createdAt: 1, updatedAt: 1, ...patch,
});
const chat = provider({ id: 'chat', name: '对话', chatModel: 'vision-model' });
const image = provider({ id: 'image', name: '绘图', model: 'gpt-image-2', quality: 'high', aspectRatio: '1:1', resolutionTier: '2K' });
const upload: ReferenceImage = { id: 'up', uri: 'file:///upload.png', name: 'upload.png', mimeType: 'image/png', size: 64 };
const images = (entries: Array<[string, string]>) => new Map(entries.map(([label, uri]) => [label, { label, uri, name: 'x.png', mimeType: 'image/png', size: 1 }]));

beforeEach(() => {
  mockProviders = [chat, image];
  mockConversations = [];
  mockMessages = [];
  mockSettings = {};
  mockOrder.length = 0;
  [mockAgent, mockGenerate, mockEdit, mockDownload, mockCopyGenerated, mockInsertConversation, mockDeleteEmpty].forEach((mock) => mock.mockReset());
  mockCopyGenerated.mockImplementation(async (uri: string) => ({ id: 'copy', uri: `${uri}.copy.png`, name: 'copy.png', mimeType: 'image/png', size: 1 }));
});

test('new chat is an unsaved draft: repeated taps never create empty conversations', async () => {
  await mount();
  expect(mockDeleteEmpty).toHaveBeenCalled();
  await act(async () => { app.newChat(); app.newChat(); app.newChat(); });
  expect(app.activeConversationId).toBeNull();
  expect(mockInsertConversation).not.toHaveBeenCalled();

  mockAgent.mockResolvedValue({ text: '你好！', imageCall: null, images: new Map(), toolMode: 'native' });
  await act(async () => { await app.send({ text: '你好' }); });
  expect(mockInsertConversation).toHaveBeenCalledTimes(1);
  expect(app.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  expect(app.messages[1]).toMatchObject({ status: 'complete', text: '你好！', imageUri: null });

  await act(async () => { app.newChat(); app.newChat(); });
  expect(app.activeConversationId).toBeNull();
  expect(app.messages).toEqual([]);
  expect(mockInsertConversation).toHaveBeenCalledTimes(1);
  expect(app.conversations).toHaveLength(1);
});

test('the chat model decides to draw; the tool call is saved before the paid image request', async () => {
  mockAgent.mockImplementation(async (_request: unknown, onText?: (text: string) => void) => {
    onText?.('好的，我来画。');
    return { text: '好的，我来画。', imageCall: { prompt: '竖版橘猫', referenceImages: [], aspectRatio: '9:16', transparent: true }, images: new Map(), toolMode: 'native' };
  });
  mockGenerate.mockImplementation(async () => { mockOrder.push('generate'); return 'file:///cat.png'; });
  await mount();
  await act(async () => { await app.send({ text: '画一只橘猫，竖版，透明背景' }); });
  const request = mockAgent.mock.calls[0][0];
  expect(request).toMatchObject({ model: 'vision-model', toolMode: 'native', imageAvailable: true, prompt: '画一只橘猫，竖版，透明背景' });
  expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-image-2', prompt: '竖版橘猫', size: '1152x2048', quality: 'high', transparent: true }));
  expect(mockOrder).toEqual(['saved-image-job', 'generate']);
  expect(app.messages[1]).toMatchObject({ status: 'complete', mode: 'generate', text: '好的，我来画。', imageUri: 'file:///cat.png', preparedPrompt: '竖版橘猫', analysisModel: 'vision-model', providerId: 'image' });
});

test('references resolve to the current upload (with mask) or a copy of an earlier generated image', async () => {
  mockAgent.mockResolvedValueOnce({ text: '', imageCall: { prompt: '换成夜景', referenceImages: ['图1'], aspectRatio: null, transparent: false }, images: images([['图1', upload.uri]]), toolMode: 'native' });
  mockEdit.mockResolvedValue('file:///night.png');
  await mount();
  await act(async () => { await app.send({ text: '把背景换成夜景', images: [upload], maskUri: 'file:///mask.png' }); });
  expect(mockEdit.mock.calls[0][0]).toMatchObject({ references: [upload], maskUri: 'file:///mask.png', prompt: '换成夜景', size: '2048x2048' });

  mockAgent.mockResolvedValueOnce({ text: '', imageCall: { prompt: '再加一轮月亮', referenceImages: ['图2'], aspectRatio: null, transparent: false }, images: images([['图1', upload.uri], ['图2', 'file:///night.png']]), toolMode: 'native' });
  mockEdit.mockResolvedValue('file:///moon.png');
  await act(async () => { await app.send({ text: '再加个月亮' }); });
  expect(mockCopyGenerated).toHaveBeenCalledWith('file:///night.png');
  expect(mockEdit.mock.calls[1][0]).toMatchObject({ references: [expect.objectContaining({ uri: 'file:///night.png.copy.png' })], maskUri: null });
  // The second turn saw the first turn as history.
  expect(mockAgent.mock.calls[1][0].history).toHaveLength(2);
});

test('with only an image service every message is drawn directly', async () => {
  mockProviders = [image];
  mockGenerate.mockResolvedValue('file:///direct.png');
  await mount();
  await act(async () => { await app.send({ text: '一座雪山' }); });
  expect(mockAgent).not.toHaveBeenCalled();
  expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ prompt: '一座雪山', size: '2048x2048' }));
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///direct.png' });
  await expect(app.send({ text: '读一下', documents: [{ id: 'd', uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 1 }] })).rejects.toThrow('对话模型');
});

test('retrying a failed drawing repeats only the image call; a failed download only downloads', async () => {
  mockAgent.mockResolvedValue({ text: '画一下', imageCall: { prompt: '灯塔', referenceImages: [], aspectRatio: null, transparent: false }, images: new Map(), toolMode: 'native' });
  mockGenerate.mockRejectedValueOnce(new Error('上游超时'));
  await mount();
  await act(async () => { await app.send({ text: '画灯塔' }); });
  expect(app.messages[1]).toMatchObject({ status: 'error', error: '上游超时', preparedPrompt: '灯塔' });

  mockGenerate.mockRejectedValueOnce(new RemoteImageDownloadError('https://cdn.example/lighthouse.png'));
  await act(async () => { await app.retry(app.messages[1]); });
  expect(mockAgent).toHaveBeenCalledTimes(1);
  expect(app.messages[1]).toMatchObject({ status: 'error', remoteImageUrl: 'https://cdn.example/lighthouse.png' });

  mockDownload.mockResolvedValue('file:///lighthouse.png');
  await act(async () => { await app.retry(app.messages[1]); });
  expect(mockGenerate).toHaveBeenCalledTimes(2);
  expect(mockDownload).toHaveBeenCalledWith('https://cdn.example/lighthouse.png', expect.anything());
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///lighthouse.png', remoteImageUrl: null });
});

test('switching models is global and persists', async () => {
  const second = provider({ id: 'second', chatModel: 'claude-x', chatApi: 'anthropic' });
  mockProviders = [chat, image, second];
  await mount();
  expect(app.chatProvider?.id).toBe('chat');
  await act(async () => { await app.selectChatProvider('second', 'claude-y'); });
  expect(app.chatProvider).toMatchObject({ id: 'second', chatModel: 'claude-y' });
  expect(mockSettings.chat_provider_id).toBe('second');
  await act(async () => { await app.selectImageProvider('image', { aspectRatio: '16:9' }); });
  expect(app.imageProvider?.aspectRatio).toBe('16:9');
});
