import { encodeBase64 } from './speech-api';

/**
 * Audio plumbing for cloud speech: every text-to-speech vendor ends up as 24 kHz mono PCM16 for the
 * native player, whatever it sends (raw PCM at another rate, WAV with a header, base64, hex).
 */

export const PLAYER_RATE = 24000;
const CHUNK_BYTES = 4800;

const LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.charCodeAt(index)] = index;
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/** Base64 (standard or URL-safe, padding optional) to bytes, without relying on atob. */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/_-]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let length = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const value = LOOKUP[clean.charCodeAt(index)];
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length] = (buffer >> bits) & 0xff;
      length += 1;
    }
  }
  return out.subarray(0, length);
}

const HEX = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < 16; index += 1) {
    const digit = index.toString(16);
    table[digit.charCodeAt(0)] = index;
    table[digit.toUpperCase().charCodeAt(0)] = index;
  }
  return table;
})();

export function decodeHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length >> 1);
  let length = 0;
  let high = -1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const value = code < 128 ? HEX[code] : -1;
    if (value < 0) continue;
    if (high < 0) high = value;
    else { out[length] = (high << 4) | value; length += 1; high = -1; }
  }
  return out.subarray(0, length);
}

/** If `bytes` start with a RIFF/WAVE header: its sample rate and where the PCM data begins. */
export function parseWavHeader(bytes: Uint8Array): { rate: number; channels: number; dataOffset: number } | null {
  if (bytes.length < 12) return null;
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let rate = PLAYER_RATE;
  let channels = 1;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 16 <= bytes.length) {
      channels = view.getUint16(offset + 10, true) || 1;
      rate = view.getUint32(offset + 12, true) || PLAYER_RATE;
    }
    if (id === 'data') return { rate, channels, dataOffset: offset + 8 };
    offset += 8 + size + (size % 2);
  }
  // Streamed WAVs sometimes announce a data chunk that has not arrived yet.
  return null;
}

/** Linear resampling of mono PCM16 (little-endian). Good enough for speech. */
export function resamplePcm16(bytes: Uint8Array, from: number, to: number): Uint8Array {
  if (from === to || !from || !to) return bytes;
  const samples = Math.floor(bytes.length / 2);
  const input = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
  const outSamples = Math.max(0, Math.floor((samples * to) / from));
  const out = new Uint8Array(outSamples * 2);
  const output = new DataView(out.buffer);
  const step = from / to;
  for (let index = 0; index < outSamples; index += 1) {
    const position = index * step;
    const left = Math.floor(position);
    const right = Math.min(samples - 1, left + 1);
    const fraction = position - left;
    const a = input.getInt16(left * 2, true);
    const b = input.getInt16(right * 2, true);
    output.setInt16(index * 2, Math.round(a + (b - a) * fraction), true);
  }
  return out;
}

/**
 * Streaming linear resampler: keeps the fractional read position and the previous chunk's last sample,
 * so chunk boundaries interpolate like the middle of a buffer (no clicks, no drift).
 */
export class Pcm16Resampler {
  private last = 0;
  /** Next output position in input samples, relative to the next chunk's first sample (-1 = `last`). */
  private position = 0;

  constructor(private from: number, private to: number) {}

  process(bytes: Uint8Array): Uint8Array {
    if (this.from === this.to || !this.from || !this.to) return bytes;
    const samples = Math.floor(bytes.length / 2);
    if (!samples) return new Uint8Array(0);
    const input = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
    const at = (index: number) => (index < 0 ? this.last : input.getInt16(index * 2, true));
    const step = this.from / this.to;
    const out = new Int16Array(Math.ceil((samples - this.position) / step) + 1);
    let count = 0;
    // Only positions whose right neighbour is in this chunk; the rest wait for the next one.
    while (this.position < samples - 1) {
      const left = Math.floor(this.position);
      const a = at(left);
      out[count] = Math.round(a + (at(left + 1) - a) * (this.position - left));
      count += 1;
      this.position += step;
    }
    this.last = at(samples - 1);
    this.position -= samples;
    return int16Bytes(out, count);
  }

