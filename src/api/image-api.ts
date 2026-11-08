import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import { sha256 } from '@noble/hashes/sha2.js';

import type { GeneratedImage, ImageApiResponse, Quality, ReferenceImage } from '../domain';
import { createId, imageEndpoint, normalizeBaseUrl, parseImageModels, redactSensitiveText } from '../domain-utils';
import { MAX_GENERATED_IMAGES, validateImageCount } from '../generated-images';
import { downloadPng, saveBase64Png } from '../storage/files';
import { isAbortError, networkFailureMessage } from './network';

export interface GenerateRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  quality: Quality;
  size: string;
  transparent: boolean;
  /** Defaults to one; validate before any paid request is submitted. */
  count?: number;
  /** Client-only slot IDs keep gallery selection stable as pending images finish. */
  resultIds?: string[];
  signal?: AbortSignal;
  /** An async task submitted earlier for this same job: poll it instead of submitting (and paying) again. */
  resumeTask?: ImageTaskRef | null;
  /** Awaited on task acceptance and each changed result checkpoint, including completion. */
  onTask?: (task: ImageTaskRef) => Promise<void> | void;
  /** Persist each batch checkpoint before processing another image. */
  onImages?: (images: GeneratedImage[]) => Promise<void> | void;
}

/** Durable task results contain references only, never megabytes of image data. */
export interface ImageTaskResult {
  url?: string;
  localUri?: string;
  /** Explicit zero-based provider slot. One-based formats need a provider adapter. */
  index?: number;
  imageId?: string;
  base64Hash?: string;
}

export interface ImageTaskRef { id: string; url: string; results?: ImageTaskResult[]; terminal?: boolean }

/** Error code of a task the provider reported as failed: resuming it is pointless. */
export const IMAGE_TASK_FAILED = 'image_task_failed';

export interface EditRequest extends GenerateRequest {
  references: ReferenceImage[];
  maskUri?: string | null;
}

export class ImageApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(redactSensitiveText(message));
    this.name = 'ImageApiError';
  }
}

const isGptImage = (model: string) => /gpt-image|chatgpt-image/i.test(model);

export function buildGenerationBody(request: Omit<GenerateRequest, 'baseUrl' | 'apiKey' | 'signal'>) {
  return {
    model: request.model,
    prompt: request.prompt,
    size: request.size,
    n: validateImageCount(request.count),
    // quality / output_format / background are GPT Image parameters; other models (DALL·E, Seedream,
    // Qwen-Image, Flux behind compatible relays) reject or misread them.
    ...(isGptImage(request.model) ? {
      quality: request.quality, output_format: 'png' as const,
      ...(request.transparent ? { background: 'transparent' as const } : {}),
    } : {}),
  };
}

export function buildEditFields(request: Omit<EditRequest, 'baseUrl' | 'apiKey' | 'signal' | 'references' | 'maskUri'>) {
  return {
    model: request.model,
    prompt: request.prompt,
    size: request.size,
    n: String(validateImageCount(request.count)),
    // quality / output_format / background are GPT Image parameters; other models (DALL·E, Seedream,
    // Qwen-Image, Flux behind compatible relays) reject or misread them.
    ...(isGptImage(request.model) ? {
      quality: request.quality, output_format: 'png' as const,
      ...(request.transparent ? { background: 'transparent' as const } : {}),
    } : {}),
  };
}

export async function fetchImageModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(imageEndpoint(baseUrl, 'models'), {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
      headers: authorizationHeaders(apiKey),
      signal: controller.signal,
    });
    const payload = await parseResponse(response);
    return parseImageModels(payload);
  } catch (error) {
    if (isAbortError(error)) throw new ImageApiError('连接测试超时，请检查 API 地址');
    if (error instanceof ImageApiError) throw error;
    throw new ImageApiError(networkFailureMessage(baseUrl, '模型列表', error));
  } finally {
    clearTimeout(timer);
  }
}

/** Removes the literal API key from any error text (relays sometimes echo it back). */
function withoutKey<T>(apiKey: string, task: () => Promise<T>): Promise<T> {
  const key = apiKey.trim();
  return task().catch((error: unknown) => {
    if (!key || !(error instanceof Error) || !error.message.includes(key)) throw error;
    const safe = error.message.split(key).join('[已隐藏密钥]');
    throw error instanceof ImageApiError ? new ImageApiError(safe, error.status, error.code) : Object.assign(new Error(safe), { name: error.name });
  });
}

