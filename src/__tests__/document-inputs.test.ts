const mockSourceSize = { value: 100 };
const mockCopy = jest.fn();
jest.mock('expo-file-system', () => ({
  File: class {
    uri: string;
    exists = true;
    constructor(...parts: unknown[]) { this.uri = parts.map((item) => typeof item === 'object' ? 'file:///documents' : item).join('/'); }
    get size() { return mockSourceSize.value; }
    copy = (...args: unknown[]) => mockCopy(...args);
  },
  Directory: class { create() {} },
  Paths: { document: 'file:///documents' },
}));
jest.mock('expo-document-picker', () => ({}));
import { documentMimeType, importDocument, validateAttachments } from '../document-inputs';
import type { DocumentAttachment, ReferenceImage } from '../domain';

const document: DocumentAttachment = { id: '1', uri: 'file:///a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 100 };

test('accepts supported formats even with generic Android MIME types, rejects Word', () => {
  expect(documentMimeType('方案.PDF', 'application/octet-stream')).toBe('application/pdf');
  expect(documentMimeType('README.md')).toBe('text/markdown');
  expect(() => documentMimeType('方案.docx', 'application/pdf')).toThrow('先转为 PDF');
});

test('enforces individual and combined attachment limits', () => {
  expect(() => validateAttachments([{ ...document, size: 21 * 1024 * 1024 }], [])).toThrow('20MB');
  expect(() => validateAttachments(Array(5).fill(document), [])).toThrow('4 份');
  const reference: ReferenceImage = { ...document, mimeType: 'image/png', size: 16 * 1024 * 1024 };
  expect(() => validateAttachments([{ ...document, size: 16 * 1024 * 1024 }], [reference])).toThrow('30MB');
});

test('uses actual file size to reject misleading picker metadata before copying', async () => {
  mockSourceSize.value = 25 * 1024 * 1024;
  await expect(importDocument({ uri: 'file:///a.pdf', name: 'a.pdf', size: 10 })).rejects.toThrow('20MB');
  expect(mockCopy).not.toHaveBeenCalled();
  mockSourceSize.value = 100;
});
