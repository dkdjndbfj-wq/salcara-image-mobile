import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';

import type { ImageApiResponse, Quality, ReferenceImage } from '../domain';
import { createId, imageEndpoint, normalizeBaseUrl, parseImageModels, redactSensitiveText } from '../domain-utils';
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
  signal?: AbortSignal;
  /** An async task submitted earlier for this same job: poll it instead of submitting (and paying) again. */
  resumeTask?: ImageTaskRef | null;
  /** Called as soon as the provider answers with an async task, so a later retry can resume it. */
  onTask?: (task: ImageTaskRef) => void;
}

export interface ImageTaskRef { id: string; url: string }

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
    n: 1,
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
    n: '1',
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

/** Resumes a saved task when it still points at this provider. */
async function resumeImageTask(request: GenerateRequest): Promise<string | null> {
  const saved = request.resumeTask;
  const url = saved?.id && saved.url ? resolveSameHostUrl(saved.url, request.baseUrl) : null;
  if (!saved || !url) return null;
  return persistApiResult(await pollImageTask({ id: saved.id, url }, request), request.signal);
}

async function generateImageUnsafe(request: GenerateRequest): Promise<string> {
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
  return persistImageResponse(payload, request);
}

async function editImageUnsafe(request: EditRequest): Promise<string> {
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
  return persistImageResponse(payload, request);
}

async function persistImageResponse(payload: ImageApiResponse | Record<string, unknown>, request: GenerateRequest): Promise<string> {
  const task = asyncTaskFromPayload(payload, request.baseUrl);
  if (!task) return persistApiResult(payload, request.signal);
  try { request.onTask?.(task); } catch { /* saving the id is best effort */ }
  const completed = await pollImageTask(task, request);
  return persistApiResult(completed, request.signal);
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
    if (resolved.protocol !== expected.protocol || resolved.hostname !== expected.hostname || resolved.port !== expected.port) return null;
    resolved.hash = '';
    return resolved.toString();
  } catch {
    return null;
  }
}

async function pollImageTask(task: AsyncImageTask, request: GenerateRequest): Promise<ImageApiResponse | Record<string, unknown>> {
  const deadline = Date.now() + 10 * 60_000;
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
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null;
      throw new ImageApiError(typeof error?.message === 'string' ? error.message : `图片任务 ${task.id} 未完成`, undefined, IMAGE_TASK_FAILED);
    }
    if (findImagePayload(response) || ['completed', 'succeeded', 'success', 'done'].includes(status)) return response;
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
  if (image?.base64) return saveBase64Png(normalizeBase64(image.base64));
  if (image?.url?.startsWith('data:image/')) {
    const encoded = /^data:image\/[^;]+;base64,(.+)$/s.exec(image.url)?.[1];
    if (!encoded) throw new ImageApiError('接口返回的内嵌图片格式不受支持');
    return saveBase64Png(normalizeBase64(encoded));
  }
  if (image?.url) return downloadPng(image.url, signal);
  throw new ImageApiError(
    '接口返回成功，但没有找到图片数据。请确认上游返回 data[0].b64_json 或 data[0].url；如果只返回外部图片地址，请在 sub2api 开启“生图结果 URL 转 base64”。',
  );
}

/**
 * Providers in the wild do not all preserve the OpenAI Images response shape.
 * Keep the wire parser deliberately tolerant, but only inspect image-like keys
 * so a successful text/error payload is never mistaken for base64 image bytes.
 */
export function findImagePayload(payload: unknown): { base64?: string; url?: string } | null {
  const visited = new Set<object>();
  const candidates: Array<{ base64?: string; url?: string }> = [];
  collectImagePayloads(payload, 0, visited, false, candidates);
  return candidates.find((candidate) => Boolean(candidate.base64)) ?? candidates[0] ?? null;
}

function collectImagePayloads(
  value: unknown,
  depth: number,
  visited: Set<object>,
  imageContext: boolean,
  candidates: Array<{ base64?: string; url?: string }>,
): void {
  if (depth > 8 || value === null || value === undefined) return;

  if (typeof value === 'string') {
    const text = value.trim();
    if (/^data:image\//i.test(text) || /^https?:\/\//i.test(text)) candidates.push({ url: text });
    // Bare strings are only considered base64 when they came from an image
    // field or an image array. This avoids treating a normal text answer as an
    // image while supporting {images: ["..."]} and {output: "..."} variants.
    else if (imageContext && looksLikeBase64(text)) candidates.push({ base64: text });
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectImagePayloads(item, depth + 1, visited, imageContext, candidates);
    }
    return;
  }

  if (typeof value !== 'object') return;
  if (visited.has(value)) return;
  visited.add(value);
  const record = value as Record<string, unknown>;

  const base64Keys = [
    'b64_json', 'b64', 'base64', 'base64_json', 'image_base64',
    'imageBase64', 'image_data', 'imageData', 'data_url', 'dataUrl',
    'partial_image_b64', 'partialImageB64', 'image_bytes', 'imageBytes', 'bytes',
  ];
  for (const key of base64Keys) {
    const candidate = record[key];
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const text = candidate.trim();
    if (/^data:image\//i.test(text)) candidates.push({ url: text });
    else if (looksLikeBase64(text)) candidates.push({ base64: text });
  }

  const urlKeys = ['url', 'image_url', 'imageUrl', 'src', 'image_src', 'imageSrc'];
  for (const key of urlKeys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && (/^(?:data:image\/|https?:\/\/)/i.test(candidate.trim()))) {
      candidates.push({ url: candidate.trim() });
    }
    // Some providers use image_url: { url: "..." }.
    if (candidate && typeof candidate === 'object') {
      collectImagePayloads(candidate, depth + 1, visited, true, candidates);
    }
  }

  // These are common wrappers used by gateway/proxy implementations. Avoid
  // traversing arbitrary metadata keys (which can be very large or sensitive).
  const wrapperKeys = ['data', 'images', 'image', 'output', 'outputs', 'result', 'results', 'response', 'artifacts', 'choices', 'message', 'content'];
  for (const key of wrapperKeys) {
    if (!(key in record)) continue;
    collectImagePayloads(record[key], depth + 1, visited, true, candidates);
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
