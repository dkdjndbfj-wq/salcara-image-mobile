const mockFetch = jest.fn();
const mockReadFiles = new Map<string, { size?: number; text?: string; base64?: string; exists?: boolean }>();
const mockReadBase64 = jest.fn();
const mockRenderPdf = jest.fn();
const mockCleanupPdf = jest.fn();
const mockPdfResult = {
  directory: 'file:///cache/pdf-render', pageCount: 2,
  pages: [
    { uri: 'file:///cache/pdf-render/page-001.jpg', page: 1, width: 1131, height: 1600, size: 128 },
    { uri: 'file:///cache/pdf-render/page-002.jpg', page: 2, width: 1600, height: 1131, size: 128 },
  ],
};
jest.mock('../pdf-inputs', () => ({
  renderPdfPages: (...args: unknown[]) => mockRenderPdf(...args),
  cleanupPdfRender: (...args: unknown[]) => mockCleanupPdf(...args),
}));
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

import { buildChatBody, fetchChatModels, MAX_REQUEST_BODY_BYTES, parseChatModels, parseChatText, prepareImagePrompt, sendChat, serializeChatBody } from '../api/chat-api';
import type { ChatMessage, DocumentAttachment, ReferenceImage } from '../domain';

const request = { baseUrl: 'https://example.com', apiKey: 'test-key', model: 'vision-model', prompt: '按附件做足球场海报' };
const pdf: DocumentAttachment = { id: 'pdf', uri: 'file:///source.pdf', name: '方案.pdf', mimeType: 'application/pdf', size: 128 };
const image: ReferenceImage = { id: 'image', uri: 'file:///source.png', name: '参考.png', mimeType: 'image/png', size: 128 };
const baseMessage: ChatMessage = {
  id: 'm', conversationId: 'c', role: 'user', prompt: '画足球场', mode: 'generate', status: 'complete', providerId: 'p',
  model: 'image-model', quality: 'high', size: '1024x1024', transparent: false, imageUri: null, remoteImageUrl: null,
  references: [], maskUri: null, error: null, elapsedMs: null, createdAt: 1,
};

beforeEach(() => {
  mockFetch.mockReset(); mockReadFiles.clear(); mockReadBase64.mockReset();
  mockRenderPdf.mockReset().mockResolvedValue(mockPdfResult);
  mockCleanupPdf.mockReset();
  mockReadFiles.set(mockPdfResult.pages[0].uri, { size: 128, base64: 'cGFnZS0x' });
  mockReadFiles.set(mockPdfResult.pages[1].uri, { size: 128, base64: 'cGFnZS0y' });
});

test('builds Chat Completions with every locally rendered PDF page and local text inputs', async () => {
  const txt: DocumentAttachment = { ...pdf, id: 'txt', uri: 'file:///notes.txt', name: '说明.txt', mimeType: 'text/plain' };
  const body = await buildChatBody({ ...request, documents: [pdf, txt], references: [image] });
  const messages = body.messages as Array<{ content: unknown }>;
  expect(messages[1].content).toEqual(expect.arrayContaining([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJjZA==', detail: 'auto' } },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,cGFnZS0x', detail: 'auto' } },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,cGFnZS0y', detail: 'auto' } },
    { type: 'text', text: expect.stringContaining('方案.pdf”第 1 / 2 页') },
    { type: 'text', text: expect.stringContaining('方案.pdf”第 2 / 2 页') },
    { type: 'text', text: expect.stringContaining('附件正文') },
  ]));
  expect(JSON.stringify(body)).not.toContain('test-key');
  expect(JSON.stringify(body)).not.toContain('file_data');
  expect(mockReadBase64).not.toHaveBeenCalledWith(pdf.uri);
  expect(mockRenderPdf).toHaveBeenCalledWith(pdf.uri, undefined);
  expect(mockCleanupPdf).toHaveBeenCalledWith(mockPdfResult);
});

