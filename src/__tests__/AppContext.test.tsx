import { act, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { ChatMessage, Conversation, DocumentAttachment, ProviderProfile } from '../domain';

let mockProviders: ProviderProfile[] = [];
let mockConversations: Conversation[] = [];
let mockMessages: ChatMessage[] = [];
const mockOrder: string[] = [];
const mockGenerate = jest.fn();
const mockEdit = jest.fn();
const mockSendChat = jest.fn();
const mockPrepare = jest.fn();
const mockDownload = jest.fn();
const mockDeleteLocal = jest.fn();
const mockGetKey = jest.fn();

jest.mock('../api/image-api', () => ({
  generateImage: (...args: unknown[]) => mockGenerate(...args),
  editImage: (...args: unknown[]) => mockEdit(...args),
  normalizeError: (error: unknown) => error instanceof Error ? error : new Error('请求失败'),
}));
jest.mock('../api/chat-api', () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
  prepareImagePrompt: (...args: unknown[]) => mockPrepare(...args),
}));
jest.mock('../document-inputs', () => ({ validateAttachments: jest.fn() }));
jest.mock('../image-inputs', () => ({
  createReferenceFromGenerated: async (uri: string) => ({ id: 'copied-ref', uri: `${uri}-copied.png`, name: '上张图片.png', mimeType: 'image/png', size: 128 }),
}));
jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: jest.fn(async () => {}), deactivateKeepAwake: jest.fn(async () => {}) }));
jest.mock('../storage/secure-keys', () => ({ getProviderKey: (...args: unknown[]) => mockGetKey(...args), deleteProviderKey: jest.fn(async () => {}) }));
jest.mock('../storage/files', () => ({
  downloadPng: (...args: unknown[]) => mockDownload(...args),
  deleteLocalFile: (...args: unknown[]) => mockDeleteLocal(...args),
  RemoteImageDownloadError: class extends Error {
    remoteImageUrl: string;
    constructor(url: string) { super('图片下载失败'); this.remoteImageUrl = url; }
  },
}));
jest.mock('../storage/database', () => ({
  initializeDatabase: async () => {},
  getActiveProviderId: async () => 'image-provider',
  setActiveProviderId: async () => {},
  listProviders: async () => [...mockProviders],
  listConversations: async () => [...mockConversations],
  listMessages: async (id: string) => mockMessages.filter((item) => item.conversationId === id),
  insertConversation: async (conversation: Conversation) => { mockConversations.push(conversation); },
  updateConversation: async (conversation: Conversation) => { mockConversations = mockConversations.map((item) => item.id === conversation.id ? conversation : item); },
  insertMessage: async (message: ChatMessage) => { mockMessages.push(message); },
  updateMessage: async (message: ChatMessage) => {
    if (message.preparedPrompt && message.status === 'pending') mockOrder.push('persist-prepared');
    mockMessages = mockMessages.map((item) => item.id === message.id ? message : item);
  },
  upsertProvider: async (profile: ProviderProfile) => { mockProviders = mockProviders.map((item) => item.id === profile.id ? profile : item); },
  deleteConversationRecord: async (id: string) => {
    const messages = mockMessages.filter((item) => item.conversationId === id);
    mockMessages = mockMessages.filter((item) => item.conversationId !== id);
    mockConversations = mockConversations.filter((item) => item.id !== id);
    return messages;
  },
  deleteProviderRecord: async (id: string) => { mockProviders = mockProviders.filter((item) => item.id !== id); },
}));

import { AppProvider, useApp } from '../state/AppContext';
import { RemoteImageDownloadError } from '../storage/files';

let app: ReturnType<typeof useApp>;
function Probe() { app = useApp(); return null; }
async function mount(mode: 'image' | 'chat' = 'image') {
  await render(<AppProvider><Probe /></AppProvider>);
  await waitFor(() => expect(app.ready).toBe(true));
  await act(async () => { await app.setComposerMode(mode); });
}
const pdf: DocumentAttachment = { id: 'doc', uri: 'file:///document.pdf', name: '场地方案.pdf', mimeType: 'application/pdf', size: 128 };

