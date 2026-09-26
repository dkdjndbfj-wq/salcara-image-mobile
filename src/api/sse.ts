/**
 * Minimal Server-Sent Events reader for expo/fetch responses.
 *
 * Streaming is used when the runtime exposes a readable body. Some relays
 * ignore `stream: true` and answer with plain JSON, and test environments may
 * not expose a stream at all; callers therefore receive either SSE events or
 * the full body text, never a silent empty result.
 */
export type SseEvent = { event: string | null; data: string };

type StreamingResponse = {
  headers?: { get?: (name: string) => string | null } | null;
  body?: unknown;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

type Reader = { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel?: () => Promise<void> | void };

export type SseResult = { kind: 'events' } | { kind: 'json'; text: string };

export async function readSse(
  response: StreamingResponse,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<SseResult> {
  const contentType = response.headers?.get?.('content-type') ?? '';
  const body = response.body as { getReader?: () => Reader } | null | undefined;
  const canStream = typeof body?.getReader === 'function' && typeof TextDecoder !== 'undefined';
  if (!canStream || /application\/json/i.test(contentType)) {
    const withJson = response as StreamingResponse & { json?: () => Promise<unknown> };
    const text = typeof response.text === 'function' ? await response.text()
      : typeof withJson.json === 'function' ? JSON.stringify(await withJson.json()) : '';
    if (looksLikeSse(text)) {
      parseSseChunk(text + '\n\n', onEvent);
      return { kind: 'events' };
    }
    return { kind: 'json', text };
  }

  const reader = body!.getReader!();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let sawEvent = false;
  const abort = () => { void Promise.resolve(reader.cancel?.()).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (emitBlock(block, onEvent)) sawEvent = true;
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      if (!sawEvent && !looksLikeSse(buffer)) return { kind: 'json', text: buffer };
      emitBlock(buffer, onEvent);
    }
    return { kind: 'events' };
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

function looksLikeSse(text: string): boolean {
  return /^\s*(?:data|event):/m.test(text) && !/^\s*[{[]/.test(text);
}

export function parseSseChunk(text: string, onEvent: (event: SseEvent) => void): void {
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) emitBlock(block, onEvent);
}

function emitBlock(block: string, onEvent: (event: SseEvent) => void): boolean {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return false;
  onEvent({ event, data: data.join('\n') });
  return true;
}
