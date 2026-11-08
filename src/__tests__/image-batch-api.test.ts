jest.mock('expo/fetch', () => ({ fetch: (...args: Parameters<typeof fetch>) => global.fetch(...args) }));
jest.mock('expo-file-system', () => ({
  File: class File {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get extension() { return '.png'; }
    get exists() { return mockSavedFiles.has(this.uri); }
    get size() { return this.exists ? 4 : 0; }
    async bytes() { return new Uint8Array(); }
  },
}));
jest.mock('../storage/files', () => ({
  saveBase64Png: jest.fn(),
  downloadPng: jest.fn(),
}));

import { buildEditFields, buildGenerationBody, editImages, findImagePayloads, generateImages, persistApiResults } from '../api/image-api';
import type { ImageTaskRef } from '../api/image-api';
import type { GeneratedImage } from '../domain';
import { downloadPng, saveBase64Png } from '../storage/files';

const request = {
  baseUrl: 'https://images.example/v1', apiKey: 'private-batch-key',
  model: 'gpt-image-2', prompt: '两张不同的风景', quality: 'high' as const,
  size: '1024x1024', transparent: false, count: 2,
};
const first = 'YWJjZA==';
const second = 'ZWZnaA==';
const firstUrl = 'https://cdn.example/first.png';
const secondUrl = 'https://cdn.example/second.png';
const mockDownload = jest.mocked(downloadPng);
const mockSave = jest.mocked(saveBase64Png);
const mockSavedFiles = new Set<string>();
const response = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload } as Response);

beforeEach(() => {
  mockSavedFiles.clear();
  mockDownload.mockReset().mockImplementation(async (url: string) => `file:///download-${url.split('/').pop()}`);
  mockSave.mockReset().mockImplementation((value: string) => {
    const uri = `file:///base64-${value.slice(0, 4)}.png`;
    mockSavedFiles.add(uri);
    return uri;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('generation and editing send a validated batch count in their native field types', async () => {
  expect(buildGenerationBody(request).n).toBe(2);
  expect(buildEditFields({ ...request, count: 10 }).n).toBe('10');
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: [{ b64_json: first }] }));
  for (const count of [0, 11, 2.5, NaN]) {
    await expect(generateImages({ ...request, count })).rejects.toThrow('1 到 10');
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([4, 5, 10])('generates %i images in provider array order despite different download delays', async (count) => {
  jest.useFakeTimers();
  const providerOrder = [9, 2, 7, 1, 8, 3, 6, 5, 4, 0].slice(0, count);
  const urls = providerOrder.map((index) => `https://cdn.example/provider-${index}.png`);
  const snapshots: GeneratedImage[][] = [];
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: urls.map((url) => ({ url })) }));
  mockDownload.mockImplementation((url) => new Promise((resolve) => {
    setTimeout(() => resolve(`file:///saved-${url.split('/').pop()}`), url === urls[0] ? 80 : 1);
  }));
  const task = generateImages({ ...request, count, onImages: (images) => { snapshots.push(images); } });
  await jest.runAllTimersAsync();
  const images = await task;
  expect(images.map((image) => image.uri)).toEqual(providerOrder.map((index) => `file:///saved-provider-${index}.png`));
  expect(images.every((image) => image.status === 'complete')).toBe(true);
  expect(snapshots.every((snapshot) => snapshot.map((image) => image.remoteUrl).join('|') === urls.join('|'))).toBe(true);
  expect(snapshots.every((snapshot) => snapshot.map((image) => image.id).join('|') === images.map((image) => image.id).join('|'))).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).n).toBe(count);
});

test('plural parsing preserves order, chooses inline bytes per object and deduplicates aliases', () => {
  expect(findImagePayloads({ data: [
    { url: firstUrl },
    { b64_json: second, url: secondUrl, image_url: { url: secondUrl }, base64: second },
    { b64_json: 'ZWZn\n aA==', url: secondUrl },
    { image_url: { url: 'https://cdn.example/third.png' } },
  ] })).toEqual([
    { url: firstUrl },
    { base64: second, url: secondUrl },
    { url: 'https://cdn.example/third.png' },
  ]);
  expect(findImagePayloads({ data: [{ url: firstUrl }, { url: firstUrl, b64_json: first }] })).toEqual([{ url: firstUrl, base64: first }]);
  expect(findImagePayloads({ images: [{ data_url: `data:image/png;base64,${first}`, url: firstUrl }] })).toEqual([{ base64: first, url: firstUrl }]);
  expect(findImagePayloads({ images: [`data:image/png;base64,${first}`, { b64_json: first }] })).toHaveLength(1);
});

