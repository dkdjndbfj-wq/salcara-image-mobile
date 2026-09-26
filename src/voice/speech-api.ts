import { fetch as expoFetch } from 'expo/fetch';

import { abortError } from '../api/network';
import { normalizeBaseUrl } from '../domain-utils';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 without relying on btoa (not guaranteed on every Hermes build). */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - index;
  if (rest === 1) {
    const n = bytes[index] << 16;
    out += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8);
    out += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`;
  }
  return out;
}

export class SpeechApiError extends Error {
  constructor(message: string, public status?: number) { super(message); this.name = 'SpeechApiError'; }
}

function statusMessage(status: number, what: string): string {
  if (status === 401 || status === 403) return `${what}密钥无效，或该分组没有此模型权限`;
  if (status === 404) return `服务商没有提供${what}接口，请在语音设置中更换服务商或模型`;
  if (status === 429) return `${what}限流或余额不足，请稍后重试`;
  if (status >= 500) return `${what}服务暂时不可用，请稍后重试`;
  return `${what}请求失败（HTTP ${status}）`;
}

async function failure(response: { status: number; text: () => Promise<string> }, what: string): Promise<never> {
  let detail = '';
  try {
    const body = await response.text();
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    detail = parsed?.error?.message ?? '';
  } catch { /* not JSON */ }
  throw new SpeechApiError(`${statusMessage(response.status, what)}${detail ? `：${detail.slice(0, 160)}` : ''}`, response.status);
}

export interface TranscribeRequest {
  baseUrl: string; apiKey: string; model: string; uri: string;
  language?: string; prompt?: string; signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** OpenAI-compatible /audio/transcriptions with a recorded WAV file. */
export async function transcribeAudio({ baseUrl, apiKey, model, uri, language, prompt, signal, fetchImpl }: TranscribeRequest): Promise<string> {
  if (signal?.aborted) throw abortError();
  const form = new FormData();
  form.append('file', { uri, name: 'speech.wav', type: 'audio/wav' } as unknown as Blob);
  form.append('model', model.trim());
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt.slice(0, 400));
  const response = await (fetchImpl ?? fetch)(`${normalizeBaseUrl(baseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: 'application/json' },
    body: form,
    signal,
  });
  if (!response.ok) await failure(response, '语音识别');
  const payload = await response.json() as { text?: unknown };
  return typeof payload?.text === 'string' ? payload.text.trim() : '';
}

export interface SpeechRequest {
  baseUrl: string; apiKey: string; model: string; voice: string; input: string;
  instructions?: string; signal?: AbortSignal;
  /** Receives 24 kHz mono PCM16 as base64, in ~100 ms pieces. */
  onAudio: (base64: string) => void;
  fetchImpl?: typeof expoFetch;
}

const CHUNK_BYTES = 4800;

/** Streams /audio/speech as raw PCM so playback starts before synthesis finishes. */
export async function streamSpeech({ baseUrl, apiKey, model, voice, input, instructions, signal, onAudio, fetchImpl }: SpeechRequest): Promise<void> {
  if (signal?.aborted) throw abortError();
  const response = await (fetchImpl ?? expoFetch)(`${normalizeBaseUrl(baseUrl)}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model.trim(), voice, input, response_format: 'pcm', ...(instructions ? { instructions } : {}) }),
    signal,
  });
  if (!response.ok) await failure(response as unknown as { status: number; text: () => Promise<string> }, '语音合成');
  let carry = new Uint8Array(0);
  const emit = (bytes: Uint8Array, flush: boolean) => {
    const joined = new Uint8Array(carry.length + bytes.length);
    joined.set(carry, 0);
    joined.set(bytes, carry.length);
    let offset = 0;
    while (joined.length - offset >= CHUNK_BYTES) {
      onAudio(encodeBase64(joined.subarray(offset, offset + CHUNK_BYTES)));
      offset += CHUNK_BYTES;
    }
    let rest = joined.subarray(offset);
    if (flush) {
      const even = rest.length - (rest.length % 2);
      if (even > 0) onAudio(encodeBase64(rest.subarray(0, even)));
      rest = new Uint8Array(0);
    }
    carry = new Uint8Array(rest);
  };
  const body = (response as unknown as { body?: { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } }).body;
  if (body?.getReader) {
    const reader = body.getReader();
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) emit(value, false);
    }
    emit(new Uint8Array(0), true);
    return;
  }
  const buffer = await (response as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer();
  emit(new Uint8Array(buffer), true);
}
