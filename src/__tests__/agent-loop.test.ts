const mockFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));
jest.mock('expo-file-system', () => ({ File: class { uri: string; constructor(uri: string) { this.uri = uri; } get exists() { return true; } get size() { return 10; } } }));
jest.mock('../pdf-inputs', () => ({ renderPdfPages: async () => ({ pages: [] }), cleanupPdfRender: async () => undefined }));
jest.mock('expo-document-picker', () => ({}));

import { TOOL_SPECS, type ToolCall } from '../agent/tools';
import { resetToolSupportCache, runAgentTurn, type AgentToolkit, type ToolExecution } from '../api/chat-api';

const request = { baseUrl: 'https://relay.example/v1', apiKey: 'k', model: 'm', prompt: '今天上海天气怎么样', now: new Date(2026, 8, 27, 10, 5) };
const sse = (events: unknown[]) => ({
  ok: true, status: 200, headers: { get: () => 'text/event-stream' },
  text: async () => events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''),
});
const body = (index: number) => JSON.parse(mockFetch.mock.calls[index][1].body);

function toolkit(results: Record<string, ToolExecution> = {}, maxSteps = 6): AgentToolkit & { calls: ToolCall[]; steps: Array<{ text: string; calls: ToolCall[] }> } {
  const calls: ToolCall[] = [];
  const steps: Array<{ text: string; calls: ToolCall[] }> = [];
  return {
    calls, steps, maxSteps,
    specs: [TOOL_SPECS.web_search, TOOL_SPECS.read_webpage, TOOL_SPECS.generate_image],
    execute: async (call) => { calls.push(call); return results[call.name] ?? { content: `${call.name} 的结果` }; },
    onModelStep: ({ text, calls: stepCalls }) => steps.push({ text, calls: stepCalls }),
  };
}

beforeEach(() => { mockFetch.mockReset(); resetToolSupportCache(); });

test('Chat Completions: tool result goes back as a tool message and the model continues', async () => {
  mockFetch
    .mockResolvedValueOnce(sse([
      { choices: [{ delta: { content: '我查一下。' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'web_search', arguments: '{"query":"上海' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ' 天气"}' } }] }, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]))
    .mockResolvedValueOnce(sse([
      { choices: [{ delta: { content: '上海今天多云，22°C [1]。' } }] },
      { choices: [{ delta: { content: '\n<<<SUGGEST ["明天呢","要带伞吗"]>>>' } }] },
      '[DONE]',
    ]));
  const kit = toolkit({ web_search: { content: '[1] 上海天气\nhttps://weather.example\n多云 22°C' } });
  const seen: string[] = [];
  const result = await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: kit, suggestions: true }, (text) => seen.push(text));
  expect(kit.calls).toEqual([{ id: 'call_a', name: 'web_search', input: { query: '上海 天气' }, raw: '{"query":"上海 天气"}' }]);
  expect(result.text).toBe('上海今天多云，22°C [1]。');
  expect(result.suggestions).toEqual(['明天呢', '要带伞吗']);
  expect(result.steps).toBe(2);
  // The pre-tool remark is shown while streaming, then replaced by the answer.
  expect(seen).toContain('我查一下。');
  expect(seen[seen.length - 1]).toBe('上海今天多云，22°C [1]。');
  expect(kit.steps[0]).toMatchObject({ text: '我查一下。' });
  const second = body(1);
  const tail = second.messages.slice(-2);
  expect(tail[0]).toMatchObject({ role: 'assistant', content: '我查一下。', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '{"query":"上海 天气"}' } }] });
  expect(tail[1]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: '[1] 上海天气\nhttps://weather.example\n多云 22°C' });
  expect(second.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['web_search', 'read_webpage', 'generate_image']);
  expect(second.messages[0].content).toContain('2026-09-27 周日 10:05');
  expect(second.messages[0].content).toContain('<<<SUGGEST');
});

