const mockFetch = jest.fn();
jest.mock('expo/fetch', () => ({ fetch: (...args: unknown[]) => mockFetch(...args) }));

import { createPhoneAction, parseClock, parseLocalDateTime } from '../agent/actions';
import { normalizeAgent } from '../agent/agents';
import { safeFileName } from '../agent/files';
import { memoryPrompt, rejectsMemory } from '../agent/memory';
import { parseAgentSettings } from '../agent/settings';
import { extractMarkers, visibleStreamingText } from '../agent/tools';
import { parseTrace, traceFileUris } from '../agent/types';
import {
  assertPublicUrl, htmlToText, resolveLocation, parseBingResults, parseDuckDuckGoResults, readWebpage, searchTavily, unwrapBingUrl, webSearch,
} from '../agent/web';

beforeEach(() => mockFetch.mockReset());

test('markers: several tool lines, a legacy image marker and suggestions are extracted', () => {
  const raw = '好的。\n<<<TOOL web_search {"query":"a>>>b"}>>>\n<<<TOOL read_webpage {"url":"https://x.example"}>>>\n<<<IMAGE {"prompt":"猫"}>>>\n<<<SUGGEST ["再详细点","有什么风险", 3]>>>';
  const result = extractMarkers(raw);
  expect(result.text).toBe('好的。');
  expect(result.calls.map((call) => [call.name, call.input])).toEqual([
    ['web_search', { query: 'a>>>b' }], ['read_webpage', { url: 'https://x.example' }], ['generate_image', { prompt: '猫' }],
  ]);
  expect(result.suggestions).toEqual(['再详细点', '有什么风险']);
  expect(extractMarkers('<<<TOOL web_search {bad json}>>>').calls[0]).toMatchObject({ name: 'web_search', input: null });
});

test('streaming hides markers and half-typed markers, but not ordinary text', () => {
  expect(visibleStreamingText('答案\n<<<SUGGEST ["a"')).toBe('答案');
  expect(visibleStreamingText('答案\n<<<SUG')).toBe('答案');
  expect(visibleStreamingText('答案 <')).toBe('答案');
  expect(visibleStreamingText('cat <<<EOF')).toBe('cat <<<EOF');
  expect(visibleStreamingText('a < b')).toBe('a < b');
});

test('HTML becomes readable text with headings and list items; scripts and nav are dropped', () => {
  const html = `<html><head><title>标题 &amp; 副标题</title><script>var x=1</script></head><body>
    <nav>菜单 首页</nav><article><h1>正文标题</h1><p>第一段&nbsp;内容。${'很长的正文。'.repeat(80)}</p><ul><li>要点一</li><li>要点二</li></ul></article>
    <footer>版权</footer></body></html>`;
  const page = htmlToText(html);
  expect(page.title).toBe('标题 & 副标题');
  expect(page.text).toContain('# 正文标题');
  expect(page.text).toContain('- 要点一');
  expect(page.text).not.toContain('var x');
  expect(page.text).not.toContain('菜单');
  expect(page.text).not.toContain('版权');
});

test('Bing and DuckDuckGo result pages are parsed and wrapped links unwrapped', () => {
  const target = 'https://example.com/新闻?id=1';
  const encoded = Buffer.from(target).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  expect(unwrapBingUrl(`https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${encoded}&amp;ntb=1`)).toBe(target);
  const bing = `<ol><li class="b_algo" data-x="1"><h2><a href="https://a.example/1" h="x">第一条 <strong>结果</strong></a></h2><div class="b_caption"><p>摘要 &quot;一&quot;</p></div></li>
    <li class="b_algo"><h2><a href="https://b.example/2">第二条</a></h2><p>摘要二</p></li></ol>`;
  expect(parseBingResults(bing)).toEqual([
    { url: 'https://a.example/1', title: '第一条 结果', snippet: '摘要 "一"' },
    { url: 'https://b.example/2', title: '第二条', snippet: '摘要二' },
  ]);
  const ddg = `<div class="result results_links"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fc.example%2Fp&amp;rut=1">C 标题</a>
    <a class="result__snippet" href="#">C 摘要</a></div>`;
  expect(parseDuckDuckGoResults(ddg)).toEqual([{ url: 'https://c.example/p', title: 'C 标题', snippet: 'C 摘要' }]);
});