beforeEach(() => {
  jest.clearAllMocks();
  mockConversations = [];
  mockMessages = [];
  mockOrder.length = 0;
  mockProviders = [
    { id: 'image-provider', name: '生图', baseUrl: 'https://images.example.com/v1', model: 'image-model', quality: 'high',
      aspectRatio: '16:9', resolutionTier: '2K', chatModel: 'own-chat-model', chatApi: 'chat-completions', analysisProviderId: 'analysis-provider', createdAt: 1, updatedAt: 1 },
    { id: 'analysis-provider', name: '解析', baseUrl: 'https://chat.example.com/v1', model: null, quality: null,
      aspectRatio: null, resolutionTier: null, chatModel: 'vision-model', chatApi: 'responses', createdAt: 1, updatedAt: 1 },
  ];
  mockGenerate.mockReset().mockImplementation(async () => { mockOrder.push('generate'); return 'file:///result.png'; });
  mockEdit.mockReset().mockResolvedValue('file:///edited.png');
  mockSendChat.mockReset().mockResolvedValue('足球场有两侧看台。');
  mockPrepare.mockReset().mockImplementation(async () => { mockOrder.push('analyze'); return '用户要求与文档整合后的作图说明'; });
  mockDownload.mockReset().mockResolvedValue('file:///downloaded.png');
  mockGetKey.mockReset().mockImplementation(async (id: string) => `${id}-test-key`);
});

test('chat stores assistant text in the conversation without invoking generation', async () => {
  mockProviders[0].analysisProviderId = null;
  await mount('chat');
  await act(async () => { await app.sendPrompt('描述足球场', [], undefined, false, [pdf]); });
  expect(mockSendChat).toHaveBeenCalledWith(expect.objectContaining({ model: 'own-chat-model', documents: [pdf], prompt: '描述足球场' }));
  expect(mockGenerate).not.toHaveBeenCalled();
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(app.messages[1]).toMatchObject({ role: 'assistant', mode: 'chat', status: 'complete', text: '足球场有两侧看台。', imageUri: null });
});

test('PDF-assisted generation uses the selected analysis key and persists analysis before generation', async () => {
  await mount();
  await act(async () => { await app.sendPrompt('按 PDF 生成足球场', [], undefined, false, [pdf]); });
  expect(mockPrepare).toHaveBeenCalledWith(expect.objectContaining({
    baseUrl: 'https://chat.example.com/v1', apiKey: 'analysis-provider-test-key', model: 'vision-model', api: 'responses', documents: [pdf],
  }));
  expect(mockGenerate).toHaveBeenCalledWith(expect.objectContaining({
    baseUrl: 'https://images.example.com/v1', apiKey: 'image-provider-test-key', model: 'image-model', prompt: '用户要求与文档整合后的作图说明',
  }));
  expect(mockOrder).toEqual(['analyze', 'persist-prepared', 'generate']);
  expect(app.messages[1]).toMatchObject({ status: 'complete', preparedPrompt: '用户要求与文档整合后的作图说明', imageUri: 'file:///result.png' });
});

test('analysis failure prevents the image charge and leaves a manual retry record', async () => {
  mockPrepare.mockRejectedValue(new Error('模型不支持 PDF'));
  await mount();
  await act(async () => { await app.sendPrompt('按 PDF 生成足球场', [], undefined, false, [pdf]); });
  expect(mockGenerate).not.toHaveBeenCalled();
  expect(mockEdit).not.toHaveBeenCalled();
  expect(app.messages[1]).toMatchObject({ status: 'error', error: '模型不支持 PDF' });
  expect(app.generating).toBe(false);
});