test('provider responses cannot create more than ten stored images', async () => {
  const payload = { data: Array.from({ length: 25 }, (_, index) => ({ url: `https://cdn.example/${index}.png` })) };
  expect(findImagePayloads(payload)).toHaveLength(10);
  const images = await persistApiResults(payload, { count: 10 });
  expect(images).toHaveLength(10);
  expect(mockDownload).toHaveBeenCalledTimes(10);
  expect(images[9].remoteUrl).toBe('https://cdn.example/9.png');
});

test('checkpoints every original URL before downloading and awaits each checkpoint', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: [{ url: firstUrl }, { b64_json: second, url: secondUrl }] }));
  let release!: () => void;
  let checkpointEntered!: () => void;
  const entered = new Promise<void>((resolve) => { checkpointEntered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const snapshots: GeneratedImage[][] = [];
  const task = generateImages({ ...request, onImages: async (images) => {
    snapshots.push(images);
    if (snapshots.length === 1) { checkpointEntered(); await gate; }
  } });
  await entered;
  expect(mockDownload).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
  expect(snapshots[0].map((image) => [image.status, image.remoteUrl])).toEqual([['pending', firstUrl], ['pending', secondUrl]]);
  release();
  const images = await task;
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).n).toBe(2);
  expect(images.map((image) => image.uri)).toEqual(['file:///download-first.png', 'file:///base64-ZWZn.png']);
  expect(snapshots.map((snapshot) => snapshot.map((image) => image.status))).toEqual([
    ['pending', 'pending'], ['complete', 'pending'], ['complete', 'complete'],
  ]);
  expect(new Set(images.map((image) => image.id)).size).toBe(2);
  expect(snapshots.every((snapshot) => snapshot[0].id === images[0].id)).toBe(true);
  expect(mockDownload).toHaveBeenCalledTimes(1);
});

test('partial download failure preserves success and retry URLs without another paid request', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: [{ url: firstUrl }, { url: secondUrl }] }));
  mockDownload.mockResolvedValueOnce('file:///first.png').mockRejectedValueOnce(new Error(`cannot download with ${request.apiKey}`));
  const images = await generateImages(request);
  expect(images[0]).toMatchObject({ status: 'complete', uri: 'file:///first.png', remoteUrl: firstUrl, error: null });
  expect(images[1]).toMatchObject({ status: 'error', uri: null, remoteUrl: secondUrl });
  expect(images[1].error).not.toContain(request.apiKey);
  expect(images[1].error).toContain('[已隐藏密钥]');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('client slot IDs stay stable in the initial manifest, each checkpoint and final results without entering the paid request', async () => {
  const resultIds = ['image-1', 'image-2', 'image-3', 'image-2', ''];
  const urls = Array.from({ length: 6 }, (_, index) => `https://cdn.example/stable-${index}.png`);
  const snapshots: GeneratedImage[][] = [];
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: urls.map((url) => ({ url })) }));
  const images = await generateImages({ ...request, count: 5, resultIds, onImages: (snapshot) => { snapshots.push(snapshot); } });
  const ids = images.map((image) => image.id);
  expect(ids.slice(0, 3)).toEqual(resultIds.slice(0, 3));
  expect(new Set(ids).size).toBe(6);
  expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
  expect(snapshots).toHaveLength(7);
  expect(snapshots[0].every((image) => image.status === 'pending')).toBe(true);
  expect(snapshots.every((snapshot) => snapshot.map((image) => image.id).join('|') === ids.join('|'))).toBe(true);
  expect(snapshots.map((snapshot) => snapshot.filter((image) => image.status === 'complete').length)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty('resultIds');
  expect(buildEditFields({ ...request, count: 5, resultIds })).not.toHaveProperty('resultIds');
});

