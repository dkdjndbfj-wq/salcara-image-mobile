import { File } from 'expo-file-system';
import { fetch } from 'expo/fetch';

import type { ImageApiResponse, Quality, ReferenceImage } from '../domain';
import { imageEndpoint, parseImageModels, redactSensitiveText } from '../domain-utils';
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
  return persistApiResult(payload, request.signal);
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
  return persistApiResult(payload, request.signal);
}

async function requestImageApi(url: string, options: Parameters<typeof fetch>[1]) {
  try {
    return await parseResponse(await fetch(url, { ...options, redirect: 'error', credentials: 'omit' }));
  } catch (error) {
    if (error instanceof ImageApiError || isAbortError(error)) throw error;
    throw new ImageApiError(networkFailureMessage(url, '生图接口', error));
  }
}

function authorizationHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey.trim()}` };
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
  const image = (payload as ImageApiResponse).data?.[0];
  if (image?.b64_json) return saveBase64Png(image.b64_json);
  if (image?.url?.startsWith('data:image/')) {
    const encoded = /^data:image\/(?:png|jpeg|webp);base64,(.+)$/s.exec(image.url)?.[1];
    if (!encoded) throw new ImageApiError('接口返回的内嵌图片格式不受支持');
    return saveBase64Png(encoded);
  }
  if (image?.url) return downloadPng(image.url, signal);
  throw new ImageApiError('接口返回成功，但没有找到图片数据');
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
