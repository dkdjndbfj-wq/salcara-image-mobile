import { sha256 } from '@noble/hashes/sha2.js';

import { abortError } from './api/network';

export const MAX_APK_BYTES = 512 * 1024 * 1024;

export type VerifiedApkMetadata = { size: number; digest: string | null };

function validateExpected(expected: VerifiedApkMetadata): void {
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || expected.size > MAX_APK_BYTES
    || !/^sha256:[a-f0-9]{64}$/i.test(expected.digest ?? '')) {
    throw new Error('更新包缺少可靠的大小或 SHA-256 校验信息');
  }
}

/**
 * Verify an already downloaded file without buffering the APK in JavaScript.
 * This is deliberately separate from copyVerifiedApk: the native Expo
 * downloader writes to a temporary file first, so a partially downloaded APK
 * can never become the file handed to Android's package installer.
 */
export async function verifyDownloadedApk(
  source: ReadableStream<Uint8Array>,
  fileSize: number,
  expected: VerifiedApkMetadata,
  signal: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  validateExpected(expected);
  if (!Number.isSafeInteger(fileSize) || fileSize !== expected.size) {
    throw new Error('更新包大小校验失败，下载内容不完整');
  }

  const hash = sha256.create();
  const reader = source.getReader();
  let read = 0;
  let header = new Uint8Array(0);
  try {
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortError();
      if (done) break;
      if (!value?.byteLength) continue;
      if (header.length < 4) {
        const next = new Uint8Array(Math.min(4, header.length + value.byteLength));
        next.set(header);
        next.set(value.slice(0, next.length - header.length), header.length);
        header = next;
      }
      read += value.byteLength;
      if (read > expected.size) throw new Error('更新包大小校验失败，下载内容超过发布记录');
      hash.update(value);
      onProgress?.(Math.min(0.99, read / expected.size));
    }
    if (read !== expected.size) throw new Error('更新包大小校验失败，下载未完成');
    // An APK is a ZIP archive. This catches the common case where a captive
    // portal or a proxy returns an HTML error page with status 200 before the
    // (more expensive) SHA-256 comparison is reported to the user.
    if (header.length < 2 || header[0] !== 0x50 || header[1] !== 0x4b) {
      throw new Error('下载内容不是有效的 Android APK');
    }
    const actual = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (`sha256:${actual}` !== expected.digest!.toLowerCase()) throw new Error('更新包 SHA-256 校验失败，已停止安装');
    if (signal.aborted) throw abortError();
    onProgress?.(1);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    hash.destroy();
    reader.releaseLock();
  }
}

/** Incrementally verify the exact bytes being written, never buffer a full APK. */
export async function copyVerifiedApk(
  source: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
  expected: { size: number; digest: string | null },
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<void> {
  validateExpected(expected);
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
