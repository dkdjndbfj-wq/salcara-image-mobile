import { fetch as expoFetch } from 'expo/fetch';
import { useSyncExternalStore } from 'react';

import type { ProviderProfile } from '../domain';
import { normalizeBaseUrl } from '../domain-utils';
import { getSetting, setSetting } from '../storage/database';
import { getProviderKey } from '../storage/secure-keys';

/** 记忆匣 plugin settings. */
export interface MemoryBoxSettings {
  /** The plugin itself: when off, characters still chat but nothing is remembered or compressed. */
  enabled: boolean;
  /** Semantic search with an embeddings API (OpenAI-compatible providers). */
  embeddings: boolean;
  embeddingProviderId: string | null;
  embeddingModel: string;
  /** Model that extracts, summarizes and reflects in the background (null = the character's chat model). */
  workerProviderId: string | null;
  workerModel: string;
  reflection: boolean;
  /** The assistant space may read facts about the user (never the chats themselves). */
  shareWithAssistant: boolean;
}

export const DEFAULT_MEMORY_BOX_SETTINGS: MemoryBoxSettings = {
  enabled: true,
  embeddings: true,
  embeddingProviderId: null,
  embeddingModel: 'text-embedding-3-small',
  workerProviderId: null,
  workerModel: '',
  reflection: true,
  shareWithAssistant: true,
};

const KEY = 'memory_box_settings';
let current = DEFAULT_MEMORY_BOX_SETTINGS;
let loaded = false;
const listeners = new Set<() => void>();

export function parseMemoryBoxSettings(raw: string | null): MemoryBoxSettings {
  if (!raw) return DEFAULT_MEMORY_BOX_SETTINGS;
  try {
    const value = JSON.parse(raw) as Partial<MemoryBoxSettings>;
    const flag = (item: unknown, fallback: boolean) => (typeof item === 'boolean' ? item : fallback);
    const text = (item: unknown, fallback: string) => (typeof item === 'string' ? item.trim().slice(0, 120) : fallback);
    return {
      enabled: flag(value.enabled, true),
      embeddings: flag(value.embeddings, true),
      embeddingProviderId: typeof value.embeddingProviderId === 'string' ? value.embeddingProviderId : null,
      embeddingModel: text(value.embeddingModel, DEFAULT_MEMORY_BOX_SETTINGS.embeddingModel) || DEFAULT_MEMORY_BOX_SETTINGS.embeddingModel,
      workerProviderId: typeof value.workerProviderId === 'string' ? value.workerProviderId : null,
      workerModel: text(value.workerModel, ''),
      reflection: flag(value.reflection, true),
      shareWithAssistant: flag(value.shareWithAssistant, true),
    };
  } catch {
    return DEFAULT_MEMORY_BOX_SETTINGS;
  }
}

export async function loadMemoryBoxSettings(): Promise<MemoryBoxSettings> {
  if (!loaded) { current = parseMemoryBoxSettings(await getSetting(KEY)); loaded = true; listeners.forEach((listener) => listener()); }
  return current;
}
export async function updateMemoryBoxSettings(patch: Partial<MemoryBoxSettings>): Promise<void> {
  await loadMemoryBoxSettings();
  current = { ...current, ...patch };
  listeners.forEach((listener) => listener());
  await setSetting(KEY, JSON.stringify(current));
}
export function memoryBoxSettings(): MemoryBoxSettings { return current; }
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) void loadMemoryBoxSettings().catch(() => undefined);
  return () => { listeners.delete(listener); };
}
export function useMemoryBoxSettings(): MemoryBoxSettings { return useSyncExternalStore(subscribe, memoryBoxSettings, memoryBoxSettings); }
export function resetMemoryBoxSettingsForTesting(value = DEFAULT_MEMORY_BOX_SETTINGS): void { current = value; loaded = value !== DEFAULT_MEMORY_BOX_SETTINGS; }

// ——— Embeddings ———

/** The OpenAI-compatible provider used for embeddings, if any. */
export function embeddingProvider(providers: ProviderProfile[], settings: MemoryBoxSettings, fallback: ProviderProfile | null): ProviderProfile | null {
  if (!settings.enabled || !settings.embeddings) return null;
  const openai = (item: ProviderProfile | null | undefined): item is ProviderProfile => Boolean(item && item.chatApi !== 'anthropic');
  const chosen = providers.find((item) => item.id === settings.embeddingProviderId);
  if (openai(chosen)) return chosen;
  if (openai(fallback)) return fallback;
  return providers.find(openai) ?? null;
}

/** Providers that answered with an error are skipped for the rest of the session (no repeated slow failures). */
const failedProviders = new Map<string, string>();
export function embeddingFailure(providerId: string): string | undefined { return failedProviders.get(providerId); }
export function resetEmbeddingFailures(): void { failedProviders.clear(); }

/** Embeds texts (short dimensions keep storage small). Returns null when embeddings are unavailable. */
export async function embedTexts(provider: ProviderProfile | null, model: string, texts: string[], signal?: AbortSignal): Promise<number[][] | null> {
  if (!provider || !texts.length || failedProviders.has(provider.id)) return null;
  const apiKey = await getProviderKey(provider.id);
  if (!apiKey) return null;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await expoFetch(`${normalizeBaseUrl(provider.baseUrl)}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts.map((text) => text.slice(0, 2000)), ...(/text-embedding-3/.test(model) ? { dimensions: 512 } : {}) }),
      signal: controller.signal, redirect: 'error', credentials: 'omit',
    });
    if (!response.ok) {
      // 4xx: this provider/model can't embed; don't keep trying. 5xx/429: try again later.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) failedProviders.set(provider.id, `HTTP ${response.status}`);
      return null;
    }
    const payload = await response.json() as { data?: Array<{ embedding?: unknown; index?: number }> };
    const rows = Array.isArray(payload.data) ? [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
    const vectors = rows.map((row) => (Array.isArray(row.embedding) && row.embedding.every((value) => typeof value === 'number') ? row.embedding as number[] : null));
    if (vectors.length !== texts.length || vectors.some((vector) => !vector)) return null;
    return vectors as number[][];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
