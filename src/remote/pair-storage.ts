import * as SecureStore from 'expo-secure-store';

function name(providerId: string): string {
  return `remote-pair-${providerId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export async function getPairToken(providerId: string): Promise<string | null> {
  return SecureStore.getItemAsync(name(providerId));
}

export async function savePairToken(providerId: string, token: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('中转站返回的配对凭证无效');
  await SecureStore.setItemAsync(name(providerId), token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function deletePairToken(providerId: string): Promise<void> {
  await SecureStore.deleteItemAsync(name(providerId));
}
