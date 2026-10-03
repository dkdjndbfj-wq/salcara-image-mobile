import { copyVerifiedApk, verifyDownloadedApk, withApkDownloadDeadline } from '../apk-download';

const digest = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // SHA-256("abc")

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