export function generateImage(request: GenerateRequest): Promise<string> {
  return withoutKey(request.apiKey, () => generateImageUnsafe(request));
}

export function editImage(request: EditRequest): Promise<string> {
  return withoutKey(request.apiKey, () => editImageUnsafe(request));
}

export function generateImages(request: GenerateRequest): Promise<GeneratedImage[]> {
  return withoutKey(request.apiKey, async () => {
    const count = validateImageCount(request.count);
    return persistApiResults(await generateImagePayload(request), { ...request, count });
  });
}

export function editImages(request: EditRequest): Promise<GeneratedImage[]> {
  return withoutKey(request.apiKey, async () => {
    const count = validateImageCount(request.count);
    return persistApiResults(await editImagePayload(request), { ...request, count });
  });
}

/** Resumes a saved task when it still points at this provider. */
async function resumeImageTask(request: GenerateRequest): Promise<ImageApiResponse | Record<string, unknown> | null> {
  const saved = request.resumeTask;
  if (!saved) return null;
  const url = typeof saved.id === 'string' && saved.id.trim() && typeof saved.url === 'string' ? resolveSameHostUrl(saved.url, request.baseUrl) : null;
  if (!url) throw new ImageApiError('原图片任务地址无效或与当前 API 不匹配，未重新生成');
  if (saved.terminal === true) return completedTaskPayload(normalizeTaskResults(saved.results));
  return pollImageTask({ id: saved.id, url }, request);
}

async function generateImageUnsafe(request: GenerateRequest): Promise<string> {
  return persistApiResult(await generateImagePayload(request), request.signal);
}

async function generateImagePayload(request: GenerateRequest): Promise<ImageApiResponse | Record<string, unknown>> {
  validateImageCount(request.count);
  const resumed = await resumeImageTask(request);
  if (resumed) return resumed;
  const payload = await requestImageApi(imageEndpoint(request.baseUrl, 'images/generations'), {
    method: 'POST',
    headers: {
      ...authorizationHeaders(request.apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildGenerationBody(request)),
    signal: request.signal,
  });
  return resolveImageResponse(payload, request);
}

async function editImageUnsafe(request: EditRequest): Promise<string> {
  return persistApiResult(await editImagePayload(request), request.signal);
}

async function editImagePayload(request: EditRequest): Promise<ImageApiResponse | Record<string, unknown>> {
  validateImageCount(request.count);
  if (request.references.length === 0) throw new ImageApiError('图片编辑至少需要一张参考图');
  if (request.references.length > 4) throw new ImageApiError('一次最多上传 4 张参考图');
  const resumed = await resumeImageTask(request);
  if (resumed) return resumed;

  const form = new FormData();
  const fields = buildEditFields(request);
  Object.entries(fields).forEach(([key, value]) => form.append(key, value));

  request.references.forEach((reference, index) => {
    const file = new File(reference.uri);
    form.append('image[]', file, reference.name || `reference-${index + 1}${file.extension || '.png'}`);
  });
  if (request.maskUri) {
    form.append('mask', new File(request.maskUri), 'mask.png');
  }

  const payload = await requestImageApi(imageEndpoint(request.baseUrl, 'images/edits'), {
    method: 'POST',
    headers: authorizationHeaders(request.apiKey),
    body: form,
    signal: request.signal,
  });
  return resolveImageResponse(payload, request);
}

async function resolveImageResponse(payload: ImageApiResponse | Record<string, unknown>, request: GenerateRequest): Promise<ImageApiResponse | Record<string, unknown>> {
  const task = asyncTaskFromPayload(payload, request.baseUrl);
  if (!task) return payload;
  await request.onTask?.(task);
  return pollImageTask(task, request, payload);
}

type AsyncImageTask = { url: string; id: string };

function asyncTaskFromPayload(payload: unknown, baseUrl: string): AsyncImageTask | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  const id = typeof record.task_id === 'string'
    ? record.task_id
    : typeof record.taskId === 'string' ? record.taskId : '';
  if (!id || !['queued', 'pending', 'processing', 'running', 'submitted'].includes(status)) return null;
  const explicit = typeof record.poll_url === 'string' ? record.poll_url : typeof record.pollUrl === 'string' ? record.pollUrl : '';
  const fallback = `${normalizeBaseUrl(baseUrl)}/images/tasks/${encodeURIComponent(id)}`;
  const url = explicit ? resolveSameHostUrl(explicit, baseUrl) : fallback;
  return url ? { url, id } : null;
}

