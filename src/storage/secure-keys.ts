import * as SecureStore from 'expo-secure-store';

// SecureStore key names only allow letters, numbers, ".", "-" and "_".
// Keep the provider id after a valid, stable prefix so Android does not
// reject a newly-added provider before the API key can be saved.
const PREFIX = 'provider-key-';

export async function saveProviderKey(providerId: string, apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('请输入 API 密钥');
  await SecureStore.setItemAsync(`${PREFIX}${providerId}`, trimmed, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function getProviderKey(providerId: string): Promise<string | null> {
  return SecureStore.getItemAsync(`${PREFIX}${providerId}`);
}

export async function deleteProviderKey(providerId: string): Promise<void> {
  await SecureStore.deleteItemAsync(`${PREFIX}${providerId}`);
}
