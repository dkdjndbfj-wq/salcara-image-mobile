import { fetch as expoFetch } from 'expo/fetch';

import { abortError } from '../api/network';
import type { ProviderProfile } from '../domain';
import { createId, joinUrl, normalizeBaseUrl } from '../domain-utils';
import { fileBase64 } from '../storage/files';
import { File } from 'expo-file-system';
import { decodeBase64, decodeHex, PcmSink, PLAYER_RATE, utf8 } from './pcm';
import { serviceValues } from '../api/services';
import { GeminiLiveSession, realtimeInputRate, realtimeUrl, RealtimeSession, type LiveSession, type RealtimeHandlers } from './realtime';
import { SpeechApiError, streamSpeech, transcribeAudio } from './speech-api';
import { getProviderKey } from '../storage/secure-keys';
import { capabilityOf, speechBaseFor, vendorForService, type RealtimeProtocol, type SpeechKind, type SttProtocol, type TtsProtocol } from './vendors';

/**
 * One entry point per speech function. A target is whatever the user picked for that function —
 * a speech service (any vendor) or one of their OpenAI-compatible chat providers — resolved with its
 * credentials, and the adapters below speak that vendor's own API.
 */

export interface SpeechTarget {
  kind: SpeechKind;
  protocol: string;
  vendor: string;
  /** Shown in Live, e.g. “豆包语音”. */
  label: string;
  values: Record<string, string>;
  baseUrl: string;
  model: string;
  voice: string;
  extra?: Record<string, unknown>;
}

const KIND_NAME: Record<SpeechKind, string> = { stt: '语音识别', tts: '语音合成', realtime: '实时语音' };

/**
 * Resolves the service picked for a function; `null` when nothing usable is configured.
 * `ref` is a service id; null means “the chat service, if its vendor can do this”.
 */
export async function resolveTarget(kind: SpeechKind, ref: string | null, model: string, voice: string, providers: ProviderProfile[], chatProvider: ProviderProfile | null): Promise<SpeechTarget | null> {
  const preferred = ref ? providers.find((item) => item.id === ref) ?? null : null;
  // A service deleted since falls back to the chat service; one that exists but can't do this doesn't.
  const service = preferred ?? chatProvider;
  if (!service) return null;
  const vendor = vendorForService(service);
  const capability = capabilityOf(vendor, kind);
  if (!capability) return null;
  const values = await serviceValues(service);
  if (!values.apiKey) throw new Error(`没有找到“${service.name}”的 API 密钥`);
  const baseUrl = vendor.id === 'azure-openai'
    ? `${service.baseUrl.trim().replace(/\/+$/, '').replace(/(\/openai)?\/v1$/, '')}/openai/v1`
    : speechBaseFor(vendor, service.baseUrl);
  // Following the chat service: its vendor's defaults (a saved model/voice may belong to another vendor).
  const chosen = preferred ? model.trim() : '';
  const chosenVoice = preferred ? voice.trim() : '';
  return {
    kind, protocol: capability.protocol, vendor: vendor.id, label: service.name || vendor.name, values, baseUrl,
    model: chosen || capability.models[0] || '', voice: chosenVoice || capability.voices?.[0]?.id || '', extra: capability.extra,
  };
}

export function missingTargetMessage(kind: SpeechKind): string {
  return `还没有可用的${KIND_NAME[kind]}：请在“设置 → 语音”里为「${KIND_NAME[kind]}」选择服务和模型（阿里云百炼、豆包语音、OpenAI、硅基流动等都可以）`;
}

// ——— helpers ———

type Fetch = typeof expoFetch;
let fetchImpl: Fetch = expoFetch;
/** Test hook. */
export function setSpeechFetchForTesting(next: Fetch | null): void { fetchImpl = next ?? expoFetch; }