function resolveSameHostUrl(value: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(value, normalizeBaseUrl(baseUrl));
    const expected = new URL(normalizeBaseUrl(baseUrl));
    if (resolved.username || resolved.password) return null;
    if (resolved.protocol !== expected.protocol || resolved.hostname !== expected.hostname || resolved.port !== expected.port) return null;
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

async function pollImageTask(task: AsyncImageTask, request: GenerateRequest, initial?: unknown): Promise<ImageApiResponse | Record<string, unknown>> {
  const deadline = Date.now() + 10 * 60_000;
  let received = normalizeTaskResults(request.resumeTask?.results);
  let previousCheckpoint = JSON.stringify({ results: received, terminal: false });
  const merge = (latest: ImagePayload[]) => {
    const collected = imagePayloadCollector(true);
    [...received, ...latest].forEach(collected.append);
    received = collected.candidates;
  };
  const checkpoint = async (terminal: boolean) => {
    if (!request.onTask) return;
    for (const image of received) {
      // The network parser never accepts localUri. Only a previously validated
      // client checkpoint or our own successful file write can supply this field.
      if (image.base64 && !/^https?:\/\//i.test(image.url ?? '')) {
        const encoded = normalizeBase64(image.base64);
        if (!image.localUri || !savedImageExists(image.localUri)) image.localUri = saveBase64Png(encoded);
        image.base64Hash ??= hashBase64(encoded);
        delete image.base64;
        if (/^data:image\//i.test(image.url ?? '')) delete image.url;
      }
    }
    const results = taskResults(received);
    const serialized = JSON.stringify({ results, terminal });
    if (serialized === previousCheckpoint) return;
    // A failed write stops polling. A newly written but unreferenced image then
    // remains in the generated-images directory for the existing orphan sweep.
    await request.onTask({ ...task, results, terminal });
    previousCheckpoint = serialized;
  };
  const completedResponse = async (latest: ImagePayload[]): Promise<ImageApiResponse> => {
    // A complete final array is authoritative. A delta-only final response must
    // also retain earlier completed images, in first-seen provider order.
    let selected = received;
    if (latest.length >= validateImageCount(request.count)) {
      const canonical = imagePayloadCollector(true);
      latest.forEach(canonical.append);
      const finalCount = canonical.candidates.length;
      received.forEach(canonical.append);
      selected = canonical.candidates.slice(0, finalCount);
    }
    const images = selected.map((image, position) => ({ image, position })).sort((left, right) =>
      (left.image.index ?? MAX_GENERATED_IMAGES + 1 + left.position) - (right.image.index ?? MAX_GENERATED_IMAGES + 1 + right.position));
    received = images.map(({ image }) => image);
    await checkpoint(true);
    return completedTaskPayload(received);
  };
  merge(findImagePayloads(initial, false));
  await checkpoint(false);
  let waitMs = 2_000;
  let failures = 0;
  while (Date.now() < deadline) {
    if (request.signal?.aborted) throw new ImageApiError('请求已取消或超时');
    await waitForPoll(waitMs, request.signal);
    let response: Awaited<ReturnType<typeof requestImageApi>>;
    try {
      response = await requestImageApi(task.url, {
        method: 'GET',
        headers: authorizationHeaders(request.apiKey),
        signal: request.signal,
      });
      failures = 0;
    } catch (error) {
      // Polling is free and the task keeps running: ride out a dropped connection or a busy relay.
      const status = error instanceof ImageApiError ? error.status : undefined;
      const transient = !isAbortError(error) && !request.signal?.aborted && (status === undefined || status === 408 || status === 429 || status >= 500);
      failures += 1;
      if (!transient || failures > MAX_POLL_FAILURES) {
        if (isAbortError(error) || request.signal?.aborted) throw error;
        const detail = error instanceof Error ? error.message : '网络错误';
        throw new ImageApiError(`查询图片任务 ${task.id} 的进度失败：${detail}。任务可能仍在生成，重试会继续查询这个任务，不会重复提交`, status);
      }
      waitMs = Math.min(8_000, waitMs * 2);
      continue;
    }
    const record = response && typeof response === 'object' ? response as Record<string, unknown> : {};
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
    const latest = findImagePayloads(response, false);
    merge(latest);
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      // Some batch providers report a failed task after producing a subset.
      // Keep those already-paid images; the missing slots receive local errors.
      if (received.length) return completedResponse(latest);
      const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null;
      throw new ImageApiError(typeof error?.message === 'string' ? error.message : `图片任务 ${task.id} 未完成`, undefined, IMAGE_TASK_FAILED);
    }
    const stillRunning = ['queued', 'pending', 'processing', 'running', 'submitted'].includes(status);
    if (['completed', 'succeeded', 'success', 'done'].includes(status) || (!stillRunning && latest.length)) return completedResponse(latest);
    await checkpoint(false);
    const retryAfter = Number(record.retry_after ?? record.retryAfter);
    waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(10_000, retryAfter * 1000) : Math.min(8_000, Math.round(waitMs * 1.35));
  }
  throw new ImageApiError('图片任务等待超过 10 分钟，已停止轮询。请查看服务商记录后再手动重试');
}

const MAX_POLL_FAILURES = 4;

function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('请求已取消')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(new Error('请求已取消')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestImageApi(url: string, options: Parameters<typeof fetch>[1]) {
  let response: Response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', credentials: 'omit' });
  } catch (error) {
    if (error instanceof ImageApiError || isAbortError(error)) throw error;
    // Expo's streaming fetch and React Native's built-in fetch use different
    // native plumbing on some Android versions. Only when the first transport
    // provably never reached the server (DNS / connect / TLS handshake) is the
    // same request tried once on the other transport. Any later failure may
    // mean the provider already started a paid generation, so it is never
    // resent automatically.
    const alternateFetch = globalThis.fetch;
    if (typeof alternateFetch !== 'function' || alternateFetch === fetch || !isConnectFailure(error)) {
      throw new ImageApiError(networkFailureMessage(url, '生图接口', error));
    }
    try {
      response = await alternateFetch(url, { ...options, redirect: 'error', credentials: 'omit' });
    } catch (alternateError) {
      if (alternateError instanceof ImageApiError || isAbortError(alternateError)) throw alternateError;
      throw new ImageApiError(networkFailureMessage(url, '生图接口', alternateError));
    }
  }
  try {
    return await parseResponse(response);
  } catch (error) {
    if (error instanceof ImageApiError || isAbortError(error)) throw error;
    throw new ImageApiError(networkFailureMessage(url, '生图接口', error));
  }
}

/** Failures that happen before any byte of the request reaches the server. */
export function isConnectFailure(error: unknown): boolean {
  if (!(error instanceof Error) || isAbortError(error)) return false;
  // Android (OkHttp / Java) and iOS (NSURLError) wordings of “never reached the server”.
  return /unknownhost|unable to resolve|no address associated|failed to connect|connectexception|connection refused|econnrefused|ehostunreach|enetunreach|network is unreachable|sslhandshake|handshake failed|cleartext|hostname could not be found|could not connect to the server|appears to be offline|not connected to the internet|app transport security/i.test(error.message);
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    Accept: 'application/json',
    'User-Agent': 'Salcara-AI-Android',
    'X-Client-Request-Id': createId(),
  };
}

