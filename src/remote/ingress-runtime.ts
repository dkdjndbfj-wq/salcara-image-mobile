import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createIngressRouter } from './ingress';
import type { FetchLike } from './client';

const key = (canonical: string) => `salcara.ingress.v1.${bytesToHex(sha256(new TextEncoder().encode(canonical)))}`;
export function ingressRuntime(fetch: FetchLike) {
  return createIngressRouter({ fetch, nonce: () => bytesToHex(getRandomBytes(32)), storage: {
    read: canonical => SecureStore.getItemAsync(key(canonical)),
    write: (canonical, value) => SecureStore.setItemAsync(key(canonical), value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  } });
}
