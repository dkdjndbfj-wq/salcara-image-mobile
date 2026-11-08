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

import { buildChatBody, clearPdfPageCache, fetchChatModels, labelConversationImages, MAX_REQUEST_BODY_BYTES, parseChatModels, parseChatText, resetToolSupportCache, runAgentTurn, sendChat, serializeChatBody } from '../api/chat-api';
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
  resetToolSupportCache();
  mockFetch.mockReset(); mockReadFiles.clear(); mockReadBase64.mockReset();
  mockRenderPdf.mockReset().mockResolvedValue(mockPdfResult);
  clearPdfPageCache();
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
  expect(body).toMatchObject({ store: false, stream: true });
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

test('sends every complete pair (no round cap) and avoids resending duplicate attachment bytes', async () => {
  const history: ChatMessage[] = [];
  for (let index = 0; index < 13; index += 1) history.push(
    { ...baseMessage, id: `u${index}`, prompt: `轮次-${index}`, references: [image] },
    { ...baseMessage, id: `a${index}`, role: 'assistant', text: `回复-${index}` },
  );
  const body = await buildChatBody({ ...request, history, references: [image] });
  expect(JSON.stringify(body)).toContain('轮次-0"');
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
  await expect(sendChat({ ...request, prompt: '字'.repeat(120_001) })).rejects.toThrow('拆成几次发送');
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
  expect(body).toMatchObject({ model: 'claude-test', max_tokens: 8192, stream: true, system: expect.any(String) });
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

const sse = (events: unknown[]) => ({
  ok: true, status: 200, headers: { get: () => 'text/event-stream' },
  text: async () => events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''),
});
const imageTool = { imageAvailable: true, toolMode: 'native' as const, imageDefaults: '比例 1:1' };

test('agent streams text and returns the image tool call from Chat Completions deltas', async () => {
  mockFetch.mockResolvedValue(sse([
    { choices: [{ delta: { content: '好的，' } }] },
    { choices: [{ delta: { content: '我来画。' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'generate_image', arguments: '{"prompt":"橘猫' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '睡在云上","aspect_ratio":"9:16"}' } }] }, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]));
  const seen: string[] = [];
  const result = await runAgentTurn({ ...request, prompt: '画一只猫，竖版', ...imageTool }, (text) => seen.push(text));
  expect(result.text).toBe('好的，我来画。');
  expect(result.imageCall).toEqual({ prompt: '橘猫睡在云上', referenceImages: [], aspectRatio: '9:16', transparent: false });
  expect(seen).toContain('好的，');
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.stream).toBe(true);
  expect(body.tools[0].function.name).toBe('generate_image');
  expect(body.messages[0].content).toContain('generate_image');
});

test('agent reads Claude tool_use streams and resolves image labels to conversation files', async () => {
  mockFetch.mockResolvedValue(sse([
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'generate_image', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"prompt":"改成夜景",' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"reference_images":["图 2"]}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ]));
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'u1', references: [image] },
    { ...baseMessage, id: 'a1', role: 'assistant', imageUri: 'file:///generated.png', preparedPrompt: '海边小屋', text: '画好了' },
  ];
  const result = await runAgentTurn({ ...request, api: 'anthropic', prompt: '把刚才那张改成夜景', history, ...imageTool });
  expect(result.imageCall?.referenceImages).toEqual(['图2']);
  expect(result.images.get('图2')?.uri).toBe('file:///generated.png');
  expect(result.images.get('图1')?.uri).toBe(image.uri);
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.tools[0]).toMatchObject({ name: 'generate_image', input_schema: expect.any(Object) });
  expect(JSON.stringify(body.messages)).toContain('图2（上一轮你生成的图片）');
  expect(body.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant', 'user']);
});

test.each(['chat-completions', 'responses', 'anthropic'] as const)('history image receipts are application context rather than assistant speech (%s)', async (api) => {
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'u1', prompt: '画海边的小屋' },
    { ...baseMessage, id: 'a1', role: 'assistant', imageUri: 'file:///generated.png', preparedPrompt: '海边小屋', text: '我来画。\n\n[我调用了 generate_image，已生成 图1。作图描述：海边小屋]' },
  ];
  const body = await buildChatBody({ ...request, api, prompt: '把刚才那张改成夜景', history, ...imageTool });
  const messages = (api === 'responses' ? body.input : body.messages) as Array<{ role: string; content: unknown }>;
  const assistants = JSON.stringify(messages.filter((message) => message.role === 'assistant'));
  const context = JSON.stringify(messages.filter((message) => message.role === 'user'));
  expect(assistants).toContain('我来画。');
  expect(assistants).not.toContain('generate_image');
  expect(assistants).not.toContain('生成描述');
  expect(context).toContain('应用记录：上一轮结果');
  expect(context).toContain('图片：图1。生成描述：海边小屋');
  expect(context).toContain('图1（上一轮你生成的图片）');
  expect(context).toContain('把刚才那张改成夜景');
});