test('Claude: assistant blocks are sent back unchanged with tool_result blocks', async () => {
  mockFetch
    .mockResolvedValueOnce(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先搜索。' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"新闻"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]))
    .mockResolvedValueOnce(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '今天的要闻是……' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]));
  const kit = toolkit({ web_search: { content: '结果', images: ['data:image/png;base64,QUJD'] } });
  const result = await runAgentTurn({ ...request, api: 'anthropic', toolMode: 'native', imageAvailable: false, toolkit: kit });
  expect(result.text).toBe('今天的要闻是……');
  const second = body(1);
  const [assistant, user] = second.messages.slice(-2);
  expect(assistant).toEqual({ role: 'assistant', content: [{ type: 'text', text: '先搜索。' }, { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: '新闻' } }] });
  expect(user.role).toBe('user');
  expect(user.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '结果' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }] });
  expect(second.tool_choice).toEqual({ type: 'auto' });
});

test('Responses: function_call and function_call_output items use the call_id', async () => {
  mockFetch
    .mockResolvedValueOnce(sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'read_webpage', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"url":"https://a.example"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'read_webpage', arguments: '{"url":"https://a.example"}' } },
      { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_x', name: 'read_webpage', arguments: '{"url":"https://a.example"}' }] } },
    ]))
    .mockResolvedValueOnce(sse([{ type: 'response.output_text.delta', delta: '文章说的是……' }]));
  const kit = toolkit();
  const result = await runAgentTurn({ ...request, api: 'responses', toolMode: 'native', imageAvailable: false, toolkit: kit });
  expect(kit.calls).toHaveLength(1);
  expect(kit.calls[0]).toMatchObject({ id: 'call_x', input: { url: 'https://a.example' } });
  expect(result.text).toBe('文章说的是……');
  const input = body(1).input;
  expect(input.slice(-2)).toEqual([
    { type: 'function_call', call_id: 'call_x', name: 'read_webpage', arguments: '{"url":"https://a.example"}' },
    { type: 'function_call_output', call_id: 'call_x', output: 'read_webpage 的结果' },
  ]);
});

test('text protocol: markers become tool calls and results come back as a user message', async () => {
  mockFetch
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'tools not supported' } }) })
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '我搜一下。\n<<<TOOL web_search {"query":"油价"}>>>' } }] }]))
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '今天 92 号汽油 7.5 元。' } }] }]));
  const kit = toolkit();
  const result = await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: kit });
  expect(result.toolMode).toBe('text');
  expect(kit.calls[0]).toMatchObject({ name: 'web_search', input: { query: '油价' } });
  expect(result.text).toBe('今天 92 号汽油 7.5 元。');
  const third = body(2);
  expect(third.tools).toBeUndefined();
  const [assistant, user] = third.messages.slice(-2);
  expect(assistant).toEqual({ role: 'assistant', content: '我搜一下。\n<<<TOOL web_search {"query":"油价"}>>>' });
  expect(user.role).toBe('user');
  expect(user.content[0].text).toContain('[工具结果]');
  expect(user.content[0].text).toContain('web_search 的结果');
});

test('a terminal tool ends the turn and keeps the text written before it', async () => {
  mockFetch.mockResolvedValueOnce(sse([
    { choices: [{ delta: { content: '这就画。', tool_calls: [{ index: 0, id: 'c1', function: { name: 'generate_image', arguments: '{"prompt":"猫"}' } }] } }] },
  ]));
  const kit = toolkit({ generate_image: { content: '已生成 图1', terminal: true, keepText: true } });
  const result = await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: kit });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(result.text).toBe('这就画。');
});

