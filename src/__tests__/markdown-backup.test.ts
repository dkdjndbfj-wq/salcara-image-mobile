jest.mock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: async () => undefined }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: async () => ({ canceled: true }) }));
jest.mock('expo-file-system', () => ({ Directory: class {}, File: class {}, Paths: { cache: {}, document: { uri: 'file:///doc/' } }, FileMode: {} }));
jest.mock('../storage/database', () => ({ database: async () => null, listMessages: async () => [] }));

import { highlightCode, INLINE_MATH, splitDisplayMath, texToText } from '../components/markdown-extras';
import { conversationMarkdown, rebaseRows, safeEntryPath } from '../storage/backup';
import type { ChatMessage } from '../domain';

test('math reads as text', () => {
  expect(texToText('\\frac{a+b}{2}')).toBe('(a+b)/2');
  expect(texToText('x^2 + y^{2} = r^2')).toBe('x² + y² = r²');
  expect(texToText('\\alpha \\leq \\beta')).toBe('α ≤ β');
  expect(texToText('\\sqrt{x^2+1}')).toBe('√(x²+1)');
  expect(texToText('a_{ij}')).toBe('aᵢⱼ');
  expect(splitDisplayMath('前\n$$\nE=mc^2\n$$\n后')).toEqual([{ math: false, text: '前\n' }, { math: true, text: 'E=mc^2' }, { math: false, text: '\n后' }]);
  const inline = new RegExp(INLINE_MATH.source, 'g');
  expect('价格 $5 和 $6 元'.match(inline)).toBeNull();
  expect('公式 $x^2$ 和 \\(\\alpha\\)'.match(inline)).toEqual(['$x^2$', '\\(\\alpha\\)']);
});

test('code gets light colouring', () => {
  expect(highlightCode('const x = "hi"; // note', 'ts')).toEqual([
    { kind: 'keyword', text: 'const' }, { kind: 'plain', text: ' x = ' }, { kind: 'string', text: '"hi"' }, { kind: 'plain', text: '; ' }, { kind: 'comment', text: '// note' },
  ]);
  expect(highlightCode('# c\nprint(1)', 'python').map((token) => token.kind)).toEqual(['comment', 'plain', 'number', 'plain']);
  expect(highlightCode('plain words', 'text')).toEqual([{ kind: 'plain', text: 'plain words' }]);
});

test('backup helpers: markdown, safe paths, moved document folder', () => {
  const base = { conversationId: 'c', mode: 'chat', status: 'complete', providerId: 'p', model: 'm', quality: 'auto', size: 'auto', transparent: false, imageUri: null, remoteImageUrl: null, references: [], maskUri: null, error: null, elapsedMs: null };
  const markdown = conversationMarkdown('旅行计划', [
    { ...base, id: 'u', role: 'user', prompt: '去哪里？', createdAt: new Date(2026, 9, 3, 9, 5).getTime() },
    { ...base, id: 'a', role: 'assistant', prompt: '', text: '去杭州。', createdAt: 2, agent: { sources: [{ title: '指南', url: 'https://example.com' }] } },
  ] as unknown as ChatMessage[], new Date(2026, 9, 3, 10, 0).getTime());
  expect(markdown).toContain('# 旅行计划');
  expect(markdown).toContain('## 你 · 2026-10-03 09:05\n\n去哪里？');
  expect(markdown).toContain('去杭州。');
  expect(markdown).toContain('1. [指南](https://example.com)');

  expect(safeEntryPath('files/generated-images/a.png')).toBe('generated-images/a.png');
  expect(safeEntryPath('files/../secrets')).toBeNull();
  expect(safeEntryPath('files/generated-images/../../x')).toBeNull();
  expect(safeEntryPath('files/other/a.png')).toBeNull();
  expect(safeEntryPath('backup.json')).toBeNull();

  expect(rebaseRows([{ uri: 'file:///old/generated-images/a.png', n: 1 }], 'file:///old/', 'file:///new/')).toEqual([{ uri: 'file:///new/generated-images/a.png', n: 1 }]);
});
