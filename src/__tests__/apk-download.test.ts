import { copyVerifiedApk } from '../apk-download';

const digest = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // SHA-256("abc")

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
