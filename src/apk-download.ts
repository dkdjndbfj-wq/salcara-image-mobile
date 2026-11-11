import { sha256 } from '@noble/hashes/sha2.js';

import { abortError } from './api/network';
import { awaitUpdateOperation } from './update-async';

export const MAX_APK_BYTES = 512 * 1024 * 1024;
const APK_READ_BYTES = 64 * 1024;
const VERIFY_YIELD_BYTES = 256 * 1024;

export type VerifiedApkMetadata = { size: number; digest: string | null };

function validateExpected(expected: VerifiedApkMetadata): void {
  if (!Number.isSafeInteger(expected.size) || expected.size <= 0 || expected.size > MAX_APK_BYTES
    || !/^sha256:[a-f0-9]{64}$/i.test(expected.digest ?? '')) {
    throw new Error('更新包缺少可靠的大小或 SHA-256 校验信息');
  }
}

/** Give each mirror an idle deadline; slow downloads with progress may continue. */
export async function withApkDownloadDeadline<T>(
  operation: (signal: AbortSignal, keepAlive: () => void) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs = 90_000,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (parentSignal.aborted) throw abortError();
  parentSignal.addEventListener('abort', cancel, { once: true });
  let timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const keepAlive = () => {
    if (controller.signal.aborted) return;
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
  };
  try {
    const result = await awaitUpdateOperation(() => operation(controller.signal, keepAlive), controller.signal);
    if (parentSignal.aborted) throw abortError();
    if (controller.signal.aborted) throw new Error('下载服务器连接超时');
    return result;
  } catch (error) {
    if (parentSignal.aborted) throw abortError();
    if (controller.signal.reason === 'timeout') throw new Error('下载服务器连接超时');
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener('abort', cancel);
  }
}

/** File.readableStream() reads 1 KiB at a time; use bounded native reads for APKs. */
export function apkFileStream(handle: { readBytes(length: number): Uint8Array; close(): void }): ReadableStream<Uint8Array> {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    handle.close();
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const bytes = handle.readBytes(APK_READ_BYTES);
        if (bytes.byteLength === 0) { close(); controller.close(); }
        else controller.enqueue(bytes);
      } catch (error) {
        try { close(); } catch { /* Preserve the read failure. */ }
        controller.error(error);
      }
    },
    cancel: close,
  }, { highWaterMark: 0 });
}

// Cancellation is best effort: cleanup cannot prevent a cancelled update from
// returning when a native stream does not settle its own cancel/abort promise.
function stopStream(operation: () => Promise<unknown>): void {
  try { void Promise.resolve(operation()).catch(() => undefined); } catch { /* Already stopped. */ }
}

function releaseStreamLock(operation: () => void): void {
  try { operation(); } catch { /* Some native readers cannot release a pending read. */ }
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
  const hash = sha256.create();
  const reader = source.getReader();
  let read = 0;
  let header = new Uint8Array(0);
  let bytesSinceYield = 0;
  let lastYieldAt = Date.now();
  let lastProgress = -1;
  const yieldToUI = async () => {
    if (bytesSinceYield < VERIFY_YIELD_BYTES && Date.now() - lastYieldAt < 16) return;
    await awaitUpdateOperation(() => new Promise<void>((resolve) => setTimeout(resolve, 0)), signal);
    bytesSinceYield = 0;
    lastYieldAt = Date.now();
  };
  try {
    validateExpected(expected);
    if (!Number.isSafeInteger(fileSize) || fileSize !== expected.size) {
      throw new Error('更新包大小校验失败，下载内容不完整');
    }
    while (true) {
      if (signal.aborted) throw abortError();
      const { done, value } = await awaitUpdateOperation(() => reader.read(), signal);
      if (signal.aborted) throw abortError();
      if (done) break;
      if (!value?.byteLength) { await yieldToUI(); continue; }
      if (header.length < 4) {
        const next = new Uint8Array(Math.min(4, header.length + value.byteLength));
        next.set(header);
        next.set(value.slice(0, next.length - header.length), header.length);
        header = next;
      }
      if (read + value.byteLength > expected.size) throw new Error('更新包大小校验失败，下载内容超过发布记录');
      for (let offset = 0; offset < value.byteLength; offset += APK_READ_BYTES) {
        if (signal.aborted) throw abortError();
        const chunk = value.subarray(offset, Math.min(offset + APK_READ_BYTES, value.byteLength));
        hash.update(chunk);
        read += chunk.byteLength;
        bytesSinceYield += chunk.byteLength;
        const progress = Math.min(99, Math.floor(read / expected.size * 100));
        if (progress !== lastProgress) {
          lastProgress = progress;
          onProgress?.(progress / 100);
        }
        await yieldToUI();
      }
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
    stopStream(() => reader.cancel(error));
    throw error;
  } finally {
    hash.destroy();
    releaseStreamLock(() => reader.releaseLock());
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
      const { done, value } = await awaitUpdateOperation(() => reader.read(), signal);
      if (signal.aborted) throw abortError();
      if (done) break;
      written += value.byteLength;
      if (written > expected.size) throw new Error('更新包大小校验失败，下载内容超过发布记录');
      hash.update(value);
      await awaitUpdateOperation(() => writer.write(value), signal);
      onProgress(written / expected.size);
    }
    if (written !== expected.size) throw new Error('更新包大小校验失败，下载未完成');
    const actual = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (`sha256:${actual}` !== expected.digest!.toLowerCase()) throw new Error('更新包 SHA-256 校验失败，已停止安装');
    if (signal.aborted) throw abortError();
    await awaitUpdateOperation(() => writer.close(), signal);
  } catch (error) {
    stopStream(() => reader.cancel(error));
    stopStream(() => writer.abort(error));
    throw error;
  } finally {
    hash.destroy();
    releaseStreamLock(() => reader.releaseLock());
    releaseStreamLock(() => writer.releaseLock());
  }
}