async function parseResponse(response: Response): Promise<ImageApiResponse | Record<string, unknown>> {
  let payload: ImageApiResponse | Record<string, unknown> = {};
  try {
    payload = (await response.json()) as ImageApiResponse;
  } catch {
    if (!response.ok) throw new ImageApiError(statusMessage(response.status), response.status);
  }

  if (!response.ok) {
    const apiPayload = payload as ImageApiResponse;
    const message = apiPayload.error?.message || statusMessage(response.status);
    throw new ImageApiError(message, response.status, apiPayload.error?.code);
  }
  return payload;
}

export async function persistApiResult(
  payload: ImageApiResponse | Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const image = findImagePayload(payload);
  if (image) return persistImagePayload(image, signal);
  throw new ImageApiError(
    '接口返回成功，但没有找到图片数据。请确认上游返回 data[0].b64_json 或 data[0].url；如果只返回外部图片地址，请在 sub2api 开启“生图结果 URL 转 base64”。',
  );
}

type ImagePayload = ImageTaskResult & { base64?: string };
type PersistBatchOptions = Pick<GenerateRequest, 'signal' | 'count' | 'resultIds' | 'onImages'> & { apiKey?: string };
// A symbol cannot arrive in provider JSON, so task-local files never enter via
// untrusted HTTP response fields that merely happen to be named "localUri".
const TASK_IMAGES = Symbol('client-image-task-results');

