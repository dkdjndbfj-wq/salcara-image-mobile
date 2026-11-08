import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { ChatMessage, Conversation, GeneratedImage, ProviderProfile, ReferenceImage } from '../domain';

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
const mockListMessages = jest.fn();
const mockListRecentMessages = jest.fn();
const mockUpdateMessage = jest.fn();
const mockPickAndRestoreBackup = jest.fn();

jest.mock('expo-crypto', () => {
  let next = 0;
  return { randomUUID: () => `test-id-${++next}` };
});
jest.mock('../api/chat-api', () => ({ runAgentTurn: (...args: unknown[]) => mockAgent(...args) }));
jest.mock('../agent/web', () => ({ hostOf: (url: string) => url, webSearch: async () => ({ engine: 'test', results: [] }), readWebpage: async () => { throw new Error('offline'); } }));
jest.mock('../api/image-api', () => ({
  generateImage: (...args: unknown[]) => mockGenerate(...args),
  editImage: (...args: unknown[]) => mockEdit(...args),
  generateImages: async (request: { onImages?: (images: unknown[]) => Promise<void> }) => {
    const result = await mockGenerate(request);
    const images = Array.isArray(result) ? result : [{ id: 'image-1', uri: result, status: 'complete' }];
    await request.onImages?.(images);
    return images;
  },
  editImages: async (request: { onImages?: (images: unknown[]) => Promise<void> }) => {
    const result = await mockEdit(request);
    const images = Array.isArray(result) ? result : [{ id: 'image-1', uri: result, status: 'complete' }];
    await request.onImages?.(images);
    return images;
  },
  normalizeError: (error: unknown) => error instanceof Error ? error : new Error('请求失败'),
}));
jest.mock('../document-inputs', () => ({ validateAttachments: () => undefined }));
jest.mock('../image-inputs', () => ({ createReferenceFromGenerated: (...args: unknown[]) => mockCopyGenerated(...args), previewDataUrl: async () => 'data:image/jpeg;base64,AAAA' }));
jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: async () => undefined, deactivateKeepAwake: async () => undefined }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: async () => 'key', deleteProviderKey: async () => undefined }));
jest.mock('../storage/backup', () => ({ pickAndRestoreBackup: (...args: unknown[]) => mockPickAndRestoreBackup(...args) }));
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
  listMessages: (...args: unknown[]) => mockListMessages(...args),
  listRecentMessages: (...args: unknown[]) => mockListRecentMessages(...args),
  deleteMessageRecords: async (id: string, ids: string[]) => {
    const removed = mockMessages.filter((item) => item.conversationId === id && ids.includes(item.id));
    mockMessages = mockMessages.filter((item) => !removed.includes(item));
    return removed;
  },
  deleteMessagesFrom: async (id: string, createdAt: number) => {
    const removed = mockMessages.filter((item) => item.conversationId === id && item.createdAt >= createdAt);
    mockMessages = mockMessages.filter((item) => !removed.includes(item));
    return removed;
  },
  insertMessage: async (message: ChatMessage) => { mockMessages.push(message); },
  listMemories: async () => [],
  listAgents: async () => [],
  searchMessages: async () => [],
  updateMessage: (message: ChatMessage) => mockUpdateMessage(message),
}));

import { AppProvider, faithfulPrompt, useApp } from '../state/AppContext';
import { RemoteImageDownloadError } from '../storage/files';
import { liveText } from '../state/live-text';
import { imageCountFromPrompt } from '../state/app-helpers';

let app: ReturnType<typeof useApp>;
function Probe() { app = useApp(); return null; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
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
  [mockAgent, mockGenerate, mockEdit, mockDownload, mockCopyGenerated, mockInsertConversation, mockDeleteEmpty, mockDeleteFile, mockPickAndRestoreBackup].forEach((mock) => mock.mockReset());
  mockListMessages.mockReset().mockImplementation(async (id: string) => mockMessages.filter((item) => item.conversationId === id));
  mockListRecentMessages.mockReset().mockImplementation(async (id: string, limit: number, before?: number) =>
    mockMessages.filter((item) => item.conversationId === id && (before === undefined || item.createdAt < before)).slice(-limit));
  mockCopyGenerated.mockImplementation(async (uri: string) => ({ id: 'copy', uri: `${uri}.copy.png`, name: 'copy.png', mimeType: 'image/png', size: 1 }));
  mockUpdateMessage.mockReset().mockImplementation(async (message: ChatMessage) => {
    if (message.preparedPrompt && message.status === 'pending' && !message.imageUri) mockOrder.push('saved-image-job');
    mockMessages = mockMessages.map((item) => item.id === message.id ? message : item);
  });
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
  // “用我的原话”: the image model gets the user's words, not the chat model's rewrite.
  expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-image-2', prompt: '画一只橘猫，竖版，透明背景', size: '1536x2736', quality: 'high', transparent: true }));
  expect(mockOrder).toEqual(['saved-image-job', 'generate']);
  expect(app.messages[1]).toMatchObject({ status: 'complete', mode: 'generate', text: '好的，我来画。', imageUri: 'file:///cat.png', preparedPrompt: '画一只橘猫，竖版，透明背景', analysisModel: 'vision-model', providerId: 'image' });
});

