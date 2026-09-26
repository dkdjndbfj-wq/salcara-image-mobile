import { unzipSync, strFromU8 } from 'fflate';
import { File } from 'expo-file-system';

import type { DocumentAttachment } from './domain';
import { attachmentKind, normalizedMimeType } from './document-inputs';

export const MAX_EXTRACTED_TEXT = 100_000;

export type PreparedAttachment =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string }
  | { type: 'file'; data: string; filename: string; mimeType: string }
  | { type: 'metadata'; text: string };

/**
 * Reads a local attachment without sending it to a third-party extractor.
 * Office files are ZIP/XML containers; only visible text is extracted and
 * macros/embedded binaries are deliberately ignored. Unknown files remain a
 * file part for protocols which support input_file/file content.
 */
/**
 * Extracted text of office files, archives and text files, reused while the
 * same file stays in the conversation (history resends it on later turns).
 */
const extractedCache = new Map<string, PreparedAttachment>();
const MAX_CACHE_ENTRIES = 12;

function remember(key: string, value: PreparedAttachment): PreparedAttachment {
  if (value.type === 'text' || value.type === 'metadata') {
    extractedCache.delete(key);
    extractedCache.set(key, value);
    while (extractedCache.size > MAX_CACHE_ENTRIES) extractedCache.delete(extractedCache.keys().next().value as string);
  }
  return value;
}

/** Test hook. */
export function clearExtractedCache(): void { extractedCache.clear(); }

/** Raw bytes without a base64 round trip when the runtime supports it. */
async function readBytes(file: File): Promise<Uint8Array> {
  const withBytes = file as File & { bytes?: () => Promise<Uint8Array> };
  if (typeof withBytes.bytes === 'function') {
    try { return await withBytes.bytes(); } catch { /* fall back */ }
  }
  return base64ToBytes(await file.base64());
}

export async function prepareAttachment(attachment: DocumentAttachment, signal?: AbortSignal): Promise<PreparedAttachment> {
  throwIfAborted(signal);
  const kind = attachment.kind ?? attachmentKind(attachment.name, attachment.mimeType);
  const file = readableFile(attachment);
  const cacheKey = `${attachment.uri}#${file.size ?? attachment.size}#${kind}`;
  const cached = extractedCache.get(cacheKey);
  if (cached) return remember(cacheKey, cached);
  const mimeType = normalizedMimeType(attachment.name, attachment.mimeType);
  if (kind === 'image') {
    const base64 = await file.base64();
    throwIfAborted(signal);
    if (!base64) throw new Error(`附件“${attachment.name}”为空`);
    return { type: 'image', data: `data:${mimeType};base64,${base64}` };
  }
  if (kind === 'text') {
    const raw = await file.text();
    throwIfAborted(signal);
    if (raw.includes('\u0000')) return remember(cacheKey, { type: 'metadata', text: metadataLine(attachment, '检测到二进制内容，未直接展开') });
    return remember(cacheKey, { type: 'text', text: limitText(stripBom(raw), attachment.name) });
  }
  if (kind === 'office') {
    const bytes = await readBytes(file);
    throwIfAborted(signal);
    const text = extractOfficeText(attachment.name, bytes);
    if (text.trim()) return remember(cacheKey, { type: 'text', text: limitText(text, attachment.name) });
    const base64 = await file.base64();
    if (base64) return { type: 'file', data: `data:${mimeType};base64,${base64}`, filename: attachment.name, mimeType };
    return remember(cacheKey, { type: 'metadata', text: metadataLine(attachment, '这是办公文档；当前未能提取可读正文') });
  }
  if (kind === 'archive') {
    const bytes = await readBytes(file);
    throwIfAborted(signal);
    const entries = listZipEntries(bytes);
    return remember(cacheKey, { type: 'metadata', text: entries.length
      ? `${metadataLine(attachment, '压缩包目录（未解压，不执行其中代码）')}\n${entries.slice(0, 200).map((entry) => `- ${entry}`).join('\n')}`
      : metadataLine(attachment, '压缩包未能读取目录；未解压其中内容') });
  }
  // Responses and several OpenAI-compatible gateways understand a generic
  // file part. We preserve the original name so the model can identify it.
  const base64 = await file.base64();
  throwIfAborted(signal);
  if (!base64) throw new Error(`附件“${attachment.name}”为空`);
  return { type: 'file', data: `data:${mimeType};base64,${base64}`, filename: attachment.name, mimeType };
}

export function metadataLine(attachment: Pick<DocumentAttachment, 'name' | 'mimeType' | 'size'>, suffix = ''): string {
  const size = Number.isFinite(attachment.size) ? `${(attachment.size / 1024 / 1024).toFixed(2)} MB` : '大小未知';
  return `附件：${attachment.name}（${attachment.mimeType || '未知类型'}，${size}）${suffix ? `。${suffix}` : ''}`;
}

function readableFile(attachment: DocumentAttachment): File {
  if (!attachment.uri.startsWith('file://')) throw new Error(`附件“${attachment.name}”尚未保存到本地，请重新选择`);
  const file = new File(attachment.uri);
  if (!file.exists || !file.size) throw new Error(`附件“${attachment.name}”已丢失或为空，请重新添加`);
  return file;
}

function extractOfficeText(name: string, bytes: Uint8Array): string {
  if (!bytes.length) return '';
  const extension = name.toLowerCase().split('.').pop() ?? '';
  // Legacy binary .doc/.xls/.ppt cannot safely be parsed without a large
  // native converter. Return metadata instead of pretending to understand it.
  if (['doc', 'xls', 'ppt'].includes(extension)) return '';
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { return ''; }
  const preferred = extension === 'docx'
    ? ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']
    : extension === 'pptx'
      ? Object.keys(files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path)).sort()
      : extension === 'xlsx'
        ? ['xl/sharedStrings.xml', ...Object.keys(files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path)).sort()]
        : ['content.xml', ...Object.keys(files).filter((path) => /\.(xml|xhtml|html)$/i.test(path)).sort()];
  const paths = [...new Set(preferred)].filter((path) => files[path]);
  return paths.map((path) => xmlToText(strFromU8(files[path]))).filter(Boolean).join('\n').trim();
}

function xmlToText(xml: string): string {
  return decodeEntities(xml
    .replace(/<w:tab\b[^>]*\/?\s*>/gi, '\t')
    .replace(/<(?:w:p|a:p|text:p|table:table-row|row|tr|br)\b[^>]*\/?>/gi, '\n')
    .replace(/<\/\s*(?:w:p|a:p|text:p|table:table-row|row|tr|br)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n'))
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : '';
  });
}

function listZipEntries(bytes: Uint8Array): string[] {
  try { return Object.keys(unzipSync(bytes)); } catch { return []; }
}

function limitText(value: string, name: string): string {
  if (value.length <= MAX_EXTRACTED_TEXT) return value;
  return `${value.slice(0, MAX_EXTRACTED_TEXT)}\n\n[${name} 内容已截断，超过本地解析上限]`;
}

function stripBom(value: string): string { return value.replace(/^\uFEFF/, ''); }

const BASE64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((character, index) => { table[character.charCodeAt(0)] = index; });
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/** Table-driven decoder: one pass, no per-character search, no intermediate string copy. */
function base64ToBytes(value: string): Uint8Array {
  const output = new Uint8Array(Math.floor(value.length * 3 / 4) + 3);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 61) break; // '='
    const digit = code < 256 ? BASE64_LOOKUP[code] : -1;
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (offset < output.length) output[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return offset === output.length ? output : output.slice(0, offset);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('请求已取消');
    error.name = 'AbortError';
    throw error;
  }
}