test('missing results are reported individually without silently buying another generation', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: [{ b64_json: first }] }));
  const images = await generateImages({ ...request, count: 3 });
  expect(images.map((image) => image.status)).toEqual(['complete', 'error', 'error']);
  expect(images[1].error).toContain('第 2 张未返回');
  expect(images[2].error).toContain('第 3 张未返回');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('explicit sparse indices preserve their original slots in a synchronous partial batch', async () => {
  const resultIds = ['image-1', 'image-2', 'image-3', 'image-4'];
  const snapshots: GeneratedImage[][] = [];
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: [
    { index: 3, url: secondUrl }, { index: 1, url: firstUrl },
  ] }));
  const images = await generateImages({ ...request, count: 4, resultIds, onImages: (snapshot) => { snapshots.push(snapshot); } });
  expect(images.map((image) => image.status)).toEqual(['error', 'complete', 'error', 'complete']);
  expect(images.map((image) => image.uri)).toEqual([null, 'file:///download-first.png', null, 'file:///download-second.png']);
  expect(images[0].error).toContain('第 1 张未返回');
  expect(images[2].error).toContain('第 3 张未返回');
  expect(snapshots.every((snapshot) => snapshot.map((image) => image.id).join('|') === resultIds.join('|'))).toBe(true);
  expect(snapshots.every((snapshot) => snapshot[1].remoteUrl === firstUrl && snapshot[3].remoteUrl === secondUrl)).toBe(true);
  expect(mockDownload.mock.calls.map(([url]) => url)).toEqual([firstUrl, secondUrl]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('short, single-image-only and oversized responses never trigger paid top-up requests', async () => {
  for (const [count, returned] of [[4, 1], [5, 3], [4, 5], [10, 12]]) {
    const urls = Array.from({ length: returned }, (_, index) => `https://cdn.example/${index}.png`);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: urls.map((url) => ({ url })) }));
    const images = await generateImages({ ...request, count });
    const retained = Math.min(returned, 10);
    expect(images.filter((image) => image.status === 'complete').map((image) => image.remoteUrl)).toEqual(urls.slice(0, 10));
    expect(images).toHaveLength(Math.max(count, retained));
    expect(images.slice(retained).every((image) => image.status === 'error' && image.error?.includes('未返回'))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  }
});

test('a provider that explicitly supports only one image does not cause an automatic n=1 fallback', async () => {
  for (const count of [4, 5, 10]) {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: { message: 'This model supports only n=1' } }),
    } as Response);
    await expect(generateImages({ ...request, count })).rejects.toThrow('only n=1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).n).toBe(count);
    fetchMock.mockRestore();
  }
  expect(mockDownload).not.toHaveBeenCalled();
});

test('cancellation after a saved image keeps it and marks remaining downloads as paused', async () => {
  const controller = new AbortController();
  const images = await persistApiResults({ data: [{ url: firstUrl }, { url: secondUrl }] }, {
    count: 2, signal: controller.signal,
    onImages: (snapshot) => { if (snapshot[0].status === 'complete') controller.abort(); },
  });
  expect(images.map((image) => image.status)).toEqual(['complete', 'error']);
  expect(images[0].uri).toBe('file:///download-first.png');
  expect(images[1]).toMatchObject({ remoteUrl: secondUrl, uri: null, error: '图片下载已暂停' });
  expect(mockDownload).toHaveBeenCalledTimes(1);
});

test('checkpoint failures propagate and stop processing later images', async () => {
  const storageError = new Error('database is full');
  const snapshots: GeneratedImage[][] = [];
  await expect(persistApiResults({ data: [{ url: firstUrl }, { url: secondUrl }] }, {
    count: 2,
    onImages: async (images) => {
      snapshots.push(images);
      if (images[0].status === 'complete') throw storageError;
    },
  })).rejects.toBe(storageError);
  expect(snapshots).toHaveLength(2);
  expect(mockDownload).toHaveBeenCalledTimes(1);
});

test('failure to checkpoint the initial manifest never starts a download', async () => {
  const storageError = new Error('cannot persist manifest');
  await expect(persistApiResults({ data: [{ url: firstUrl }] }, {
    onImages: async () => { throw storageError; },
  })).rejects.toBe(storageError);
  expect(mockDownload).not.toHaveBeenCalled();
});