test('references resolve to the current upload (with mask) or a copy of an earlier generated image', async () => {
  mockAgent.mockResolvedValueOnce({ text: '', imageCall: { prompt: '换成夜景', referenceImages: ['图1'], aspectRatio: null, transparent: false }, images: images([['图1', upload.uri]]), toolMode: 'native' });
  mockEdit.mockResolvedValue('file:///night.png');
  await mount();
  await act(async () => { await app.send({ text: '把背景换成夜景', images: [upload], maskUri: 'file:///mask.png' }); });
  expect(mockEdit.mock.calls[0][0]).toMatchObject({ references: [upload], maskUri: 'file:///mask.png', prompt: '把背景换成夜景', size: '2048x2048' });

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
  expect(app.messages[1]).toMatchObject({ status: 'error', error: '绘图服务出错：上游超时', preparedPrompt: '灯塔' });

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

test('multi-step turn: the image tool draws inside the loop and the trace is saved with the message', async () => {
  mockAgent.mockImplementation(async (request: { toolkit: { specs: Array<{ name: string }>; execute: (call: unknown, context: unknown) => Promise<{ content: string }> } }, onText?: (text: string) => void) => {
    expect(request.toolkit.specs.map((spec) => spec.name)).toContain('generate_image');
    onText?.('好的，画一只猫。');
    const result = await request.toolkit.execute({ id: 'c1', name: 'generate_image', input: { prompt: '橘猫', aspect_ratio: '16:9' }, raw: '' }, { step: 0, mode: 'native' });
    expect(result.content).toContain('图1');
    return { text: '好的，画一只猫。', imageCall: null, images: new Map(), toolMode: 'native', suggestions: ['换成黑猫'], sources: [], steps: 1 };
  });
  mockGenerate.mockImplementation(async () => { mockOrder.push('generate'); return 'file:///cat.png'; });
  await mount();
  await act(async () => { await app.send({ text: '画只猫' }); });
  expect(mockOrder).toEqual(['saved-image-job', 'generate']);
  expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ prompt: '橘猫', size: '2736x1536' }));
  const reply = app.messages[1];
  expect(reply).toMatchObject({ status: 'complete', text: '好的，画一只猫。', imageUri: 'file:///cat.png', preparedPrompt: '橘猫' });
  expect(reply.agent?.steps.map((step) => [step.kind, step.status])).toEqual([['image', 'done']]);
  expect(reply.agent?.suggestions).toEqual(['换成黑猫']);
  expect(mockMessages.find((item) => item.id === reply.id)?.agent?.steps).toHaveLength(1);
});

test('a failed drawing inside a turn is retried alone and its step then shows as done', async () => {
  mockAgent.mockImplementation(async (request: { toolkit: { execute: (call: unknown, context: unknown) => Promise<unknown> } }) => {
    await request.toolkit.execute({ id: 'c1', name: 'generate_image', input: { prompt: '灯塔' }, raw: '' }, { step: 0, mode: 'native' });
    return { text: '', imageCall: null, images: new Map(), toolMode: 'native', suggestions: [], sources: [], steps: 1 };
  });
  mockGenerate.mockRejectedValueOnce(new Error('上游超时')).mockResolvedValueOnce('file:///lighthouse.png');
  await mount();
  await act(async () => { await app.send({ text: '画灯塔' }); });
  expect(app.messages[1]).toMatchObject({ status: 'error', error: '绘图服务出错：上游超时', preparedPrompt: '灯塔' });
  expect(app.messages[1].agent?.steps[0]).toMatchObject({ kind: 'image', status: 'error' });
  await act(async () => { await app.retry(app.messages[1]); });
  expect(mockAgent).toHaveBeenCalledTimes(1);
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///lighthouse.png' });
  expect(app.messages[1].agent?.steps[0]).toMatchObject({ status: 'done' });
});

