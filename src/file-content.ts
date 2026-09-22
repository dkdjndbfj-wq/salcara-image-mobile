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
export async function prepareAttachment(attachment: DocumentAttachment, signal?: AbortSignal): Promise<PreparedAttachment> {
  throwIfAborted(signal);
  const kind = attachment.kind ?? attachmentKind(attachment.name, attachment.mimeType);
  const file = readableFile(attachment);
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
    if (raw.includes('\u0000')) return { type: 'metadata', text: metadataLine(attachment, '检测到二进制内容，未直接展开') };
    return { type: 'text', text: limitText(stripBom(raw), attachment.name) };
  }
  if (kind === 'office') {
    const base64 = await file.base64();
    throwIfAborted(signal);
    const text = extractOfficeText(attachment.name, base64ToBytes(base64));
    if (text.trim()) return { type: 'text', text: limitText(text, attachment.name) };
    if (base64) return { type: 'file', data: `data:${mimeType};base64,${base64}`, filename: attachment.name, mimeType };
    return { type: 'metadata', text: metadataLine(attachment, '这是办公文档；当前未能提取可读正文') };
  }
  if (kind === 'archive') {
    const base64 = await file.base64();
    throwIfAborted(signal);
    const entries = listZipEntries(base64ToBytes(base64));
    return { type: 'metadata', text: entries.length
      ? `${metadataLine(attachment, '压缩包目录（未解压，不执行其中代码）')}\n${entries.slice(0, 200).map((entry) => `- ${entry}`).join('\n')}`
      : metadataLine(attachment, '压缩包未能读取目录；未解压其中内容') };
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

function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/\s/g, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const output = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const character of clean) {
    if (character === '=') break;
    const digit = alphabet.indexOf(character);
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