test.each(['native', 'text'] as const)('a copied historical image receipt is a protocol error, never a generated image (%s)', async (toolMode) => {
  const seen: string[] = [];
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '我来改地图上的坐标。\n\n[我调用了 generate_image，已生成 图4。作图描述：地图上的坐标一个地方一个]' } }] }]));
  await expect(runAgentTurn({ ...request, ...imageTool, toolMode }, (value) => seen.push(value))).rejects.toThrow('本轮未生成图片');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(seen.at(-1)).toBe('');
});

test('a real image call wins over a copied receipt but the receipt is never displayed', async () => {
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: {
    content: '我来改。\n[我调用了 generate_image，已生成 图4。作图描述：改地图]',
    tool_calls: [{ index: 0, id: 'image', function: { name: 'generate_image', arguments: '{"prompt":"每个城市保留一个标记","reference_images":["图3"]}' } }],
  } }] }]));
  const result = await runAgentTurn({ ...request, ...imageTool });
  expect(result.text).toBe('我来改。');
  expect(result.imageCall).toMatchObject({ prompt: '每个城市保留一个标记', referenceImages: ['图3'] });
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test('native mode does not silently finish when a relay returns only a text image marker', async () => {
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '我来画。\n<<<TOOL generate_image {"prompt":"猫"}>>>' } }] }]));
  await expect(runAgentTurn({ ...request, ...imageTool })).rejects.toThrow('没有发起有效的绘图调用');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  // The user retries deliberately: the next request offers the explicit text
  // protocol instead of repeating the same silently unsupported native mode.
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '我来画。\n<<<TOOL generate_image {"prompt":"猫"}>>>' } }] }]));
  const result = await runAgentTurn({ ...request, ...imageTool });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(result.imageCall?.prompt).toBe('猫');
  expect(JSON.parse(mockFetch.mock.calls[1][1].body).tools).toBeUndefined();
  expect(JSON.parse(mockFetch.mock.calls[1][1].body).messages[0].content).toContain('<<<TOOL 工具名');
});

test('a text protocol marker missing its closing delimiter cannot start a drawing', async () => {
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '我来画。\n<<<TOOL generate_image {"prompt":"猫"}' } }] }]));
  await expect(runAgentTurn({ ...request, ...imageTool, toolMode: 'text' })).rejects.toThrow('本轮未生成图片');
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test('ordinary non-image conversation history remains unchanged', async () => {
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'u1', prompt: '你好' },
    { ...baseMessage, id: 'a1', role: 'assistant', text: '你好，有什么能帮你？' },
  ];
  const body = await buildChatBody({ ...request, history, ...imageTool });
  const assistants = (body.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === 'assistant');
  expect(assistants).toEqual([{ role: 'assistant', content: '你好，有什么能帮你？' }]);
  expect(JSON.stringify(body.messages)).not.toContain('应用记录：');
});

test('agent accepts a non-streaming Responses payload with a function call', async () => {
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ output: [
    { type: 'message', content: [{ type: 'output_text', text: '马上画' }] },
    { type: 'function_call', name: 'generate_image', arguments: '{"prompt":"透明背景贴纸","transparent_background":true}' },
  ] }) });
  const result = await runAgentTurn({ ...request, api: 'responses', prompt: '做个贴纸', ...imageTool });
  expect(result.text).toBe('马上画');
  expect(result.imageCall).toMatchObject({ prompt: '透明背景贴纸', transparent: true });
});