test('a slow progress write cannot land after the completed image snapshot', async () => {
  const progressWrite = deferred<void>();
  const drawing = deferred<string>();
  const drawingStarted = deferred<void>();
  const persist = mockUpdateMessage.getMockImplementation()!;
  mockUpdateMessage.mockImplementation(async (message: ChatMessage) => {
    if (message.status === 'pending' && message.agent?.plan?.length) await progressWrite.promise;
    await persist(message);
  });
  mockGenerate.mockImplementation(() => { drawingStarted.resolve(); return drawing.promise; });
  mockAgent.mockImplementation(async (request: { toolkit: { execute: (call: unknown, context: unknown) => Promise<unknown> } }) => {
    const image = request.toolkit.execute({ id: 'image', name: 'generate_image', input: { prompt: '星星' }, raw: '' }, { step: 0, mode: 'native' });
    await drawingStarted.promise;
    await request.toolkit.execute({ id: 'plan', name: 'update_plan', input: { steps: [{ title: '整理图片' }] }, raw: '' }, { step: 1, mode: 'native' });
    await image;
    return { text: '画好了', imageCall: null, images: new Map(), toolMode: 'native' };
  });
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = app.send({ text: '画星星' }); });
  await waitFor(() => expect(mockUpdateMessage.mock.calls.some(([item]: [ChatMessage]) => item.agent?.plan?.length)).toBe(true));
  await act(async () => { drawing.resolve('file:///stars.png'); });
  // Until the older snapshot has reached disk, the newer image checkpoint is queued.
  expect(mockUpdateMessage.mock.calls.some(([item]: [ChatMessage]) => item.imageUri)).toBe(false);
  expect(app.messages[1].imageUri).toBeNull();
  await act(async () => { progressWrite.resolve(); await pending; });
  expect(mockMessages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///stars.png', text: '画好了' });
});

