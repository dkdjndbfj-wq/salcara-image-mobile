import { fetch as expoFetch } from 'expo/fetch';

import type { SearchEngine } from './settings';
import type { Source } from './types';

/**
 * Web search and page reading for the agent. Keys stay on the phone and are
 * only sent to the search service the user chose. Pages are fetched without
 * cookies, and addresses on the local network are refused so a web page or a
 * prompt injection can't make the phone read a router or NAS page.
 */

export interface SearchResult extends Source { published?: string }
export interface SearchResponse { engine: string; results: SearchResult[]; answer?: string }
export type Recency = 'day' | 'week' | 'month' | 'year';

export class WebToolError extends Error {
  constructor(message: string) { super(message); this.name = 'WebToolError'; }
}

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const SEARCH_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PAGE_CHARACTERS = 14_000;

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'follow' | 'manual' | 'error' };
/** A response whose body reads stay under the same timeout and cancel button as the request. */
interface TimedResponse {
  ok: boolean;
  status: number;
  url?: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  /** Stops the download when the body is not needed. */
  cancel: () => void;
}

async function timedFetch(url: string, init: FetchInit, timeoutMs: number, signal?: AbortSignal): Promise<TimedResponse> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const release = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
  const failure = (error: unknown): Error => {
    if (signal?.aborted) { const abort = new Error('请求已取消'); abort.name = 'AbortError'; return abort; }
    if (controller.signal.aborted) return new WebToolError(`${hostOf(url)} 响应超时`);
    if (error instanceof WebToolError) return error;
    return new WebToolError(`无法连接 ${hostOf(url)}${error instanceof Error && error.message ? `（${error.message.slice(0, 80)}）` : ''}`);
  };
  let response: Awaited<ReturnType<typeof expoFetch>>;
  try {
    response = await expoFetch(url, { ...init, signal: controller.signal, credentials: 'omit' });
  } catch (error) {
    release();
    throw failure(error);
  }
  const guard = async <T>(read: () => Promise<T>): Promise<T> => {
    try { return await read(); } catch (error) { throw failure(error); } finally { release(); }
  };
  return {
    ok: response.ok,
    status: response.status,
    url: typeof (response as { url?: unknown }).url === 'string' ? (response as { url: string }).url : undefined,
    headers: response.headers,
    text: () => guard(() => response.text()),
    json: () => guard(() => response.json() as Promise<unknown>),
    cancel: () => { release(); controller.abort(); },
  };
}

/**
 * Minimal URL parsing. React Native's URL polyfill does not implement every
 * getter on all versions, so hosts are read with a regular expression.
 */