test('local network and odd URLs are refused before any request', async () => {
  for (const url of ['http://192.168.1.1/admin', 'http://localhost:8080', 'http://10.0.0.2', 'http://[::1]/', 'http://router.lan', 'http://nas.local/x', 'ftp://example.com', 'http://user:pw@example.com', 'http://intranet', 'http://2130706433/']) {
    expect(() => assertPublicUrl(url)).toThrow();
  }
  expect(assertPublicUrl('https://news.example.com/a?b=1')).toBe('https://news.example.com/a?b=1');
  await expect(readWebpage('http://127.0.0.1/secret')).rejects.toThrow('局域网');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('reading a page falls back to the reader service for script-rendered pages', async () => {
  mockFetch
    .mockResolvedValueOnce({ ok: true, status: 200, url: 'https://spa.example/', headers: { get: (name: string) => (name === 'content-type' ? 'text/html; charset=utf-8' : null) }, text: async () => '<html><body><div id="root"></div></body></html>' })
    .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ data: { title: 'SPA', url: 'https://spa.example/', content: '渲染后的正文' } }) });
  const page = await readWebpage('https://spa.example/');
  expect(page).toMatchObject({ title: 'SPA', text: '渲染后的正文', via: 'reader' });
  expect(mockFetch.mock.calls[1][0]).toBe('https://r.jina.ai/https://spa.example/');
});

test('GBK pages go to the reader service instead of being garbled', async () => {
  mockFetch
    .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: (name: string) => (name === 'content-type' ? 'text/html; charset=gbk' : null) }, text: async () => '<html>乱码</html>' })
    .mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { title: '中文页', content: '正文' } }) });
  expect((await readWebpage('https://gbk.example/')).via).toBe('reader');
});

test('Tavily results are normalized and keys are sent as a bearer token', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ results: [{ title: 'T', url: 'https://t.example', content: '内容', published_date: '2026-09-01' }, { title: 'dup', url: 'https://t.example' }] }) });
  const result = await searchTavily('问题', 'tvly-1', { recency: 'week' });
  expect(result.results).toEqual([{ title: 'T', url: 'https://t.example', snippet: '内容', published: '2026-09-01' }]);
  const [url, init] = mockFetch.mock.calls[0];
  expect(url).toBe('https://api.tavily.com/search');
  expect(init.headers.Authorization).toBe('Bearer tvly-1');
  expect(JSON.parse(init.body)).toMatchObject({ query: '问题', time_range: 'week' });
  mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
  await expect(webSearch('x', { engine: 'tavily', key: 'bad' })).rejects.toThrow('密钥无效');
});

test('phone actions are validated and summarized; nothing runs until confirmed', () => {
  expect(parseClock('7:05')).toEqual([7, 5]);
  expect(parseClock('19点半')).toEqual([19, 30]);
  expect(parseClock('25:00')).toBeNull();
  const alarm = createPhoneAction({ action: 'alarm', time: '07:30', days: [1, 2, 3, 4, 5, 9], title: '晨跑' });
  expect(alarm).toMatchObject({ kind: 'alarm', status: 'ready', summary: '闹钟 07:30 · 工作日 · 晨跑', params: { hour: 7, minute: 30, days: [1, 2, 3, 4, 5] } });
  const now = new Date(2026, 8, 27, 9, 0);
  const event = createPhoneAction({ action: 'calendar', title: '牙医', start: '2026-09-28T14:00', location: '市一院' }, now);
  expect(event.summary).toBe('牙医 · 9月28日 周一 14:00–15:00 · 市一院');
  expect(event.params.end).toBe(new Date(2026, 8, 28, 15, 0).getTime());
  const allDay = createPhoneAction({ action: 'calendar', title: '出游', start: '2026-10-01' }, now);
  expect(allDay.params.allDay).toBe(true);
  expect(createPhoneAction({ action: 'timer', seconds: 330 }).summary).toBe('倒计时 5 分钟 30 秒');
  expect(() => createPhoneAction({ action: 'call', to: 'abc' })).toThrow('电话号码');
  expect(() => createPhoneAction({ action: 'open_url', url: 'javascript:alert(1)' })).toThrow();
  expect(() => createPhoneAction({ action: 'calendar', title: 'x', start: '2026-02-30T10:00' })).toThrow('start');
  expect(() => createPhoneAction({ action: 'hack' })).toThrow('不支持');
  expect(parseLocalDateTime('2026-9-3 08:15')?.date.getHours()).toBe(8);
});

