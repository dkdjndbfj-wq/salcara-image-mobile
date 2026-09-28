import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { createId } from '../domain-utils';
import type { GeneratedFile } from './types';

/** Files the assistant creates (tables, documents, pages). */
const MAX_FILE_CHARACTERS = 1_000_000;

const TYPES: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', html: 'text/html', htm: 'text/html', xml: 'application/xml', svg: 'image/svg+xml',
  yaml: 'text/yaml', yml: 'text/yaml', ics: 'text/calendar', srt: 'text/plain', log: 'text/plain',
  py: 'text/x-python', js: 'text/javascript', ts: 'text/plain', css: 'text/css', sql: 'text/plain', sh: 'text/x-sh',
};

export function extensionOf(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]{1,10})$/);
  return match ? match[1] : '';
}

export function mimeTypeFor(name: string): string {
  return TYPES[extensionOf(name)] ?? 'text/plain';
}

/** A safe file name: no paths or control characters, a known text extension. */
export function safeFileName(raw: string, content = ''): string {
  let name = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').split(/\s+/).filter((part) => part && !/^\.+$/.test(part)).join(' ').replace(/^\.+/, '');
  if (!name) name = '文件';
  let extension = extensionOf(name);
  if (!TYPES[extension]) {
    extension = /^\s*</.test(content) && /<html|<body|<div/i.test(content) ? 'html' : /^[^\n,]+(,[^\n,]*)+\n/.test(content) ? 'csv' : 'md';
    name = `${name.replace(/\.[a-z0-9]{1,10}$/i, '')}.${extension}`;
  }
  const stem = name.slice(0, name.length - extension.length - 1).slice(0, 60).trim() || '文件';
  return `${stem}.${extension}`;
}

export function writeGeneratedFile(rawName: string, content: string): GeneratedFile {
  if (!content.trim()) throw new Error('文件内容为空');
  if (content.length > MAX_FILE_CHARACTERS) throw new Error('文件内容过长（上限约 100 万字）');
  const name = safeFileName(rawName, content);
  const directory = new Directory(Paths.document, 'generated-files', createId());
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, name);
  file.create({ overwrite: true, intermediates: true });
  // Excel only reads UTF-8 CSV correctly with a byte order mark.
  const body = extensionOf(name) === 'csv' && !content.startsWith('﻿') ? `﻿${content}` : content;
  file.write(body);
  return { id: createId(), uri: file.uri, name, mimeType: mimeTypeFor(name), size: file.size ?? body.length };
}

export async function readGeneratedFile(file: GeneratedFile, limit = 60_000): Promise<string> {
  const text = await new File(file.uri).text();
  const clean = text.replace(/^﻿/, '');
  return clean.length > limit ? `${clean.slice(0, limit)}\n…` : clean;
}

export async function shareGeneratedFile(file: GeneratedFile): Promise<void> {
  if (!new File(file.uri).exists) throw new Error('文件已不存在');
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持系统分享');
  await Sharing.shareAsync(file.uri, { mimeType: file.mimeType, dialogTitle: file.name });
}

/** Deletes a generated file and its private folder. */
export function deleteGeneratedFile(uri: string | null | undefined): void {
  if (!uri || !uri.startsWith('file://')) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
    const folder = uri.replace(/\/[^/]+$/, '');
    if (/generated-files\/[^/]+$/.test(folder)) {
      const directory = new Directory(folder);
      if (directory.exists && directory.list().length === 0) directory.delete();
    }
  } catch {
    // best effort
  }
}