test.each(['stop', 'timeout'] as const)('%s during post-image work retains the delivered picture as complete', async (reason) => {
  mockGenerate.mockResolvedValueOnce('file:///delivered.png');
  mockAgent.mockImplementationOnce(async (request: { signal: AbortSignal; toolkit: { execute: (call: unknown, context: unknown) => Promise<unknown> } }) => {
    await request.toolkit.execute({ id: 'c1', name: 'generate_image', input: { prompt: '星星' }, raw: '' }, { step: 0, mode: 'native' });
    return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  await mount();
  if (reason === 'timeout') jest.useFakeTimers();
  try {
    let pending!: Promise<void>;
    await act(async () => { pending = app.send({ text: '画星星' }); });
    await waitFor(() => expect(app.messages[1]?.imageUri).toBe('file:///delivered.png'));
    await act(async () => {
      if (reason === 'stop') app.stop();
      else await jest.advanceTimersByTimeAsync(10 * 60_000 + 1);
      await pending;
    });
    expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///delivered.png', error: null });
    expect(mockMessages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///delivered.png', error: null });
    expect(app.messages[1].agent?.steps.at(-1)?.title).toContain('图片已保留');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(app.busy).toBe(false);
  } finally { jest.useRealTimers(); }
});

test('deleting a chat during a blocked image checkpoint cleans up its late result', async () => {
  const checkpoint = deferred<void>();
  const persist = mockUpdateMessage.getMockImplementation()!;
  mockUpdateMessage.mockImplementation(async (message: ChatMessage) => {
    if (message.imageUri) await checkpoint.promise;
    await persist(message);
  });
  mockAgent.mockResolvedValue({ text: '', imageCall: { prompt: '星星', referenceImages: [], aspectRatio: null, transparent: false }, images: new Map(), toolMode: 'native' });
  mockGenerate.mockResolvedValue('file:///late-checkpoint.png');
  await mount();
  jest.useFakeTimers();
  try {
    let sending!: Promise<void>;
    await act(async () => { sending = app.send({ text: '画星星' }); });
    await waitFor(() => expect(mockUpdateMessage.mock.calls.some(([item]: [ChatMessage]) => item.imageUri)).toBe(true));
    let removing!: Promise<void>;
    await act(async () => {
      removing = app.deleteConversation(app.activeConversationId!);
      await jest.advanceTimersByTimeAsync(5001);
      await removing;
    });
    expect(mockDeleteFile).toHaveBeenCalledWith('file:///late-checkpoint.png');
    await expect(app.restoreBackup()).rejects.toThrow('保存完成');
    expect(mockPickAndRestoreBackup).not.toHaveBeenCalled();
    await act(async () => { checkpoint.resolve(); await sending; });
    expect(mockMessages).toEqual([]);
    expect(app.messages).toEqual([]);
    expect(app.activeConversationId).toBeNull();
    expect(app.anyBusy).toBe(false);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

test('a deleted conversation restored from backup can receive new replies in the same session', async () => {
  mockAgent.mockResolvedValue({ text: '你好', imageCall: null, images: new Map(), toolMode: 'native' });
  await mount();
  await act(async () => { await app.send({ text: '你好' }); });
  const conversation = mockConversations[0];
  const history = [...mockMessages];
  await act(async () => { await app.deleteConversation(conversation.id); });
  mockPickAndRestoreBackup.mockImplementationOnce(async () => {
    mockConversations = [conversation];
    mockMessages = history;
    return { conversations: 1, messages: 2, characters: 0, files: 0 };
  });
  await act(async () => { await app.restoreBackup(); await app.openConversation(conversation.id); });
  await act(async () => { await app.send({ text: '继续聊' }); });
  expect(app.messages).toHaveLength(4);
  expect(app.messages[3]).toMatchObject({ conversationId: conversation.id, status: 'complete', text: '你好' });
});

test.each(['cancel', 'error'] as const)('backup restoration blocks new runs and releases its guard after %s', async (outcome) => {
  const picker = deferred<void>();
  mockPickAndRestoreBackup.mockImplementationOnce(async () => {
    await picker.promise;
    if (outcome === 'error') throw new Error('备份损坏');
    return null;
  });
  mockAgent.mockResolvedValue({ text: '你好', imageCall: null, images: new Map(), toolMode: 'native' });
  await mount();
  let restoring!: Promise<unknown>;
  await act(async () => { restoring = app.restoreBackup().catch((error: Error) => error.message); });
  await expect(app.send({ text: '你好' })).rejects.toThrow('正在恢复备份');
  await expect(app.restoreBackup()).rejects.toThrow('正在恢复备份');
  expect(mockInsertConversation).not.toHaveBeenCalled();
  expect(mockAgent).not.toHaveBeenCalled();
  await act(async () => { picker.resolve(); await restoring; });
  await act(async () => { await app.send({ text: '你好' }); });
  expect(app.messages[1]).toMatchObject({ status: 'complete', text: '你好' });
});

test('late streamed text cannot overwrite a finished reply', async () => {
  let showText!: (text: string) => void;
  mockAgent.mockImplementationOnce(async (_request: unknown, onText: typeof showText) => {
    showText = onText;
    return { text: '最终回复', imageCall: null, images: new Map(), toolMode: 'native' };
  });
  await mount();
  await act(async () => { await app.send({ text: '你好' }); });
  const reply = app.messages[1];
  await act(async () => { showText('晚到的进度'); });
  expect(liveText(reply.id)).toBeUndefined();
  expect(app.messages[1]).toMatchObject({ text: '最终回复', status: 'complete' });
  expect(mockMessages[1]).toMatchObject({ text: '最终回复', status: 'complete' });
});

test('a redraw that fails keeps the picture the turn already had', async () => {
  mockAgent.mockImplementation(async (request: { toolkit: { execute: (call: unknown, context: unknown) => Promise<unknown> } }) => {
    await request.toolkit.execute({ id: 'c1', name: 'generate_image', input: { prompt: '灯塔' }, raw: '' }, { step: 0, mode: 'native' });
    await request.toolkit.execute({ id: 'c2', name: 'generate_image', input: { prompt: '灯塔，夜景' }, raw: '' }, { step: 1, mode: 'native' });
    return { text: '', imageCall: null, images: new Map(), toolMode: 'native', suggestions: [], sources: [], steps: 2 };
  });
  mockGenerate.mockResolvedValueOnce('file:///first.png').mockRejectedValueOnce(new Error('上游超时'));
  await mount();
  await act(async () => { await app.send({ text: '画灯塔' }); });
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///first.png', error: null });
  expect(app.messages[1].agent?.drafts ?? []).toEqual([]);
});

test('an async image task is saved and resumed on retry instead of submitted again', async () => {
  mockAgent.mockResolvedValue({ text: '画一下', imageCall: { prompt: '灯塔', referenceImages: [], aspectRatio: null, transparent: false }, images: new Map(), toolMode: 'native' });
  const task = { id: 'task-1', url: 'https://img.example/v1/images/tasks/task-1' };
  mockGenerate.mockImplementationOnce(async (request: { onTask?: (value: typeof task) => void }) => { request.onTask?.(task); throw new Error('网络中断'); })
    .mockResolvedValueOnce('file:///resumed.png');
  await mount();
  await act(async () => { await app.send({ text: '画灯塔' }); });
  expect(app.messages[1]).toMatchObject({ status: 'error' });
  await act(async () => { await app.retry(app.messages[1]); });
  expect(mockGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ resumeTask: task }));
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///resumed.png' });
});

test('stopping mid-step marks running steps as stopped; research and agent flags reach the turn', async () => {
  mockAgent.mockImplementationOnce((request: { signal: AbortSignal; extraInstructions: string[]; toolkit: { maxSteps: number; execute: (call: unknown, context: unknown) => Promise<unknown> } }) => new Promise((_resolve, reject) => {
    expect(request.extraInstructions.join('\n')).toContain('深度研究');
    expect(request.toolkit.maxSteps).toBeGreaterThan(8);
    void request.toolkit.execute({ id: 'p', name: 'update_plan', input: { steps: [{ title: '找资料' }] }, raw: '' }, { step: 0, mode: 'native' });
    request.signal.addEventListener('abort', () => { const error = new Error('stop'); error.name = 'AbortError'; reject(error); });
  }));
  await mount();
  let pending: Promise<void> = Promise.resolve();
  await act(async () => { pending = app.send({ text: '研究一下电池技术', research: true }); });
  await waitFor(() => expect(app.messages[1]?.agent?.plan).toEqual([{ title: '找资料', done: false }]));
  await act(async () => { app.stop(); await pending; });
  expect(app.messages[1]).toMatchObject({ status: 'cancelled' });
  expect(app.messages[1].agent?.research).toBe(true);
});

test('image prompts keep the user’s own words unless they lean on earlier context', () => {
  expect(faithfulPrompt('把背景换成夜景，人物别动', '将背景替换为璀璨星空下的都市夜景，霓虹灯光，电影感')).toBe('把背景换成夜景，人物别动');
  // Needs the earlier discussion: the user's words first, the gathered context after.
  expect(faithfulPrompt('按刚才的方案画海报', '夏日音乐节海报，标题“Salcara Live”')).toBe('按刚才的方案画海报\n\n补充（来自前面的对话）：夏日音乐节海报，标题“Salcara Live”');
  // Says nothing drawable by itself (“画吧”): the drafted prompt is used.
  expect(faithfulPrompt('好，画吧', '一只在云朵上睡觉的橘猫')).toBe('一只在云朵上睡觉的橘猫');
  expect(faithfulPrompt('', '一座雪山')).toBe('一座雪山');
});

const seeded = (id: string, role: 'user' | 'assistant', createdAt: number, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, conversationId: 'c1', role, prompt: role === 'user' ? `问题 ${id}` : '', mode: 'chat', status: 'complete', providerId: 'chat', model: 'vision-model',
  quality: 'auto', size: 'auto', transparent: false, imageUri: null, remoteImageUrl: null, references: [], maskUri: null, error: null, elapsedMs: null,
  createdAt, text: role === 'assistant' ? `回答 ${id}` : null, ...patch,
} as ChatMessage);

test('editing a sent message replaces it and every later turn; deleting a question takes its answer along', async () => {
  const old: ReferenceImage = { ...upload, id: 'old', uri: 'file:///old.png' };
  const kept: ReferenceImage = { ...upload, id: 'kept', uri: 'file:///kept.png' };
  mockConversations = [{ id: 'c1', title: '旧对话', providerId: 'chat', transparent: false, createdAt: 1, updatedAt: 1 }];
  mockMessages = [
    seeded('u1', 'user', 1000), seeded('a1', 'assistant', 1001),
    seeded('u2', 'user', 2000, { references: [old, kept] }), seeded('a2', 'assistant', 2001),
    seeded('u3', 'user', 3000), seeded('a3', 'assistant', 3001),
  ];
  mockAgent.mockResolvedValue({ text: '新的回答', imageCall: null, images: new Map(), toolMode: 'native' });
  await mount();
  await act(async () => { await app.openConversation('c1'); });
  await act(async () => { await app.editAndResend('u2', { text: '改过的问题', images: [kept] }); });
  expect(app.messages.map((item) => item.role === 'user' ? item.prompt : item.text)).toEqual(['问题 u1', '回答 a1', '改过的问题', '新的回答']);
  expect(app.messages[3]).toMatchObject({ role: 'assistant', prompt: '改过的问题', text: '新的回答' });
  expect(mockMessages.some((item) => ['u2', 'a2', 'u3', 'a3'].includes(item.id))).toBe(false);
  // The picture carried into the edit stays; the one left out is deleted.
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///old.png');
  expect(mockDeleteFile).not.toHaveBeenCalledWith('file:///kept.png');

  await act(async () => { await app.deleteMessage('u1'); });
  expect(app.messages.map((item) => item.role === 'user' ? item.prompt : item.text)).toEqual(['改过的问题', '新的回答']);
  expect(mockMessages.some((item) => item.id === 'u1' || item.id === 'a1')).toBe(false);
});

test('a search hit opens its conversation at that message', async () => {
  mockConversations = [{ id: 'c1', title: '长对话', providerId: 'chat', transparent: false, createdAt: 1, updatedAt: 1 }];
  mockMessages = Array.from({ length: 200 }, (_, index) => seeded(`m${index}`, index % 2 ? 'assistant' : 'user', 1000 + index));
  await mount();
  await act(async () => { await app.openMessage('c1', 'm10'); });
  expect(app.activeConversationId).toBe('c1');
  expect(app.messages[0].id).toBe('m6');
  expect(app.messages[app.messages.length - 1].id).toBe('m199');
  expect(app.hasOlderMessages).toBe(true);
  expect(app.jumpRequest).toMatchObject({ messageId: 'm10' });
});

test('a late conversation read cannot overwrite a newer navigation', async () => {
  const firstRows = deferred<ChatMessage[]>();
  const secondRows = deferred<ChatMessage[]>();
  const first = { id: 'c1', title: '第一条', providerId: 'chat', transparent: false, createdAt: 1, updatedAt: 1 } as Conversation;
  const second = { id: 'c2', title: '第二条', providerId: 'chat', transparent: false, createdAt: 2, updatedAt: 2 } as Conversation;
  mockConversations = [first, second];
  mockListMessages.mockImplementation((id: string) => id === 'c1' ? firstRows.promise : secondRows.promise);
  await mount();
  let firstOpen!: Promise<void>;
  let secondOpen!: Promise<void>;
  await act(async () => { firstOpen = app.openConversation('c1', false); secondOpen = app.openConversation('c2', false); await Promise.resolve(); });
  secondRows.resolve([{ ...seeded('c2-message', 'assistant', 2), conversationId: 'c2' }]);
  await act(async () => { await secondOpen; });
  firstRows.resolve([{ ...seeded('c1-message', 'assistant', 1), conversationId: 'c1' }]);
  await act(async () => { await firstOpen; });
  expect(app.activeConversationId).toBe('c2');
  expect(app.messages[0].conversationId).toBe('c2');
});

const batch = (): GeneratedImage[] => [
  { id: 'image-1', uri: 'file:///batch-one.png', status: 'complete' },
  { id: 'image-2', uri: null, remoteUrl: 'https://cdn.example/two.png', status: 'error', error: '图片下载失败' },
  { id: 'image-3', uri: 'file:///batch-three.png', status: 'complete' },
];
function batchCall() {
  mockAgent.mockResolvedValue({ text: '画好了', imageCall: { prompt: '三张风景', count: 3, referenceImages: [], aspectRatio: null, transparent: false }, images: new Map(), toolMode: 'native' });
}

test('a batch retains every delivered image and retries only the selected already-paid download', async () => {
  batchCall(); mockGenerate.mockResolvedValue(batch());
  await mount();
  await act(async () => { await app.send({ text: '生成三张风景' }); });
  const old = app.messages[1];
  expect(old).toMatchObject({ status: 'complete', imageCount: 3, imageUri: 'file:///batch-one.png', generatedImages: batch() });
  mockDownload.mockResolvedValue('file:///batch-two.png');
  await act(async () => { await app.retryImage(old, 'image-2'); });
  expect(mockDownload).toHaveBeenCalledWith('https://cdn.example/two.png', expect.any(AbortSignal));
  expect(app.messages[1].generatedImages?.map((image) => image.uri)).toEqual(['file:///batch-one.png', 'file:///batch-two.png', 'file:///batch-three.png']);
  expect(mockMessages[1].generatedImages).toEqual(app.messages[1].generatedImages);
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockAgent).toHaveBeenCalledTimes(1);
  await act(async () => { await expect(app.retryImage(old, 'image-2')).rejects.toThrow('没有可重新下载'); });
  expect(mockDownload).toHaveBeenCalledTimes(1);
});

test('a second image waits for its own disk checkpoint even when the first image is already visible', async () => {
  batchCall();
  const nextImage = deferred<void>(), checkpoint = deferred<void>();
  const first = [{ ...batch()[0] }, { ...batch()[1], status: 'pending' as const }, { id: 'image-3', uri: null, status: 'pending' as const }];
  const persist = mockUpdateMessage.getMockImplementation()!;
  mockUpdateMessage.mockImplementation(async (message: ChatMessage) => {
    if (message.generatedImages?.[2]?.uri) await checkpoint.promise;
    await persist(message);
  });
  mockGenerate.mockImplementation(async (request: { onImages: (images: GeneratedImage[]) => Promise<void> }) => {
    await request.onImages(first);
    await nextImage.promise;
    return batch();
  });
  await mount();
  let sending!: Promise<void>;
  await act(async () => { sending = app.send({ text: '生成三张风景' }); });
  await waitFor(() => expect(app.messages[1]?.imageUri).toBe('file:///batch-one.png'));
  await act(async () => { nextImage.resolve(); });
  await waitFor(() => expect(mockUpdateMessage.mock.calls.some(([message]: [ChatMessage]) => message.generatedImages?.[2]?.uri)).toBe(true));
  expect(app.messages[1].generatedImages?.[2]?.uri).toBeNull();
  await act(async () => { checkpoint.resolve(); await sending; });
  expect(app.messages[1].generatedImages?.[2]?.uri).toBe('file:///batch-three.png');
});

test('stopping a per-image download preserves the other results and repeated taps cannot start another download', async () => {
  batchCall(); mockGenerate.mockResolvedValue(batch());
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  const original = app.messages[1];
  mockDownload.mockImplementation((_url: string, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('已停止')))));
  let retrying!: Promise<void>;
  await act(async () => { retrying = app.retryImage(original, 'image-2'); });
  await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1));
  await act(async () => { await expect(app.retryImage(original, 'image-2')).rejects.toThrow('当前回复'); app.stop(); await retrying; });
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///batch-one.png' });
  expect(app.messages[1].generatedImages?.[1]).toMatchObject({ status: 'error', remoteUrl: 'https://cdn.example/two.png', error: '图片下载已停止' });
  expect(mockGenerate).toHaveBeenCalledTimes(1);
});

