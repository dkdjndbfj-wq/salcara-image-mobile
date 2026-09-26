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
const mockDeleteFile = jest.fn();

jest.mock('expo-crypto', () => {
  let next = 0;
  return { randomUUID: () => `test-id-${++next}` };
});
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
  deleteLocalFile: (...args: unknown[]) => mockDeleteFile(...args),
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
  [mockAgent, mockGenerate, mockEdit, mockDownload, mockCopyGenerated, mockInsertConversation, mockDeleteEmpty, mockDeleteFile].forEach((mock) => mock.mockReset());
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

test('a long drawing keeps running in the background while another conversation is used', async () => {
  let finishDrawing: (uri: string) => void = () => undefined;
  let drawingSignal: AbortSignal | undefined;
  mockAgent.mockImplementation(async (request: { prompt: string }, onText?: (text: string) => void) => {
    if (request.prompt === '画灯塔') {
      onText?.('马上画。');
      return { text: '马上画。', imageCall: { prompt: '灯塔', referenceImages: [], aspectRatio: null, transparent: false }, images: new Map(), toolMode: 'native' };
    }
    return { text: '在的。', imageCall: null, images: new Map(), toolMode: 'native' };
  });
  mockGenerate.mockImplementation((options: { signal: AbortSignal }) => new Promise<string>((resolve) => { drawingSignal = options.signal; finishDrawing = resolve; }));
  await mount();

  let drawing: Promise<void> = Promise.resolve();
  await act(async () => { drawing = app.send({ text: '画灯塔' }); });
  await waitFor(() => expect(app.phase).toBe('drawing'));
  const first = app.activeConversationId!;
  expect(app.busy).toBe(true);
  await expect(app.send({ text: '再画一张' })).rejects.toThrow('请先等待');

  // Leaving the drawing conversation is allowed and doesn't cancel it.
  await act(async () => { app.newChat(); });
  expect(app.busy).toBe(false);
  expect(app.anyBusy).toBe(true);
  expect(app.runningConversationIds).toEqual([first]);
  await act(async () => { await app.send({ text: '你在吗' }); });
  const second = app.activeConversationId!;
  expect(second).not.toBe(first);
  expect(app.messages.map((item) => item.prompt)).toEqual(['你在吗', '你在吗']);
  expect(app.messages[1]).toMatchObject({ status: 'complete', text: '在的。' });
  await act(async () => { app.stop(); });
  expect(drawingSignal?.aborted).toBe(false);

  // Coming back shows the live drawing state, then the finished image.
  await act(async () => { await app.openConversation(first); });
  expect(app.busy).toBe(true);
  expect(app.messages[1]).toMatchObject({ status: 'pending', text: '马上画。', preparedPrompt: '灯塔' });
  await act(async () => { finishDrawing('file:///lighthouse.png'); await drawing; });
  expect(app.busy).toBe(false);
  expect(app.anyBusy).toBe(false);
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///lighthouse.png' });
  // The other conversation was never touched by the drawing's updates.
  expect(mockMessages.filter((item) => item.conversationId === second).map((item) => item.status)).toEqual(['complete', 'complete']);
});

test('finishing a background reply does not overwrite the conversation on screen', async () => {
  let finishReply: () => void = () => undefined;
  mockAgent.mockImplementationOnce((_request: unknown, onText?: (text: string) => void) => new Promise((resolve) => {
    onText?.('写到一半');
    finishReply = () => resolve({ text: '写完了', imageCall: null, images: new Map(), toolMode: 'native' });
  }));
  await mount();
  let pending: Promise<void> = Promise.resolve();
  await act(async () => { pending = app.send({ text: '写一篇长文' }); });
  const first = app.activeConversationId!;
  await act(async () => { app.newChat(); });
  await act(async () => { finishReply(); await pending; });
  expect(app.activeConversationId).toBeNull();
  expect(app.messages).toEqual([]);
  await act(async () => { await app.openConversation(first); });
  expect(app.messages[1]).toMatchObject({ status: 'complete', text: '写完了' });
});

test('deleting a conversation stops its reply; providers cannot be removed mid-reply', async () => {
  let signal: AbortSignal | undefined;
  mockAgent.mockImplementationOnce((request: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    signal = request.signal;
    request.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await mount();
  let pending: Promise<void> = Promise.resolve();
  await act(async () => { pending = app.send({ text: '你好' }); });
  await expect(app.removeProvider('image')).rejects.toThrow('请先等待');
  const id = app.activeConversationId!;
  await act(async () => { await app.deleteConversation(id); await pending; });
  expect(signal?.aborted).toBe(true);
  expect(app.anyBusy).toBe(false);
  expect(app.conversations).toHaveLength(0);
});

test('regenerating an image deletes the replaced file but keeps the user upload', async () => {
  mockAgent.mockResolvedValue({ text: '', imageCall: { prompt: '夜景', referenceImages: ['图1'], aspectRatio: null, transparent: false }, images: images([['图1', upload.uri]]), toolMode: 'native' });
  mockEdit.mockResolvedValueOnce('file:///first.png').mockResolvedValueOnce('file:///second.png');
  await mount();
  await act(async () => { await app.send({ text: '改成夜景', images: [upload] }); });
  expect(app.messages[1].imageUri).toBe('file:///first.png');
  await act(async () => { await app.retry(app.messages[1]); });
  expect(app.messages[1].imageUri).toBe('file:///second.png');
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///first.png');
  expect(mockDeleteFile).not.toHaveBeenCalledWith(upload.uri);
});

test('deleting a conversation mid-drawing waits for the run and removes the files it produced', async () => {
  let finish: (uri: string) => void = () => undefined;
  mockAgent.mockResolvedValue({ text: '画', imageCall: { prompt: '猫', referenceImages: [], aspectRatio: null, transparent: false }, images: new Map(), toolMode: 'native' });
  // The provider returns the image just as the user deletes the chat.
  mockGenerate.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
  await mount();
  let pending: Promise<void> = Promise.resolve();
  await act(async () => { pending = app.send({ text: '画猫' }); });
  await waitFor(() => expect(app.phase).toBe('drawing'));
  const id = app.activeConversationId!;
  let deleted: Promise<void> = Promise.resolve();
  await act(async () => { deleted = app.deleteConversation(id); finish('file:///late.png'); await deleted; await pending; });
  expect(mockMessages).toHaveLength(0);
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///late.png');
  expect(app.conversations).toHaveLength(0);
});
