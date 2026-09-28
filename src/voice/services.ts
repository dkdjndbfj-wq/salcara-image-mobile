import { useSyncExternalStore } from 'react';

import { createId } from '../domain-utils';
import { getSetting, setSetting } from '../storage/database';
import { deleteProviderKey, getProviderKey, saveProviderKey } from '../storage/secure-keys';
import { vendorById, type SpeechKind } from './vendors';

/**
 * Speech services the user added (one vendor account each). Non-secret settings live in the settings
 * table; every secret field goes to the system secure store, like chat provider keys.
 */

export interface SpeechService {
  id: string;
  vendor: string;
  name: string;
  /** Non-secret field values (region, API base, app id…). */
  config: Record<string, string>;
  createdAt: number;
}

/** A voice-settings reference to a speech service (plain ids refer to chat providers). */
export const SERVICE_PREFIX = 'svc:';
export const serviceRef = (id: string) => `${SERVICE_PREFIX}${id}`;
export const isServiceRef = (ref: string | null | undefined): ref is string => Boolean(ref?.startsWith(SERVICE_PREFIX));

const KEY = 'speech_services';
let services: SpeechService[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function parse(raw: string | null): SpeechService[] {
  try {
    const value: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SpeechService => Boolean(item && typeof item === 'object' && typeof (item as SpeechService).id === 'string' && vendorById((item as SpeechService).vendor)))
      .map((item) => ({ ...item, config: item.config && typeof item.config === 'object' ? item.config : {} }));
  } catch {
    return [];
  }
}

export async function loadSpeechServices(): Promise<SpeechService[]> {
  if (!loaded) {
    services = parse(await getSetting(KEY));
    loaded = true;
    notify();
  }
  return services;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loaded) void loadSpeechServices().catch(() => undefined);
  return () => { listeners.delete(listener); };
}
const snapshot = () => services;
export function useSpeechServices(): SpeechService[] { return useSyncExternalStore(subscribe, snapshot, snapshot); }

const secretId = (serviceId: string, field: string) => `speech-${serviceId}-${field}`;

/** Creates or updates a service. Empty secret values keep the stored secret. */
export async function saveSpeechService(input: Omit<SpeechService, 'id' | 'createdAt'> & { id?: string | null }, secrets: Record<string, string>): Promise<SpeechService> {
  const vendor = vendorById(input.vendor);
  if (!vendor) throw new Error('未知的语音服务');
  const existing = services.find((item) => item.id === input.id);
  const service: SpeechService = {
    id: existing?.id ?? createId(), vendor: vendor.id, name: input.name.trim() || vendor.name,
    config: Object.fromEntries(Object.entries(input.config).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)), createdAt: existing?.createdAt ?? Date.now(),
  };
  // Validate every field before writing any secret, so a missing field never leaves half a service behind.
  const writes: Array<[string, string]> = [];
  for (const field of vendor.fields) {
    if (field.secret) {
      const value = secrets[field.key]?.trim();
      if (value) writes.push([secretId(service.id, field.key), value]);
      else if (!field.optional && (!existing || !(await getProviderKey(secretId(service.id, field.key))))) throw new Error(`请填写${field.label}`);
    } else if (!field.optional && !service.config[field.key]) {
      throw new Error(`请填写${field.label}`);
    }
  }
  for (const [id, value] of writes) await saveProviderKey(id, value);
  services = existing ? services.map((item) => (item.id === service.id ? service : item)) : [...services, service];
  notify();
  await setSetting(KEY, JSON.stringify(services));
  return service;
}

export async function deleteSpeechService(id: string): Promise<void> {
  const service = services.find((item) => item.id === id);
  if (!service) return;
  const vendor = vendorById(service.vendor);
  for (const field of vendor?.fields ?? []) if (field.secret) await deleteProviderKey(secretId(id, field.key)).catch(() => undefined);
  services = services.filter((item) => item.id !== id);
  notify();
  await setSetting(KEY, JSON.stringify(services));
}

/** Every field value of a service, secrets included (for making a request). */
export async function serviceValues(service: SpeechService): Promise<Record<string, string>> {
  const vendor = vendorById(service.vendor);
  const values: Record<string, string> = { ...service.config };
  for (const field of vendor?.fields ?? []) {
    if (field.secret) values[field.key] = (await getProviderKey(secretId(service.id, field.key))) ?? '';
  }
  return values;
}

export async function hasSecret(serviceId: string, field: string): Promise<boolean> {
  return Boolean(await getProviderKey(secretId(serviceId, field)));
}

export function servicesFor(kind: SpeechKind, list: SpeechService[] = services): SpeechService[] {
  return list.filter((service) => Boolean(vendorById(service.vendor)?.[kind]));
}

export function serviceById(id: string | null | undefined, list: SpeechService[] = services): SpeechService | null {
  return list.find((item) => item.id === id) ?? null;
}

/** Test hook. */
export function resetSpeechServicesForTesting(list: SpeechService[] = []): void { services = list; loaded = true; }