test('a batch with no successful image keeps all download URLs and retry never submits another paid request', async () => {
  batchCall();
  mockGenerate.mockResolvedValue(batch().map((image, index) => ({ ...image, uri: null, status: 'error', remoteUrl: `https://cdn.example/${index}.png`, error: '离线' })));
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  expect(app.messages[1].status).toBe('error');
  mockDownload.mockImplementation(async (url: string) => `file:///${url.split('/').pop()}`);
  await act(async () => { await app.retry(app.messages[1]); });
  expect(app.messages[1].generatedImages?.every((image) => image.status === 'complete')).toBe(true);
  expect(app.messages[1].status).toBe('complete');
  expect(mockGenerate).toHaveBeenCalledTimes(1); expect(mockDownload).toHaveBeenCalledTimes(3);
});

test('regeneration clears the previous batch and deletion reclaims every newly owned image', async () => {
  batchCall(); mockGenerate.mockResolvedValueOnce(batch()).mockResolvedValueOnce([{ id: 'image-1', uri: 'file:///new.png', status: 'complete' }]);
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  await act(async () => { await app.retry(app.messages[1]); });
  expect(app.messages[1].generatedImages).toHaveLength(1);
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///batch-one.png');
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///batch-three.png');
  await act(async () => { await app.deleteConversation(app.activeConversationId!); });
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///new.png');
});

