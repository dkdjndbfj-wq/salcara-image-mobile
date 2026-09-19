import * as SecureStore from 'expo-secure-store';

const PREFIX = 'provider-key:';

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