test('a relay that rejects tool definitions is retried once in text-tool mode', async () => {
  mockFetch
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'tools not supported' } }) })
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '这就画。\n<<<IMAGE {"prompt":"雪山日出"}>>>' } }] }, '[DONE]']));
  const result = await runAgentTurn({ ...request, prompt: '画雪山', ...imageTool });
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(result.text).toBe('这就画。');
  expect(result.imageCall?.prompt).toBe('雪山日出');
  const retry = JSON.parse(mockFetch.mock.calls[1][1].body);
  expect(retry.tools).toBeUndefined();
  expect(retry.messages[0].content).toContain('<<<TOOL 工具名');
  expect(retry.messages[0].content).toContain('- generate_image');
  // Remembered for the session: the next turn goes straight to text mode.
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '你好' } }] }]));
  await runAgentTurn({ ...request, prompt: '你好', ...imageTool });
  expect(JSON.parse(mockFetch.mock.calls[2][1].body).tools).toBeUndefined();
});

test('without an image service the model is told it cannot draw and no tools are sent', async () => {
  mockFetch.mockResolvedValue(sse([{ choices: [{ delta: { content: '需要先添加图片服务' } }] }]));
  const result = await runAgentTurn({ ...request, prompt: '画一只猫', imageAvailable: false, toolMode: 'native' });
  expect(result.imageCall).toBeNull();
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body.tools).toBeUndefined();
  expect(body.messages[0].content).toContain('没有配置图片服务');
});

test('labels images in conversation order and only resends recent history pixels', async () => {
  const history: ChatMessage[] = [];
  for (let index = 0; index < 5; index += 1) history.push(
    { ...baseMessage, id: `u${index}` },
    { ...baseMessage, id: `a${index}`, role: 'assistant', imageUri: `file:///gen-${index}.png` },
  );
  const labels = labelConversationImages(history, [image]);
  expect(labels.map((item) => item.label)).toEqual(['图1', '图2', '图3', '图4', '图5', '图6']);
  expect(labels[5].uri).toBe(image.uri);
  await buildChatBody({ ...request, history, references: [image], ...imageTool });
  const read = mockReadBase64.mock.calls.map(([uri]) => uri);
  expect(read).toEqual(['file:///gen-2.png', 'file:///gen-3.png', 'file:///gen-4.png', image.uri]);
});

test('a ten-image batch keeps all tool references in order without duplicating its legacy imageUri', async () => {
  const generatedImages = Array.from({ length: 10 }, (_, index) => ({ id: `batch-${index + 1}`, uri: `file:///batch-${index + 1}.png`, status: 'complete' as const }));
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'batch-question', prompt: '画十张风景' },
    { ...baseMessage, id: 'batch-answer', role: 'assistant', imageUri: generatedImages[0].uri, imageCount: 10, generatedImages },
  ];
  mockFetch.mockResolvedValue(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'edit-batch', function: {
      name: 'generate_image', arguments: JSON.stringify({ prompt: '以第十张为主图，参考第二张改成夜景', reference_images: ['图10', '图2'] }),
    } }] }, finish_reason: 'tool_calls' }] },
  ]));
  const result = await runAgentTurn({ ...request, prompt: '用第十张参考第二张改成夜景', history, references: [image], ...imageTool });
  expect(result.images.size).toBe(11);
  expect([...result.images.entries()].map(([label, entry]) => [label, entry.uri])).toEqual([
    ...generatedImages.map((entry, index) => [`图${index + 1}`, entry.uri]), ['图11', image.uri],
  ]);
  expect(result.imageCall?.referenceImages).toEqual(['图10', '图2']);
  expect(result.imageCall?.referenceImages.map((label) => result.images.get(label)?.uri)).toEqual(['file:///batch-10.png', 'file:///batch-2.png']);
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  const serialized = JSON.stringify(body.messages);
  for (let index = 1; index <= 10; index += 1) {
    expect(serialized.split(`图${index}（上一轮你生成的图片）`)).toHaveLength(2);
  }
  expect(serialized).toContain('图11（用户本轮上传）');
  expect(mockReadBase64.mock.calls.map(([uri]) => uri)).toEqual(['file:///batch-8.png', 'file:///batch-9.png', 'file:///batch-10.png', image.uri]);
});

