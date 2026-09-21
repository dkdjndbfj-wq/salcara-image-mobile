import { sha256 } from '@noble/hashes/sha2.js';

import { abortError } from './api/network';

export const MAX_APK_BYTES = 512 * 1024 * 1024;

/** Incrementally verify the exact bytes being written, never buffer a full APK. */
export async function copyVerifiedApk(
  source: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
  expected: { size: number; digest: string | null },
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<void> {
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || expected.size > MAX_APK_BYTES
    || !/^sha256:[a-f0-9]{64}$/i.test(expected.digest ?? '')) {
    throw new Error('更新包缺少可靠的大小或 SHA-256 校验信息');
  }
  const hash = sha256.create();
  const reader = source.getReader();
  const writer = destination.getWriter();
  let written = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortError();
      if (done) break;
      written += value.byteLength;
      if (written > expected.size) throw new Error('更新包大小校验失败，下载内容超过发布记录');
      hash.update(value);
      await writer.write(value);
      onProgress(written / expected.size);
    }
    if (written !== expected.size) throw new Error('更新包大小校验失败，下载未完成');
    const actual = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (`sha256:${actual}` !== expected.digest!.toLowerCase()) throw new Error('更新包 SHA-256 校验失败，已停止安装');
    if (signal.aborted) throw abortError();
    await writer.close();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await writer.abort(error).catch(() => undefined);
    throw error;
  } finally {
    hash.destroy();
    reader.releaseLock();
    writer.releaseLock();
  }
}