test('asynchronous tasks wait for a complete batch and retain their resume ID', async () => {
  jest.useFakeTimers();
  const onTask = jest.fn(async () => undefined);
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'task-1', status: 'queued' }))
    .mockResolvedValueOnce(response({ status: 'running', data: [{ b64_json: first }] }))
    .mockResolvedValueOnce(response({ status: 'completed', data: [{ b64_json: first }, { b64_json: second }] }));
  const task = generateImages({ ...request, onTask });
  await jest.runAllTimersAsync();
  expect((await task).map((image) => image.status)).toEqual(['complete', 'complete']);
  expect(onTask).toHaveBeenCalledWith({ id: 'task-1', url: 'https://images.example/v1/images/tasks/task-1' });
  expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'GET', 'GET']);
});

test('delta-only task replies retain earlier images once, in first-returned order, excluding previews', async () => {
  jest.useFakeTimers();
  const urls = ['first', 'second', 'third', 'fourth'].map((name) => `https://cdn.example/${name}.png`);
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'delta', status: 'queued', data: [{ url: urls[0] }] }))
    .mockResolvedValueOnce(response({ status: 'running', data: [
      { url: urls[1] }, { url: urls[0] }, { partial_image_b64: first }, { status: 'pending', url: 'https://cdn.example/preview.png' },
    ] }))
    .mockResolvedValueOnce(response({ status: 'running', data: [{ url: urls[2] }] }))
    .mockResolvedValueOnce(response({ status: 'done', data: [{ url: urls[3] }] }));
  const task = generateImages({ ...request, count: 4 });
  await jest.runAllTimersAsync();
  const images = await task;
  expect(images.map((image) => image.remoteUrl)).toEqual(urls);
  expect(images.every((image) => image.status === 'complete')).toBe(true);
  expect(mockDownload.mock.calls.map(([url]) => url)).toEqual(urls);
  expect(mockSave).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
});

test('indexed asynchronous images keep logical order and update the same image without duplication', async () => {
  jest.useFakeTimers();
  const entry = (index: number, url = `https://cdn.example/index-${index}.png`) => ({ image_id: `image-${index}`, index, url });
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'indexed', status: 'queued', data: [entry(4), entry(1)] }))
    .mockResolvedValueOnce(response({ status: 'running', data: [entry(0)] }))
    .mockResolvedValueOnce(response({ status: 'running', data: [entry(3, 'https://cdn.example/expired-signature.png')] }))
    .mockResolvedValueOnce(response({ status: 'running', data: [entry(2)] }))
    .mockResolvedValueOnce(response({ status: 'running', data: [entry(3), entry(4)] }))
    .mockResolvedValueOnce(response({ status: 'done', data: [] }));
  const task = generateImages({ ...request, count: 5 });
  await jest.runAllTimersAsync();
  const images = await task;
  const urls = Array.from({ length: 5 }, (_, index) => `https://cdn.example/index-${index}.png`);
  expect(images.map((image) => image.remoteUrl)).toEqual(urls);
  expect(images.every((image) => image.status === 'complete')).toBe(true);
  expect(mockDownload.mock.calls.map(([url]) => url)).toEqual(urls);
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
});

test('a full terminal array defines the final upstream order before any download is shown', async () => {
  jest.useFakeTimers();
  const urls = ['first', 'second', 'third', 'fourth'].map((name) => `https://cdn.example/${name}.png`);
  const checkpoints: GeneratedImage[][] = [];
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'snapshot', status: 'queued', data: [{ url: urls[2] }] }))
    .mockResolvedValueOnce(response({ status: 'running', data: [{ url: urls[3] }, { url: urls[0] }] }))
    .mockResolvedValueOnce(response({ status: 'done', data: urls.map((url) => ({ url })) }));
  const task = generateImages({ ...request, count: 4, onImages: (images) => { checkpoints.push(images); } });
  await jest.runAllTimersAsync();
  expect((await task).map((image) => image.remoteUrl)).toEqual(urls);
  expect(checkpoints[0].map((image) => image.remoteUrl)).toEqual(urls);
  expect(checkpoints[0].every((image) => image.status === 'pending')).toBe(true);
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
});

