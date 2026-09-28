const mockSearch = jest.fn();
const mockRead = jest.fn();
const mockKeys: Record<string, string> = {};
const mockMemories: Array<{ id: string; content: string; conversationId: string | null; createdAt: number; updatedAt: number }> = [];
jest.mock('../agent/web', () => ({
  hostOf: (url: string) => url.replace(/^https?:\/\//, '').split('/')[0],
  webSearch: (...args: unknown[]) => mockSearch(...args),
  readWebpage: (...args: unknown[]) => mockRead(...args),
}));
jest.mock('expo-secure-store', () => ({ getItemAsync: async (key: string) => mockKeys[key] ?? null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined }));
jest.mock('expo-crypto', () => { let next = 0; return { randomUUID: () => `id-${++next}` }; });
jest.mock('../storage/database', () => ({
  getSetting: async () => null, setSetting: async () => undefined,
  searchMessages: async () => [{ conversationId: 'c0', title: '装修', messageId: 'm', role: 'user', snippet: '预算 10 万', createdAt: 0 }],
  listMemories: async () => [...mockMemories],
  insertMemory: async (memory: never) => { mockMemories.push(memory); },
  deleteMemoryRecord: async (id: string) => { const index = mockMemories.findIndex((item) => item.id === id); if (index >= 0) mockMemories.splice(index, 1); },
}));
jest.mock('../agent/files', () => ({ writeGeneratedFile: (name: string, content: string) => ({ id: 'f', uri: `file:///files/${name}`, name, mimeType: 'text/csv', size: content.length }) }));

import { resetMemoryCacheForTesting } from '../agent/memory';
import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from '../agent/settings';
import { createToolbox, NORMAL_LIMITS, resolveSearch, type ToolboxOptions } from '../agent/toolbox';
import { emptyTrace, type AgentTrace, type CustomAgent } from '../agent/types';

let trace: AgentTrace = emptyTrace();
const draw = jest.fn();
function options(patch: Partial<ToolboxOptions> = {}, settings: Partial<AgentSettings> = {}): ToolboxOptions {
  return {
    api: 'chat-completions', baseUrl: 'https://relay.example/v1', settings: { ...DEFAULT_AGENT_SETTINGS, ...settings }, conversationId: 'c1',
    imageAvailable: true, voice: false, research: false, agent: null, memories: [],
    drawImage: (...args) => draw(...args), updateTrace: (update) => { trace = update(trace); }, ...patch,
  };
}
const call = (name: string, input: Record<string, unknown> | null) => ({ id: name, name, input, raw: JSON.stringify(input) });

beforeEach(() => {
  trace = emptyTrace();
  draw.mockReset(); mockSearch.mockReset(); mockRead.mockReset();
  Object.keys(mockKeys).forEach((key) => delete mockKeys[key]);
  mockMemories.length = 0;
  resetMemoryCacheForTesting();
});

test('search source: provider search on official endpoints, keys next, built-in last', async () => {
  const settings = DEFAULT_AGENT_SETTINGS;
  expect(await resolveSearch(settings, 'anthropic', 'https://api.anthropic.com/v1')).toMatchObject({ native: true });
  expect(await resolveSearch(settings, 'responses', 'https://api.openai.com/v1')).toMatchObject({ native: true });
  expect(await resolveSearch(settings, 'chat-completions', 'https://api.openai.com/v1')).toMatchObject({ native: false, config: { engine: 'builtin' } });
  expect(await resolveSearch(settings, 'responses', 'https://relay.example/v1')).toMatchObject({ native: false, config: { engine: 'builtin' } });
  mockKeys['search-key-brave'] = 'b';
  expect(await resolveSearch(settings, 'responses', 'https://relay.example/v1')).toMatchObject({ config: { engine: 'brave', key: 'b' } });
  mockKeys['search-key-tavily'] = 't';
  expect(await resolveSearch(settings, 'responses', 'https://relay.example/v1')).toMatchObject({ config: { engine: 'tavily', key: 't' } });
  expect(await resolveSearch({ ...settings, webSearch: 'native' }, 'responses', 'https://relay.example/v1')).toMatchObject({ native: true });
  expect(await resolveSearch({ ...settings, webSearch: 'off' }, 'responses', 'https://api.openai.com/v1')).toEqual({ native: false, config: null });
});

test('tool set follows settings, voice mode and the custom agent', async () => {
  const names = async (patch: Partial<ToolboxOptions>, settings: Partial<AgentSettings> = {}) => (await createToolbox(options(patch, settings))).toolkit.specs.map((spec) => spec.name);
  expect(await names({})).toEqual(['generate_image', 'web_search', 'read_webpage', 'remember', 'search_history', 'phone_action', 'create_file']);
  expect(await names({ voice: true })).toEqual(['generate_image', 'web_search', 'read_webpage', 'remember']);
  expect(await names({}, { webSearch: 'off', memoryEnabled: false, phoneActions: false, historySearch: false })).toEqual(['generate_image', 'create_file']);
  expect(await names({ research: true })).toContain('update_plan');
  const agent: CustomAgent = { id: 'a', name: '译', icon: '译', color: '#000', description: '', instructions: '只翻译', capabilities: [], starters: [], providerId: null, model: null, createdAt: 0, updatedAt: 0 };
  const { toolkit, instructions } = await createToolbox(options({ agent }));
  expect(toolkit.specs.map((spec) => spec.name)).toEqual([]);
  expect(instructions[0]).toContain('只翻译');
  expect((await createToolbox(options({ research: true }))).toolkit.maxSteps).toBeGreaterThan(NORMAL_LIMITS.steps);
});

test('searches record steps and number sources consistently across calls', async () => {
  mockSearch.mockResolvedValue({ engine: 'Bing', results: [{ title: 'A', url: 'https://a.example/1', snippet: 'a' }, { title: 'B', url: 'https://b.example/2', snippet: 'b' }] });
  const { toolkit } = await createToolbox(options());
  const first = await toolkit.execute(call('web_search', { query: '问题' }), { step: 0, mode: 'native' });
  expect(first.content).toContain('[1] A');
  expect(first.content).toContain('[2] B');
  mockSearch.mockResolvedValue({ engine: 'Bing', results: [{ title: 'C', url: 'https://c.example', snippet: 'c' }, { title: 'A', url: 'https://a.example/1', snippet: 'a' }] });
  const second = await toolkit.execute(call('web_search', { query: '换个词' }), { step: 1, mode: 'native' });
  expect(second.content).toContain('[3] C');
  expect(second.content).toContain('[1] A');
  expect(trace.sources?.map((source) => source.url)).toEqual(['https://a.example/1', 'https://b.example/2', 'https://c.example']);
  expect(trace.steps.map((step) => [step.kind, step.status, step.title])).toEqual([['search', 'done', '搜索：问题'], ['search', 'done', '搜索：换个词']]);
  for (let index = 2; index < NORMAL_LIMITS.searches; index += 1) await toolkit.execute(call('web_search', { query: `q${index}` }), { step: index, mode: 'native' });
  expect((await toolkit.execute(call('web_search', { query: 'too many' }), { step: 9, mode: 'native' })).content).toContain('次数已用完');
});

test('a failed search is shown as a failed step and reported to the model, not thrown', async () => {
  mockSearch.mockRejectedValue(new Error('Bing 不可用'));
  const { toolkit } = await createToolbox(options());
  const result = await toolkit.execute(call('web_search', { query: 'x' }), { step: 0, mode: 'native' });
  expect(result.content).toBe('搜索失败：Bing 不可用');
  expect(trace.steps[0]).toMatchObject({ status: 'error', error: 'Bing 不可用' });
});

test('drawing ends the turn unless self-check is on; redraw is limited to one', async () => {
  draw.mockResolvedValue({ label: '图3', preview: 'data:image/jpeg;base64,AA' });
  let { toolkit } = await createToolbox(options());
  expect(await toolkit.execute(call('generate_image', { prompt: '猫' }), { step: 0, mode: 'native' })).toMatchObject({ terminal: true, keepText: true });
  expect(draw).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: '猫' }), { preview: false });

  trace = emptyTrace();
  ({ toolkit } = await createToolbox(options({}, { imageCheck: 'redraw' })));
  const checked = await toolkit.execute(call('generate_image', { prompt: '猫' }), { step: 0, mode: 'native' });
  expect(checked).toMatchObject({ images: ['data:image/jpeg;base64,AA'] });
  expect(checked.terminal).toBeFalsy();
  expect(await toolkit.execute(call('generate_image', { prompt: '更好的猫' }), { step: 1, mode: 'native' })).toMatchObject({ terminal: true });
  expect((await toolkit.execute(call('generate_image', { prompt: '第三张' }), { step: 2, mode: 'native' })).content).toContain('次数已用完');
  expect(draw).toHaveBeenCalledTimes(3);
  expect(trace.steps.map((step) => step.title)).toEqual(['画图：猫', '检查画面是否符合要求', '重新画图：更好的猫']);

  draw.mockRejectedValueOnce(new Error('上游超时'));
  ({ toolkit } = await createToolbox(options()));
  await expect(toolkit.execute(call('generate_image', { prompt: '狗' }), { step: 0, mode: 'native' })).rejects.toThrow('上游超时');
});

