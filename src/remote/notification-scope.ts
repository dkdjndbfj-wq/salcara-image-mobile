import { sha256 } from '@noble/hashes/sha2.js';
import type { Hub } from './client';

export const validNotificationScope = (value: unknown): value is string => typeof value === 'string' && /^ns1_[a-f0-9]{64}$/.test(value);

/** A navigation namespace, never an authorization credential. */
export function notificationScopeFor(hub: Pick<Hub, 'url' | 'pairToken'>, deviceId: string): string | null {
  if (!hub.pairToken || !deviceId) return null;
  const identity = JSON.stringify(['salcara-notification-scope-v1', hub.url, deviceId, hub.pairToken]);
  return `ns1_${Array.from(sha256(new TextEncoder().encode(identity)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