export function parseWebUrl(raw: string): { protocol: string; userinfo: string; host: string; href: string } | null {
  const match = raw.trim().match(/^([a-z][a-z0-9+.-]*):\/\/(?:([^@/?#]*)@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?([/?#][^\s]*)?$/i);
  if (!match || !match[3]) return null;
  return { protocol: match[1].toLowerCase(), userinfo: match[2] ?? '', host: match[3].toLowerCase(), href: raw.trim() };
}

export function hostOf(url: string): string {
  return parseWebUrl(url)?.host.replace(/^www\./, '') ?? url.slice(0, 60);
}

/** application/x-www-form-urlencoded query string (URLSearchParams is incomplete on some RN versions). */
export function queryString(params: Record<string, string | undefined>): string {
  return Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
}

// ——— HTML helpers ———

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®', times: '×' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Readable text of an HTML page: main content when marked up, headings and list items kept. */
/** Pages are cut before parsing so regex passes stay fast on low-end phones. */
const MAX_PARSE_CHARACTERS = 1_500_000;

export function htmlToText(source: string): { title: string; text: string; description: string } {
  const html = source.length > MAX_PARSE_CHARACTERS ? source.slice(0, MAX_PARSE_CHARACTERS) : source;
  const title = stripTags(html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1]
    ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const description = stripTags(html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? '');
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|select|button)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/i, ' ');
  const main = pickMain(body);
  body = (main ?? body)
    .replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => `\n\n${'#'.repeat(Math.min(3, Number(level)))} ${stripTags(inner)}\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre|dd|dt|figure|header|main)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t 　]+/g, ' ').trim())
    .filter((line, index, lines) => line.length > 0 && !(line === '-' || (line.startsWith('- ') && line.length < 3)) && !(index > 0 && line === lines[index - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text, description };
}

function pickMain(html: string): string | null {
  for (const pattern of [/<article\b[\s\S]*?<\/article>/gi, /<main\b[\s\S]*?<\/main>/gi]) {
    const matches = html.match(pattern);
    if (!matches) continue;
    const longest = matches.reduce((best, item) => (item.length > best.length ? item : best), '');
    if (stripTags(longest).length > 400) return longest;
  }
  return null;
}

// ——— Search engines ———

function recencyTavily(recency?: Recency) { return recency; }
function recencyBrave(recency?: Recency) { return recency ? { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[recency] : undefined; }

async function readJson(response: TimedResponse, service: string): Promise<Record<string, unknown>> {
  if (!response.ok) response.cancel();
  if (response.status === 401 || response.status === 403) throw new WebToolError(`${service} 密钥无效或没有权限`);
  if (response.status === 429) throw new WebToolError(`${service} 请求过于频繁或额度已用完`);
  if (!response.ok) throw new WebToolError(`${service} 返回 HTTP ${response.status}`);
  try { return await response.json() as Record<string, unknown>; } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /超时/.test(error.message))) throw error;
    throw new WebToolError(`${service} 返回了无法解析的结果`);
  }
}

export async function searchTavily(query: string, key: string, options: { recency?: Recency; count?: number; signal?: AbortSignal }): Promise<SearchResponse> {
  const response = await timedFetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, max_results: options.count ?? 6, search_depth: 'basic', include_answer: false, topic: 'general', ...(options.recency ? { time_range: recencyTavily(options.recency) } : {}) }),
  }, SEARCH_TIMEOUT_MS, options.signal);
  const payload = await readJson(response, 'Tavily');
  const results = (Array.isArray(payload.results) ? payload.results : []).map((item) => {
    const record = item as Record<string, unknown>;
    return { title: String(record.title ?? ''), url: String(record.url ?? ''), snippet: String(record.content ?? '').slice(0, 600), published: typeof record.published_date === 'string' ? record.published_date : undefined };
  });
  return { engine: 'Tavily', results: cleanResults(results) };
}

export async function searchBrave(query: string, key: string, options: { recency?: Recency; count?: number; signal?: AbortSignal }): Promise<SearchResponse> {
  const params = queryString({ q: query, count: String(options.count ?? 6), text_decorations: 'false', freshness: recencyBrave(options.recency) });
  const response = await timedFetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  }, SEARCH_TIMEOUT_MS, options.signal);
  const payload = await readJson(response, 'Brave Search');
  const web = payload.web as Record<string, unknown> | undefined;
  const results = (Array.isArray(web?.results) ? web.results : []).map((item) => {
    const record = item as Record<string, unknown>;
    const extra = Array.isArray(record.extra_snippets) ? record.extra_snippets.filter((value): value is string => typeof value === 'string').slice(0, 2).join(' ') : '';
    return { title: stripTags(String(record.title ?? '')), url: String(record.url ?? ''), snippet: stripTags(`${String(record.description ?? '')} ${extra}`).slice(0, 600), published: typeof record.page_age === 'string' ? record.page_age : undefined };
  });
  return { engine: 'Brave', results: cleanResults(results) };
}

export async function searchSearxng(query: string, instance: string, options: { recency?: Recency; count?: number; signal?: AbortSignal }): Promise<SearchResponse> {
  const base = instance.trim().replace(/\/+$/, '').replace(/\/search$/, '');
  if (!/^https?:\/\//i.test(base)) throw new WebToolError('请在“设置 → 联网与手机操作”填写 SearXNG 地址');
  const params = queryString({ q: query, format: 'json', time_range: options.recency });
  const response = await timedFetch(`${base}/search?${params}`, { headers: { Accept: 'application/json' } }, SEARCH_TIMEOUT_MS, options.signal);
  if (response.status === 403) { response.cancel(); throw new WebToolError('SearXNG 实例拒绝了 JSON 请求（需要在 settings.yml 开启 json 格式）'); }
  const payload = await readJson(response, 'SearXNG');
  const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, options.count ?? 6).map((item) => {
    const record = item as Record<string, unknown>;
    return { title: String(record.title ?? ''), url: String(record.url ?? ''), snippet: String(record.content ?? '').slice(0, 600), published: typeof record.publishedDate === 'string' ? record.publishedDate : undefined };
  });
  return { engine: 'SearXNG', results: cleanResults(results) };
}

/** Bing wraps result links as /ck/a?…&u=a1<base64url>; returns the real target. */
export function unwrapBingUrl(href: string): string {
  const decoded = decodeEntities(href);
  if (!/bing\.com\/ck\/a/i.test(decoded)) return decoded;
  const encoded = decoded.match(/[?&]u=a1([^&]+)/)?.[1];
  if (!encoded) return decoded;
  try { return base64UrlDecode(encoded); } catch { return decoded; }
}

function base64UrlDecode(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | alphabet.indexOf(char);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); }
  }
  return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''));
}

export function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<li[^>]+class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '';
    results.push({ url: unwrapBingUrl(link[1]), title: stripTags(link[2]), snippet: stripTags(snippet).replace(/^[\d\s年月日·-]+·\s*/, '').slice(0, 400) });
  }
  return cleanResults(results);
}

export function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"[^>]*>/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    let url = decodeEntities(link[1]);
    const target = url.match(/[?&]uddg=([^&]+)/)?.[1];
    if (target) { try { url = decodeURIComponent(target); } catch { /* keep */ } }
    if (url.startsWith('//')) url = `https:${url}`;
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i)?.[1] ?? '';
    results.push({ url, title: stripTags(link[2]), snippet: stripTags(snippet).slice(0, 400) });
  }
  return cleanResults(results);
}

/** No-setup search: public result pages (Bing first, it is reachable in more regions). */
export async function searchBuiltin(query: string, options: { count?: number; signal?: AbortSignal }): Promise<SearchResponse> {
  const failures: string[] = [];
  try {
    const response = await timedFetch(`https://www.bing.com/search?${queryString({ q: query, setlang: 'zh-Hans', count: '10' })}`, {
      headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6' },
    }, SEARCH_TIMEOUT_MS, options.signal);
    if (response.ok) {
      const results = parseBingResults(await response.text()).slice(0, options.count ?? 6);
      if (results.length) return { engine: 'Bing', results };
      failures.push('Bing 没有返回可读结果');
    } else { response.cancel(); failures.push(`Bing HTTP ${response.status}`); }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    failures.push(error instanceof Error ? error.message : 'Bing 不可用');
  }
  try {
    const response = await timedFetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'User-Agent': MOBILE_UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: queryString({ q: query }),
    }, SEARCH_TIMEOUT_MS, options.signal);
    if (response.ok) {
      const results = parseDuckDuckGoResults(await response.text()).slice(0, options.count ?? 6);
      if (results.length) return { engine: 'DuckDuckGo', results };
      failures.push('DuckDuckGo 没有返回可读结果');
    } else { response.cancel(); failures.push(`DuckDuckGo HTTP ${response.status}`); }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    failures.push(error instanceof Error ? error.message : 'DuckDuckGo 不可用');
  }
  throw new WebToolError(`内置搜索暂时不可用（${failures.join('；')}）。可在“设置 → 联网与手机操作”填写 Tavily 或 Brave 密钥获得稳定搜索`);
}

function cleanResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((item) => {
    if (!/^https?:\/\//i.test(item.url) || seen.has(item.url)) return false;
    seen.add(item.url);
    item.title = item.title.trim() || hostOf(item.url);
    return true;
  });
}

export interface SearchConfig { engine: Exclude<SearchEngine, 'auto' | 'native' | 'off'>; key?: string | null; searxngUrl?: string }

export async function webSearch(query: string, config: SearchConfig, options: { recency?: Recency; count?: number; signal?: AbortSignal } = {}): Promise<SearchResponse> {
  const clean = query.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) throw new WebToolError('搜索关键词为空');
  if (config.engine === 'tavily') {
    if (!config.key) throw new WebToolError('还没有填写 Tavily 密钥');
    return searchTavily(clean, config.key, options);
  }
  if (config.engine === 'brave') {
    if (!config.key) throw new WebToolError('还没有填写 Brave Search 密钥');
    return searchBrave(clean, config.key, options);
  }
  if (config.engine === 'searxng') return searchSearxng(clean, config.searxngUrl ?? '', options);
  return searchBuiltin(clean, options);
}

// ——— Page reading ———

/** Refuses local-network and non-web addresses. */
export function assertPublicUrl(raw: string): string {
  const url = parseWebUrl(raw);
  if (!url) throw new WebToolError('网址格式不正确');
  if (url.protocol !== 'http' && url.protocol !== 'https') throw new WebToolError('只能读取 http(s) 网页');
  const host = url.host.replace(/\.$/, '');
  // Only plain ASCII names and dotted IPv4: percent-escapes, full-width digits and IPv6 literals
  // can all be decoded by the network stack into local addresses the checks below would miss.
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('[')) throw new WebToolError('出于安全考虑，只读取普通域名的网页');
  // Octal / hex / short IPv4 forms (0177.0.0.1, 0x7f.1, 127.1) are refused outright.
  if (/^[0-9.]+$/.test(host) && !/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host)) throw new WebToolError('网址格式不正确');
  if (/(^|\.)0x[0-9a-f]+(\.|$)/.test(host)) throw new WebToolError('网址格式不正确');
  const privateV4 = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.internal')
    || privateV4.test(host) || host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host) || /^::ffff:/.test(host)
    || (!host.includes('.') && !host.includes(':')) || /^\d+$/.test(host)) {
    throw new WebToolError('出于安全考虑，不读取局域网或本机地址');
  }
  if (url.userinfo) throw new WebToolError('不读取带账号密码的网址');
  return url.href;
}

