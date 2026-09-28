import { runAgentTurn } from '../api/chat-api';
import type { ProviderProfile } from '../domain';
import { getProviderKey } from '../storage/secure-keys';
import type { MemoryBoxSettings } from './settings';
import type { Character } from './types';

/**
 * Background model calls (extract, summarize, reflect). They never stream to
 * the screen and use a small JSON protocol.
 */

export interface WorkerModel { provider: ProviderProfile; model: string }

export function resolveWorker(providers: ProviderProfile[], settings: MemoryBoxSettings, character: Character | null, chatProvider: ProviderProfile | null): WorkerModel | null {
  const byId = (id: string | null | undefined) => providers.find((item) => item.id === id) ?? null;
  const chosen = byId(settings.workerProviderId);
  if (chosen && (settings.workerModel || chosen.chatModel)) return { provider: chosen, model: settings.workerModel || chosen.chatModel! };
  const own = byId(character?.providerId);
  if (own && (character?.model || own.chatModel)) return { provider: own, model: character?.model || own.chatModel! };
  if (chatProvider?.chatModel) return { provider: chatProvider, model: chatProvider.chatModel };
  const any = providers.find((item) => item.chatModel);
  return any ? { provider: any, model: any.chatModel! } : null;
}

export async function completeJson(worker: WorkerModel, system: string, prompt: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const apiKey = await getProviderKey(worker.provider.id);
  if (!apiKey) throw new Error(`没有找到“${worker.provider.name}”的 API 密钥`);
  const result = await runAgentTurn({
    baseUrl: worker.provider.baseUrl, apiKey, model: worker.model, api: worker.provider.chatApi,
    prompt, history: [], system, toolMode: 'none', signal,
  });
  return parseJsonObject(result.text);
}

/** First JSON object in a reply (models sometimes wrap it in prose or ``` fences). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
