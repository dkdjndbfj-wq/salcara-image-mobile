import * as SecureStore from 'expo-secure-store';

function name(providerId: string): string {
  return `remote-pair-${providerId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

// Pair tokens are a second persistence namespace used by the legacy
// station-login flow. Serialize writes so sign-out cannot delete a token that
// a concurrent QR/login operation has just replaced.
let mutationTail: Promise<void> = Promise.resolve();
function mutate<T>(task: () => Promise<T>): Promise<T> {
  const run = mutationTail.then(task, task);
  mutationTail = run.then(() => undefined, () => undefined);
  return run;
}

export async function getPairToken(providerId: string): Promise<string | null> {
  const value = await SecureStore.getItemAsync(name(providerId));
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

export async function savePairToken(providerId: string, token: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('中转站返回的配对凭证无效');
  await mutate(() => SecureStore.setItemAsync(name(providerId), token, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }));
}

export async function deletePairToken(providerId: string, expectedToken?: string): Promise<void> {
  await mutate(async () => {
    if (expectedToken && await SecureStore.getItemAsync(name(providerId)) !== expectedToken) return;
    await SecureStore.deleteItemAsync(name(providerId));
  });
}