test('phone actions, files, memory and history search', async () => {
  const { toolkit } = await createToolbox(options());
  expect((await toolkit.execute(call('phone_action', { action: 'alarm', time: '6:40' }), { step: 0, mode: 'native' })).content).toContain('确认卡片');
  expect(trace.actions?.[0]).toMatchObject({ kind: 'alarm', status: 'ready' });
  expect((await toolkit.execute(call('phone_action', { action: 'alarm', time: 'soon' }), { step: 0, mode: 'native' })).content).toContain('参数有误');
  expect((await toolkit.execute(call('create_file', { filename: '预算.csv', content: 'a,b\n1,2' }), { step: 0, mode: 'native' })).keepText).toBe(true);
  expect(trace.files?.[0].name).toBe('预算.csv');
  expect((await toolkit.execute(call('remember', { fact: '住在杭州' }), { step: 0, mode: 'native' })).content).toBe('已记住。');
  expect(mockMemories.map((item) => item.content)).toEqual(['住在杭州']);
  expect((await toolkit.execute(call('remember', { fact: '我的密码是 123456' }), { step: 0, mode: 'native' })).content).toContain('没有记录');
  expect((await toolkit.execute(call('search_history', { query: '装修' }), { step: 0, mode: 'native' })).content).toContain('预算 10 万');
  expect((await toolkit.execute(call('web_search', null), { step: 0, mode: 'native' })).content).toContain('不是有效的 JSON');
});