test('file names are made safe and get a known text extension', () => {
  expect(safeFileName('../../etc/passwd')).toBe('etc passwd.md');
  expect(safeFileName('预算.csv')).toBe('预算.csv');
  expect(safeFileName('报告', '<html><body>x</body></html>')).toBe('报告.html');
  expect(safeFileName('数据.exe', 'a,b\n1,2\n')).toBe('数据.csv');
  expect(safeFileName('')).toBe('文件.md');
});

test('memories refuse secrets and render with labels within budget', () => {
  expect(rejectsMemory('我的银行卡号是 6222 0212 3456 7890 123')).toBeTruthy();
  expect(rejectsMemory('邮箱密码是 abc')).toBeTruthy();
  expect(rejectsMemory('用户喜欢简洁的回答')).toBeNull();
  const prompt = memoryPrompt([{ id: 'a', content: '住在杭州', conversationId: null, createdAt: 1, updatedAt: 1 }, { id: 'b', content: '是老师', conversationId: null, createdAt: 2, updatedAt: 2 }]);
  expect(prompt).toContain('M1. 住在杭州');
  expect(prompt).toContain('M2. 是老师');
});

test('settings, agents and traces tolerate bad stored data', () => {
  expect(parseAgentSettings('{"webSearch":"evil","imageCheck":"redraw","memoryEnabled":"yes"}')).toMatchObject({ webSearch: 'auto', imageCheck: 'redraw', memoryEnabled: true });
  expect(parseAgentSettings('not json').webSearch).toBe('auto');
  const agent = normalizeAgent({ name: '  英语  陪练 ', icon: '', color: '#bad', description: '', instructions: 'x', capabilities: ['search', 'nope' as never], starters: [' 你好 ', '', 'a', 'b', 'c', 'd'], providerId: null, model: ' ' });
  expect(agent).toMatchObject({ name: '英语 陪练', icon: '英', capabilities: ['search'], starters: ['你好', 'a', 'b', 'c'], model: null });
  expect(() => normalizeAgent({ ...agent, name: ' ' })).toThrow('名字');
  const trace = parseTrace(JSON.stringify({ steps: [{ id: '1', kind: 'search', title: '搜索', status: 'running', startedAt: 1 }], files: [{ id: 'f', uri: 'file:///f/a.csv', name: 'a.csv', mimeType: 'text/csv', size: 1 }], drafts: ['file:///d.png'] }));
  expect(trace?.steps[0].status).toBe('error');
  expect(traceFileUris(trace)).toEqual(['file:///f/a.csv', 'file:///d.png']);
  expect(parseTrace('{"steps":"x"}')).toBeNull();
});

test('encoded, IPv6 and odd numeric hosts cannot reach the local network', () => {
  for (const url of ['http://%31%39%32.168.1.1/', 'http://１２７.0.0.1/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:7f00:1]/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://127.1/']) {
    expect(() => assertPublicUrl(url)).toThrow();
  }
  expect(assertPublicUrl('http://8.8.8.8/dns')).toBe('http://8.8.8.8/dns');
});

test('long address lists and odd times are handled quickly and safely', () => {
  const started = Date.now();
  expect(() => createPhoneAction({ action: 'email', to: `${'a,'.repeat(90)}@` })).toThrow('邮箱');
  expect(Date.now() - started).toBeLessThan(200);
  expect(createPhoneAction({ action: 'email', to: 'a@x.com; b@y.cn', subject: 'hi' }).params.to).toBe('a@x.com; b@y.cn');
  expect(parseLocalDateTime('2026-10-01T14:75')).toBeNull();
  expect(parseLocalDateTime('2026-10-01T06:30:00Z')?.date.getTime()).toBe(Date.UTC(2026, 9, 1, 6, 30));
  expect(parseLocalDateTime('2026-10-01T06:30:00')?.date.getHours()).toBe(6);
});

test('redirects are followed by hand and never into the local network', async () => {
  expect(resolveLocation('https://a.com/x/y?q=1', '/z')).toBe('https://a.com/z');
  expect(resolveLocation('https://a.com/x/y', 'z')).toBe('https://a.com/x/z');
  expect(resolveLocation('https://a.com/x', '//b.com/p')).toBe('https://b.com/p');
  mockFetch.mockReset();
  mockFetch.mockResolvedValueOnce({ ok: false, status: 302, headers: { get: (name: string) => (name === 'location' ? 'http://192.168.1.1/admin' : null) }, text: async () => '' });
  await expect(readWebpage('https://example.com/start')).rejects.toThrow('局域网');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
});
