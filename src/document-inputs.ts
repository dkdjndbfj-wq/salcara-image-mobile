import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';

import type { DocumentAttachment, ReferenceImage } from './domain';
import { createId } from './domain-utils';

export const MAX_DOCUMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 30 * 1024 * 1024;
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'text/plain', 'text/markdown', 'text/csv'] as const;

type InputDocument = { uri: string; name: string; mimeType?: string | null; size?: number | null };

export async function pickDocuments(remaining = MAX_DOCUMENTS): Promise<DocumentAttachment[]> {
  if (remaining <= 0) throw new Error(`一次最多添加 ${MAX_DOCUMENTS} 份文档`);
  const result = await DocumentPicker.getDocumentAsync({
    type: [...DOCUMENT_MIME_TYPES, 'text/x-markdown', 'application/csv'],
    multiple: remaining > 1,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  if (result.assets.length > remaining) throw new Error(`本次最多还能添加 ${remaining} 份文档，请重新选择`);
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

export function documentMimeType(name: string, mimeType?: string | null): DocumentAttachment['mimeType'] {
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'txt') return 'text/plain';
  if (extension === 'md' || extension === 'markdown') return 'text/markdown';
  if (extension === 'csv') return 'text/csv';
  // Some Android content providers do not include an extension in the display name.
  if (!name.includes('.') && DOCUMENT_MIME_TYPES.includes(mimeType as DocumentAttachment['mimeType'])) {
    return mimeType as DocumentAttachment['mimeType'];
  }
  throw new Error('目前支持 PDF、TXT、Markdown 和 CSV 文档；其他格式请先转为 PDF');
}

export async function importDocument(asset: InputDocument): Promise<DocumentAttachment> {
  const mimeType = documentMimeType(asset.name, asset.mimeType);
  const source = new File(asset.uri);
  const size = source.size ?? asset.size ?? 0;
  if (!source.exists || size <= 0) throw new Error(`无法读取文档“${asset.name}”，请重新选择`);
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`文档“${asset.name}”超过 20MB，请缩小文件后重试`);
  const directory = new Directory(Paths.document, 'reference-documents');
  directory.create({ idempotent: true, intermediates: true });
  const extension = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'text/csv' ? 'csv' : mimeType === 'text/markdown' ? 'md' : 'txt';
  const id = createId();
  const destination = new File(directory, `${id}.${extension}`);
  await source.copy(destination, { overwrite: true });
  return { id, uri: destination.uri, name: asset.name, mimeType, size: destination.size ?? size };
}

export function validateAttachments(documents: DocumentAttachment[] = [], references: ReferenceImage[] = []): void {
  if (documents.length > MAX_DOCUMENTS) throw new Error(`一次最多添加 ${MAX_DOCUMENTS} 份文档`);
  if (references.length > 4) throw new Error('一次最多添加 4 张图片');
  const attachments = [...documents, ...references];
  for (const attachment of attachments) {
    if (!Number.isFinite(attachment.size) || attachment.size <= 0) throw new Error(`附件“${attachment.name}”为空或无法读取`);
    if (attachment.size > MAX_ATTACHMENT_BYTES) throw new Error(`附件“${attachment.name}”超过 20MB`);
  }
  if (attachments.reduce((total, item) => total + item.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error('图片和文档合计不能超过 30MB，请减少附件');
  }
}