test('resuming an existing batch polls it without a new paid request', async () => {
  jest.useFakeTimers();
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ status: 'done', data: [{ b64_json: first }, { b64_json: second }] }));
  const task = generateImages({ ...request, resumeTask: { id: 'saved-task', url: 'https://images.example/v1/images/tasks/saved-task' } });
  await jest.runAllTimersAsync();
  expect(await task).toHaveLength(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
});

test('a resumed sparse indexed task keeps missing slots through polling and terminal checkpoint restoration', async () => {
  jest.useFakeTimers();
  const localUri = 'file:///resumed-fourth.png';
  mockSavedFiles.add(localUri);
  let completed: ImageTaskRef | undefined;
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(response({ status: 'done', data: [{ index: 1, url: firstUrl }] }));
  const task = generateImages({ ...request, count: 4, resumeTask: {
    id: 'sparse-task', url: 'https://images.example/v1/images/tasks/sparse-task', results: [{ index: 3, localUri }],
  }, onTask: (checkpoint) => { completed = JSON.parse(JSON.stringify(checkpoint)) as ImageTaskRef; } });
  await jest.runAllTimersAsync();
  const images = await task;
  expect(images.map((image) => [image.status, image.uri])).toEqual([
    ['error', null], ['complete', 'file:///download-first.png'], ['error', null], ['complete', localUri],
  ]);
  expect(completed?.terminal).toBe(true);
  expect(completed?.results?.map((image) => image.index)).toEqual([1, 3]);
  const restored = await generateImages({ ...request, count: 4, resumeTask: completed });
  expect(restored.map((image) => [image.status, image.uri])).toEqual(images.map((image) => [image.status, image.uri]));
  expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['GET']);
});

test('persisted partial task results survive interruption and merge with later deltas without another POST', async () => {
  jest.useFakeTimers();
  const urls = Array.from({ length: 4 }, (_, index) => `https://cdn.example/resume-${index}.png`);
  const controller = new AbortController();
  let saved: ImageTaskRef | undefined;
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'restart', status: 'queued', data: [{ index: 2, url: urls[2] }] }))
    .mockResolvedValueOnce(response({ status: 'running', data: [{ index: 0, url: urls[0] }] }));
  const interrupted = generateImages({ ...request, count: 4, signal: controller.signal, onTask: (task) => {
    saved = JSON.parse(JSON.stringify(task)) as ImageTaskRef;
    if (task.results?.length === 2) controller.abort();
  } }).catch((error: unknown) => error);
  await jest.runAllTimersAsync();
  expect(await interrupted).toBeInstanceOf(Error);
  expect(saved?.results?.map((image) => image.url)).toEqual([urls[2], urls[0]]);
  expect(saved?.terminal).toBe(false);
  expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'GET']);
  expect(mockDownload).not.toHaveBeenCalled();

  fetchMock.mockReset()
    .mockResolvedValueOnce(response({ status: 'running', data: [{ index: 3, url: urls[3] }] }))
    .mockResolvedValueOnce(response({ status: 'done', data: [{ index: 1, url: urls[1] }] }));
  const resumed = generateImages({ ...request, count: 4, resumeTask: saved });
  await jest.runAllTimersAsync();
  const images = await resumed;
  expect(images.map((image) => image.remoteUrl)).toEqual(urls);
  expect(images.every((image) => image.status === 'complete')).toBe(true);
  expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'GET']);
});

