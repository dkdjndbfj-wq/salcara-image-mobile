import { getRandomBytesAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const KEY = 'salcara-remote-phone-identity-v1';
let flight: Promise<string> | null = null;
/** Installation identity for matching across stations, not an authentication
 * token. Never use an API key, hardware ID, user account or receipt ID here. */
export function phoneIdentity(): Promise<string> {
  if (flight) return flight;
  const pending = (async () => {
    const saved = await SecureStore.getItemAsync(KEY);
    if (saved !== null) {
      if (!/^[a-f0-9]{64}$/.test(saved)) throw new Error('手机配对身份无法读取，请重试');
      return saved;
    }
    const bytes = await getRandomBytesAsync(32);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('无法创建安全手机配对身份');
    const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(KEY, id, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    return id;
  })();
  flight = pending;
  void pending.finally(() => { if (flight === pending) flight = null; }).catch(() => undefined);
  return pending;
}