test('partial batches and legacy single images share the same labels across all chat protocols', async () => {
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'u-batch', references: [image] },
    { ...baseMessage, id: 'a-batch', role: 'assistant', imageUri: 'file:///batch-first.png', generatedImages: [
      { id: 'first', uri: 'file:///batch-first.png', status: 'complete' },
      { id: 'failed', uri: null, remoteUrl: 'https://cdn.example/failed.png', status: 'error', error: 'download failed' },
      { id: 'third', uri: 'file:///batch-third.png', status: 'complete' },
    ] },
    { ...baseMessage, id: 'u-legacy' },
    { ...baseMessage, id: 'a-legacy', role: 'assistant', imageUri: 'file:///legacy.png' },
  ];
  expect(labelConversationImages(history).map((entry) => [entry.label, entry.uri])).toEqual([
    ['图1', image.uri], ['图2', 'file:///batch-first.png'], ['图3', 'file:///batch-third.png'], ['图4', 'file:///legacy.png'],
  ]);
  for (const api of ['chat-completions', 'responses', 'anthropic'] as const) {
    mockReadBase64.mockClear();
    const body = await buildChatBody({ ...request, api, history, ...imageTool });
    const serialized = JSON.stringify(api === 'responses' ? body.input : body.messages);
    for (const label of ['图2', '图3', '图4']) expect(serialized.split(`${label}（上一轮你生成的图片）`)).toHaveLength(2);
    expect(serialized).not.toContain('https://cdn.example/failed.png');
    expect(mockReadBase64.mock.calls.map(([uri]) => uri)).toEqual(['file:///batch-first.png', 'file:///batch-third.png', 'file:///legacy.png']);
  }
});

test.each(['chat-completions', 'responses', 'anthropic'] as const)('a failed first slot keeps gallery positions distinct from global image labels (%s)', async (api) => {
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'u-old', references: [image] },
    { ...baseMessage, id: 'a-old', role: 'assistant', imageUri: 'file:///old.png' },
    { ...baseMessage, id: 'u-batch', prompt: '再画三张' },
    { ...baseMessage, id: 'a-batch', role: 'assistant', imageCount: 3, generatedImages: [
      { id: 'first', uri: null, status: 'error', error: 'private upstream error' },
      { id: 'second', uri: 'file:///second.png', status: 'complete' },
      { id: 'third', uri: 'file:///third.png', status: 'complete' },
    ] },
  ];
  const body = await buildChatBody({ ...request, api, prompt: '把第二张改成夜景', history, ...imageTool });
  const serialized = JSON.stringify(api === 'responses' ? body.input : body.messages);
  expect(serialized).toContain('本组图片位置（共3张，失败或未完成项保留原位）：第1张：生成失败，不可引用；第2张：图3；第3张：图4。');
  expect(serialized).toContain('图3（上一轮你生成的图片）[本组第2张，共3张]');
  expect(serialized).toContain('图4（上一轮你生成的图片）[本组第3张，共3张]');
  expect(serialized).not.toContain('[本组第1张，共3张]');
  expect(serialized).not.toContain('private upstream error');
  expect(JSON.stringify(body)).toContain('失败或未完成项也占位，不能跳过');
  expect(labelConversationImages(history).map((entry) => [entry.label, entry.uri])).toEqual([
    ['图1', image.uri], ['图2', 'file:///old.png'], ['图3', 'file:///second.png'], ['图4', 'file:///third.png'],
  ]);
});

test('an edit of the second gallery slot resolves its mapped label after the first slot fails', async () => {
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'u-batch', prompt: '画两张' },
    { ...baseMessage, id: 'a-batch', role: 'assistant', imageCount: 2, generatedImages: [
      { id: 'first', uri: null, status: 'error' },
      { id: 'second', uri: 'file:///second.png', status: 'complete' },
    ] },
  ];
  mockFetch.mockResolvedValue(sse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'edit-second-slot', function: {
      name: 'generate_image', arguments: JSON.stringify({ prompt: '将本组第二张改成夜景', reference_images: ['图1'] }),
    } }] }, finish_reason: 'tool_calls' }] },
  ]));
  const result = await runAgentTurn({ ...request, prompt: '把第二张改成夜景', history, ...imageTool });
  expect(result.images.size).toBe(1);
  expect(result.imageCall?.referenceImages).toEqual(['图1']);
  expect(result.images.get('图1')?.uri).toBe('file:///second.png');
  const serialized = JSON.stringify(JSON.parse(mockFetch.mock.calls[0][1].body).messages);
  expect(serialized).toContain('第1张：生成失败，不可引用；第2张：图1');
  expect(serialized).toContain('图1（上一轮你生成的图片）[本组第2张，共2张]');
});