test('builds Responses with rendered PDF input_images and does not request server storage', async () => {
  const body = await buildChatBody({ ...request, api: 'responses', documents: [pdf], references: [image] });
  expect(body).toMatchObject({ store: false, stream: false });
  const input = body.input as Array<{ content: unknown }>;
  expect(input[0].content).toEqual(expect.arrayContaining([
    { type: 'input_image', image_url: 'data:image/jpeg;base64,cGFnZS0x', detail: 'auto' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,cGFnZS0y', detail: 'auto' },
    { type: 'input_image', image_url: 'data:image/png;base64,YWJjZA==', detail: 'auto' },
  ]));
  expect(JSON.stringify(body)).not.toContain('input_file');
});

test('includes generated images as legal user input and excludes failed history pairs', async () => {
  const body = await buildChatBody({ ...request, history: [
    { ...baseMessage, id: 'u1', documents: [pdf] },
    { ...baseMessage, id: 'a1', role: 'assistant', status: 'error' },
    { ...baseMessage, id: 'u2' },
    { ...baseMessage, id: 'a2', role: 'assistant', imageUri: 'file:///result.png' },
  ] });
  expect(mockReadBase64).not.toHaveBeenCalledWith(pdf.uri);
  expect(mockRenderPdf).not.toHaveBeenCalled();
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
  mockReadFiles.set(mockPdfResult.pages[0].uri, { size: 18 * 1024 * 1024, base64: 'page' });
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

test('sends an unknown local file through compatible file-input protocols', async () => {
  const binary: DocumentAttachment = { id: 'bin', uri: 'file:///model.bin', name: 'model.bin', mimeType: 'application/octet-stream', size: 128 };
  mockReadFiles.set(binary.uri, { size: 128, base64: 'AAECAw==' });
  const responses = await buildChatBody({ ...request, api: 'responses', documents: [binary] });
  expect((responses.input as Array<{ content: unknown[] }>)[0].content).toContainEqual({ type: 'input_file', filename: 'model.bin', file_data: 'data:application/octet-stream;base64,AAECAw==' });
  const completions = await buildChatBody({ ...request, documents: [binary] });
  expect((completions.messages as Array<{ content: unknown[] }>)[1].content).toContainEqual({ type: 'file', file: { filename: 'model.bin', file_data: 'data:application/octet-stream;base64,AAECAw==' } });
});

test('Claude Messages receives PDF page images instead of ignored native document blocks', async () => {
  const body = await buildChatBody({ ...request, api: 'anthropic', model: 'claude-test', documents: [pdf], references: [image] });
  expect(body).toMatchObject({ model: 'claude-test', max_tokens: 4096, stream: false, system: expect.any(String) });
  expect(body).not.toHaveProperty('instructions');
  const messages = body.messages as Array<{ role: string; content: unknown[] }>;
  expect(messages[0].role).toBe('user');
  expect(messages[0].content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'cGFnZS0x' } });
  expect(messages[0].content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'cGFnZS0y' } });
  expect(messages[0].content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJjZA==' } });
  expect(JSON.stringify(body)).not.toContain('data:application/pdf;base64,');
  expect(JSON.stringify(body)).not.toContain('"type":"document"');
});

test('Claude chat and model discovery use the native endpoint and authentication', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: '已收到 PDF' }] }) });
  await expect(sendChat({ ...request, api: 'anthropic', documents: [pdf] })).resolves.toBe('已收到 PDF');
  expect(mockFetch.mock.calls[0][0]).toBe('https://example.com/v1/messages');
  expect(mockFetch.mock.calls[0][1]).toMatchObject({ headers: { 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' }, redirect: 'error', credentials: 'omit' });
  expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-test', type: 'model' }] }) });
  await expect(fetchChatModels(request.baseUrl, request.apiKey, 'anthropic')).resolves.toEqual(['claude-test']);
  expect(mockFetch.mock.calls[1][1].headers).toEqual({ 'x-api-key': 'test-key', 'anthropic-version': '2023-06-01' });
});

test('Claude content parsing excludes reasoning blocks and refuses incomplete outputs', () => {
  expect(parseChatText({ content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }], stop_reason: 'end_turn' }, 'anthropic')).toBe('第一段\n第二段');
  expect(() => parseChatText({ content: [{ type: 'text', text: '半句话' }], stop_reason: 'max_tokens' }, 'anthropic')).toThrow('长度限制');
  expect(() => parseChatText({ content: [{ type: 'text', text: '半句话' }], stop_reason: 'pause_turn' }, 'anthropic')).toThrow('未完成');
  expect(() => parseChatText({ content: [{ type: 'text', text: '半句话' }], stop_reason: 'model_context_window_exceeded' }, 'anthropic')).toThrow('未完成');
});

test('Salcara Claude can use local PDF pages through each selected visual protocol without a special blocker', async () => {
  for (const api of ['chat-completions', 'responses', 'anthropic'] as const) {
    const body = await buildChatBody({ ...request, baseUrl: 'https://salcara.top', model: 'claude-test', api, documents: [pdf] });
    const serialized = JSON.stringify(body);
    expect(serialized).toContain('cGFnZS0x');
    expect(serialized).toContain('cGFnZS0y');
    expect(serialized).not.toContain('application/pdf');
  }
});

