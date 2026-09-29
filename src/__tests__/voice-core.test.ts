jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));

import { ASR_MODELS, fileUrl, modelSize, recognizerOptions } from '../voice/catalog';
import { VoiceExchanges } from '../voice/exchanges';
import { handleRealtimeEvent, realtimeUrl, RealtimeSession, sessionUpdate } from '../voice/realtime';
import { DEFAULT_VOICE_SETTINGS, parseVoiceSettings } from '../voice/settings';
import { encodeBase64, streamSpeech, transcribeAudio } from '../voice/speech-api';
import { takeSentences, toSpeakable } from '../voice/speech-text';

test('speakable text drops Markdown, links and code', () => {
  expect(toSpeakable('## 标题\n- **第一点**：看[文档](https://a.b/c)\n```js\nx()\n```\n> 引用')).toBe('标题\n第一点：看文档\n（这里有一段代码，可以在对话里查看）\n引用');
  expect(toSpeakable('访问 https://example.com 了解')).toBe('访问 链接 了解');
});

test('sentences are released as soon as they end; the first one is cut early at a comma', () => {
  const first = takeSentences('好的呀，我们先来看看天气怎么样', 0, false, true);
  // Too short to cut at the first comma, and the sentence hasn't ended yet.
  expect(first.sentences).toEqual([]);
  // Needs ≥ 8 characters before an early comma cut.
  const early = takeSentences('今天北京天气非常晴朗，适合出门', 0, false, true);
  expect(early.sentences).toEqual(['今天北京天气非常晴朗，']);
  const streamed = '第一句。第二句还没';
  const step = takeSentences(streamed, 0, false);
  expect(step.sentences).toEqual(['第一句。']);
  const done = takeSentences(`${streamed}说完！`, step.next, true);
  expect(done.sentences).toEqual(['第二句还没说完！']);
  expect(takeSentences('Price is 3.14 dollars. Next', 0, false).sentences).toEqual(['Price is 3.14 dollars.']);
  expect(takeSentences('看代码：```\na。b\n``` 完', 0, true).sentences).toEqual(['看代码：（这里有一段代码，可以在对话里查看）', '完']);
});

test('model catalog: exact sizes, mirror URLs and native paths', () => {
  expect(ASR_MODELS.map((model) => model.tier)).toEqual(['极速', '均衡', '精准']);
  expect(ASR_MODELS.find((model) => model.recommended)?.id).toBe('paraformer-bilingual');
  expect(Math.round(modelSize(ASR_MODELS[2]) / 1e6)).toBe(241);
  expect(fileUrl(ASR_MODELS[1].files[0], 'hf-mirror')).toBe('https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en/resolve/main/encoder.int8.onnx');
  const options = recognizerOptions(ASR_MODELS[2], 'file:///data/voice-models/sensevoice/');
  expect(options).toMatchObject({ kind: 'offline-sensevoice', model: '/data/voice-models/sensevoice/model.int8.onnx', vad: '/data/voice-models/sensevoice/vad-silero_vad.onnx', encoder: '' });
});

test('voice settings fall back to safe defaults', () => {
  expect(parseVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
  expect(parseVoiceSettings('not json')).toEqual(DEFAULT_VOICE_SETTINGS);
  const parsed = parseVoiceSettings(JSON.stringify({ inputEngine: 'local', localModel: 'sensevoice', mirror: 'bogus', ttsModel: '  ', conversationEngine: 'realtime' }));
  expect(parsed).toMatchObject({ inputEngine: 'local', localModel: 'sensevoice', mirror: 'hf-mirror', ttsModel: '', conversationEngine: 'realtime' });
});

test('base64 encoder matches Node for every tail length', () => {
  for (const length of [0, 1, 2, 3, 4, 5, 257]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 255);
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  }
});

