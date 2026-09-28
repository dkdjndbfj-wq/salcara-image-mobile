import { randomUUID } from 'expo-crypto';

import type { ChatMessage, Quality } from './domain';

export const ALL_QUALITIES: Quality[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

let fallbackCounter = 0;
/** Unique id. Falls back to a time+random id if the native UUID source is unavailable (e.g. in tests). */
export function createId(): string {
  let id: unknown;
  try { id = randomUUID?.(); } catch { id = undefined; }
  if (typeof id === 'string' && id) return id;
  fallbackCounter = (fallbackCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('请输入 API 地址');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('API 地址格式不正确');
  }

  if (parsed.protocol !== 'https:' && !isLocalHost(parsed.hostname)) {
    throw new Error('API 地址必须使用 HTTPS');
  }

  parsed.hash = '';
  parsed.search = '';
  let path = repairVersionPath(parsed.pathname.replace(/\/+$/, ''));
  // Keep any versioned path as given (/v1, /api/v3, /api/paas/v4, /v1beta/openai, /compatible-mode/v1 …);
  // only a bare host or an unversioned prefix gets the conventional /v1.
  if (!path.split('/').some((segment) => /^v\d+[a-z0-9.]*$/i.test(segment))) {
    path = `${path}/v1`.replace(/\/{2,}/g, '/');
  }
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/, '');
}

/**
 * Older versions appended /v1 to every address, which broke vendors whose API lives under another
 * version (火山方舟 /api/v3, 智谱 /api/paas/v4, 千帆 /v2, Gemini /v1beta/openai). Undo that.
 */
function repairVersionPath(path: string): string {
  return /\/v\d+[a-z0-9.]*(\/openai)?\/v1$/i.test(path) && !/\/v1\/v1$/i.test(path) ? path.replace(/\/v1$/i, '') : path;
}

/** Joins a vendor's own API root and a path without adding anything (HTTPS only). */
export function joinUrl(base: string, path: string): string {
  const root = base.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(root)) throw new Error('API 地址必须使用 HTTPS');
  return `${root}/${path.replace(/^\/+/, '')}`;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '10.0.2.2';
}

export function imageEndpoint(baseUrl: string, path: 'models' | 'images/generations' | 'images/edits'): string {
  return `${normalizeBaseUrl(baseUrl)}/${path}`;
}

export function qualitiesForModel(model: string): Quality[] {
  return model.trim().toLowerCase() === 'gpt-image-2'
    ? ['auto', 'low', 'medium', 'high']
    : ALL_QUALITIES;
}

export { sizeFor } from './image-sizes';

export function parseImageModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return Array.from(
    new Set(
      data
        .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string' && id.toLowerCase().startsWith('gpt-image')),
    ),
  ).sort();
}

export function createConversationTitle(prompt: string): string {
  const compact = prompt.trim().replace(/\s+/g, ' ');
  if (!compact) return '新会话';
  return compact.length > 24 ? `${compact.slice(0, 24)}…` : compact;
}

export function latestCompletedImage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.status === 'complete' && Boolean(message.imageUri));
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}
