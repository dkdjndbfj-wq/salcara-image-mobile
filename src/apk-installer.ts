import { abortError } from './api/network';
import { awaitUpdateOperation } from './update-async';

/** Keep the Android-only module behind a lazy, independently testable boundary. */
export async function loadAndroidUpdateInstaller() {
  return import('expo-intent-launcher');
}

type Installer = {
  startActivityAsync: (action: string, params: { data: string; type: string; flags: number }) => Promise<unknown>;
};

/** Keep cancellation authoritative across native URI/loader awaits and OEM fallback. */
export async function launchVerifiedApkInstaller(
  resolveContentUri: () => Promise<string>,
  loadInstaller: () => Promise<Installer>,
  signal?: AbortSignal,
): Promise<void> {
  const activeSignal = signal ?? new AbortController().signal;
  const ensureActive = () => { if (activeSignal.aborted) throw abortError(); };
  ensureActive();
  const contentUri = await awaitUpdateOperation(resolveContentUri, activeSignal);
  ensureActive();
  const installer = await awaitUpdateOperation(loadInstaller, activeSignal);
  ensureActive();
  const params = { data: contentUri, type: 'application/vnd.android.package-archive', flags: 1 | 0x10000000 };
  try {
    // Expo waits for Android's activity result, which some installers never
    // return. Cancellation stops our wait; it must never open a second intent.
    await awaitUpdateOperation(() => installer.startActivityAsync('android.intent.action.INSTALL_PACKAGE', params), activeSignal);
  } catch (firstError) {
    ensureActive();
    try {
      await awaitUpdateOperation(() => installer.startActivityAsync('android.intent.action.VIEW', params), activeSignal);
    } catch {
      ensureActive();
      throw firstError;
    }
  }
}