async function fail(response: { status: number; text: () => Promise<string> }, what: string): Promise<never> {
  let detail = '';
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const error = parsed.error as { message?: string } | string | undefined;
      detail = (typeof error === 'string' ? error : error?.message) || (parsed.message as string) || (parsed.err_msg as string) || (parsed.base_resp as { status_msg?: string })?.status_msg || body;
    } catch { detail = body; }
  } catch { /* no body */ }
  const status = response.status;
  const head = status === 401 || status === 403 ? `${what}密钥无效或没有权限` : status === 404 ? `${what}接口不存在，请检查服务地址和模型` : status === 429 ? `${what}限流或余额不足` : status >= 500 ? `${what}服务暂时不可用` : `${what}请求失败（HTTP ${status}）`;
  throw new SpeechApiError(`${head}${detail ? `：${String(detail).slice(0, 160)}` : ''}`, status);
}

async function readBytes(uri: string): Promise<Uint8Array> {
  const file = new File(uri) as unknown as { bytes?: () => Promise<Uint8Array> | Uint8Array; base64?: () => Promise<string> | string };
  if (file.bytes) return await file.bytes();
  return decodeBase64(await fileBase64(uri));
}

/** OpenAI-style bases get the usual normalisation; vendor roots are joined as they are. */
function strip(base: string): string { return normalizeBaseUrl(base); }
function root(base: string, fallback: string): string { return joinUrl(base || fallback, '').replace(/\/$/, ''); }

async function streamBody(response: Response, onChunk: (bytes: Uint8Array) => void, signal?: AbortSignal): Promise<void> {
  const body = (response as unknown as { body?: { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } }).body;
  if (body?.getReader) {
    const reader = body.getReader();
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) onChunk(value);
    }
    return;
  }
  onChunk(new Uint8Array(await response.arrayBuffer()));
}

/** Streams a text body line by line (SSE / NDJSON); lines are split on raw bytes so characters never break. */
async function streamLines(response: Response, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  let pending = new Uint8Array(0);
  const flush = (bytes: Uint8Array) => { const line = utf8(bytes).trim(); if (line) onLine(line); };
  await streamBody(response, (bytes) => {
    const joined = new Uint8Array(pending.length + bytes.length);
    joined.set(pending, 0);
    joined.set(bytes, pending.length);
    let start = 0;
    for (let index = 0; index < joined.length; index += 1) {
      if (joined[index] === 10) { flush(joined.subarray(start, index)); start = index + 1; }
    }
    pending = joined.slice(start);
  }, signal);
  if (pending.length) flush(pending);
}