test('image-only prompts recognize explicit image counts without counting depicted subjects', async () => {
  expect(imageCountFromPrompt('画三只猫')).toBe(1);
  expect(imageCountFromPrompt('给我画三张海报')).toBe(3);
  expect(imageCountFromPrompt('生成10张图片')).toBe(10);
  expect(imageCountFromPrompt('我只要四张')).toBe(4);
  expect(imageCountFromPrompt('帮我画五张不同的风景')).toBe(5);
  expect(() => imageCountFromPrompt('生成十一张图片')).toThrow('1 到 10');
  mockProviders = [image]; mockGenerate.mockResolvedValue(batch());
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({ count: 3 }));
  expect(app.messages[1].generatedImages).toHaveLength(3);
});

test('an unavailable image reference cannot turn an edit into a new paid generation', async () => {
  mockAgent.mockResolvedValue({ text: '', imageCall: { prompt: '修改第二张', referenceImages: ['图2'], aspectRatio: null, transparent: false }, images: images([['图1', 'file:///available.png']]), toolMode: 'native' });
  await mount(); await act(async () => { await app.send({ text: '修改第二张' }); });
  expect(app.messages[1]).toMatchObject({ status: 'error', error: expect.stringContaining('图2') });
  expect(mockGenerate).not.toHaveBeenCalled(); expect(mockEdit).not.toHaveBeenCalled(); expect(mockCopyGenerated).not.toHaveBeenCalled();
});