test.each(['chat-completions', 'responses', 'anthropic'] as const)('an all-failed batch remains the latest group instead of falling back to an older success (%s)', async (api) => {
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'u-old', prompt: '旧的一张' },
    { ...baseMessage, id: 'a-old', role: 'assistant', imageUri: 'file:///old.png' },
    { ...baseMessage, id: 'u-failed', prompt: '新的三张' },
    { ...baseMessage, id: 'a-failed', role: 'assistant', status: 'error', imageCount: 3, generatedImages: [
      { id: 'first', uri: null, status: 'error' },
      { id: 'second', uri: null, remoteUrl: 'https://cdn.example/second.png?token=private', status: 'error' },
      { id: 'third', uri: null, status: 'pending' },
    ] },
    { ...baseMessage, id: 'u-empty', prompt: '没有内容的失败回合不进入历史' },
    { ...baseMessage, id: 'a-empty', role: 'assistant', status: 'error' },
    { ...baseMessage, id: 'u-pending', prompt: '仍在进行的回合不进入历史' },
    { ...baseMessage, id: 'a-pending', role: 'assistant', status: 'pending', generatedImages: [{ id: 'pending', uri: null, status: 'pending' }] },
  ];
  const body = await buildChatBody({ ...request, api, prompt: '第二张怎么样了', history, ...imageTool });
  const serialized = JSON.stringify(api === 'responses' ? body.input : body.messages);
  expect(serialized).toContain('新的三张');
  expect(serialized).toContain('本组图片位置（共3张，失败或未完成项保留原位）：第1张：生成失败，不可引用；第2张：未下载，不可引用；第3张：尚未完成，不可引用。');
  expect(serialized.lastIndexOf('本组图片位置')).toBeGreaterThan(serialized.indexOf('图1（上一轮你生成的图片）'));
  expect(serialized).not.toContain('https://cdn.example');
  expect(serialized).not.toContain('没有内容的失败回合不进入历史');
  expect(serialized).not.toContain('仍在进行的回合不进入历史');
  expect(labelConversationImages(history).map((entry) => [entry.label, entry.uri])).toEqual([['图1', 'file:///old.png']]);
  expect(mockReadBase64.mock.calls.map(([uri]) => uri)).toEqual(['file:///old.png']);
});

test('a 400 that is not about tools does not disable native tools for later turns', async () => {
  mockFetch
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'image input not supported' } }) })
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'image input not supported' } }) });
  await expect(runAgentTurn({ ...request, prompt: '看图', ...imageTool })).rejects.toThrow('image input not supported');
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '你好' } }] }]));
  await runAgentTurn({ ...request, prompt: '你好', ...imageTool });
  expect(JSON.parse(mockFetch.mock.calls[2][1].body).tools).toBeDefined();
});

test('native-tool streams keep text that contains <<< while streaming', async () => {
  mockFetch.mockResolvedValue(sse([{ choices: [{ delta: { content: 'cat <<<EOF' } }] }]));
  const seen: string[] = [];
  await runAgentTurn({ ...request, prompt: 'bash', ...imageTool }, (text) => seen.push(text));
  expect(seen[0]).toBe('cat <<<EOF');
});

test('Responses streams keep repeated argument fragments intact', async () => {
  mockFetch.mockResolvedValue(sse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc2', name: 'generate_image', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc2', delta: '{"prompt":"a' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc2', delta: 'a' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc2', delta: 'a"}' },
  ]));
  expect((await runAgentTurn({ ...request, api: 'responses', prompt: '画', ...imageTool })).imageCall?.prompt).toBe('aaa');
});

test('follow-up questions reuse rendered PDF pages instead of rendering again', async () => {
  const history: ChatMessage[] = [{ ...baseMessage, id: 'u1', documents: [pdf] }, { ...baseMessage, id: 'a1', role: 'assistant', text: '看完了' }];
  await buildChatBody({ ...request, documents: [pdf] });
  const second = await buildChatBody({ ...request, prompt: '第二页讲了什么', history });
  const third = await buildChatBody({ ...request, prompt: '再总结一下', history: [...history, { ...baseMessage, id: 'u2' }, { ...baseMessage, id: 'a2', role: 'assistant', text: '好的' }] });
  expect(JSON.stringify(second)).toContain('cGFnZS0y');
  expect(JSON.stringify(third)).toContain('cGFnZS0y');
  expect(mockRenderPdf).toHaveBeenCalledTimes(1);
  expect(mockCleanupPdf).toHaveBeenCalledTimes(1);
});

