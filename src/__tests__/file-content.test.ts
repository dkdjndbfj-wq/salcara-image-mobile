const mockFiles = new Map<string, { text?: string; base64?: string; size?: number }>();

jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return mockFiles.has(this.uri); }
    get size() { return mockFiles.get(this.uri)?.size ?? 128; }
    async text() { return mockFiles.get(this.uri)?.text ?? ''; }
    async base64() { return mockFiles.get(this.uri)?.base64 ?? ''; }
  },
}));

import { strToU8, zipSync } from 'fflate';
import { prepareAttachment } from '../file-content';
import type { DocumentAttachment } from '../domain';

function attachment(uri: string, name: string, mimeType: string): DocumentAttachment {
  return { id: name, uri, name, mimeType, size: 128 };
}

beforeEach(() => mockFiles.clear());

test('reads UTF-8 text and strips a BOM', async () => {
  mockFiles.set('file:///notes.md', { text: '\uFEFF# 标题\n正文' });
  await expect(prepareAttachment(attachment('file:///notes.md', 'notes.md', 'text/markdown'))).resolves.toEqual({ type: 'text', text: '# 标题\n正文' });
});

test('extracts visible text from a DOCX XML container without executing macros', async () => {
  const bytes = zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>足球场</w:t></w:r></w:p><w:p><w:t>蓝色看台</w:t></w:p></w:body></w:document>') });
  const encoded = Buffer.from(bytes).toString('base64');
  mockFiles.set('file:///plan.docx', { base64: encoded });
  const result = await prepareAttachment(attachment('file:///plan.docx', 'plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  expect(result).toEqual({ type: 'text', text: '足球场\n蓝色看台' });
});

test('lists ZIP entries instead of extracting or executing arbitrary content', async () => {
  const bytes = zipSync({ 'README.txt': strToU8('不要执行'), 'src/main.ts': strToU8('code') });
  mockFiles.set('file:///project.zip', { base64: Buffer.from(bytes).toString('base64') });
  const result = await prepareAttachment(attachment('file:///project.zip', 'project.zip', 'application/zip'));
  expect(result.type).toBe('metadata');
  expect(result.type === 'metadata' ? result.text : '').toContain('README.txt');
  expect(result.type === 'metadata' ? result.text : '').not.toContain('不要执行');
});

test('keeps unknown binary files as a named data file', async () => {
  mockFiles.set('file:///model.bin', { base64: 'AAECAw==' });
  await expect(prepareAttachment(attachment('file:///model.bin', 'model.bin', 'application/octet-stream'))).resolves.toMatchObject({ type: 'file', filename: 'model.bin', mimeType: 'application/octet-stream' });
});