test('forget removes the memory the model refers to by label', async () => {
  mockMemories.push({ id: 'x1', content: '喜欢猫', conversationId: null, createdAt: 1, updatedAt: 1 }, { id: 'x2', content: '住在北京', conversationId: null, createdAt: 2, updatedAt: 2 });
  const { toolkit, instructions } = await createToolbox(options({ memories: [...mockMemories] }));
  expect(instructions.join('\n')).toContain('M2. 住在北京');
  expect((await toolkit.execute(call('forget', { memory_id: 'M2' }), { step: 0, mode: 'native' })).content).toBe('已删除记忆 M2。');
  expect(mockMemories.map((item) => item.id)).toEqual(['x1']);
  expect((await toolkit.execute(call('forget', { memory_id: 'M9' }), { step: 0, mode: 'native' })).content).toContain('没有找到');
});

test('text before non-image tools becomes a note on the next step; native searches become steps', async () => {
  mockSearch.mockResolvedValue({ engine: 'Bing', results: [] });
  const { toolkit } = await createToolbox(options());
  toolkit.onModelStep?.({ step: 0, text: '我先查一下最新数据。', calls: [call('web_search', { query: 'x' })], searches: [], sources: [] });
  await toolkit.execute(call('web_search', { query: 'x' }), { step: 0, mode: 'native' });
  expect(trace.steps[0].note).toBe('我先查一下最新数据。');
  toolkit.onModelStep?.({ step: 1, text: '', calls: [], searches: ['天气'], sources: [{ title: 'W', url: 'https://w.example' }] });
  expect(trace.steps[1]).toMatchObject({ kind: 'search', status: 'done', title: '搜索：天气' });
  expect(trace.sources).toEqual([{ title: 'W', url: 'https://w.example' }]);
});
