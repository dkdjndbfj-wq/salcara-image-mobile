import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';

import type { AttachmentKind, DocumentAttachment, ReferenceImage } from './domain';
import { createId } from './domain-utils';

/** Keep the request small enough for mobile memory and compatible proxy limits. */
export const MAX_DOCUMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 30 * 1024 * 1024;

/** Kept public so settings/help screens can advertise common formats. */
export const DOCUMENT_MIME_TYPES = [
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values',
  'application/json', 'application/xml', 'text/xml', 'text/html', 'text/css',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf', 'application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
] as const;

type InputDocument = { uri: string; name: string; mimeType?: string | null; size?: number | null };

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'log', 'ini', 'cfg', 'conf', 'env',
  'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'java', 'kt', 'kts', 'py', 'pyw',
  'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'swift', 'dart', 'rb', 'php', 'sql', 'sh', 'bash', 'zsh',
  'bat', 'cmd', 'ps1', 'r', 'lua', 'ex', 'exs', 'erl', 'hrl', 'vue', 'svelte', 'astro', 'tex', 'rtf', 'srt', 'vtt',
]);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'epub']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff']);

/**
 * Let Android's system picker expose every file. We classify it locally after
 * import instead of maintaining a fragile allow-list in the picker itself.
 */
export async function pickDocuments(remaining = MAX_DOCUMENTS): Promise<DocumentAttachment[]> {
  if (remaining <= 0) throw new Error(`一次最多添加 ${MAX_DOCUMENTS} 个文件`);
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    multiple: remaining > 1,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  if (result.assets.length > remaining) throw new Error(`本次最多还能添加 ${remaining} 个文件，请重新选择`);
  const imported: DocumentAttachment[] = [];
  try {
    for (const asset of result.assets) imported.push(await importDocument(asset));
    validateAttachments(imported, []);
    return imported;
  } catch (error) {
    for (const document of imported) {
      try { new File(document.uri).delete(); } catch { /* Best-effort cleanup of this failed import. */ }
    }
    throw error;
  }
}

/** Alias with a product-facing name for the general chat composer. */
export const pickAnyFiles = pickDocuments;

export function fileExtension(name: string): string {
  const clean = name.split(/[\\/]/).pop() ?? name;
  const match = clean.match(/\.([a-z0-9]{1,16})$/i);
  return match?.[1]?.toLowerCase() ?? '';
}

export function attachmentKind(name: string, mimeType?: string | null): AttachmentKind {
  const mime = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  const extension = fileExtension(name);
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || TEXT_EXTENSIONS.has(extension)) return 'text';
  if (mime.includes('word') || mime.includes('excel') || mime.includes('spreadsheet') || mime.includes('powerpoint') || mime.includes('presentation') || mime.includes('opendocument') || mime === 'application/epub+zip' || OFFICE_EXTENSIONS.has(extension)) return 'office';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z') || mime.includes('tar') || mime.includes('gzip') || mime.includes('bzip') || mime.includes('xz') || ARCHIVE_EXTENSIONS.has(extension)) return 'archive';
  return 'binary';
}

export function isImageAttachment(document: Pick<DocumentAttachment, 'name' | 'mimeType' | 'kind'>): boolean {
  return (document.kind ?? attachmentKind(document.name, document.mimeType)) === 'image';
}

export function normalizedMimeType(name: string, mimeType?: string | null): string {
  const supplied = (mimeType ?? '').toLowerCase().split(';')[0].trim();
  const extension = fileExtension(name);
  const byExtension: Record<string, string> = {
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip',
    zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
  };
  if (byExtension[extension]) return byExtension[extension];
  if (supplied && supplied !== 'application/octet-stream' && supplied !== 'binary/octet-stream') return supplied;
  return supplied || 'application/octet-stream';
}

/** Backwards-compatible name used by older callers and tests. */
export function documentMimeType(name: string, mimeType?: string | null): string {
  return normalizedMimeType(name, mimeType);
}

export async function importDocument(asset: InputDocument): Promise<DocumentAttachment> {
  const mimeType = normalizedMimeType(asset.name, asset.mimeType);
  const kind = attachmentKind(asset.name, mimeType);
  const source = new File(asset.uri);
  const size = source.size ?? asset.size ?? 0;
  if (!source.exists || size <= 0) throw new Error(`无法读取文件“${asset.name}”，请重新选择`);
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`文件“${asset.name}”超过 20MB，请缩小文件后重试`);
  const directory = new Directory(Paths.document, 'reference-documents');
  directory.create({ idempotent: true, intermediates: true });
  const extension = fileExtension(asset.name);
  const id = createId();
  const destination = new File(directory, `${id}${extension ? `.${extension}` : '.bin'}`);
  await source.copy(destination, { overwrite: true });
  return { id, uri: destination.uri, name: asset.name || `附件-${id}`, mimeType, kind, size: destination.size ?? size };
}

export function validateAttachments(documents: DocumentAttachment[] = [], references: ReferenceImage[] = []): void {
  if (documents.length > MAX_DOCUMENTS) throw new Error(`一次最多添加 ${MAX_DOCUMENTS} 个文件`);
  if (references.length > 4) throw new Error('一次最多添加 4 张图片');
  const attachments = [...documents, ...references];
  for (const attachment of attachments) {
    if (!Number.isFinite(attachment.size) || attachment.size <= 0) throw new Error(`附件“${attachment.name}”为空或无法读取`);
    if (attachment.size > MAX_ATTACHMENT_BYTES) throw new Error(`附件“${attachment.name}”超过 20MB`);
  }
  if (attachments.reduce((total, item) => total + item.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error('图片和文件合计不能超过 30MB，请减少附件');
  }
}