test('only the two most recent history turns with files resend them; older ones become a short note', async () => {
  const doc = (name: string): DocumentAttachment => ({ ...pdf, id: name, uri: `file:///${name}.txt`, name: `${name}.txt`, mimeType: 'text/plain' });
  ['old', 'mid', 'new'].forEach((name) => mockReadFiles.set(`file:///${name}.txt`, { size: 16, text: `${name}-正文` }));
  const history: ChatMessage[] = ['old', 'mid', 'new'].flatMap((name) => [
    { ...baseMessage, id: `u-${name}`, documents: [doc(name)] }, { ...baseMessage, id: `a-${name}`, role: 'assistant' as const, text: '收到' },
  ]);
  const serialized = JSON.stringify(await buildChatBody({ ...request, history }));
  expect(serialized).not.toContain('old-正文');
  expect(serialized).toContain('较早提供的附件：“old.txt”');
  expect(serialized).toContain('mid-正文');
  expect(serialized).toContain('new-正文');
});

test('a history PDF that can no longer be rendered does not block the current question', async () => {
  mockRenderPdf.mockRejectedValueOnce(new Error('PDF 文件损坏或已加密'));
  const body = await buildChatBody({ ...request, prompt: '继续', history: [{ ...baseMessage, documents: [pdf] }, { ...baseMessage, role: 'assistant', text: '好的' }] });
  expect(JSON.stringify(body)).toContain('已无法读取');
});

test('a failed Responses stream reports the provider error instead of an empty reply', async () => {
  mockFetch.mockResolvedValue(sse([{ type: 'response.failed', response: { error: { message: '内容审核未通过' } } }]));
  await expect(runAgentTurn({ ...request, api: 'responses', toolMode: 'native', imageAvailable: true }, () => undefined)).rejects.toThrow('内容审核未通过');
});

test('switching to a text-only model mid-conversation drops pictures and retries once, then remembers', async () => {
  const history: ChatMessage[] = [
    { ...baseMessage, id: 'u0', prompt: '看看这张', references: [image] },
    { ...baseMessage, id: 'a0', role: 'assistant', text: '这是一张参考图' },
  ];
  const textOnly = { ...request, model: 'deepseek-chat-textonly' };
  mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'unknown variant `image_url`, expected `text`' } }) });
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '好的' } }] }]));
  const result = await runAgentTurn({ ...textOnly, prompt: '继续', history });
  expect(result.text).toBe('好的');
  const retried = mockFetch.mock.calls[1][1].body as string;
  expect(retried).not.toContain('image_url');
  expect(retried).toContain('当前模型不支持看图');
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '再次' } }] }]));
  await runAgentTurn({ ...textOnly, prompt: '再问', history });
  expect(mockFetch).toHaveBeenCalledTimes(3);
  expect(mockFetch.mock.calls[2][1].body as string).not.toContain('image_url');
});

test('reasoning and thought signatures travel back with tool calls', async () => {
  const toolkit = {
    specs: [{ name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } }], maxSteps: 3,
    execute: async () => ({ content: '结果' }),
  };
  mockFetch.mockResolvedValueOnce(sse([
    { choices: [{ delta: { reasoning_content: '先想一想' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_search', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }] } }] },
  ]));
  mockFetch.mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '完成' } }] }]));
  await runAgentTurn({ ...request, model: 'deepseek-reasoner', prompt: '查一下', toolMode: 'native', toolkit: toolkit as never });
  const second = JSON.parse(mockFetch.mock.calls[1][1].body);
  const assistantTurn = second.messages.find((item: { role: string; tool_calls?: unknown }) => item.role === 'assistant' && item.tool_calls);
  expect(assistantTurn.reasoning_content).toBe('先想一想');
  expect(assistantTurn.tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'sig' } });
});

test('a step cut off mid tool call runs nothing and says why', async () => {
  const execute = jest.fn(async () => ({ content: '结果' }));
  const toolkit = { specs: [{ name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } }], maxSteps: 4, execute };
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce(sse([
    { choices: [{ delta: { content: '我查一下' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_search', arguments: '{"query":"很长' } }] }, finish_reason: 'length' }] },
  ]));
  const result = await runAgentTurn({ ...request, prompt: '查一下', toolMode: 'native', toolkit: toolkit as never });
  expect(execute).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(result.text).toContain('我查一下');
  expect(result.text).toContain('参数不完整');
});