const baiduTokens = new Map<string, { token: string; expires: number }>();
async function baiduToken(apiKey: string, secretKey: string, signal?: AbortSignal): Promise<string> {
  const cached = baiduTokens.get(apiKey);
  if (cached && cached.expires > Date.now()) return cached.token;
  const response = await fetchImpl(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(apiKey)}&client_secret=${encodeURIComponent(secretKey)}`, { method: 'POST', signal });
  if (!response.ok) await fail(response, '百度鉴权');
  const payload = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!payload.access_token) throw new SpeechApiError(`百度鉴权失败：${payload.error_description ?? '请检查 API Key 和 Secret Key'}`);
  baiduTokens.set(apiKey, { token: payload.access_token, expires: Date.now() + Math.max(60, (payload.expires_in ?? 86400) - 3600) * 1000 });
  return payload.access_token;
}

function volcHeaders(values: Record<string, string>, resource: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Api-Resource-Id': resource, 'X-Api-Request-Id': createId() };
  if (values.appId) { headers['X-Api-App-Key'] = values.appId; headers['X-Api-App-Id'] = values.appId; headers['X-Api-Access-Key'] = values.accessKey; } else headers['X-Api-Key'] = values.accessKey;
  return headers;
}

function languageHint(language?: string): string | undefined {
  const value = language?.trim();
  return value && value !== 'auto' ? value : undefined;
}

/** The app's language choice ('zh' | 'en' | 'ja' | 'yue') in each recognition API's own code. */
const LANGUAGE_CODES: Record<string, Partial<Record<'openai' | 'azure' | 'google' | 'deepgram' | 'baidu', string>>> = {
  zh: { openai: 'zh', azure: 'zh-CN', google: 'cmn-Hans-CN', deepgram: 'zh-CN', baidu: '1537' },
  en: { openai: 'en', azure: 'en-US', google: 'en-US', deepgram: 'en', baidu: '1737' },
  ja: { openai: 'ja', azure: 'ja-JP', google: 'ja-JP', deepgram: 'ja' },
  // OpenAI takes ISO-639-1 only, which has no code for Cantonese.
  yue: { openai: 'zh', azure: 'zh-HK', google: 'yue-Hant-HK', deepgram: 'zh-HK', baidu: '1637' },
};

function languageFamily(code: string): string {
  const value = code.toLowerCase();
  if (value === 'zh-hk' || value.startsWith('yue') || value === '1637') return 'yue';
  if (value.startsWith('zh') || value.startsWith('cmn') || value === '1537') return 'zh';
  if (value === '1737') return 'en';
  return value.split('-')[0];
}

/**
 * Language for a request. Where the model field is itself the language (Azure, Google, Baidu dev_pid),
 * a model already in the chosen language (e.g. zh-TW for 中文) is kept.
 */
export function speechLanguage(protocol: string, language: string | undefined, model = ''): string | undefined {
  const hint = languageHint(language);
  const byModel = protocol === 'azure' || protocol === 'google' || protocol === 'baidu';
  if (!hint) return byModel ? model || undefined : undefined;
  const key = protocol === 'azure' || protocol === 'google' || protocol === 'deepgram' || protocol === 'baidu' ? protocol : 'openai';
  const mapped = LANGUAGE_CODES[hint.toLowerCase()]?.[key];
  if (byModel && model && (!mapped || languageFamily(model) === languageFamily(hint))) return model;
  if (protocol === 'dashscope' || protocol === 'elevenlabs' || protocol === 'gemini') return hint;
  return mapped ?? hint;
}

// ——— speech → text ———

/**
 * Longest recording a protocol's one-shot recognition accepts. Short-audio REST APIs (Baidu, Azure,
 * Google sync) cap at 60 s; Qwen ASR flash at 3 min; the rest are bounded by the app's own limit.
 */
export function maxRecordingMs(protocol: string): number {
  switch (protocol) {
    case 'baidu': case 'azure': case 'google': return 58_000;
    case 'dashscope': return 175_000;
    default: return 5 * 60_000;
  }
}

export interface TranscribeOptions { uri: string; language?: string; prompt?: string; signal?: AbortSignal }

/** Transcribes one recorded utterance (16 kHz mono WAV) with the target's API. */
export async function transcribe(target: SpeechTarget, { uri, language, prompt, signal }: TranscribeOptions): Promise<string> {
  if (signal?.aborted) throw abortError();
  const v = target.values;
  const protocol = target.protocol as SttProtocol;
  const what = `语音识别（${target.label}）`;
  switch (protocol) {
    case 'openai': {
      if (target.vendor === 'azure-openai') {
        const form = new FormData();
        form.append('file', { uri, name: 'speech.wav', type: 'audio/wav' } as unknown as Blob);
        form.append('model', target.model);
        if (speechLanguage('openai', language)) form.append('language', speechLanguage('openai', language)!);
        const response = await fetch(`${strip(target.baseUrl)}/audio/transcriptions`, { method: 'POST', headers: { 'api-key': v.apiKey }, body: form, signal });
        if (!response.ok) await fail(response, what);
        return String(((await response.json()) as { text?: string }).text ?? '').trim();
      }
      return transcribeAudio({ baseUrl: target.baseUrl, apiKey: v.apiKey, model: target.model, uri, language: speechLanguage('openai', language), prompt, signal });
    }
    case 'dashscope': {
      const audio = await fileBase64(uri);
      const response = await fetchImpl(`${root(target.baseUrl, 'https://dashscope.aliyuncs.com')}/compatible-mode/v1/chat/completions`, {
        method: 'POST', signal, headers: { Authorization: `Bearer ${v.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: target.model, stream: false,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${audio}` } }] }],
          asr_options: { enable_itn: true, ...(speechLanguage('dashscope', language) ? { language: speechLanguage('dashscope', language) } : {}) },
        }),
      });
      if (!response.ok) await fail(response, what);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      return (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => (part as { text?: string }).text ?? '').join('') : '').trim();
    }
    case 'volcengine': {
      const audio = await fileBase64(uri);
      const response = await fetchImpl('https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash', {
        method: 'POST', signal, headers: { ...volcHeaders(v, 'volc.bigasr.auc_turbo'), 'X-Api-Sequence': '-1' },
        body: JSON.stringify({ user: { uid: 'salcara' }, audio: { data: audio }, request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true } }),
      });
      if (!response.ok) await fail(response, what);
      const status = response.headers.get('X-Api-Status-Code') ?? '';
      // 20000003: the recording was silence.
      if (status === '20000003') return '';
      if (status && status !== '20000000') throw new SpeechApiError(`${what}失败（${status}）：${response.headers.get('X-Api-Message') ?? ''}`);
      const payload = await response.json() as { result?: { text?: string } };
      return (payload.result?.text ?? '').trim();
    }
    case 'baidu': {
      const bytes = await readBytes(uri);
      const token = await baiduToken(v.apiKey, v.secretKey, signal);
      const response = await fetchImpl('https://vop.baidu.com/server_api', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'wav', rate: 16000, channel: 1, cuid: 'salcara', token, dev_pid: Number(speechLanguage('baidu', language, target.model)) || 1537, speech: await fileBase64(uri), len: bytes.length }),
      });
      if (!response.ok) await fail(response, what);
      const payload = await response.json() as { err_no?: number; err_msg?: string; result?: string[] };
      if (payload.err_no && payload.err_no !== 3301) throw new SpeechApiError(`${what}失败：${payload.err_msg ?? payload.err_no}`);
      return (payload.result?.[0] ?? '').trim();
    }
    case 'azure': {
      const region = (v.region || 'eastasia').trim();
      const response = await fetchImpl(`https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(speechLanguage('azure', language, target.model) || 'zh-CN')}&format=simple`, {
        method: 'POST', signal, headers: { 'Ocp-Apim-Subscription-Key': v.apiKey, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000', Accept: 'application/json' },
        body: await readBytes(uri) as unknown as BodyInit,
      });
      if (!response.ok) await fail(response, what);
      const payload = await response.json() as { RecognitionStatus?: string; DisplayText?: string };
      if (payload.RecognitionStatus && !['Success', 'NoMatch', 'InitialSilenceTimeout'].includes(payload.RecognitionStatus)) throw new SpeechApiError(`${what}失败：${payload.RecognitionStatus}`);
      return (payload.DisplayText ?? '').trim();
    }
    case 'google': {
      const response = await fetchImpl(`https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(v.apiKey)}`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: speechLanguage('google', language, target.model) || 'cmn-Hans-CN', enableAutomaticPunctuation: true }, audio: { content: await fileBase64(uri) } }),
      });
      if (!response.ok) await fail(response, what);
      const payload = await response.json() as { results?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
      return (payload.results ?? []).map((item) => item.alternatives?.[0]?.transcript ?? '').join('').trim();
    }
    case 'gemini': {
      const audio = await fileBase64(uri);
      const spoken = speechLanguage('gemini', language);
      const instruction = `逐字转写这段语音，只输出转写文字，不要任何解释。${spoken ? `语言：${({ zh: '中文', en: '英语', ja: '日语', yue: '粤语' } as Record<string, string>)[spoken] ?? spoken}。` : ''}`;
      const base = root(target.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
      const headers = { 'x-goog-api-key': v.apiKey, 'Content-Type': 'application/json' };
      // Interactions API first (current), generateContent as the fallback for older models and proxies.
      const response = await fetchImpl(`${base}/interactions`, {
        method: 'POST', signal, headers,
        body: JSON.stringify({ model: target.model, input: [{ type: 'text', text: instruction }, { type: 'audio', data: audio, mime_type: 'audio/wav' }] }),
      });
      if (response.ok) {
        const payload = await response.json() as { output_text?: string; steps?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> };
        if (typeof payload.output_text === 'string') return payload.output_text.trim();
        const steps = (payload.steps ?? []).filter((step) => !step.type || step.type === 'model_output');
        return (steps[steps.length - 1]?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('').trim();
      }
      if (response.status !== 404 && response.status !== 400) await fail(response, what);
      const legacy = await fetchImpl(`${base}/models/${encodeURIComponent(target.model)}:generateContent`, {
        method: 'POST', signal, headers,
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: instruction }, { inline_data: { mime_type: 'audio/wav', data: audio } }] }] }),
      });
      if (!legacy.ok) await fail(legacy, what);
      const payload = await legacy.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      return (payload.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('').trim();
    }
    case 'deepgram': {
      const query = new URLSearchParams({ model: target.model || 'nova-3', smart_format: 'true', punctuate: 'true' });
      query.set('language', speechLanguage('deepgram', language) ?? 'multi');
      const response = await fetchImpl(`https://api.deepgram.com/v1/listen?${query.toString()}`, {
        method: 'POST', signal, headers: { Authorization: `Token ${v.apiKey}`, 'Content-Type': 'audio/wav' }, body: await readBytes(uri) as unknown as BodyInit,
      });
      if (!response.ok) await fail(response, what);
      const payload = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
      return (payload.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim();
    }
    case 'elevenlabs': {
      const form = new FormData();
      form.append('file', { uri, name: 'speech.wav', type: 'audio/wav' } as unknown as Blob);
      form.append('model_id', target.model || 'scribe_v2');
      if (speechLanguage('elevenlabs', language)) form.append('language_code', speechLanguage('elevenlabs', language)!);
      const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': v.apiKey }, body: form, signal });
      if (!response.ok) await fail(response, what);
      return String(((await response.json()) as { text?: string }).text ?? '').trim();
    }
    default:
      throw new SpeechApiError(`${target.label} 不支持语音识别`);
  }
}

