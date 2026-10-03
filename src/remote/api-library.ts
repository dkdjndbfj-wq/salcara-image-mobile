import type { ProviderProfile } from '../domain';
import { createId, normalizeBaseUrl } from '../domain-utils';
import { deleteProviderRecord, listProviders, upsertProvider } from '../storage/database';
import { deleteProviderKey, getProviderKey, saveProviderKey } from '../storage/secure-keys';

export interface ProgrammingApiInput { id?: string | null; name: string; baseUrl: string; key: string }

/** Saving a credential is not selecting a model, an Agent, or another app function. */
export async function saveProgrammingApi(input: ProgrammingApiInput): Promise<ProviderProfile> {
  const name = input.name.trim();
  if (!name) throw new Error('请输入名称');
  if (name.length > 100) throw new Error('名称最多 100 个字');
  let address: URL;
  try { address = new URL(input.baseUrl.trim()); } catch { throw new Error('API 地址格式不正确'); }
  if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
    throw new Error('请使用不含账号、参数的 API 地址');
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  // Read the latest resource, not the editor's stale copy: unrelated model settings survive.
  let existing: ProviderProfile | undefined;
  try { existing = input.id ? (await listProviders()).find((item) => item.id === input.id) : undefined; } catch { throw new Error('没有读到这个 API，请重试'); }
  if (input.id && !existing) throw new Error('这个 API 已被删除，请重新添加');
  const supplied = input.key.trim();
  const sameOrigin = existing && apiOrigin(existing.baseUrl) === address.origin;
  if (existing && !sameOrigin && !supplied) throw new Error('地址已更换，请重新填写密钥');
  let oldKey: string | null = null;
  try { oldKey = existing ? await getProviderKey(existing.id) : null; } catch { throw new Error('没有读到已保存的密钥，请重试'); }
  const key = supplied || (sameOrigin ? oldKey : null);
  if (!key) throw new Error('请输入 API Key');
  const now = Date.now();
  const profile: ProviderProfile = existing
    ? { ...existing, name, baseUrl, updatedAt: now }
    : { id: createId(), name, baseUrl, vendor: 'custom', chatApi: 'chat-completions',
      model: null, chatModel: null, quality: null, aspectRatio: null, resolutionTier: null,
      analysisProviderId: null, imageProviderId: null, createdAt: now, updatedAt: now };
  let keyAttempted = false;
  let recordAttempted = false;
  try {
    if (supplied || !existing) { keyAttempted = true; await saveProviderKey(profile.id, key); }
    recordAttempted = true;
    await upsertProvider(profile);
    return profile;
  } catch {
    // SQLite and SecureStore have no shared transaction. Restore both sides best-effort.
    let restored = true;
    if (recordAttempted) {
      try { if (existing) await upsertProvider(existing); else await deleteProviderRecord(profile.id); } catch { restored = false; }
    }
    if (keyAttempted) {
      try { if (oldKey) await saveProviderKey(profile.id, oldKey); else await deleteProviderKey(profile.id); } catch { restored = false; }
    }
    // Never expose a storage exception: it might contain an entered credential.
    throw new Error(restored ? '没有保存成功，请重试' : '保存失败，请检查这个 API');
  }
}

function apiOrigin(value: string): string | null {
  try { const url = new URL(value); return url.username || url.password ? null : url.origin; } catch { return null; }
}

/** The editor never reads the old secret into its TextInput or into ordinary metadata. */
export function programmingApiDraft(profile?: ProviderProfile): ProgrammingApiInput {
  return { id: profile?.id ?? null, name: profile?.name ?? '', baseUrl: profile?.baseUrl ?? '', key: '' };
}