test('failed or expired history PDFs do not block a current Salcara Claude text-only request', async () => {
  const history: ChatMessage[] = [
    { ...baseMessage, documents: [pdf] }, { ...baseMessage, role: 'assistant', status: 'error' },
    { ...baseMessage, documents: [pdf] }, { ...baseMessage, role: 'assistant', text: '很早的 PDF' },
  ];
  for (let index = 0; index < 12; index += 1) history.push({ ...baseMessage, id: `u${index}` }, { ...baseMessage, id: `a${index}`, role: 'assistant', text: '后续对话' });
  await expect(buildChatBody({ ...request, baseUrl: 'https://salcara.top', model: 'claude-test', history })).resolves.toHaveProperty('messages');
  expect(mockReadBase64).not.toHaveBeenCalled();
  expect(mockRenderPdf).not.toHaveBeenCalled();
});

test('checks the serialized request size including Base64 and UTF-8 instead of only raw attachment size', async () => {
  const framing = JSON.stringify({ value: '' }).length;
  const fitsExactly = { value: 'a'.repeat(MAX_REQUEST_BODY_BYTES - framing) };
  expect(serializeChatBody(fitsExactly).length).toBe(MAX_REQUEST_BODY_BYTES);
  expect(() => serializeChatBody({ value: `${fitsExactly.value.slice(1)}中` })).toThrow('32MB');
  mockReadFiles.set(image.uri, { size: 18 * 1024 * 1024, base64: 'a'.repeat(24 * 1024 * 1024) });
  mockReadFiles.set('file:///second.png', { size: 8 * 1024 * 1024, base64: 'a'.repeat(11 * 1024 * 1024) });
  await expect(sendChat({ ...request, api: 'anthropic', references: [{ ...image, size: 18 * 1024 * 1024 }, { ...image, id: 'second', uri: 'file:///second.png', size: 8 * 1024 * 1024 }] })).rejects.toThrow('32MB');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('counts only rendered PDF bytes in transport totals and renders duplicate history PDFs once', async () => {
  mockReadFiles.set(pdf.uri, { size: 20 * 1024 * 1024 });
  mockReadFiles.set(image.uri, { size: 18 * 1024 * 1024 });
  const largePdf = { ...pdf, size: 20 * 1024 * 1024 };
  const body = await buildChatBody({ ...request, history: [
    { ...baseMessage, documents: [largePdf] }, { ...baseMessage, role: 'assistant', text: '方案里有一片球场' },
    { ...baseMessage, documents: [largePdf] }, { ...baseMessage, role: 'assistant', text: '继续分析方案' },
  ], references: [{ ...image, size: 18 * 1024 * 1024 }] });
  expect(JSON.stringify(body)).toContain('cGFnZS0x');
  expect(mockRenderPdf).toHaveBeenCalledTimes(1);
  expect(mockCleanupPdf).toHaveBeenCalledTimes(1);
});

test('rejects empty or incomplete PDF render results and always cleans their cache', async () => {
  mockRenderPdf.mockResolvedValueOnce({ ...mockPdfResult, pageCount: 0, pages: [] });
  await expect(sendChat({ ...request, documents: [pdf] })).rejects.toThrow('未能完整解析');
  mockRenderPdf.mockResolvedValueOnce({ ...mockPdfResult, pageCount: 3 });
  await expect(sendChat({ ...request, documents: [pdf] })).rejects.toThrow('未能完整解析');
  mockRenderPdf.mockResolvedValueOnce({ ...mockPdfResult, pageCount: 13 });
  await expect(sendChat({ ...request, documents: [pdf] })).rejects.toThrow('12 页');
  expect(mockCleanupPdf).toHaveBeenCalledTimes(3);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('renderer failure or empty page prevents HTTP and cleans every completed render', async () => {
  mockRenderPdf.mockRejectedValueOnce(new Error('PDF 损坏或已加密'));
  await expect(sendChat({ ...request, documents: [pdf] })).rejects.toThrow('损坏或已加密');
  expect(mockCleanupPdf).not.toHaveBeenCalled();
  mockReadFiles.set(mockPdfResult.pages[0].uri, { size: 128, base64: '' });
  await expect(sendChat({ ...request, documents: [pdf] })).rejects.toThrow('第 1 页为空');
  expect(mockCleanupPdf).toHaveBeenCalledWith(mockPdfResult);
  expect(mockFetch).not.toHaveBeenCalled();
});

test('cancellation during PDF page reads cleans the cache and never sends a paid request', async () => {
  const controller = new AbortController();
  mockReadBase64.mockImplementationOnce(() => controller.abort());
  await expect(sendChat({ ...request, documents: [pdf], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockCleanupPdf).toHaveBeenCalledWith(mockPdfResult);
  expect(mockFetch).not.toHaveBeenCalled();
  mockReadBase64.mockReset();
});