test('streamed speech is re-chunked into whole PCM16 samples', async () => {
  const pieces = [new Uint8Array(3001).fill(1), new Uint8Array(2000).fill(2), new Uint8Array(1).fill(3)];
  const audio: string[] = [];
  const fetchImpl = jest.fn(async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => (pieces.length ? { done: false, value: pieces.shift() } : { done: true }) }) },
  }));
  await streamSpeech({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'gpt-4o-mini-tts', voice: 'marin', input: '你好', onAudio: (b64) => audio.push(b64), fetchImpl: fetchImpl as never });
  const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
  expect(url).toBe('https://api.example/v1/audio/speech');
  expect(JSON.parse(init.body)).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'marin', response_format: 'pcm', input: '你好' });
  const lengths = audio.map((b64) => Buffer.from(b64, 'base64').length);
  expect(lengths).toEqual([4800, 202]);
});

test('transcription posts the WAV as multipart and surfaces provider errors', async () => {
  const appended: Array<[string, unknown]> = [];
  (globalThis as { FormData?: unknown }).FormData = class { append(key: string, value: unknown) { appended.push([key, value]); } };
  const ok = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ text: ' 你好世界 ' }) }));
  await expect(transcribeAudio({ baseUrl: 'https://api.example/v1/', apiKey: 'k', model: 'gpt-4o-mini-transcribe', uri: 'file:///a.wav', fetchImpl: ok as never })).resolves.toBe('你好世界');
  expect((ok.mock.calls[0] as unknown as [string])[0]).toBe('https://api.example/v1/audio/transcriptions');
  expect(appended).toEqual(expect.arrayContaining([['model', 'gpt-4o-mini-transcribe'], ['file', { uri: 'file:///a.wav', name: 'speech.wav', type: 'audio/wav' }]]));
  const missing = jest.fn(async () => ({ ok: false, status: 404, text: async () => '{"error":{"message":"no route"}}' }));
  await expect(transcribeAudio({ baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm', uri: 'file:///a.wav', fetchImpl: missing as never })).rejects.toThrow('服务商没有提供语音识别接口');
});

test('realtime: URL, GA session shape and event mapping (GA + beta names)', () => {
  expect(realtimeUrl('https://api.openai.com/v1/', 'gpt-realtime-2.1')).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1');
  // Keys are never sent over plain HTTP / WS.
  expect(() => realtimeUrl('http://10.0.0.2:8080/v1', 'm')).toThrow('HTTPS');
  const update = sessionUpdate({ baseUrl: '', apiKey: '', model: 'gpt-realtime-2.1', voice: 'cedar', instructions: '简短' });
  expect(update.session.audio?.output).toEqual({ format: { type: 'audio/pcm', rate: 24000 }, voice: 'cedar' });
  expect(update.session.audio?.input?.turn_detection).toMatchObject({ interrupt_response: true });
  const seen: string[] = [];
  const handlers = {
    onAudio: (b: string) => seen.push(`audio:${b}`), onAssistantText: (t: string) => seen.push(`say:${t}`),
    onUserText: (t: string) => seen.push(`user:${t}`), onSpeechStarted: () => seen.push('barge'), onError: (m: string) => seen.push(`err:${m}`),
  };
  handleRealtimeEvent({ type: 'response.output_audio.delta', delta: 'AAA' }, handlers);
  handleRealtimeEvent({ type: 'response.audio.delta', delta: 'BBB' }, handlers);
  handleRealtimeEvent({ type: 'response.output_audio_transcript.delta', delta: '你好' }, handlers);
  handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' 在吗 ' }, handlers);
  handleRealtimeEvent({ type: 'input_audio_buffer.speech_started' }, handlers);
  handleRealtimeEvent({ type: 'error', error: { code: 'response_cancel_not_active', message: 'x' } }, handlers);
  handleRealtimeEvent({ type: 'error', error: { message: 'quota' } }, handlers);
  expect(seen).toEqual(['audio:AAA', 'audio:BBB', 'say:你好', 'user:在吗', 'barge', 'err:quota']);
});