test('base64-only checkpoints store file references and deduplicate repeated bytes after a JSON round trip', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  let saved: ImageTaskRef | undefined;
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'inline-restart', status: 'queued', data: [{ b64_json: first }] }));
  const interrupted = generateImages({ ...request, signal: controller.signal, onTask: (task) => {
    saved = JSON.parse(JSON.stringify(task)) as ImageTaskRef;
    if (task.results?.length === 1) controller.abort();
  } }).catch((error: unknown) => error);
  await jest.runAllTimersAsync();
  expect(await interrupted).toBeInstanceOf(Error);
  expect(saved?.results).toEqual([{ localUri: 'file:///base64-YWJj.png', base64Hash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(JSON.stringify(saved)).not.toContain(first);
  expect(mockSave).toHaveBeenCalledTimes(1);

  fetchMock.mockReset()
    .mockResolvedValueOnce(response({ status: 'running', data: [{ b64_json: 'YWJj\n ZA==' }] }))
    .mockResolvedValueOnce(response({ status: 'done', data: [{ b64_json: first }, { b64_json: second }] }));
  const onTask = jest.fn(async () => undefined);
  const resumed = generateImages({ ...request, resumeTask: saved, onTask });
  await jest.runAllTimersAsync();
  expect((await resumed).map((image) => [image.status, image.uri])).toEqual([
    ['complete', 'file:///base64-YWJj.png'], ['complete', 'file:///base64-ZWZn.png'],
  ]);
  expect(mockSave.mock.calls.map(([value]) => value)).toEqual([first, second]);
  expect(onTask).toHaveBeenCalledTimes(1);
  expect(onTask).toHaveBeenLastCalledWith(expect.objectContaining({ terminal: true, results: [
    { localUri: 'file:///base64-YWJj.png', base64Hash: expect.any(String) },
    { localUri: 'file:///base64-ZWZn.png', base64Hash: expect.any(String) },
  ] }));
  expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['GET', 'GET']);
});

test('a completed checkpoint restores local and remote images without polling or submitting', async () => {
  const localUri = 'file:///base64-YWJj.png';
  mockSavedFiles.add(localUri);
  const fetchMock = jest.spyOn(global, 'fetch');
  const images = await generateImages({ ...request, resumeTask: {
    id: 'finished', url: 'https://images.example/v1/images/tasks/finished', terminal: true,
    results: [{ localUri, index: 0 }, { url: secondUrl, index: 1 }],
  } });
  expect(images.map((image) => [image.status, image.uri])).toEqual([
    ['complete', localUri], ['complete', 'file:///download-second.png'],
  ]);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockDownload.mock.calls.map(([url]) => url)).toEqual([secondUrl]);
});

test('replayed bytes restore a checkpoint file that was lost during interruption', async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  let saved: ImageTaskRef | undefined;
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'lost-local', status: 'queued', data: [{ b64_json: first }] }));
  const interrupted = generateImages({ ...request, signal: controller.signal, onTask: (task) => {
    saved = JSON.parse(JSON.stringify(task)) as ImageTaskRef;
    if (task.results?.length === 1) controller.abort();
  } }).catch((error: unknown) => error);
  await jest.runAllTimersAsync();
  expect(await interrupted).toBeInstanceOf(Error);
  mockSavedFiles.clear();

  fetchMock.mockReset().mockResolvedValueOnce(response({ status: 'done', data: [{ b64_json: first }, { b64_json: second }] }));
  const task = generateImages({ ...request, resumeTask: saved, onTask: async () => undefined });
  await jest.runAllTimersAsync();
  expect((await task).every((image) => image.status === 'complete')).toBe(true);
  expect(mockSave.mock.calls.map(([value]) => value)).toEqual([first, first, second]);
  expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['GET']);
});

test('provider JSON cannot supply a client local-file reference', async () => {
  const localUri = 'file:///private-existing.png';
  mockSavedFiles.add(localUri);
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: [{ localUri }, { url: secondUrl, localUri }] }));
  const images = await generateImages(request);
  expect(images.map((image) => [image.status, image.uri])).toEqual([
    ['complete', 'file:///download-second.png'], ['error', null],
  ]);
  expect(mockDownload.mock.calls.map(([url]) => url)).toEqual([secondUrl]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('invalid saved image references cannot read files or cause a fresh paid generation', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  const results = [
    { url: 'file:///private.png' }, { url: 'https://user:secret@cdn.example/image.png' },
    { localUri: 'private.png' }, { localUri: 'file:///images/../private.png' },
    { localUri: 'file:///images/%2e%2e/private.png' }, { localUri: 'file:///private\n.png' },
  ];
  results.forEach((image) => { if (image.localUri) mockSavedFiles.add(image.localUri); });
  const images = await generateImages({ ...request, count: 1, resumeTask: {
    id: 'invalid-results', url: 'https://images.example/v1/images/tasks/invalid-results', terminal: true, results,
  } });
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ status: 'error', uri: null });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockDownload).not.toHaveBeenCalled();
});