export interface PageContent { url: string; title: string; text: string; via: 'direct' | 'reader' }

function charsetOf(contentType: string, head: string): string {
  const fromHeader = contentType.match(/charset=([\w-]+)/i)?.[1];
  const fromMeta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  return (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
}

/** Resolves a redirect's Location against the page that sent it. */
export function resolveLocation(base: string, location: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(location)) return location;
  const origin = base.match(/^([a-z][a-z0-9+.-]*:)\/\/[^/?#]*/i);
  if (!origin) return location;
  if (location.startsWith('//')) return `${origin[1]}${location}`;
  if (location.startsWith('/')) return `${origin[0]}${location}`;
  const path = base.slice(origin[0].length).replace(/[?#].*$/, '');
  return `${origin[0]}${path.replace(/[^/]*$/, '') || '/'}${location}`;
}

async function readDirect(url: string, signal?: AbortSignal): Promise<PageContent | null> {
  // Redirects are followed by hand so a public page can't bounce the request to a LAN address.
  let current = url;
  let response: TimedResponse | null = null;
  for (let hop = 0; hop <= 5; hop += 1) {
    const next = await timedFetch(current, {
      redirect: 'manual',
      headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7' },
    }, PAGE_TIMEOUT_MS, signal);
    if (next.status === 0) { next.cancel(); return null; } // an opaque redirect: let the reader service try
    if (![301, 302, 303, 307, 308].includes(next.status)) { response = next; break; }
    const location = next.headers.get('location');
    next.cancel();
    if (!location || hop === 5) return null;
    try { current = assertPublicUrl(resolveLocation(current, location)); } catch { throw new WebToolError('网页跳转到了局域网地址，已停止读取'); }
  }
  if (!response) return null;
  if (!response.ok) {
    response.cancel();
    if (response.status === 404 || response.status === 410) throw new WebToolError(`网页不存在（HTTP ${response.status}）`);
    return null;
  }
  const finalUrl = response.url || current;
  try { assertPublicUrl(finalUrl); } catch { response.cancel(); throw new WebToolError('网页跳转到了局域网地址，已停止读取'); }
  const length = Number(response.headers.get('content-length') ?? 0);
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  // Too big, or PDFs / images…: let the reader service convert them.
  if (length > MAX_PAGE_BYTES || (type && !/text\/|html|xml|json/.test(type))) { response.cancel(); return null; }
  const raw = await response.text();
  if (raw.length > MAX_PAGE_BYTES) return null;
  const charset = charsetOf(type, raw.slice(0, 2048));
  if (!/utf-?8|ascii|iso-8859-1|us-ascii/.test(charset)) return null; // GBK/Big5 pages would be garbled here
  if (/html|xml/.test(type) || /^\s*</.test(raw)) {
    const page = htmlToText(raw);
    if (page.text.length < 200) return null; // probably rendered by JavaScript
    return { url: finalUrl, title: page.title || hostOf(finalUrl), text: page.text, via: 'direct' };
  }
  return { url: finalUrl, title: hostOf(finalUrl), text: raw.trim(), via: 'direct' };
}

async function readWithReader(url: string, signal?: AbortSignal): Promise<PageContent> {
  const response = await timedFetch(`https://r.jina.ai/${url}`, {
    headers: { Accept: 'application/json', 'X-Return-Format': 'markdown' },
  }, PAGE_TIMEOUT_MS + 10_000, signal);
  if (!response.ok) response.cancel();
  if (response.status === 429) throw new WebToolError('网页读取服务繁忙，请稍后再试');
  if (!response.ok) throw new WebToolError(`无法读取这个网页（HTTP ${response.status}）`);
  let payload: Record<string, unknown>;
  try { payload = await response.json() as Record<string, unknown>; } catch { throw new WebToolError('网页读取服务返回了无法解析的内容'); }
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const text = typeof data.content === 'string' ? data.content.trim() : '';
  if (!text) throw new WebToolError('这个网页没有可读的正文');
  return { url: typeof data.url === 'string' ? data.url : url, title: typeof data.title === 'string' && data.title ? data.title : hostOf(url), text, via: 'reader' };
}

export async function readWebpage(raw: string, signal?: AbortSignal): Promise<PageContent> {
  const url = assertPublicUrl(raw);
  let direct: PageContent | null = null;
  let directError: unknown = null;
  try { direct = await readDirect(url, signal); } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (error instanceof WebToolError && /不存在|局域网/.test(error.message)) throw error;
    directError = error;
  }
  if (direct) return { ...direct, text: clipText(direct.text) };
  try {
    const page = await readWithReader(url, signal);
    return { ...page, text: clipText(page.text) };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw directError instanceof WebToolError ? directError : error;
  }
}

function clipText(text: string): string {
  return text.length > MAX_PAGE_CHARACTERS ? `${text.slice(0, MAX_PAGE_CHARACTERS)}\n…（正文较长，只读取了前 ${MAX_PAGE_CHARACTERS} 字）` : text;
}

/** Formats search results for the model, numbered to match citations. */
export function formatResults(results: SearchResult[], offset: number): string {
  if (!results.length) return '没有找到结果。可以换个关键词再搜一次。';
  return results.map((item, index) => `[${offset + index + 1}] ${item.title}\n${item.url}${item.published ? `\n发布时间：${item.published}` : ''}\n${item.snippet ?? ''}`.trim()).join('\n\n');
}