test('manual retry reuses a saved preparedPrompt without paying to analyze the document again', async () => {
  mockGenerate.mockRejectedValueOnce(new Error('上游生图暂不可用')).mockResolvedValueOnce('file:///retry.png');
  await mount();
  await act(async () => { await app.sendPrompt('按 PDF 生成足球场', [], undefined, false, [pdf]); });
  const failed = app.messages[1];
  expect(failed.preparedPrompt).toBe('用户要求与文档整合后的作图说明');
  await act(async () => { await app.retryMessage(failed); });
  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(mockGenerate).toHaveBeenCalledTimes(2);
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///retry.png' });
});

test('a returned image URL is only downloaded on retry and never regenerated', async () => {
  mockGenerate.mockRejectedValueOnce(new RemoteImageDownloadError('https://cdn.example.com/result.png'));
  await mount();
  await act(async () => { await app.sendPrompt('生成足球场', [], undefined, false); });
  expect(app.messages[1]).toMatchObject({ status: 'error', remoteImageUrl: 'https://cdn.example.com/result.png' });
  await act(async () => { await app.retryMessage(app.messages[1]); });
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockDownload).toHaveBeenCalledWith('https://cdn.example.com/result.png', expect.any(AbortSignal));
  expect(app.messages[1]).toMatchObject({ status: 'complete', imageUri: 'file:///downloaded.png', remoteImageUrl: null });
});

test('in-flight requests reject double submissions and changes to provider, mode and conversation', async () => {
  let finish!: (uri: string) => void;
  mockGenerate.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
  await mount();
  let pending!: Promise<void>;
  await act(async () => { pending = app.sendPrompt('生成足球场', [], undefined, false); });
  await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1));
  await expect(app.sendPrompt('第二次点击', [], undefined, false)).rejects.toThrow('当前请求尚未完成');
  await expect(app.activateProvider('analysis-provider')).rejects.toThrow('切换服务商');
  await expect(app.setComposerMode('chat')).rejects.toThrow('等待或取消');
  await expect(app.startConversation()).rejects.toThrow('等待或取消');
  await act(async () => { finish('file:///result.png'); await pending; });
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(app.messages).toHaveLength(2);
});

test('continuing an image conversation copies the last generated file as an edit reference', async () => {
  await mount();
  await act(async () => { await app.sendPrompt('生成足球场', [], undefined, false); });
  await act(async () => { await app.sendPrompt('把看台改成蓝色', []); });
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockEdit).toHaveBeenCalledWith(expect.objectContaining({ prompt: '把看台改成蓝色', references: [expect.objectContaining({ uri: 'file:///result.png-copied.png' })] }));
});

test('a separate chat group can discuss generated images without changing the conversation owner', async () => {
  await mount();
  await act(async () => { await app.sendPrompt('生成足球场', [], undefined, false); });
  const conversationId = app.activeConversation!.id;
  await act(async () => { await app.setComposerMode('chat'); });
  await act(async () => { await app.sendPrompt('描述刚才那张图', [], undefined, false); });
  expect(app.activeConversation).toMatchObject({ id: conversationId, providerId: 'image-provider' });
  expect(app.messages[3]).toMatchObject({ providerId: 'analysis-provider', model: 'vision-model', mode: 'chat' });
  expect(mockSendChat).toHaveBeenCalledWith(expect.objectContaining({
    apiKey: 'analysis-provider-test-key', api: 'responses', model: 'vision-model',
    history: expect.arrayContaining([expect.objectContaining({ role: 'assistant', imageUri: 'file:///result.png' })]),
  }));
});

test('deleting a conversation cleans local document attachments together with images', async () => {
  await mount();
  await act(async () => { await app.sendPrompt('按 PDF 生成足球场', [], undefined, false, [pdf]); });
  const id = app.activeConversation!.id;
  await act(async () => { await app.removeConversation(id); });
  expect(mockDeleteLocal).toHaveBeenCalledWith(pdf.uri);
  expect(mockDeleteLocal).toHaveBeenCalledWith('file:///result.png');
  expect(app.messages).toHaveLength(0);
});
