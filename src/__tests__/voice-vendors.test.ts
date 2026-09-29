jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-file-system', () => ({ File: class {
  uri: string;
  constructor(path: string) { this.uri = path; }
  async bytes() { return new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]); }
} }));
jest.mock('../storage/files', () => ({ fileBase64: async () => 'UklGRgECAwQ=' }));
const mockSecrets: Record<string, string> = {};
jest.mock('../storage/secure-keys', () => ({
  getProviderKey: async (id: string) => mockSecrets[id] ?? null,
  saveProviderKey: async (id: string, value: string) => { mockSecrets[id] = value; },
  deleteProviderKey: async (id: string) => { delete mockSecrets[id]; },
}));
const mockStore: Record<string, string> = {};
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockStore[key] ?? null, setSetting: async (key: string, value: string) => { mockStore[key] = value; } }));

import { maxRecordingMs, openRealtime, resolveTarget, setSpeechFetchForTesting, speechLanguage, synthesize, transcribe, type SpeechTarget } from '../voice/engines';
import { decodeBase64, decodeHex, PcmSink, resamplePcm16 } from '../voice/pcm';
import { handleRealtimeEvent, sessionUpdate } from '../voice/realtime';
import { defaultModel, modelsFor, speechBaseFor, supports, vendorForService } from '../api/vendors';
import type { ProviderProfile } from '../domain';
import { encodeBase64 } from '../voice/speech-api';
import { VENDORS } from '../voice/vendors';

type Call = { url: string; init: { method?: string; headers?: Record<string, string>; body?: unknown } };
const calls: Call[] = [];
function respond(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: (init.status ?? 200) < 400, status: init.status ?? 200,
    headers: { get: (name: string) => init.headers?.[name] ?? null },
    json: async () => JSON.parse(text), text: async () => text,
    arrayBuffer: async () => (body instanceof Uint8Array ? body.buffer : new TextEncoder().encode(text).buffer),
  };
}
function mockFetch(...responses: unknown[]) {
  calls.length = 0;
  let index = 0;
  setSpeechFetchForTesting((async (url: string, init: Call['init']) => { calls.push({ url, init }); return responses[Math.min(index++, responses.length - 1)]; }) as never);
}
const target = (patch: Partial<SpeechTarget>): SpeechTarget => ({ kind: 'tts', protocol: 'openai', vendor: 'openai', label: 'T', values: { apiKey: 'k' }, baseUrl: '', model: '', voice: '', ...patch });
const pcm = (samples: number[]) => { const bytes = new Uint8Array(samples.length * 2); const view = new DataView(bytes.buffer); samples.forEach((value, index) => view.setInt16(index * 2, value, true)); return bytes; };

test('every service vendor does something, speech functions have models, and field keys are unique', () => {
  for (const vendor of VENDORS) {
    const kinds = (['chat', 'image', 'stt', 'tts', 'realtime'] as const).filter((kind) => supports(vendor, kind));
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of (['stt', 'tts', 'realtime'] as const)) if (vendor[kind]) expect(vendor[kind]!.models.length).toBeGreaterThan(0);
    const fields = vendor.fields ?? [];
    expect(new Set(fields.map((field) => field.key)).size).toBe(fields.length);
  }
});

test('PCM sink strips WAV headers, resamples to 24 kHz and base64-encodes', () => {
  const out: string[] = [];
  const sink = new PcmSink((chunk) => out.push(chunk), 16000);
  sink.write(pcm([0, 1000, 2000, 3000]));
  sink.end();
  const bytes = out.map(decodeBase64).reduce((sum, chunk) => sum + chunk.length, 0);
  expect(bytes).toBe(12);
  expect(resamplePcm16(pcm([0, 100]), 24000, 24000).length).toBe(4);
  // A WAV header announces its own rate.
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  [..."RIFF"].forEach((c, i) => { header[i] = c.charCodeAt(0); });
  [..."WAVEfmt "].forEach((c, i) => { header[8 + i] = c.charCodeAt(0); });
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  [..."data"].forEach((c, i) => { header[36 + i] = c.charCodeAt(0); });
  view.setUint32(40, 4, true);
  const wavOut: string[] = [];
  const wav = new PcmSink((chunk) => wavOut.push(chunk));
  wav.write(new Uint8Array([...header, ...pcm([5, 6])]));
  wav.end();
  expect([...decodeBase64(wavOut.join(''))]).toEqual([...pcm([5, 6])]);
  expect(encodeBase64(decodeBase64('aGVsbG8='))).toBe('aGVsbG8=');
});