test('a missing saved local file is reported without purchasing another image', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  const images = await generateImages({ ...request, count: 1, resumeTask: {
    id: 'missing-file', url: 'https://images.example/v1/images/tasks/missing-file', terminal: true,
    results: [{ localUri: 'file:///missing.png' }],
  } });
  expect(images[0]).toMatchObject({ status: 'error', uri: null, error: '已保存的图片文件已不可用' });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
  expect(mockDownload).not.toHaveBeenCalled();
});

test('a partial task checkpoint failure stops polling and keeps the newly written file for normal cleanup', async () => {
  jest.useFakeTimers();
  const storageError = new Error('task checkpoint could not be persisted');
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'checkpoint-failure', status: 'queued' }))
    .mockResolvedValueOnce(response({ status: 'running', data: [{ b64_json: first }] }));
  const task = generateImages({ ...request, onTask: async (checkpoint) => {
    if (checkpoint.results?.length) throw storageError;
  } }).catch((error: unknown) => error);
  await jest.runAllTimersAsync();
  expect(await task).toBe(storageError);
  expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(['POST', 'GET']);
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(mockSavedFiles.has('file:///base64-YWJj.png')).toBe(true);
  expect(mockDownload).not.toHaveBeenCalled();
});

test('partial task checkpoints finish persisting before the next poll starts', async () => {
  jest.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ task_id: 'await-checkpoint', status: 'queued' }))
    .mockResolvedValueOnce(response({ status: 'running', data: [{ url: firstUrl }] }))
    .mockResolvedValueOnce(response({ status: 'done', data: [{ url: secondUrl }] }));
  const task = generateImages({ ...request, onTask: async (checkpoint) => {
    if (checkpoint.results?.length === 1) await gate;
  } });
  await jest.advanceTimersByTimeAsync(20_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(mockDownload).not.toHaveBeenCalled();
  release();
  await jest.runAllTimersAsync();
  expect((await task).map((image) => image.remoteUrl)).toEqual([firstUrl, secondUrl]);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('a failed asynchronous batch still keeps the images its provider completed', async () => {
  jest.useFakeTimers();
  const fetchMock = jest.spyOn(global, 'fetch')
    .mockResolvedValueOnce(response({ status: 'running', data: [{ b64_json: first }] }))
    .mockResolvedValueOnce(response({ status: 'failed', error: { message: 'second image failed' } }));
  const task = generateImages({ ...request, resumeTask: { id: 'saved-task', url: 'https://images.example/v1/images/tasks/saved-task' } });
  await jest.runAllTimersAsync();
  const images = await task;
  expect(images.map((image) => image.status)).toEqual(['complete', 'error']);
  expect(images[0].uri).toBe('file:///base64-YWJj.png');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('an asynchronous task ID checkpoint failure is never swallowed', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ task_id: 'task-1', status: 'queued' }));
  const storageError = new Error('could not save task ID');
  await expect(generateImages({ ...request, onTask: async () => { throw storageError; } })).rejects.toBe(storageError);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a mismatched saved task never causes a silent new paid request', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  for (const url of ['https://other.example/v1/images/tasks/task-1', 'https://user:secret@images.example/v1/images/tasks/task-1']) {
    await expect(generateImages({ ...request, resumeTask: { id: 'task-1', url } })).rejects.toThrow('未重新生成');
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([4, 5, 10])('editing supports %i images with a single multipart submission', async (count) => {
  const OriginalFormData = global.FormData;
  class FormDataStub {
    parts: Array<[string, unknown]> = [];
    append(name: string, value: unknown) { this.parts.push([name, value]); }
  }
  Object.defineProperty(global, 'FormData', { configurable: true, value: FormDataStub });
  const urls = Array.from({ length: count }, (_, index) => `https://cdn.example/edit-${index}.png`);
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(response({ data: urls.map((url) => ({ url })) }));
  try {
    const images = await editImages({ ...request, count, references: [{ id: 'ref-1', uri: 'file:///ref.png', name: 'ref.png', mimeType: 'image/png', size: 100 }] });
    expect(images.map((image) => image.status)).toEqual(Array(count).fill('complete'));
    expect(images.map((image) => image.remoteUrl)).toEqual(urls);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0][1]?.body as unknown as FormDataStub).parts).toContainEqual(['n', String(count)]);
  } finally {
    Object.defineProperty(global, 'FormData', { configurable: true, value: OriginalFormData });
  }
});
