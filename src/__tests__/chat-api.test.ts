const mockFetch = jest.fn();
const mockReadFiles = new Map<string, { size?: number; text?: string; base64?: string; exists?: boolean }>();
const mockReadBase64 = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return mockReadFiles.get(this.uri)?.exists ?? true; }
    get size() { return mockReadFiles.get(this.uri)?.size ?? 128; }
    async text() { return mockReadFiles.get(this.uri)?.text ?? '附件正文'; }
    async base64() { mockReadBase64(this.uri); return mockReadFiles.get(this.uri)?.base64 ?? 'YWJjZA=='; }
  },
}));
jest.mock('expo-document-picker', () => ({}));

import { buildChatBody, fetchChatModels, parseChatModels, parseChatText, prepareImagePrompt, sendChat } from '../api/chat-api';
import type { ChatMessage, DocumentAttachment, ReferenceImage } from '../domain';

const request = { baseUrl: 'https://example.com', apiKey: 'test-key', model: 'vision-model', prompt: '按附件做足球场海报' };
const pdf: DocumentAttachment = { id: 'pdf', uri: 'file:///source.pdf', name: '方案.pdf', mimeType: 'application/pdf', size: 128 };
const image: ReferenceImage = { id: 'image', uri: 'file:///source.png', name: '参考.png', mimeType: 'image/png', size: 128 };
const baseMessage: ChatMessage = {
  id: 'm', conversationId: 'c', role: 'user', prompt: '画足球场', mode: 'generate', status: 'complete', providerId: 'p',
  model: 'image-model', quality: 'high', size: '1024x1024', transparent: false, imageUri: null, remoteImageUrl: null,
  references: [], maskUri: null, error: null, elapsedMs: null, createdAt: 1,
};

beforeEach(() => { mockFetch.mockReset(); mockReadFiles.clear(); mockReadBase64.mockClear(); });

test('builds documented Chat Completions image/PDF and local text inputs', async () => {
  const txt: DocumentAttachment = { ...pdf, id: 'txt', uri: 'file:///notes.txt', name: '说明.txt', mimeType: 'text/plain' };
  const body = await buildChatBody({ ...request, documents: [pdf, txt], references: [image] });
  const messages = body.messages as Array<{ content: unknown }>;
  expect(messages[1].content).toEqual(expect.arrayContaining([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJjZA==', detail: 'auto' } },
    { type: 'file', file: { filename: '方案.pdf', file_data: 'data:application/pdf;base64,YWJjZA==' } },
    { type: 'text', text: expect.stringContaining('附件正文') },
  ]));
  expect(JSON.stringify(body)).not.toContain('test-key');
});

test('builds Responses input_file/input_image and does not request server storage', async () => {
  const body = await buildChatBody({ ...request, api: 'responses', documents: [pdf], references: [image] });
  expect(body).toMatchObject({ store: false, stream: false });
  const input = body.input as Array<{ content: unknown }>;
  expect(input[0].content).toEqual(expect.arrayContaining([
    { type: 'input_file', filename: '方案.pdf', file_data: 'data:application/pdf;base64,YWJjZA==' },
    { type: 'input_image', image_url: 'data:image/png;base64,YWJjZA==', detail: 'auto' },
  ]));
});

test('includes generated images as legal user input and excludes failed history pairs', async () => {
  const body = await buildChatBody({ ...request, history: [
    { ...baseMessage, id: 'u1', documents: [pdf] },
    { ...baseMessage, id: 'a1', role: 'assistant', status: 'error' },
    { ...baseMessage, id: 'u2' },
    { ...baseMessage, id: 'a2', role: 'assistant', imageUri: 'file:///result.png' },
  ] });
  expect(mockReadBase64).not.toHaveBeenCalledWith(pdf.uri);
  const messages = body.messages as Array<{ role: string; content: Array<{ type: string }> }>;
  const imageMessage = messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'));
  expect(imageMessage?.role).toBe('user');
  expect(mockReadBase64).toHaveBeenCalledWith('file:///result.png');
});

test('caps history at complete pairs and avoids resending duplicate attachment bytes', async () => {
  const history: ChatMessage[] = [];
  for (let index = 0; index < 13; index += 1) history.push(
    { ...baseMessage, id: `u${index}`, prompt: `轮次-${index}`, references: [image] },
    { ...baseMessage, id: `a${index}`, role: 'assistant', text: `回复-${index}` },
  );
  const body = await buildChatBody({ ...request, history, references: [image] });
  expect(JSON.stringify(body)).not.toContain('轮次-0"');
  expect(JSON.stringify(body)).toContain('轮次-12');
  expect(mockReadBase64.mock.calls.filter(([uri]) => uri === image.uri)).toHaveLength(1);
});

test('rejects excessive accumulated history attachments and oversized text before HTTP', async () => {
  mockReadFiles.set(pdf.uri, { size: 18 * 1024 * 1024 });
  mockReadFiles.set(image.uri, { size: 18 * 1024 * 1024 });
  await expect(sendChat({ ...request, history: [
    { ...baseMessage, documents: [{ ...pdf, size: 18 * 1024 * 1024 }] },
    { ...baseMessage, role: 'assistant', text: '已读' },
  ], references: [{ ...image, size: 18 * 1024 * 1024 }] })).rejects.toThrow('30MB');
  await expect(sendChat({ ...request, prompt: '字'.repeat(120_001) })).rejects.toThrow('12 万字符');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('parses direct and block text responses, refusing incomplete results', () => {
  expect(parseChatText({ choices: [{ message: { content: '你好' } }] }, 'chat-completions')).toBe('你好');
  expect(parseChatText({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'PDF 解析结果' }] }] }, 'responses')).toBe('PDF 解析结果');
  expect(() => parseChatText({ status: 'incomplete', output_text: '半句话' }, 'responses')).toThrow('未完成');
  expect(() => parseChatText({ choices: [{ finish_reason: 'length', message: { content: '半句话' } }] }, 'chat-completions')).toThrow('长度限制');
});

test('does not retry or change protocols after a potentially billable request', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'unsupported PDF' } }) });
  await expect(sendChat({ ...request, documents: [pdf] })).rejects.toThrow('PDF');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/v1/chat/completions');
  expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
});

test('redacts a provider key even when it uses a custom non-sk format', async () => {
  mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid key custom-secret-value' } }) });
  await expect(sendChat({ ...request, apiKey: 'custom-secret-value' })).rejects.toThrow('[已隐藏密钥]');
});

test('forwards cancellation and never sends an already-cancelled request', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(sendChat({ ...request, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockFetch).not.toHaveBeenCalled();
});

test('prepares a single image prompt while preserving the original user requirement', async () => {
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ output_text: '俯视足球场，保留文档中的尺寸标注' }) });
  await expect(prepareImagePrompt({ ...request, api: 'responses', documents: [pdf] })).resolves.toContain(request.prompt);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.instructions).toContain('不得虚构文档内容');
});

test('models list keeps compatible provider IDs without inventing defaults', async () => {
  expect(parseChatModels({ data: [{ id: 'custom-vision' }, { id: 'custom-vision' }, { id: 'gpt-image-2' }, { id: 3 }] })).toEqual(['custom-vision', 'gpt-image-2']);
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) });
  await expect(fetchChatModels('https://example.com/v1', 'test-key')).resolves.toEqual([]);
  expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
});