test('PCM resampling is continuous across chunk boundaries', () => {
  const ramp = Array.from({ length: 48 }, (_, index) => index * 100);
  const samples = (chunks: string[]) => chunks.flatMap((chunk) => { const bytes = decodeBase64(chunk); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length); return Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true)); });
  const whole: string[] = [];
  const one = new PcmSink((chunk) => whole.push(chunk), 16000);
  one.write(pcm(ramp));
  one.end();
  const split: string[] = [];
  const many = new PcmSink((chunk) => split.push(chunk), 16000);
  for (let index = 0; index < ramp.length; index += 5) many.write(pcm(ramp.slice(index, index + 5)));
  many.end();
  expect(samples(split)).toEqual(samples(whole));
  // A ramp stays a ramp: no repeated or skipped values at the seams.
  const out = samples(split).slice(0, 60);
  for (let index = 1; index < out.length; index += 1) expect(Math.abs(out[index] - out[index - 1] - 67) <= 1).toBe(true);
  expect([...decodeHex('0aFf zz 10')]).toEqual([10, 255, 16]);
  expect(speechLanguage('google', 'zh', 'cmn-Hans-CN')).toBe('cmn-Hans-CN');
  expect(speechLanguage('azure', 'en', 'zh-CN')).toBe('en-US');
  expect(speechLanguage('azure', 'zh', 'zh-TW')).toBe('zh-TW');
  expect(speechLanguage('baidu', 'yue', '1537')).toBe('1637');
  expect(speechLanguage('openai', 'yue')).toBe('zh');
  expect(speechLanguage('dashscope', 'yue')).toBe('yue');
  expect(speechLanguage('deepgram', '')).toBeUndefined();
  expect(maxRecordingMs('baidu')).toBe(58_000);
});

const service = (patch: Partial<ProviderProfile>): ProviderProfile => ({ id: 's', name: '服务', baseUrl: '', model: null, quality: null, aspectRatio: null, resolutionTier: null, createdAt: 1, updatedAt: 1, ...patch });

