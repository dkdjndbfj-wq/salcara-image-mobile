import { abortError } from './api/network';

type Installer = {
  startActivityAsync: (action: string, params: { data: string; type: string; flags: number }) => Promise<unknown>;
};

/** Keep cancellation authoritative across native URI/loader awaits and OEM fallback. */
export async function launchVerifiedApkInstaller(
  resolveContentUri: () => Promise<string>,
  loadInstaller: () => Promise<Installer>,
  signal?: AbortSignal,
): Promise<void> {
  const ensureActive = () => { if (signal?.aborted) throw abortError(); };
  ensureActive();
  const contentUri = await resolveContentUri();
  ensureActive();
  const installer = await loadInstaller();
  ensureActive();
  const params = { data: contentUri, type: 'application/vnd.android.package-archive', flags: 1 | 0x10000000 };
  try {
    await installer.startActivityAsync('android.intent.action.INSTALL_PACKAGE', params);
  } catch (firstError) {
    ensureActive();
    try {
      await installer.startActivityAsync('android.intent.action.VIEW', params);
    } catch {
      ensureActive();
      throw firstError;
    }
  }
}
