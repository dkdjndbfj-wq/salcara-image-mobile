import { randomUUID } from 'expo-crypto';

import type { AspectRatio, ChatMessage, Quality, ResolutionTier } from './domain';

export const RESOLUTION_MAP: Record<AspectRatio, Record<ResolutionTier, string>> = {
  '1:1': { '1K': '1024x1024', '2K': '2048x2048', '4K': '2880x2880' },
  '16:9': { '1K': '1536x1024', '2K': '2048x1152', '4K': '3840x2160' },
  '9:16': { '1K': '1024x1536', '2K': '1152x2048', '4K': '2160x3840' },
};

export const ALL_QUALITIES: Quality[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

export function createId(): string {
  return randomUUID();
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
  let path = parsed.pathname.replace(/\/+$/, '');
  if (!path.toLowerCase().endsWith('/v1')) {
    path = `${path}/v1`.replace(/\/{2,}/g, '/');
  }
  parsed.pathname = path;
  return parsed.toString().replace(/\/$/, '');
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

export function sizeFor(aspectRatio: AspectRatio, tier: ResolutionTier): string {
  return RESOLUTION_MAP[aspectRatio][tier];
}

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