function completedTaskPayload(images: ImagePayload[]): ImageApiResponse {
  return Object.assign({ data: [] }, { [TASK_IMAGES]: images.map((image) => ({ ...image })) });
}

function normalizeTaskResults(raw: unknown): ImagePayload[] {
  if (!Array.isArray(raw)) return [];
  const images: ImagePayload[] = [];
  for (const value of raw.slice(0, MAX_GENERATED_IMAGES)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    let url: string | undefined;
    if (typeof record.url === 'string' && record.url.length <= 16_384) {
      try {
        const parsed = new URL(record.url);
        if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.toString();
      } catch { /* invalid persisted URL */ }
    }
    // These files are generated by the client. Reject remote, data, relative,
    // traversal and control-character paths at the persisted JSON boundary.
    const localUri = typeof record.localUri === 'string' && record.localUri.length <= 16_384
      && /^file:\/\/\//i.test(record.localUri) && !/[\x00-\x1f]/.test(record.localUri)
      && !record.localUri.split(/[\\/]/).some((part) => part === '..' || /%2e/i.test(part)) ? record.localUri : undefined;
    if (!url && !localUri) continue;
    const index = imageSlotIndex(record.index);
    const imageId = typeof record.imageId === 'string' && record.imageId.trim() && record.imageId.length <= 200 ? record.imageId.trim() : undefined;
    const base64Hash = typeof record.base64Hash === 'string' && /^[a-f0-9]{64}$/.test(record.base64Hash) ? record.base64Hash : undefined;
    images.push({ ...(url ? { url } : {}), ...(localUri ? { localUri } : {}), ...(index === undefined ? {} : { index }),
      ...(imageId ? { imageId } : {}), ...(base64Hash ? { base64Hash } : {}) });
  }
  return images;
}

