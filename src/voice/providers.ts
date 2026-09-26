import type { ProviderProfile } from '../domain';
import { getProviderKey } from '../storage/secure-keys';

/** Speech endpoints (/audio/*, /realtime) are OpenAI-style; Anthropic's API has none. */
export function supportsSpeechApi(provider: ProviderProfile | null | undefined): provider is ProviderProfile {
  return Boolean(provider && provider.chatApi !== 'anthropic');
}

/** The chosen provider, else the chat provider, else any OpenAI-compatible one. */
export function resolveSpeechProvider(providers: ProviderProfile[], preferredId: string | null, chatProvider: ProviderProfile | null): ProviderProfile | null {
  const preferred = providers.find((item) => item.id === preferredId);
  if (supportsSpeechApi(preferred)) return preferred;
  if (supportsSpeechApi(chatProvider)) return chatProvider;
  return providers.find((item) => supportsSpeechApi(item)) ?? null;
}

export async function speechCredentials(provider: ProviderProfile): Promise<{ baseUrl: string; apiKey: string }> {
  const apiKey = await getProviderKey(provider.id);
  if (!apiKey) throw new Error(`没有找到“${provider.name}”的 API 密钥`);
  return { baseUrl: provider.baseUrl, apiKey };
}