test('durable partial tasks retain their files and IDs and resume even after an old timestamp or partial delivery', async () => {
  batchCall();
  const task = { id: 'accepted-batch', url: 'https://api.example/v1/images/tasks/accepted-batch', results: [{ localUri: 'file:///generated-images/accepted.png', index: 0 }], terminal: false };
  mockGenerate.mockImplementationOnce(async (request) => {
    expect(request.resultIds).toEqual(['image-1', 'image-2', 'image-3']);
    await request.onTask(task);
    await request.onImages([{ ...batch()[0], uri: task.results[0].localUri }, ...batch().slice(1)]);
    throw new Error('查询中断');
  }).mockResolvedValueOnce(batch());
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  const saved = app.messages[1], key = `image_task:${saved.id}`;
  mockSettings[key] = JSON.stringify({ ...JSON.parse(mockSettings[key]), at: 1 });
  await act(async () => { await app.retry(saved); });
  expect(mockGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ resumeTask: task, resultIds: ['image-1', 'image-2', 'image-3'] }));
  expect(mockAgent).toHaveBeenCalledTimes(1);
  expect(mockDownload).not.toHaveBeenCalled();
  expect(mockSettings[key]).toBeUndefined();
});

test('changing the API of an accepted task fails without silently submitting a replacement', async () => {
  batchCall();
  mockGenerate.mockImplementationOnce(async (request) => { await request.onTask({ id: 'accepted', url: 'https://api.example/tasks/accepted' }); throw new Error('查询中断'); });
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  const saved = app.messages[1];
  await act(async () => { await app.updateProvider('image', { baseUrl: 'https://another.example' }); await app.retry(saved); });
  expect(app.messages[1]).toMatchObject({ status: 'error', error: expect.stringContaining('不匹配') });
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockSettings[`image_task:${saved.id}`]).toBeDefined();
});