test('realtime session connects with a bearer header and resolves on session.updated', async () => {
  const sent: string[] = [];
  let socket: { onopen: (() => void) | null; onmessage: ((e: { data: string }) => void) | null } & Record<string, unknown> = { onopen: null, onmessage: null };
  let headers: Record<string, string> = {};
  const session = new RealtimeSession({ baseUrl: 'https://api.openai.com/v1', apiKey: ' sk-1 ', model: 'gpt-realtime-2.1', voice: 'marin', instructions: '' }, {}, (url, h) => {
    headers = h;
    socket = { readyState: 1, send: (data: string) => sent.push(data), close: () => undefined, onopen: null, onmessage: null, onerror: null, onclose: null, url } as never;
    return socket as never;
  });
  const connected = session.connect(1000);
  socket.onopen?.();
  expect(JSON.parse(sent[0]).type).toBe('session.update');
  socket.onmessage?.({ data: JSON.stringify({ type: 'session.updated' }) });
  await expect(connected).resolves.toBeUndefined();
  expect(headers).toEqual({ Authorization: 'Bearer sk-1' });
  session.sendAudio('QUJD');
  expect(JSON.parse(sent[1])).toEqual({ type: 'input_audio_buffer.append', audio: 'QUJD' });
  session.close();
});

test('realtime: user transcripts of beta / DashScope dialects pair with the right answer', async () => {
  const saved: string[] = [];
  const log = new VoiceExchanges((user, assistant) => saved.push(`${user}|${assistant}`), 0);
  const handlers = {
    onUserTurn: (id: string) => log.userTurn(id),
    onUserText: (text: string, meta?: { itemId?: string; final?: boolean }) => { log.userText(text, meta); },
    onAssistantText: (delta: string) => log.assistantText(delta),
    onResponseDone: () => log.responseDone(),
  };
  handleRealtimeEvent({ type: 'input_audio_buffer.committed', item_id: 'u1' }, handlers);
  handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.text', item_id: 'u1', text: '今天', stash: '天气' }, handlers);
  handleRealtimeEvent({ type: 'response.audio_transcript.delta', delta: '晴天' }, handlers);
  handleRealtimeEvent({ type: 'response.done' }, handlers);
  // The answer is done but the question's final transcript has not arrived yet.
  expect(saved).toEqual([]);
  handleRealtimeEvent({ type: 'input_audio_buffer.committed', item_id: 'u2' }, handlers);
  handleRealtimeEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '今天天气怎么样' }, handlers);
  expect(saved).toEqual(['今天天气怎么样|晴天']);
  handleRealtimeEvent({ type: 'response.output_audio_transcript.delta', delta: '好的' }, handlers);
  handleRealtimeEvent({ type: 'response.done' }, handlers);
  // No transcript for u2 (service doesn't transcribe): saved after the grace period.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(saved).toEqual(['今天天气怎么样|晴天', '|好的']);
  // A duplicate final for a saved turn is ignored; beta servers may report it on the item itself.
  handleRealtimeEvent({ type: 'conversation.item.done', item: { id: 'u1', role: 'user', content: [{ transcript: '重复' }] } }, handlers);
  expect(saved.length).toBe(2);
  const qwen = sessionUpdate({ baseUrl: '', apiKey: '', model: 'qwen3-omni-flash-realtime', voice: 'Cherry', instructions: '', protocol: 'qwen' }).session as Record<string, unknown>;
  expect(qwen.input_audio_transcription).toEqual({ model: 'gummy-realtime-v1' });
});

test('realtime: id-less transcripts (Gemini) pair with the answer that follows', () => {
  const saved: string[] = [];
  const log = new VoiceExchanges((user, assistant) => saved.push(`${user}|${assistant}`), 0);
  log.userText('你好');
  log.userText('你好呀');
  log.assistantText('嗨');
  log.interrupted();
  log.userText('再见');
  log.assistantText('拜拜');
  log.responseDone();
  expect(saved).toEqual(['你好呀|嗨……', '再见|拜拜']);
});