  /** The tail held back for interpolation, as the last sample. */
  flush(): Uint8Array {
    const step = this.from / this.to;
    const out = new Int16Array(this.from && this.to && this.position < 0 ? Math.ceil(-this.position / step - 1e-9) : 0);
    for (let index = 0; index < out.length; index += 1) out[index] = this.last;
    const count = out.length;
    this.position = 0;
    this.last = 0;
    return int16Bytes(out, count);
  }
}

function int16Bytes(samples: Int16Array, count: number): Uint8Array {
  const out = new Uint8Array(count * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < count; index += 1) view.setInt16(index * 2, samples[index], true);
  return out;
}

/** Down-mixes interleaved PCM16 to mono. */
function toMono(bytes: Uint8Array, channels: number): Uint8Array {
  if (channels <= 1) return bytes;
  const frames = Math.floor(bytes.length / (2 * channels));
  const input = new DataView(bytes.buffer, bytes.byteOffset, frames * 2 * channels);
  const out = new Uint8Array(frames * 2);
  const output = new DataView(out.buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += input.getInt16((frame * channels + channel) * 2, true);
    output.setInt16(frame * 2, Math.round(sum / channels), true);
  }
  return out;
}

/**
 * Collects audio as it arrives and hands the player ~100 ms base64 pieces of 24 kHz mono PCM16.
 * `rate` is the vendor's rate for raw PCM; a WAV header at the start overrides it.
 */
export class PcmSink {
  private carry = new Uint8Array(0);
  private head: Uint8Array | null = new Uint8Array(0);
  private rate: number;
  private channels = 1;
  private resampler: Pcm16Resampler | null = null;

  constructor(private onAudio: (base64: string) => void, rate = PLAYER_RATE) { this.rate = rate; }

  write(bytes: Uint8Array): void {
    if (!bytes.length) return;
    if (this.head) {
      // Look for a WAV header in the first bytes before treating anything as PCM.
      const joined = concat(this.head, bytes);
      const wav = parseWavHeader(joined);
      if (wav) { this.head = null; this.rate = wav.rate; this.channels = wav.channels; this.push(joined.subarray(wav.dataOffset)); return; }
      const riff = joined.length >= 4 && String.fromCharCode(joined[0], joined[1], joined[2], joined[3]) === 'RIFF';
      // A header split across network chunks: wait for the rest (headers are small).
      if (riff && joined.length < 4096) { this.head = joined; return; }
      this.head = null;
      this.push(joined);
      return;
    }
    this.push(bytes);
  }

  private push(bytes: Uint8Array): void {
    const frame = 2 * this.channels;
    const joined = concat(this.carry, bytes);
    const usable = joined.length - (joined.length % frame);
    this.carry = joined.slice(usable);
    this.resampler ??= new Pcm16Resampler(this.rate, PLAYER_RATE);
    this.emit(this.resampler.process(toMono(joined.subarray(0, usable), this.channels)));
  }

  private emit(pcm: Uint8Array): void {
    for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) this.onAudio(encodeBase64(pcm.subarray(offset, offset + CHUNK_BYTES)));
  }

  end(): void {
    if (this.head && this.head.length) {
      const pending = this.head;
      this.head = null;
      const wav = parseWavHeader(pending);
      if (wav) { this.rate = wav.rate; this.channels = wav.channels; this.push(pending.subarray(wav.dataOffset)); } else this.push(pending);
    }
    this.head = null;
    this.carry = new Uint8Array(0);
    if (this.resampler) this.emit(this.resampler.flush());
    this.resampler = null;
  }
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** UTF-8 bytes to text (TextDecoder is not available on every Hermes build). */
export function utf8(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length;) {
    const byte = bytes[index];
    let code = byte;
    let extra = 0;
    if (byte >= 0xf0) { code = byte & 0x07; extra = 3; } else if (byte >= 0xe0) { code = byte & 0x0f; extra = 2; } else if (byte >= 0xc0) { code = byte & 0x1f; extra = 1; }
    for (let step = 1; step <= extra; step += 1) code = (code << 6) | ((bytes[index + step] ?? 0) & 0x3f);
    index += extra + 1;
    out += String.fromCodePoint(code);
  }
  return out;
}

