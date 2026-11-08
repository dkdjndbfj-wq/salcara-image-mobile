import type { AttachmentRef } from './client';

export const ATTACHMENT_ID = /^att_[a-f0-9]{32}$/;
export const ATTACHMENT_MIME = /^image\/(?:jpeg|png|webp)$/i;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
// Output can contain more images than a phone prompt. Keep its bound separate
// from MAX_REMOTE_IMAGES (four input images).
export const MAX_OUTPUT_ATTACHMENTS = 64;
export type LocalAttachment = AttachmentRef & { uri?: string };
/** An ID may first arrive without complete metadata. Downloads and their UI
 * result must agree on the exact advertised content, including missing fields. */
export const attachmentContentKey = (ref: AttachmentRef): string => JSON.stringify([ref.id, ref.mime.toLowerCase(), ref.size ?? null, ref.sha256 ?? null]);
export const localImageUri = (value: unknown): value is string => typeof value === 'string'
  && /^(?:file|content):\/\//i.test(value) && !/[\r\n\u0000]/.test(value);

export function attachmentRef(value: unknown): AttachmentRef | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !ATTACHMENT_ID.test(raw.id) || typeof raw.mime !== 'string' || !ATTACHMENT_MIME.test(raw.mime)) return null;
  if (raw.size !== undefined && (!Number.isSafeInteger(raw.size) || Number(raw.size) <= 0 || Number(raw.size) > MAX_ATTACHMENT_BYTES)) return null;
  if (raw.sha256 !== undefined && (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256))) return null;
  const ref: AttachmentRef = { id: raw.id, mime: raw.mime.toLowerCase() };
  if (typeof raw.name === 'string' && raw.name.length <= 160 && !/[\r\n\x00]/.test(raw.name)) ref.name = raw.name;
  if (typeof raw.size === 'number') ref.size = raw.size;
  if (typeof raw.sha256 === 'string') ref.sha256 = raw.sha256;
  if (typeof raw.width === 'number' && Number.isSafeInteger(raw.width) && raw.width > 0 && raw.width <= 20_000) ref.width = raw.width;
  if (typeof raw.height === 'number' && Number.isSafeInteger(raw.height) && raw.height > 0 && raw.height <= 20_000) ref.height = raw.height;
  return ref;
}

export function attachmentRefs(value: unknown): AttachmentRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>(), out: AttachmentRef[] = [];
  for (const item of value.slice(0, MAX_OUTPUT_ATTACHMENTS)) {
    const ref = attachmentRef(item);
    if (ref && !seen.has(ref.id)) { seen.add(ref.id); out.push(ref); }
  }
  return out;
}

/** Strict, bounded base64 decoder, also used for chunk integrity checks. */
export function attachmentBytes(data: string, maximum = MAX_ATTACHMENT_BYTES): Uint8Array {
  if (!data || data.length % 4 !== 0 || data.length > Math.ceil(maximum / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('图片数据无效');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const size = data.length / 4 * 3 - padding;
  if (size <= 0 || size > maximum) throw new Error('图片太大（最大 8 MB）');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (let index = 0; index < data.length; index += 4) {
    const a = alphabet.indexOf(data[index]), b = alphabet.indexOf(data[index + 1]);
    const c = data[index + 2] === '=' ? 0 : alphabet.indexOf(data[index + 2]);
    const d = data[index + 3] === '=' ? 0 : alphabet.indexOf(data[index + 3]);
    if (offset < size) bytes[offset++] = (a << 2) | (b >> 4);
    if (offset < size) bytes[offset++] = (b << 4) | (c >> 2);
    if (offset < size) bytes[offset++] = (c << 6) | d;
  }
  return bytes;
}

export function attachmentMagic(bytes: Uint8Array, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/png') return bytes.length > 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  return mime === 'image/webp' && bytes.length > 12 && [82, 73, 70, 70].every((value, index) => bytes[index] === value)
    && [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value);
}
