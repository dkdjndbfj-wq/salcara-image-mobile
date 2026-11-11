import { createHash } from 'node:crypto';
import { apkFileStream, copyVerifiedApk, verifyDownloadedApk, withApkDownloadDeadline } from '../apk-download';
import { awaitUpdateOperation } from '../update-async';

const digest = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // SHA-256("abc")

test('deadline settles even when a native download never acknowledges abort', async () => {
  jest.useFakeTimers();
  try {
    const failure = jest.fn();
    const result = withApkDownloadDeadline(() => new Promise<never>(() => undefined), new AbortController().signal, 1000);
    void result.catch(failure);
    await jest.advanceTimersByTimeAsync(1001);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ message: '下载服务器连接超时' }));
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('cancellation settles despite a pending stream read and an uncooperative cancel', async () => {
  const reader = {
    read: jest.fn(() => new Promise<never>(() => undefined)),
    cancel: jest.fn(() => new Promise<never>(() => undefined)),
    releaseLock: jest.fn(),
  };
  const controller = new AbortController();
  const failure = jest.fn();
  const result = verifyDownloadedApk(
    { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
    3, { size: 3, digest }, controller.signal,
  );
  void result.catch(failure);
  controller.abort();
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  expect(failure).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
});

test('an already cancelled update never starts native work', async () => {
  const controller = new AbortController();
  controller.abort();
  const operation = jest.fn(async () => 'must not start');
  await expect(awaitUpdateOperation(operation, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(operation).not.toHaveBeenCalled();
});

test('late native rejection after cancellation is consumed and abort listeners are removed', async () => {
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  let rejectNative!: (error: Error) => void;
  const result = awaitUpdateOperation(() => new Promise<string>((_resolve, reject) => { rejectNative = reject; }), controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  rejectNative(new Error('late native failure'));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(remove).toHaveBeenCalledTimes(1);
});

test('a synchronous native exception also releases the abort listener', async () => {
  const controller = new AbortController();
  const remove = jest.spyOn(controller.signal, 'removeEventListener');
  await expect(awaitUpdateOperation(() => { throw new Error('native startup failed'); }, controller.signal)).rejects.toThrow('native startup failed');
  expect(remove).toHaveBeenCalledTimes(1);
});

function apkBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(31);
  bytes.set([0x50, 0x4b, 0x03, 0x04]);
  return bytes;
}

function apkMetadata(bytes: Uint8Array) {
  return { size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
}

function singleChunkStream(bytes: Uint8Array) {
  const reader = {
    read: jest.fn().mockResolvedValueOnce({ done: false, value: bytes }).mockResolvedValue({ done: true }),
    cancel: jest.fn(async () => undefined), releaseLock: jest.fn(),
  };
  return { source: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>, reader };
}

test('large single-chunk APK verification yields to timers and preserves the exact SHA-256', async () => {
  const bytes = apkBytes(2 * 1024 * 1024);
  const { source, reader } = singleChunkStream(bytes);
  let timerRan = false;
  const progress = jest.fn((fraction: number) => { if (fraction === 1) expect(timerRan).toBe(true); });
  setTimeout(() => { timerRan = true; }, 0);
  await verifyDownloadedApk(source, bytes.length, apkMetadata(bytes), new AbortController().signal, progress);
  expect(progress).toHaveBeenLastCalledWith(1);
  expect(progress.mock.calls.length).toBeLessThanOrEqual(101);
  expect(reader.cancel).not.toHaveBeenCalled();
  expect(reader.releaseLock).toHaveBeenCalledTimes(1);
});

test('a timer can cancel hashing midway through one large native chunk', async () => {
  const bytes = apkBytes(2 * 1024 * 1024);
  const { source, reader } = singleChunkStream(bytes);
  const controller = new AbortController();
  const progress = jest.fn();
  setTimeout(() => controller.abort(), 0);
  await expect(verifyDownloadedApk(source, bytes.length, apkMetadata(bytes), controller.signal, progress)).rejects.toMatchObject({ name: 'AbortError' });
  expect(progress).not.toHaveBeenCalledWith(1);
  expect(Math.max(...progress.mock.calls.map(([fraction]) => fraction))).toBeLessThan(0.5);
  expect(reader.cancel).toHaveBeenCalledTimes(1);
});

test('small native reads report only changed integer percentages and verified completion', async () => {
  const bytes = apkBytes(1024 * 1024);
  let offset = 0;
  const reader = {
    read: jest.fn(async () => {
      if (offset === bytes.length) return { done: true };
      const value = bytes.subarray(offset, offset += 1024);
      return { done: false, value };
    }),
    cancel: jest.fn(async () => undefined), releaseLock: jest.fn(),
  };
  const progress = jest.fn();
  await verifyDownloadedApk({ getReader: () => reader } as unknown as ReadableStream<Uint8Array>, bytes.length, apkMetadata(bytes), new AbortController().signal, progress);
  const percentages = progress.mock.calls.map(([fraction]) => Math.round(fraction * 100));
  expect(percentages.length).toBeLessThanOrEqual(101);
  expect(new Set(percentages).size).toBe(percentages.length);
  expect(percentages.at(-1)).toBe(100);
});

describe('APK native file reader', () => {
  const originalStream = globalThis.ReadableStream;
  beforeAll(() => { globalThis.ReadableStream = require('node:stream/web').ReadableStream; });
  afterAll(() => { globalThis.ReadableStream = originalStream; });

  test('uses 64 KiB reads and closes exactly once at EOF', async () => {
    const first = apkBytes(64 * 1024);
    const last = new Uint8Array([1, 2, 3]);
    const handle = { readBytes: jest.fn().mockReturnValueOnce(first).mockReturnValueOnce(last).mockReturnValue(new Uint8Array(0)), close: jest.fn() };
    const reader = apkFileStream(handle).getReader();
    expect(handle.readBytes).not.toHaveBeenCalled();
    expect((await reader.read()).value).toEqual(first);
    expect((await reader.read()).value).toEqual(last);
    expect((await reader.read()).done).toBe(true);
    await reader.cancel();
    expect(handle.readBytes.mock.calls).toEqual([[65536], [65536], [65536]]);
    expect(handle.close).toHaveBeenCalledTimes(1);
    reader.releaseLock();
  });

  test('cancelling before reading closes without touching file data', async () => {
    const handle = { readBytes: jest.fn(), close: jest.fn() };
    const reader = apkFileStream(handle).getReader();
    await reader.cancel();
    await reader.cancel();
    expect(handle.readBytes).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
    reader.releaseLock();
  });

  test('a native read failure closes the handle and retains the original error', async () => {
    const handle = { readBytes: jest.fn(() => { throw new Error('read failed'); }), close: jest.fn(() => { throw new Error('close failed'); }) };
    const reader = apkFileStream(handle).getReader();
    await expect(reader.read()).rejects.toThrow('read failed');
    await expect(reader.cancel()).rejects.toThrow('read failed');
    expect(handle.close).toHaveBeenCalledTimes(1);
    reader.releaseLock();
  });

  test.each([
    { fileSize: 3, expected: { size: 4, digest } },
    { fileSize: 3, expected: { size: 3, digest: null } },
    { fileSize: 0, expected: { size: 0, digest } },
  ])('invalid file size or release metadata closes the already opened native handle: %p', async ({ fileSize, expected }) => {
    const handle = { readBytes: jest.fn(), close: jest.fn() };
    await expect(verifyDownloadedApk(apkFileStream(handle), fileSize, expected, new AbortController().signal)).rejects.toThrow('更新包');
    expect(handle.readBytes).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });
});

test('a stalled download is cancelled so the next mirror can be tried', async () => {
  const parent = new AbortController();
  const result = withApkDownloadDeadline((signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('native aborted')), { once: true });
  }), parent.signal, 5);
  await expect(result).rejects.toThrow('连接超时');
  expect(parent.signal.aborted).toBe(false);
});

test('slow downloads stay alive while actual progress continues', async () => {
  jest.useFakeTimers();
  let finish!: (value: string) => void;
  let reportProgress!: () => void;
  let requestSignal!: AbortSignal;
  const result = withApkDownloadDeadline((signal, keepAlive) => {
    requestSignal = signal;
    reportProgress = keepAlive;
    return new Promise<string>((resolve) => { finish = resolve; });
  }, new AbortController().signal, 1000);
  jest.advanceTimersByTime(900);
  reportProgress();
  jest.advanceTimersByTime(900);
  expect(requestSignal.aborted).toBe(false);
  finish('complete');
  await expect(result).resolves.toBe('complete');
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('a late native response never revives a user-cancelled download', async () => {
  const controller = new AbortController();
  await expect(withApkDownloadDeadline(async () => {
    controller.abort();
    return 'late file';
  }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

function streams(chunks: number[][]) {
  let index = 0;
  const reader = {
    read: jest.fn(async () => index < chunks.length ? { done: false, value: Uint8Array.from(chunks[index++]) } : { done: true }),
    cancel: jest.fn(async () => undefined), releaseLock: jest.fn(),
  };
  const writer = { write: jest.fn(async () => undefined), close: jest.fn(async () => undefined), abort: jest.fn(async () => undefined), releaseLock: jest.fn() };
  return {
    source: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
    destination: { getWriter: () => writer } as unknown as WritableStream<Uint8Array>,
    reader, writer,
  };
}

test('validates SHA-256 incrementally before completing an APK download', async () => {
  const { source, destination, writer } = streams([[97], [98, 99]]);
  const progress = jest.fn();
  await copyVerifiedApk(source, destination, { size: 3, digest }, new AbortController().signal, progress);
  expect(writer.write).toHaveBeenCalledTimes(2);
  expect(writer.close).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenLastCalledWith(1);
});

test('rejects a changed APK even when its byte length is unchanged', async () => {
  const { source, destination, writer } = streams([[97, 98, 100]]);
  await expect(copyVerifiedApk(source, destination, { size: 3, digest }, new AbortController().signal, jest.fn())).rejects.toThrow('SHA-256');
  expect(writer.close).not.toHaveBeenCalled();
  expect(writer.abort).toHaveBeenCalledTimes(1);
});

test('cancellation after the last network read does not report verified success', async () => {
  const { source, destination, reader, writer } = streams([[97, 98, 99]]);
  const controller = new AbortController();
  reader.read.mockImplementationOnce(async () => { controller.abort(); return { done: false, value: Uint8Array.from([97, 98, 99]) }; });
  await expect(copyVerifiedApk(source, destination, { size: 3, digest }, controller.signal, jest.fn())).rejects.toMatchObject({ name: 'AbortError' });
  expect(writer.close).not.toHaveBeenCalled();
  expect(reader.cancel).toHaveBeenCalled();
});

test('stops writing as soon as the download exceeds the official byte size', async () => {
  const { source, destination, writer } = streams([[97, 98, 99, 100]]);
  await expect(copyVerifiedApk(source, destination, { size: 3, digest }, new AbortController().signal, jest.fn())).rejects.toThrow('超过发布记录');
  expect(writer.write).not.toHaveBeenCalled();
});

test('verifies a native-downloaded APK stream and rejects an HTML response', async () => {
  const reader = {
    read: jest.fn()
      .mockResolvedValueOnce({ done: false, value: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]) })
      .mockResolvedValueOnce({ done: false, value: Uint8Array.from([97, 98, 99]) })
      .mockResolvedValueOnce({ done: true }),
    cancel: jest.fn(async () => undefined), releaseLock: jest.fn(),
  };
  await expect(verifyDownloadedApk(
    { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
    7,
    { size: 7, digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
    new AbortController().signal,
  )).rejects.toThrow('SHA-256');

  const htmlReader = {
    read: jest.fn()
      .mockResolvedValueOnce({ done: false, value: Uint8Array.from([0x3c, 0x68, 0x74, 0x6d]) })
      .mockResolvedValueOnce({ done: true }),
    cancel: jest.fn(async () => undefined), releaseLock: jest.fn(),
  };
  await expect(verifyDownloadedApk(
    { getReader: () => htmlReader } as unknown as ReadableStream<Uint8Array>,
    4,
    { size: 4, digest: 'sha256:9af15b336e8a9f3c8c3f6e4b1f4f7f1e7f6f9a3c5f6f7e8d9c0b1a2e3d4c5b6a' },
    new AbortController().signal,
  )).rejects.toThrow('不是有效的 Android APK');
});
