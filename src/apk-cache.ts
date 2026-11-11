import { File, Paths } from 'expo-file-system';
import type { AppRelease } from './update';

function indexFile(release: AppRelease): File {
  return new File(Paths.cache, `salcara-image-update-${release.version}.json`);
}

/** The index is only a locator. Every reused APK must pass a fresh byte check. */
export function cachedUpdateFile(release: AppRelease): File | null {
  try {
    const index = indexFile(release);
    if (!index.exists) return null;
    const saved = JSON.parse(index.textSync());
    const prefix = `salcara-image-update-${release.version}-`;
    if (saved?.version !== release.version || saved.size !== release.apk.size || saved.digest !== release.apk.digest
      || typeof saved.name !== 'string' || !saved.name.startsWith(prefix)
      || !/^\d+-\d+-\d+\.apk$/.test(saved.name.slice(prefix.length))) return null;
    const file = new File(Paths.cache, saved.name);
    return file.exists ? file : null;
  } catch {
    // An interrupted index write must not prevent checking or downloading again.
    return null;
  }
}

export function rememberVerifiedUpdate(file: File, release: AppRelease): void {
  const name = file.uri.split('/').pop() ?? '';
  const prefix = `salcara-image-update-${release.version}-`;
  if (!name.startsWith(prefix) || !/^\d+-\d+-\d+\.apk$/.test(name.slice(prefix.length))
    || new File(Paths.cache, name).uri !== file.uri) return;
  try {
    // Small synchronous metadata only; no APK bytes are loaded into JS memory.
    indexFile(release).write(JSON.stringify({ version: release.version, size: release.apk.size, digest: release.apk.digest, name }));
  } catch { /* The already verified file remains usable in this mounted session. */ }
}
