import { extractTextToolCall, imageToolDefinition, normalizeImageLabel, parseImageToolArguments, visibleStreamingText } from '../agent/image-tool';
import { readSse } from '../api/sse';

test('parses tool arguments from JSON strings or objects and normalizes labels', () => {
  expect(parseImageToolArguments('{"prompt":" 海边日落 ","reference_images":["图 1","2","图1"],"aspect_ratio":"16:9"}')).toEqual({
    prompt: '海边日落', referenceImages: ['图1', '图2'], aspectRatio: '16:9', transparent: false,
  });
  expect(parseImageToolArguments({ prompt: '贴纸', transparent_background: true, aspect_ratio: '4:3' })).toEqual({
    prompt: '贴纸', referenceImages: [], aspectRatio: null, transparent: true,
  });
  expect(parseImageToolArguments('{"prompt":""}')).toBeNull();
  expect(parseImageToolArguments('not json')).toBeNull();
  expect(normalizeImageLabel('image 12')).toBe('图12');
  expect(normalizeImageLabel('最近那张')).toBeNull();
});

test('each protocol receives its own tool schema shape', () => {
  expect(imageToolDefinition('chat-completions')).toMatchObject({ type: 'function', function: { name: 'generate_image' } });
  expect(imageToolDefinition('responses')).toMatchObject({ type: 'function', name: 'generate_image' });
  expect(imageToolDefinition('anthropic')).toMatchObject({ name: 'generate_image', input_schema: { type: 'object' } });
});

test('text-mode tool markers are extracted and never shown while streaming', () => {
  const raw = '好的，画一张。\n<<<IMAGE {"prompt":"星空","reference_images":["图3"]}>>>';
  expect(extractTextToolCall(raw)).toEqual({ text: '好的，画一张。', call: { prompt: '星空', referenceImages: ['图3'], aspectRatio: null, transparent: false } });
  expect(extractTextToolCall('普通回答')).toEqual({ text: '普通回答', call: null });
  expect(visibleStreamingText('好的\n<<<IMA')).toBe('好的');
});

test('SSE reader handles chunk boundaries, comments and JSON fallbacks', async () => {
  const events: string[] = [];
  const chunks = ['data: {"a":1}\n', '\n: keep-alive\n\nevent: x\ndata: {"b"', ':2}\n\ndata: [DONE]\n\n'];
  if (typeof TextDecoder !== 'undefined' && typeof TextEncoder !== 'undefined') {
    const encoder = new TextEncoder();
    const result = await readSse({
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => ({ read: async () => chunks.length ? { done: false, value: encoder.encode(chunks.shift()!) } : { done: true } }) },
    }, (event) => events.push(`${event.event ?? ''}|${event.data}`));
    expect(result).toEqual({ kind: 'events' });
    expect(events).toEqual(['|{"a":1}', 'x|{"b":2}', '|[DONE]']);
  }
  const json = await readSse({ headers: { get: () => 'application/json' }, text: async () => '{"ok":true}' }, () => undefined);
  expect(json).toEqual({ kind: 'json', text: '{"ok":true}' });
  const legacy = await readSse({ json: async () => ({ ok: 1 }) }, () => undefined);
  expect(legacy).toEqual({ kind: 'json', text: '{"ok":1}' });
});