test('the last allowed step forbids more tools and asks for a final answer', async () => {
  const toolCall = () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${Math.random()}`, function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }] }]);
  mockFetch.mockResolvedValueOnce(toolCall()).mockResolvedValueOnce(toolCall())
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '根据已有信息……' } }] }]));
  const kit = toolkit({}, 3);
  const result = await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: kit });
  expect(mockFetch).toHaveBeenCalledTimes(3);
  expect(kit.calls).toHaveLength(2);
  const last = body(2);
  expect(last.tool_choice).toBe('none');
  expect(last.messages[0].content).toContain('工具步骤已经用完');
  expect(result.text).toBe('根据已有信息……');
});

test('duplicate or missing tool call ids are made unique across steps', async () => {
  const call = () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }] }]);
  mockFetch.mockResolvedValueOnce(call()).mockResolvedValueOnce(call()).mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '好' } }] }]));
  const kit = toolkit();
  await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: kit });
  const ids = kit.calls.map((item) => item.id);
  expect(new Set(ids).size).toBe(2);
  const tools = body(2).messages.filter((message: { role: string }) => message.role === 'tool').map((message: { tool_call_id: string }) => message.tool_call_id);
  expect(tools).toEqual(ids);
});

test('Claude native web search: server blocks and citations are kept, sources collected', async () => {
  mockFetch.mockResolvedValueOnce(sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"天气"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://w.example/a', title: '天气网', encrypted_content: 'E' }] } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://w.example/a', title: '天气网', cited_text: '多云' } } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: '今天多云。' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
  ]));
  const kit = { ...toolkit(), nativeSearch: true };
  const result = await runAgentTurn({ ...request, baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic', toolMode: 'native', imageAvailable: false, toolkit: kit });
  expect(result.text).toBe('今天多云。');
  expect(result.sources).toEqual([{ url: 'https://w.example/a', title: '天气网' }]);
  const first = body(0);
  expect(first.tools).toContainEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  expect(first.tools.filter((tool: { name: string }) => tool.name === 'web_search')).toHaveLength(1);
});

test('Claude pause_turn resends the paused content so the model can continue', async () => {
  mockFetch
    .mockResolvedValueOnce(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'a' } } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' } },
    ]))
    .mockResolvedValueOnce(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '找到了。' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]));
  const kit = { ...toolkit(), nativeSearch: true };
  const result = await runAgentTurn({ ...request, api: 'anthropic', toolMode: 'native', imageAvailable: false, toolkit: kit });
  expect(result.text).toBe('找到了。');
  const messages = body(1).messages;
  expect(messages[messages.length - 1]).toEqual({ role: 'assistant', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'a' } }] });
});

test('a turn that only used tools and wrote nothing still resolves', async () => {
  mockFetch
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'web_search', arguments: '{}' } }] } }] }]))
    .mockResolvedValueOnce(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]));
  const result = await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: toolkit() });
  expect(result.text).toBe('');
});

test('parallel calls survive repeated ids and missing indexes', async () => {
  mockFetch
    .mockResolvedValueOnce(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'dup', function: { name: 'web_search', arguments: '{"query":"a"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'dup', function: { name: 'web_search', arguments: '{"query":"b"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ id: 'third', function: { name: 'read_webpage', arguments: '{"url":"https://c.example"}' } }] } }] },
    ]))
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '好了' } }] }]));
  const kit = toolkit();
  await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: kit });
  expect(kit.calls.map((call) => call.input)).toEqual([{ query: 'a' }, { query: 'b' }, { url: 'https://c.example' }]);
  expect(new Set(kit.calls.map((call) => call.id)).size).toBe(3);
});

test('text written before a pause is kept; a 400 on a later step is not cached as “no tools”', async () => {
  mockFetch
    .mockResolvedValueOnce(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '第一部分。' } },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' } },
    ]))
    .mockResolvedValueOnce(sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '第二部分。' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]));
  const result = await runAgentTurn({ ...request, api: 'anthropic', toolMode: 'native', imageAvailable: false, toolkit: toolkit() });
  expect(result.text).toBe('第一部分。\n\n第二部分。');

  mockFetch.mockReset();
  mockFetch
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }] }]))
    .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'bad tool message' } }) })
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '答案' } }] }]))
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '下一轮' } }] }]));
  expect((await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: toolkit() })).text).toBe('答案');
  await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: toolkit() });
  expect(body(3).tools).toBeDefined();
});

test('if the relay keeps calling tools on the last step, one tool-free request gets the answer', async () => {
  const toolCall = (id: string) => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'web_search', arguments: '{"query":"x"}' } }] } }] }]);
  mockFetch.mockResolvedValueOnce(toolCall('a')).mockResolvedValueOnce(toolCall('b'))
    .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: '最终回答' } }] }]));
  const result = await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: toolkit({}, 2) });
  expect(result.text).toBe('最终回答');
  expect(body(2).tools).toBeUndefined();
});

test('a non-streaming answer cut at the length limit is kept with a note', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '很长的回答' }, finish_reason: 'length' }] }) });
  const result = await runAgentTurn({ ...request, toolMode: 'native', imageAvailable: true, toolkit: toolkit() });
  expect(result.text).toBe('很长的回答\n\n（输出达到长度上限，已截断）');
});
