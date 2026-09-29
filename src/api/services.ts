import { useSyncExternalStore } from 'react';

import type { ProviderProfile } from '../domain';
import { createId } from '../domain-utils';
import { getSetting, setSetting, upsertProvider } from '../storage/database';
import { deleteProviderKey, getProviderKey, saveProviderKey } from '../storage/secure-keys';
import { fetchChatModels } from './chat-api';
import { vendorById, vendorForService, type Vendor } from './vendors';

/**
 * A “service” is one account at one vendor: an address and a key (stored in the secure store under the
 * service id), plus a vendor's extra fields. Every function — chat, drawing, recognition, synthesis,
 * realtime — then picks a service and one of its models.
 */

const secretKey = (serviceId: string, field: string) => `${serviceId}.${field}`;

/** Every credential of a service, for building a request. */
export async function serviceValues(service: ProviderProfile): Promise<Record<string, string>> {
  const vendor = vendorForService(service);
  const apiKey = (await getProviderKey(service.id)) ?? '';
  const values: Record<string, string> = { ...(service.extra ?? {}), apiKey, accessKey: apiKey };
  for (const field of vendor.fields ?? []) {
    if (field.secret) values[field.key] = (await getProviderKey(secretKey(service.id, field.key))) ?? '';
  }
  return values;
}

export async function saveServiceSecrets(serviceId: string, vendor: Vendor, key: string, secrets: Record<string, string>): Promise<void> {
  if (key.trim()) await saveProviderKey(serviceId, key);
  for (const field of vendor.fields ?? []) {
    const value = secrets[field.key]?.trim();
    if (field.secret && value) await saveProviderKey(secretKey(serviceId, field.key), value);
  }
}

export async function hasServiceSecret(serviceId: string, field: string): Promise<boolean> {
  return Boolean(await getProviderKey(secretKey(serviceId, field)));
}

export async function deleteServiceSecrets(service: ProviderProfile): Promise<void> {
  await deleteProviderKey(service.id).catch(() => undefined);
  for (const field of vendorForService(service).fields ?? []) {
    if (field.secret) await deleteProviderKey(secretKey(service.id, field.key)).catch(() => undefined);
  }
  await setSetting(modelsKey(service.id), null).catch(() => undefined);
  const next = { ...cache };
  delete next[service.id];
  cache = next;
  notify();
}

// ——— model lists ———

const modelsKey = (serviceId: string) => `service_models:${serviceId}`;
let cache: Record<string, string[]> = {};
const EMPTY: string[] = [];
const loaded = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** The service's model list as last read (empty until read once). */
export function cachedModels(serviceId: string | null | undefined): string[] {
  if (!serviceId) return EMPTY;
  if (!loaded.has(serviceId)) {
    loaded.add(serviceId);
    void getSetting(modelsKey(serviceId)).then((raw) => {
      try {
        const list: unknown = JSON.parse(raw || '[]');
        if (Array.isArray(list) && list.length && !cache[serviceId]) { cache = { ...cache, [serviceId]: list.filter((item): item is string => typeof item === 'string') }; notify(); }
      } catch { /* ignore */ }
    }).catch(() => undefined);
  }
  return cache[serviceId] ?? EMPTY;
}

export function useServiceModels(serviceId: string | null | undefined): string[] {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => cachedModels(serviceId), () => cachedModels(serviceId),
  );
}

/** Reads the model list from the service (when the vendor has one) and remembers it. */
export async function refreshServiceModels(service: ProviderProfile, keyOverride?: string): Promise<string[]> {
  const vendor = vendorForService(service);
  if (!vendor.lists || !service.baseUrl) return [];
  const key = keyOverride ?? (await getProviderKey(service.id));
  if (!key) throw new Error(`没有找到“${service.name}”的 API 密钥`);
  const list = await fetchChatModels(service.baseUrl, key, service.chatApi ?? vendor.chatApi ?? 'chat-completions');
  rememberModels(service.id, list);
  return list;
}

export function rememberModels(serviceId: string, list: string[]): void {
  cache = { ...cache, [serviceId]: list };
  loaded.add(serviceId);
  notify();
  void setSetting(modelsKey(serviceId), JSON.stringify(list)).catch(() => undefined);
}

// ——— migration ———

/**
 * Early 1.5 builds kept speech vendors in a separate list with their own keys. Each becomes an
 * ordinary service, and voice settings that pointed at it (`svc:<id>`) now point at the service.
 */
export async function migrateSpeechServices(updateVoice: (map: Record<string, string>) => Promise<void>): Promise<void> {
  const raw = await getSetting('speech_services');
  if (!raw) return;
  let list: Array<{ id: string; vendor: string; name: string; config?: Record<string, string>; createdAt?: number }> = [];
  try { const value: unknown = JSON.parse(raw); if (Array.isArray(value)) list = value as typeof list; } catch { list = []; }
  const map: Record<string, string> = {};
  for (const old of list) {
    const vendor = vendorById(old?.vendor);
    if (!vendor) continue;
    const readOld = async (field: string) => (await getProviderKey(`speech-${old.id}-${field}`)) ?? '';
    const key = (await readOld('apiKey')) || (await readOld('accessKey'));
    if (!key) continue;
    const config = old.config ?? {};
    const id = createId();
    const now = Date.now();
    const extra: Record<string, string> = {};
    for (const field of vendor.fields ?? []) if (!field.secret && config[field.key]) extra[field.key] = config[field.key];
    const baseUrl = vendor.id === 'azure-openai' ? config.endpoint ?? '' : config.baseUrl || vendor.baseUrl || '';
    await upsertProvider({
      id, name: old.name || vendor.name, baseUrl, vendor: vendor.id, extra, chatApi: vendor.chatApi ?? 'chat-completions',
      chatModel: null, model: null, quality: null, aspectRatio: null, resolutionTier: null, createdAt: old.createdAt ?? now, updatedAt: now,
    });
    const secrets: Record<string, string> = {};
    for (const field of vendor.fields ?? []) if (field.secret) secrets[field.key] = await readOld(field.key);
    await saveServiceSecrets(id, vendor, key, secrets);
    map[`svc:${old.id}`] = id;
  }
  await updateVoice(map);
  await setSetting('speech_services', null);
}