// ——— text → speech ———

export interface SynthesizeOptions { text: string; instructions?: string; signal?: AbortSignal; onAudio: (base64: string) => void }

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Synthesizes one sentence and streams 24 kHz PCM16 (base64) to `onAudio` as it arrives. */
export async function synthesize(target: SpeechTarget, { text, instructions, signal, onAudio }: SynthesizeOptions): Promise<void> {
  if (signal?.aborted) throw abortError();
  const v = target.values;
  const protocol = target.protocol as TtsProtocol;
  const what = `语音合成（${target.label}）`;
  const sink = new PcmSink(onAudio);
  switch (protocol) {
    case 'openai': {
      if (target.vendor === 'openai' || target.vendor === 'custom') {
        await streamSpeech({ baseUrl: target.baseUrl, apiKey: v.apiKey, model: target.model, voice: target.voice, input: text, instructions: /gpt-4o|gpt-.*tts/.test(target.model) ? instructions : undefined, signal, onAudio });
        return;
      }
      // Other OpenAI-style /audio/speech APIs (硅基流动、智谱、阶跃、Azure…): raw PCM or WAV, normalised here.
      const voice = target.vendor === 'siliconflow' && target.voice && !target.voice.includes(':') && !target.voice.startsWith('speech:') ? `${target.model}:${target.voice}` : target.voice;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (target.vendor === 'azure-openai') headers['api-key'] = v.apiKey; else headers.Authorization = `Bearer ${v.apiKey}`;
      const response = await fetchImpl(`${strip(target.baseUrl)}/audio/speech`, {
        method: 'POST', signal, headers,
        body: JSON.stringify({ model: target.model, voice, input: text, response_format: target.vendor === 'stepfun' ? 'wav' : 'pcm', ...(target.extra ?? {}) }),
      });
      if (!response.ok) await fail(response, what);
      await streamBody(response as unknown as Response, (bytes) => sink.write(bytes), signal);
      sink.end();
      return;
    }
    case 'elevenlabs': {
      const response = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(target.voice || '21m00Tcm4TlvDq8ikWAM')}/stream?output_format=pcm_24000`, {
        method: 'POST', signal, headers: { 'xi-api-key': v.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: target.model || 'eleven_flash_v2_5' }),
      });
      if (!response.ok) await fail(response, what);
      await streamBody(response as unknown as Response, (bytes) => sink.write(bytes), signal);
      sink.end();
      return;
    }
    case 'azure': {
      const region = (v.region || 'eastasia').trim();
      const voice = target.voice || 'zh-CN-XiaoxiaoNeural';
      const lang = voice.split('-').slice(0, 2).join('-') || 'zh-CN';
      const response = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
        method: 'POST', signal,
        headers: { 'Ocp-Apim-Subscription-Key': v.apiKey, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm', 'User-Agent': 'Salcara' },
        body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`,
      });
      if (!response.ok) await fail(response, what);
      await streamBody(response as unknown as Response, (bytes) => sink.write(bytes), signal);
      sink.end();
      return;
    }
    case 'google': {
      const voice = target.voice || 'cmn-CN-Chirp3-HD-Aoede';
      const response = await fetchImpl(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(v.apiKey)}`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { text }, voice: { languageCode: voice.split('-').slice(0, 2).join('-'), name: voice }, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: PLAYER_RATE } }),
      });
      if (!response.ok) await fail(response, what);
      const payload = await response.json() as { audioContent?: string };
      sink.write(decodeBase64(payload.audioContent ?? ''));
      sink.end();
      return;
    }
    case 'gemini': {
      const base = root(target.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
      const response = await fetchImpl(`${base}/interactions`, {
        method: 'POST', signal, headers: { 'x-goog-api-key': v.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: target.model || 'gemini-3.8-flash-tts',
          input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: target.voice || 'Kore' }] },
        }),
      });
      if (!response.ok) await fail(response, what);
      const payload = await response.json() as { steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string }> }> };
      const audio = (payload.steps ?? []).flatMap((step) => step.content ?? []).filter((item) => item.type === 'audio' && item.data);
      if (!audio.length) throw new SpeechApiError(`${what}没有返回音频`);
      audio.forEach((item) => sink.write(decodeBase64(item.data!)));
      sink.end();
      return;
    }
    case 'dashscope': {
      const response = await fetchImpl(`${root(target.baseUrl, 'https://dashscope.aliyuncs.com')}/api/v1/services/aigc/multimodal-generation/generation`, {
        method: 'POST', signal, headers: { Authorization: `Bearer ${v.apiKey}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'enable' },
        body: JSON.stringify({ model: target.model || 'qwen3-tts-flash', input: { text, voice: target.voice || 'Cherry' } }),
      });
      if (!response.ok) await fail(response, what);
      let failure: string | null = null;
      await streamLines(response as unknown as Response, (line) => {
        if (!line.startsWith('data:')) return;
        try {
          const event = JSON.parse(line.slice(5).trim()) as { output?: { audio?: { data?: string } }; code?: string; message?: string };
          if (event.code) failure = event.message ?? event.code;
          const data = event.output?.audio?.data;
          if (data) sink.write(decodeBase64(data));
        } catch { /* keep-alive */ }
      }, signal);
      if (failure) throw new SpeechApiError(`${what}失败：${failure}`);
      sink.end();
      return;
    }
    case 'volcengine': {
      const voice = target.voice || 'zh_female_vv_uranus_bigtts';
      // A chosen resource (seed-tts-2.0…) wins; “自动” derives it from the voice.
      const resource = /^seed-/.test(target.model) ? target.model : /^S_/.test(voice) ? 'seed-icl-2.0' : /_uranus_|saturn_/.test(voice) ? 'seed-tts-2.0' : 'seed-tts-1.0';
      const response = await fetchImpl('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
        method: 'POST', signal, headers: volcHeaders(v, resource),
        body: JSON.stringify({ user: { uid: 'salcara' }, req_params: { text, speaker: voice, audio_params: { format: 'pcm', sample_rate: PLAYER_RATE } } }),
      });
      if (!response.ok) await fail(response, what);
      let failure: string | null = null;
      await streamLines(response as unknown as Response, (line) => {
        try {
          const event = JSON.parse(line.replace(/^data:\s*/, '')) as { code?: number; message?: string; data?: string | null };
          if (event.data) sink.write(decodeBase64(event.data));
          else if (event.code && event.code !== 0 && event.code !== 20000000) failure = `${event.code} ${event.message ?? ''}`;
        } catch { /* partial line */ }
      }, signal);
      if (failure) throw new SpeechApiError(`${what}失败：${failure}`);
      sink.end();
      return;
    }
    case 'minimax': {
      const response = await fetchImpl(`${root(target.baseUrl, 'https://api.minimax.cn')}/v1/t2a_v2`, {
        method: 'POST', signal, headers: { Authorization: `Bearer ${v.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: target.model || 'speech-2.8-turbo', text, stream: false,
          voice_setting: { voice_id: target.voice || 'female-shaonv', speed: 1, vol: 1, pitch: 0 },
          audio_setting: { sample_rate: PLAYER_RATE, format: 'pcm', channel: 1 },
        }),
      });
      if (!response.ok) await fail(response, what);
      const payload = await response.json() as { data?: { audio?: string }; base_resp?: { status_code?: number; status_msg?: string } };
      if (payload.base_resp?.status_code) throw new SpeechApiError(`${what}失败：${payload.base_resp.status_msg ?? payload.base_resp.status_code}`);
      sink.write(decodeHex(payload.data?.audio ?? ''));
      sink.end();
      return;
    }
    case 'fish': {
      const response = await fetchImpl('https://api.fish.audio/v1/tts', {
        method: 'POST', signal, headers: { Authorization: `Bearer ${v.apiKey}`, 'Content-Type': 'application/json', model: target.model || 's2.1-pro' },
        body: JSON.stringify({ text, format: 'pcm', sample_rate: PLAYER_RATE, latency: 'balanced', ...(target.voice ? { reference_id: target.voice } : {}) }),
      });
      if (!response.ok) await fail(response, what);
      await streamBody(response as unknown as Response, (bytes) => sink.write(bytes), signal);
      sink.end();
      return;
    }
    case 'baidu': {
      const token = await baiduToken(v.apiKey, v.secretKey, signal);
      const body = new URLSearchParams({ tex: text, tok: token, cuid: 'salcara', ctp: '1', lan: 'zh', aue: '4', per: target.voice || '5118', spd: '5' }).toString();
      const response = await fetchImpl('https://tsn.baidu.com/text2audio', { method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!response.ok) await fail(response, what);
      if ((response.headers.get('Content-Type') ?? '').includes('json')) {
        const payload = await response.json() as { err_msg?: string; err_no?: number };
        throw new SpeechApiError(`${what}失败：${payload.err_msg ?? payload.err_no}`);
      }
      // aue=4 is 16 kHz PCM.
      const pcm16k = new PcmSink(onAudio, 16000);
      await streamBody(response as unknown as Response, (bytes) => pcm16k.write(bytes), signal);
      pcm16k.end();
      return;
    }
    default:
      throw new SpeechApiError(`${target.label} 不支持语音合成`);
  }
}

// ——— realtime conversation ———

/** Opens (but does not yet connect) a realtime session in the target vendor's dialect. */
export function openRealtime(target: SpeechTarget, instructions: string, transcribeModel: string | undefined, handlers: RealtimeHandlers): { session: LiveSession; inputRate: number } {
  const v = target.values;
  const protocol = target.protocol as RealtimeProtocol;
  if (protocol === 'gemini') {
    const host = (target.baseUrl || 'https://generativelanguage.googleapis.com').replace(/^https?:\/\//i, '').split('/')[0];
    const url = `wss://${host}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
    return { session: new GeminiLiveSession({ url, apiKey: v.apiKey, model: target.model, voice: target.voice, instructions }, handlers), inputRate: 16000 };
  }
  const base = { baseUrl: target.baseUrl, apiKey: v.apiKey, model: target.model, voice: target.voice, instructions, transcribeModel };
  if (protocol === 'qwen') {
    const socket = (v.realtimeUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime').trim();
    const config = { ...base, protocol: 'qwen' as const, transcribeModel: undefined, url: `${socket}${socket.includes('?') ? '&' : '?'}model=${encodeURIComponent(target.model)}`, headers: { Authorization: `Bearer ${v.apiKey}` } };
    return { session: new RealtimeSession(config, handlers), inputRate: realtimeInputRate(config) };
  }
  if (target.vendor === 'azure-openai') {
    return { session: new RealtimeSession({ ...base, headers: { 'api-key': v.apiKey } }, handlers), inputRate: 24000 };
  }
  const dialect = protocol === 'openai-beta' ? 'openai-beta' as const : 'openai' as const;
  const config = { ...base, protocol: dialect, url: realtimeUrl(target.baseUrl, target.model) };
  return { session: new RealtimeSession(config, handlers), inputRate: realtimeInputRate(config) };
}

export type { RealtimeProtocol };