test('resuming an accepted batch preserves empty gallery slots and clears their interrupted state', async () => {
  batchCall();
  const task = { id: 'waiting-batch', url: 'https://api.example/tasks/waiting-batch' };
  let originalIds: string[] = [];
  let resumedImages: GeneratedImage[] | undefined;
  mockGenerate.mockImplementationOnce(async (request) => {
    originalIds = [...request.resultIds];
    await request.onTask(task);
    throw new Error('查询中断');
  }).mockImplementationOnce(async () => {
    resumedImages = mockMessages[1].generatedImages?.map((image) => ({ ...image }));
    return batch();
  });
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  expect(app.messages[1].generatedImages?.every((image) => !image.uri && !image.remoteUrl)).toBe(true);
  await act(async () => { await app.retry(app.messages[1]); });
  expect(mockGenerate).toHaveBeenLastCalledWith(expect.objectContaining({ resumeTask: task, resultIds: originalIds }));
  expect(resumedImages).toEqual(originalIds.map((id) => expect.objectContaining({ id, uri: null, status: 'pending', error: null })));
  expect(app.messages[1].status).toBe('complete');
  expect(mockGenerate).toHaveBeenCalledTimes(2);
  expect(mockAgent).toHaveBeenCalledTimes(1);
  expect(mockDownload).not.toHaveBeenCalled();
});

test('deleting an unfinished batch removes durable task files and its saved task', async () => {
  batchCall();
  mockGenerate.mockImplementationOnce(async (request) => { await request.onTask({ id: 'accepted', url: 'https://api.example/tasks/accepted', results: [{ localUri: 'file:///generated-images/accepted.png' }] }); throw new Error('查询中断'); });
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  const key = `image_task:${app.messages[1].id}`;
  await act(async () => { await app.deleteMessage(app.messages[1].id); });
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///generated-images/accepted.png');
  expect(mockSettings[key]).toBeUndefined();
});

test('message deletion cannot race a retry before the retry publishes pending state', async () => {
  batchCall(); mockGenerate.mockResolvedValue(batch());
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  const saved = app.messages[1], reading = deferred<ChatMessage[]>();
  mockListMessages.mockImplementationOnce(() => reading.promise);
  mockDownload.mockResolvedValue('file:///batch-two.png');
  let retrying!: Promise<void>;
  await act(async () => { retrying = app.retryImage(saved, 'image-2'); });
  expect(app.messages[1].status).toBe('complete');
  await act(async () => { await expect(app.deleteMessage(saved.id)).rejects.toThrow('回复还在进行中'); });
  await act(async () => { reading.resolve([...mockMessages]); await retrying; });
  expect(app.messages[1].generatedImages?.[1].uri).toBe('file:///batch-two.png');
});

test('an unreadable local result can be redownloaded once and stale decode callbacks cannot redownload its replacement', async () => {
  batchCall(); mockGenerate.mockResolvedValue([{ ...batch()[0], remoteUrl: 'https://cdn.example/one.png' }]);
  await mount(); await act(async () => { await app.send({ text: '生成三张风景' }); });
  const saved = app.messages[1];
  mockDownload.mockResolvedValue('file:///recovered-one.png');
  await act(async () => { await app.retryImage(saved, 'image-1', 'file:///batch-one.png'); });
  expect(app.messages[1].generatedImages?.[0].uri).toBe('file:///recovered-one.png');
  expect(mockDeleteFile).toHaveBeenCalledWith('file:///batch-one.png');
  await act(async () => { await expect(app.retryImage(saved, 'image-1', 'file:///batch-one.png')).rejects.toThrow('没有可重新下载'); });
  expect(mockDownload).toHaveBeenCalledTimes(1); expect(mockGenerate).toHaveBeenCalledTimes(1);
});