function taskResults(images: ImagePayload[]): ImageTaskResult[] {
  return images.slice(0, MAX_GENERATED_IMAGES).map((image) => ({
    ...(/^https?:\/\//i.test(image.url ?? '') ? { url: image.url } : {}), ...(image.localUri ? { localUri: image.localUri } : {}),
    ...(image.index === undefined ? {} : { index: image.index }), ...(image.imageId ? { imageId: image.imageId } : {}),
    ...(image.base64Hash ? { base64Hash: image.base64Hash } : {}),
  }));
}

/** Hash canonical base64 in small ASCII chunks without another full-size copy. */
function hashBase64(value: string): string {
  const hash = sha256.create();
  for (let offset = 0; offset < value.length; offset += 16_384) {
    const chunk = new Uint8Array(Math.min(16_384, value.length - offset));
    for (let index = 0; index < chunk.length; index += 1) chunk[index] = value.charCodeAt(offset + index);
    hash.update(chunk);
  }
  return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function imageSlotIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_GENERATED_IMAGES ? value : undefined;
}

/** Indexed partial batches keep their holes; unindexed images retain arrival order. */
function imageResultSlots(images: ImagePayload[], count: number): Array<ImagePayload | undefined> {
  const slots: Array<ImagePayload | undefined> = Array.from({ length: count }, () => undefined);
  for (const image of images) {
    const index = imageSlotIndex(image.index);
    if (index !== undefined) slots[index] = image;
  }
  for (const image of images) {
    if (imageSlotIndex(image.index) !== undefined) continue;
    const vacant = slots.findIndex((slot) => !slot);
    const index = vacant >= 0 ? vacant : slots.length;
    if (index < MAX_GENERATED_IMAGES) slots[index] = image;
  }
  return slots;
}

/** A generation is submitted only once; failures here affect individual downloads. */
export async function persistApiResults(
  payload: ImageApiResponse | Record<string, unknown>,
  options: PersistBatchOptions = {},
): Promise<GeneratedImage[]> {
  const count = validateImageCount(options.count);
  const images = findImagePayloads(payload);
  const slots = imageResultSlots(images, count);
  const suppliedIds = (Array.isArray(options.resultIds) ? options.resultIds.slice(0, MAX_GENERATED_IMAGES) : []).map((value) => {
    const id = typeof value === 'string' ? value.trim() : '';
    return id && id.length <= 200 && !/[\x00-\x1f]/.test(id) ? id : null;
  });
  const reservedIds = new Set(suppliedIds);
  const usedIds = new Set<string>();
  const results: GeneratedImage[] = Array.from({ length: slots.length }, (_, index) => {
    let id = suppliedIds[index];
    if (!id || usedIds.has(id)) {
      do { id = createId(); } while (usedIds.has(id) || reservedIds.has(id));
    }
    usedIds.add(id);
    return {
      id,
      uri: null,
      remoteUrl: slots[index]?.url && /^https?:\/\//i.test(slots[index].url!) ? slots[index].url! : null,
      status: 'pending',
      error: null,
    };
  });
  // The caller must be able to recover remote URLs even if a later download is
  // interrupted. A failed checkpoint is fatal and must not be swallowed by the
  // per-image download error handler below.
  const checkpoint = () => options.onImages?.(results.map((result) => ({ ...result })));
  await checkpoint();
  for (let index = 0; index < results.length; index += 1) {
    const image = slots[index];
    try {
      if (options.signal?.aborted) throw new ImageApiError('图片下载已暂停');
      if (!image) throw new ImageApiError(`上游仅返回 ${images.length} 张图片，第 ${index + 1} 张未返回`);
      const uri = await persistImagePayload(image, options.signal);
      results[index] = { ...results[index], uri, status: 'complete', error: null };
    } catch (error) {
      const raw = error instanceof Error ? error.message : '图片保存失败';
      const key = options.apiKey?.trim();
      results[index] = {
        ...results[index], status: 'error',
        error: redactSensitiveText(key ? raw.split(key).join('[已隐藏密钥]') : raw),
      };
    }
    await checkpoint();
  }
  return results;
}

function savedImageExists(uri: string): boolean {
  try {
    const file = new File(uri);
    return file.exists && (file.size ?? 0) > 0;
  } catch {
    return false;
  }
}

async function persistImagePayload(image: ImagePayload, signal?: AbortSignal): Promise<string> {
  if (image.localUri) {
    if (savedImageExists(image.localUri)) return image.localUri;
    if (!image.base64 && !image.url) throw new ImageApiError('已保存的图片文件已不可用');
  }
  if (image.base64) return saveBase64Png(normalizeBase64(image.base64));
  if (/^data:image\//i.test(image.url ?? '')) {
    const encoded = /^data:image\/[^;]+;base64,(.+)$/is.exec(image.url!)?.[1];
    if (!encoded) throw new ImageApiError('接口返回的内嵌图片格式不受支持');
    return saveBase64Png(normalizeBase64(encoded));
  }
  if (image.url) return downloadPng(image.url, signal);
  throw new ImageApiError('接口返回成功，但没有找到图片数据');
}

/**
 * Providers in the wild do not all preserve the OpenAI Images response shape.
 * Keep the wire parser deliberately tolerant, but only inspect image-like keys
 * so a successful text/error payload is never mistaken for base64 image bytes.
 */
export function findImagePayload(payload: unknown): ImagePayload | null {
  const candidates = findImagePayloads(payload);
  const preferred = candidates.find((candidate) => Boolean(candidate.base64)) ?? candidates[0] ?? null;
  // Preserve the single-image API's historical inline-data preference.
  return preferred?.base64 ? { base64: preferred.base64 } : preferred;
}

/** Preserve provider order and treat aliases on one object as one image. */
export function findImagePayloads(payload: unknown, includePartial = true): ImagePayload[] {
  if (payload && typeof payload === 'object' && TASK_IMAGES in payload) {
    return (payload as { [TASK_IMAGES]: ImagePayload[] })[TASK_IMAGES].slice(0, MAX_GENERATED_IMAGES).map((image) => ({ ...image }));
  }
  const { candidates, append } = imagePayloadCollector();
  collectImagePayloads(payload, 0, new Set<object>(), false, append, () => candidates.length >= MAX_GENERATED_IMAGES, includePartial);
  return candidates;
}

function imagePayloadCollector(hashBytes = false) {
  const candidates: ImagePayload[] = [];
  const byBase64 = new Map<string, ImagePayload>();
  const byUrl = new Map<string, ImagePayload>();
  const byIndex = new Map<number, ImagePayload>();
  const byId = new Map<string, ImagePayload>();
  const byHash = new Map<string, ImagePayload>();
  const append = (candidate: ImagePayload) => {
    const embedded = candidate.url ? /^data:image\/[^;]+;base64,(.+)$/is.exec(candidate.url)?.[1] : undefined;
    const bytes = candidate.base64 ?? (embedded && looksLikeBase64(embedded) ? embedded : undefined);
    const base64 = bytes ? normalizeBase64(bytes) : undefined;
    const base64Hash = candidate.base64Hash ?? (base64 && (hashBytes || byHash.size) ? hashBase64(base64) : undefined);
    const previous = (candidate.index === undefined ? undefined : byIndex.get(candidate.index))
      ?? (candidate.imageId ? byId.get(candidate.imageId) : undefined)
      ?? (base64Hash ? byHash.get(base64Hash) : undefined)
      ?? (base64 ? byBase64.get(base64) : undefined) ?? (candidate.url ? byUrl.get(candidate.url) : undefined);
    if (previous) {
      // Identified images can get a refreshed signed URL or their final bytes.
      // Keep their original position, and replace their transport data in place.
      if (base64) {
        if (base64Hash && base64Hash !== previous.base64Hash) delete previous.localUri;
        previous.base64 = base64;
      }
      if (candidate.url) previous.url = candidate.url;
      if (candidate.localUri) previous.localUri = candidate.localUri;
      if (base64Hash) { previous.base64Hash = base64Hash; byHash.set(base64Hash, previous); }
      if (candidate.index !== undefined) { previous.index = candidate.index; byIndex.set(candidate.index, previous); }
      if (candidate.imageId) { previous.imageId = candidate.imageId; byId.set(candidate.imageId, previous); }
      if (base64) byBase64.set(base64, previous);
      if (candidate.url) byUrl.set(candidate.url, previous);
      return;
    }
    if (candidates.length >= MAX_GENERATED_IMAGES) return;
    const image = { ...(base64 ? { base64 } : {}), ...(candidate.url ? { url: candidate.url } : {}),
      ...(candidate.localUri ? { localUri: candidate.localUri } : {}), ...(base64Hash ? { base64Hash } : {}),
      ...(candidate.index === undefined ? {} : { index: candidate.index }), ...(candidate.imageId ? { imageId: candidate.imageId } : {}) };
    candidates.push(image);
    if (base64) byBase64.set(base64, image);
    if (candidate.url) byUrl.set(candidate.url, image);
    if (candidate.index !== undefined) byIndex.set(candidate.index, image);
    if (candidate.imageId) byId.set(candidate.imageId, image);
    if (base64Hash) byHash.set(base64Hash, image);
  };
  return { candidates, append };
}

const BASE64_KEYS = [
  'b64_json', 'b64', 'base64', 'base64_json', 'image_base64',
  'imageBase64', 'image_data', 'imageData', 'data_url', 'dataUrl',
  'partial_image_b64', 'partialImageB64', 'image_bytes', 'imageBytes', 'bytes',
];
const URL_KEYS = ['url', 'image_url', 'imageUrl', 'src', 'image_src', 'imageSrc'];

function directImageUrl(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim();
    return /^(?:data:image\/|https?:\/\/)/i.test(text) ? text : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth >= 4) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of URL_KEYS) {
    const nested = directImageUrl(record[key], depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function collectImagePayloads(
  value: unknown,
  depth: number,
  visited: Set<object>,
  imageContext: boolean,
  append: (image: ImagePayload) => void,
  full: () => boolean,
  includePartial: boolean,
): void {
  if (depth > 8 || value === null || value === undefined || full()) return;

  if (typeof value === 'string') {
    const text = value.trim();
    if (/^data:image\//i.test(text) || /^https?:\/\//i.test(text)) append({ url: text });
    // Bare strings are only considered base64 when they came from an image
    // field or an image array. This avoids treating a normal text answer as an
    // image while supporting {images: ["..."]} and {output: "..."} variants.
    else if (imageContext && looksLikeBase64(text)) append({ base64: text });
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectImagePayloads(item, depth + 1, visited, imageContext, append, full, includePartial);
      if (full()) break;
    }
    return;
  }

  if (typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);
  const record = value as Record<string, unknown>;
  if (!includePartial && typeof record.type === 'string' && /partial[_-]?image/i.test(record.type)) return;

  let base64: string | undefined;
  let inlineUrl: string | undefined;
  let remoteUrl: string | undefined;
  for (const key of BASE64_KEYS) {
    if (!includePartial && (key === 'partial_image_b64' || key === 'partialImageB64')) continue;
    const candidate = record[key];
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const text = candidate.trim();
    if (/^data:image\//i.test(text)) inlineUrl ??= text;
    else if (looksLikeBase64(text)) base64 ??= text;
  }

  for (const key of URL_KEYS) {
    const candidate = directImageUrl(record[key]);
    if (/^data:image\//i.test(candidate ?? '')) inlineUrl ??= candidate;
    else if (candidate) remoteUrl ??= candidate;
  }
  // Inline data avoids an expiring CDN request, while its sibling URL remains
  // available for recovery if saving the inline bytes fails.
  const embedded = inlineUrl ? /^data:image\/[^;]+;base64,(.+)$/is.exec(inlineUrl)?.[1] : undefined;
  if (!base64 && embedded && looksLikeBase64(embedded)) base64 = embedded;
  const pendingImage = !includePartial && typeof record.status === 'string' && ['queued', 'pending', 'processing', 'running', 'submitted'].includes(record.status.toLowerCase());
  const rawIndex = record.index ?? record.image_index ?? record.output_index;
  const index = imageSlotIndex(rawIndex);
  const rawId = record.image_id ?? record.imageId ?? record.id;
  const imageId = typeof rawId === 'string' && rawId.trim() && rawId.length <= 200 ? rawId.trim() : undefined;
  if (!pendingImage && (base64 || remoteUrl || inlineUrl)) append({
    ...(base64 ? { base64 } : {}), ...((remoteUrl ?? inlineUrl) ? { url: remoteUrl ?? inlineUrl } : {}),
    ...(index === undefined ? {} : { index }), ...(imageId ? { imageId } : {}),
  });

  // These are common wrappers used by gateway/proxy implementations. Avoid
  // traversing arbitrary metadata keys (which can be very large or sensitive).
  const wrapperKeys = ['data', 'images', 'image', 'output', 'outputs', 'result', 'results', 'response', 'artifacts', 'choices', 'message', 'content'];
  for (const key of wrapperKeys) {
    if (!(key in record)) continue;
    collectImagePayloads(record[key], depth + 1, visited, true, append, full, includePartial);
  }
}

/** One scan, no copies (image payloads can be tens of MB). */
function looksLikeBase64(value: string): boolean {
  let length = 0;
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 32 || code === 10 || code === 13 || code === 9) continue;
    if (code === 61) { padding += 1; if (padding > 2) return false; length += 1; continue; }
    if (padding) return false;
    const valid = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 45 || code === 95;
    if (!valid) return false;
    length += 1;
  }
  return length >= 8 && length % 4 !== 1;
}

function normalizeBase64(value: string): string {
  // Fast path: the ordinary, already padded alphabet is passed through untouched.
  if (!/[\s_-]/.test(value) && value.length % 4 === 0) return value;
  const compact = value.replace(/\s+/g, '');
  // A few gateways use base64url for the b64_json field. Android's file
  // writer expects the ordinary alphabet, so normalize it at the boundary.
  return compact.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(compact.length / 4) * 4, '=');
}

function statusMessage(status: number): string {
  if (status === 400) return '请求参数不受当前模型支持，请检查模型、画质和尺寸';
  if (status === 401 || status === 403) return 'API 密钥无效或没有调用权限';
  if (status === 404) return '没有找到图片接口，请检查 API 地址是否兼容 OpenAI Images API';
  if (status === 429) return '请求过于频繁、并发受限或账户余额不足';
  if (status >= 500) return '上游服务暂时不可用，请稍后手动重试';
  return `请求失败（HTTP ${status}）`;
}

export function normalizeError(error: unknown): ImageApiError {
  if (error instanceof ImageApiError) return error;
  if (isAbortError(error)) return new ImageApiError('请求已取消或超时');
  if (error instanceof Error) return new ImageApiError(error.message);
  return new ImageApiError('发生未知错误');
}