test('one service = address + key: speech resolves through the vendor catalog', async () => {
  // 豆包语音: the key is sent as the access key, the APP ID comes from the service's extra fields.
  mockSecrets.volc = 'volc-key';
  const volc = service({ id: 'volc', name: '豆包语音', vendor: 'volcengine', extra: { appId: '123' } });
  expect(await resolveTarget('stt', 'volc', '', '', [volc], null)).toMatchObject({ protocol: 'volcengine', model: 'bigmodel', values: { accessKey: 'volc-key', appId: '123' } });
  expect(await resolveTarget('realtime', 'volc', '', '', [volc], null)).toBeNull();

  // 百炼 added once for chat: its speech APIs live at the account root, not /compatible-mode/v1.
  mockSecrets.ali = 'ali-key';
  const ali = service({ id: 'ali', name: '百炼', vendor: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatModel: 'qwen-plus' });
  expect(await resolveTarget('tts', null, 'gpt-4o-mini-tts', 'marin', [ali], ali)).toMatchObject({ protocol: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com', model: 'qwen3-tts-flash', voice: 'Cherry' });
  expect(await resolveTarget('stt', 'ali', 'qwen3-asr-flash', '', [ali], null)).toMatchObject({ model: 'qwen3-asr-flash' });

  // A service deleted since falls back to the chat service; a chat-only vendor has no speech.
  mockSecrets.ds = 'ds-key';
  const deepseek = service({ id: 'ds', name: 'DeepSeek', vendor: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', chatModel: 'deepseek-chat' });
  expect(await resolveTarget('stt', 'gone', '', '', [ali, deepseek], ali)).toMatchObject({ vendor: 'dashscope' });
  expect(await resolveTarget('stt', null, '', '', [deepseek], deepseek)).toBeNull();

  // Services added before the catalog are matched by address; Gemini speech drops the /openai path.
  mockSecrets.g = 'g-key';
  const gemini = service({ id: 'g', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' });
  expect(vendorForService(gemini).id).toBe('gemini');
  expect(speechBaseFor(vendorForService(gemini), gemini.baseUrl)).toBe('https://generativelanguage.googleapis.com/v1beta');
  expect(await resolveTarget('realtime', 'g', '', '', [gemini], null)).toMatchObject({ protocol: 'gemini', model: 'gemini-3.8-live' });
});

test('model lists per function mix the vendor’s known models with what the API reports', () => {
  const openai = vendorForService(service({ vendor: 'openai', baseUrl: 'https://api.openai.com/v1' }));
  const listed = ['gpt-5', 'gpt-image-2', 'whisper-1', 'gpt-4o-mini-tts', 'gpt-realtime', 'text-embedding-3-small'];
  expect(modelsFor(openai, 'chat', listed)).toEqual(['gpt-5']);
  expect(modelsFor(openai, 'image', listed)).toEqual(['gpt-image-2']);
  expect(modelsFor(openai, 'stt', listed)).toContain('whisper-1');
  expect(modelsFor(openai, 'tts', listed)[0]).toBe('gpt-4o-mini-tts');
  expect(modelsFor(openai, 'realtime', listed)).toContain('gpt-realtime');
  expect(defaultModel(openai, 'image', listed)).toBe('gpt-image-2');
});

test('recognition speaks each vendor’s API', async () => {
  mockFetch(respond({ result: { text: '你好' } }, { headers: { 'X-Api-Status-Code': '20000000' } }));
  expect(await transcribe(target({ kind: 'stt', protocol: 'volcengine', vendor: 'volcengine', values: { accessKey: 'ak' } }), { uri: 'file:///a.wav' })).toBe('你好');
  expect(calls[0].url).toContain('/api/v3/auc/bigmodel/recognize/flash');
  expect(calls[0].init.headers).toMatchObject({ 'X-Api-Key': 'ak', 'X-Api-Resource-Id': 'volc.bigasr.auc_turbo' });

  mockFetch(respond({ choices: [{ message: { content: '识别结果' } }] }));
  expect(await transcribe(target({ kind: 'stt', protocol: 'dashscope', vendor: 'dashscope', model: 'qwen3-asr-flash' }), { uri: 'file:///a.wav', language: 'zh' })).toBe('识别结果');
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.messages[0].content[0]).toEqual({ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,UklGRgECAwQ=' } });
  expect(body.asr_options.language).toBe('zh');

  mockFetch(respond({ RecognitionStatus: 'Success', DisplayText: 'Azure 文本' }));
  expect(await transcribe(target({ kind: 'stt', protocol: 'azure', vendor: 'azure-speech', values: { apiKey: 'az', region: 'eastasia' }, model: 'zh-CN' }), { uri: 'file:///a.wav' })).toBe('Azure 文本');
  expect(calls[0].url).toBe('https://eastasia.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN&format=simple');

  mockFetch(respond({ error: { message: 'bad key' } }, { status: 401 }));
  await expect(transcribe(target({ kind: 'stt', protocol: 'deepgram', vendor: 'deepgram' }), { uri: 'file:///a.wav' })).rejects.toThrow('密钥无效');
});

test('synthesis turns every vendor’s audio into 24 kHz PCM', async () => {
  const collect = async (t: SpeechTarget) => { const out: string[] = []; await synthesize(t, { text: '你好', onAudio: (chunk) => out.push(chunk) }); return decodeBase64(out.join('')); };

  mockFetch(respond({ data: { audio: '01000200' }, base_resp: { status_code: 0 } }));
  expect([...await collect(target({ protocol: 'minimax', vendor: 'minimax', voice: 'female-shaonv' }))]).toEqual([1, 0, 2, 0]);
  expect(JSON.parse(String(calls[0].init.body)).audio_setting).toEqual({ sample_rate: 24000, format: 'pcm', channel: 1 });

  const chunk = encodeBase64(pcm([7, 8]));
  mockFetch(respond(`data: {"output":{"audio":{"data":"${chunk}"}}}\n\ndata: {"output":{"audio":{"data":""}}}\n`));
  expect([...await collect(target({ protocol: 'dashscope', vendor: 'dashscope', voice: 'Cherry' }))]).toEqual([...pcm([7, 8])]);
  expect(calls[0].init.headers).toMatchObject({ 'X-DashScope-SSE': 'enable' });

  mockFetch(respond(`{"code":0,"data":"${chunk}"}\n{"code":20000000,"message":"ok","data":null}\n`));
  expect([...await collect(target({ protocol: 'volcengine', vendor: 'volcengine', values: { appId: '123', accessKey: 'tok' }, voice: 'zh_female_vv_uranus_bigtts' }))]).toEqual([...pcm([7, 8])]);
  expect(calls[0].init.headers).toMatchObject({ 'X-Api-App-Id': '123', 'X-Api-Access-Key': 'tok', 'X-Api-Resource-Id': 'seed-tts-2.0' });

  mockFetch(respond(pcm([1, 2])));
  await collect(target({ protocol: 'azure', vendor: 'azure-speech', values: { apiKey: 'az', region: 'westus' }, voice: 'zh-CN-XiaoxiaoNeural' }));
  expect(calls[0].init.headers).toMatchObject({ 'X-Microsoft-OutputFormat': 'raw-24khz-16bit-mono-pcm' });
  expect(String(calls[0].init.body)).toContain('<voice name="zh-CN-XiaoxiaoNeural">你好</voice>');

  mockFetch(respond(pcm([3])));
  await collect(target({ protocol: 'openai', vendor: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B', voice: 'anna', extra: { sample_rate: 24000, stream: true } }));
  expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ voice: 'FunAudioLLM/CosyVoice2-0.5B:anna', response_format: 'pcm', sample_rate: 24000 });
});

test('realtime sessions use each vendor’s dialect and sample rate', () => {
  const qwen = openRealtime(target({ kind: 'realtime', protocol: 'qwen', vendor: 'dashscope', model: 'qwen3.8-omni-flash-realtime', voice: 'Cherry' }), '你好', undefined, {});
  expect(qwen.inputRate).toBe(16000);
  const gemini = openRealtime(target({ kind: 'realtime', protocol: 'gemini', vendor: 'gemini', model: 'gemini-3.8-live', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }), 'x', undefined, {});
  expect(gemini.inputRate).toBe(16000);
  const openai = openRealtime(target({ kind: 'realtime', protocol: 'openai', vendor: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-realtime' }), 'x', undefined, {});
  expect(openai.inputRate).toBe(24000);
  expect(sessionUpdate({ baseUrl: '', apiKey: '', model: 'm', voice: 'v', instructions: 'i', protocol: 'openai-beta' }).session).toMatchObject({ input_audio_format: 'pcm16', modalities: ['text', 'audio'] });
  const audio: string[] = [];
  handleRealtimeEvent({ type: 'response.audio.delta', delta: 'QUJD' }, { onAudio: (data) => audio.push(data) });
  expect(audio).toEqual(['QUJD']);
});
