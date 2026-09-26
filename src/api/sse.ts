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

type Reader = { read: () => Promise<{ done: boolean; value?: unknown }>; cancel?: () => Promise<void> | void };

export interface Utf8StreamDecoder { decode: (chunk?: Uint8Array, options?: { stream?: boolean }) => string }

/**
 * Incremental UTF-8 decoder. Uses the platform TextDecoder when present and a
 * small pure-JS decoder otherwise (some Hermes builds ship without it), so a
 * missing global never turns streaming off. Multi-byte characters split across
 * network chunks are held back until complete.
 */
export function createUtf8Decoder(forceFallback = false): Utf8StreamDecoder {
  if (!forceFallback && typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder('utf-8') as Utf8StreamDecoder; } catch { /* fall through */ }
  }
  let pending: number[] = [];
  return {
    decode(chunk?: Uint8Array, options?: { stream?: boolean }): string {
      const bytes = pending.length ? [...pending, ...(chunk ?? [])] : Array.from(chunk ?? []);
      pending = [];
      let out = '';
      let index = 0;
      while (index < bytes.length) {
        const lead = bytes[index];
        const need = lead < 0x80 ? 0 : lead < 0xc2 ? -1 : lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : lead < 0xf5 ? 3 : -1;
        if (need < 0) { out += '\uFFFD'; index += 1; continue; }
        if (index + need >= bytes.length) {
          if (options?.stream) { pending = bytes.slice(index); break; }
          out += '\uFFFD'; break;
        }
        let code = need === 0 ? lead : lead & (0x3f >> need);
        let valid = true;
        for (let k = 1; k <= need; k += 1) {
          const next = bytes[index + k];
          if ((next & 0xc0) !== 0x80) { valid = false; break; }
          code = (code << 6) | (next & 0x3f);
        }
        if (!valid) { out += '\uFFFD'; index += 1; continue; }
        out += String.fromCodePoint(code);
        index += need + 1;
      }
      return out;
    },
  };
}

function toBytes(value: unknown): Uint8Array | string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return null;
}

export type SseResult = { kind: 'events' } | { kind: 'json'; text: string };

export async function readSse(
  response: StreamingResponse,
  onEvent: (event: SseEvent) => void,
  signal?: AbortSignal,
): Promise<SseResult> {
  const contentType = response.headers?.get?.('content-type') ?? '';
  const body = response.body as { getReader?: () => Reader } | null | undefined;
  const canStream = typeof body?.getReader === 'function';
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
  const decoder = createUtf8Decoder();
  let buffer = '';
  let sawEvent = false;
  const abort = () => { void Promise.resolve(reader.cancel?.()).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = toBytes(value);
      if (chunk === null) continue;
      buffer = (buffer + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))).replace(/\r\n/g, '\n');
      // A lone \r at a chunk edge may be half of \r\n; keep it for the next chunk.
      if (buffer.endsWith('\r')) continue;
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
