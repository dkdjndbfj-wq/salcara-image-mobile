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
}

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

export function buildGenerationBody(request: Omit<GenerateRequest, 'baseUrl' | 'apiKey' | 'signal'>) {
  return {
    model: request.model,
    prompt: request.prompt,
    quality: request.quality,
    size: request.size,
    n: 1,
    output_format: 'png' as const,
    ...(request.transparent ? { background: 'transparent' as const } : {}),
  };
}

export function buildEditFields(request: Omit<EditRequest, 'baseUrl' | 'apiKey' | 'signal' | 'references' | 'maskUri'>) {
  return {
    model: request.model,
    prompt: request.prompt,
    quality: request.quality,
    size: request.size,
    n: '1',
    output_format: 'png' as const,
    ...(request.transparent ? { background: 'transparent' as const } : {}),
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

export async function generateImage(request: GenerateRequest): Promise<string> {
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

export async function editImage(request: EditRequest): Promise<string> {
  if (request.references.length === 0) throw new ImageApiError('图片编辑至少需要一张参考图');
  if (request.references.length > 4) throw new ImageApiError('一次最多上传 4 张参考图');

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
  while (Date.now() < deadline) {
    if (request.signal?.aborted) throw new ImageApiError('请求已取消或超时');
    await waitForPoll(waitMs, request.signal);
    const response = await requestImageApi(task.url, {
      method: 'GET',
      headers: authorizationHeaders(request.apiKey),
      signal: request.signal,
    });
    const record = response && typeof response === 'object' ? response as Record<string, unknown> : {};
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : null;
      throw new ImageApiError(typeof error?.message === 'string' ? error.message : `图片任务 ${task.id} 未完成`);
    }
    if (findImagePayload(response) || ['completed', 'succeeded', 'success', 'done'].includes(status)) return response;
    const retryAfter = Number(record.retry_after ?? record.retryAfter);
    waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(10_000, retryAfter * 1000) : Math.min(8_000, Math.round(waitMs * 1.35));
  }
  throw new ImageApiError('图片任务等待超过 10 分钟，已停止轮询。请查看服务商记录后再手动重试');
}

function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('请求已取消')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(new Error('请求已取消')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function requestImageApi(url: string, options: Parameters<typeof fetch>[1]) {
  try {
    return await parseResponse(await fetch(url, { ...options, redirect: 'error', credentials: 'omit' }));
  } catch (error) {
    if (error instanceof ImageApiError || isAbortError(error)) throw error;
    // Expo's streaming fetch and React Native's built-in fetch use different
    // native plumbing on some Android versions. If the first transport fails
    // before receiving an HTTP response, make one alternate-transport attempt
    // with the exact same request. We never retry after an HTTP error, and we
    // never follow redirects that could leak the API key.
    const alternateFetch = globalThis.fetch;
    if (typeof alternateFetch === 'function' && alternateFetch !== fetch && isTransportFailure(error)) {
      try {
        return await parseResponse(await alternateFetch(url, { ...options, redirect: 'error', credentials: 'omit' }));
      } catch (alternateError) {
        if (alternateError instanceof ImageApiError || isAbortError(alternateError)) throw alternateError;
        throw new ImageApiError(networkFailureMessage(url, '生图接口', alternateError));
      }
    }
    throw new ImageApiError(networkFailureMessage(url, '生图接口', error));
  }
}

function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return !isAbortError(error) && !/redirect|HTTP\s*\d{3}|status\s*\d{3}/i.test(error.message);
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

function looksLikeBase64(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  if (compact.length < 8 || compact.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(compact);
}

function normalizeBase64(value: string): string {
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
