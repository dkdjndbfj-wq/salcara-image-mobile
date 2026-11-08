import { promptHistory } from '../remote/prompt-history';
import { composerFileKind, appendComposerFiles } from '../remote/composer-files';
import { joinPastedText, namedTextAttachment, splitPastedText } from '../remote/pasted-text';
import type { TimelineItem } from '../remote/store';

const user = (id: string, text = id, extra: Record<string, unknown> = {}): TimelineItem => ({ kind: 'message', id, role: 'user', text, final: true, ts: 1, ...extra } as TimelineItem);
const image = (id: string) => ({ uri: `file://${id}.png`, base64: 'YWJjZA==', mime: 'image/png' as const, width: 2, height: 2 });

test('history is newest-first and excludes pending, delegated, child, blank and non-user content', () => {
  const entries = promptHistory([user('first', 'duplicate'), user('image', 'with image', { images: ['image'] }), user('latest', 'duplicate'),
    user('pending', 'pending', { local: true }), user('child', 'child', { parentId: 'worker' }), user('delegated', 'delegated', { messageOrigin: 'agent' }),
    user('blank', ' \n'), user('assistant', 'response', { role: 'assistant' }), user('too-long', 'x'.repeat(100001))]);
  expect(entries).toMatchObject([{ id: 'latest', text: 'duplicate', hasImages: false, message:{id:'latest'} }, { id: 'image', text: 'with image', hasImages: true, message:{images:['image']} }]);
  expect(promptHistory([user('attachment', 'attached', { attachments: [{ id: 'att_x' }] })])[0].hasImages).toBe(true);
});

test('history limits itself to the latest forty unique loaded user prompts', () => {
  const entries = promptHistory(Array.from({ length: 60 }, (_, index) => user(`prompt-${index}`)));
  expect(entries).toHaveLength(40);expect(entries[0].id).toBe('prompt-59');expect(entries[39].id).toBe('prompt-20');
});

test('named text files retain every character across serialisation with safe distinct labels', () => {
  const body = '  中文🙂\r\n[文本附件结束]\n\n[文本附件：nested；字符数：1]\nx\n[文本附件结束]\n  ';
  const first = namedTextAttachment('C:\\project\\[report];；\n.md', body, []), second = namedTextAttachment('C:\\project\\[report];；\n.md', body, [first]);
  expect(first.name).not.toMatch(/[\[\]\r\n；\0\\/]/);expect(second.name).not.toBe(first.name);
  const combined = joinPastedText('Existing prompt', [first, second]);
  expect(splitPastedText(combined)).toEqual({ prompt: 'Existing prompt', attachments: [first, second] });
});

test.each(['program.ts', 'source.py', 'record.jsonl', 'Dockerfile', 'Makefile', '.gitignore', 'notes.md'])('accepts supported code or text file %s', name => {
  expect(composerFileKind(name, '')).toBe('text');
});

test('file types exclude unsupported binary formats and recognise supported image formats', () => {
  for (const name of ['archive.zip', 'program.exe', 'document.pdf', 'animation.gif']) expect(() => composerFileKind(name, '')).toThrow('暂不支持');
  expect(composerFileKind('image.PNG', '')).toBe('image');expect(composerFileKind('untitled', 'image/webp')).toBe('image');
});

test('appending files retains the complete current draft and settings without modifying source objects', () => {
  const current = { text: joinPastedText('Do not overwrite', [{ name: 'code.ts', text: 'original' }]), images: [image('old')], model: 'chosen-model', options: { collaborationMode: 'plan' } };
  const before = JSON.stringify(current), files = { texts: [{ name: 'code.ts', text: 'new file\n🙂\r\n' }], images: [image('old'), image('new')] };
  const merged = appendComposerFiles(current, files);
  expect(splitPastedText(merged.text)).toEqual({ prompt: 'Do not overwrite', attachments: [{ name: 'code.ts', text: 'original' }, { name: 'code.ts (2)', text: 'new file\n🙂\r\n' }] });
  expect(merged.images).toEqual([image('old'), image('new')]);expect(merged.model).toBe('chosen-model');expect(merged.options).toEqual(current.options);
  expect(JSON.stringify(current)).toBe(before);expect(files.texts[0].name).toBe('code.ts');
});

test('invalid and excessive additions reject atomically while the original draft stays intact', () => {
  const current = { text: 'preserve me', images: [image('old')] }, before = JSON.stringify(current);
  expect(() => appendComposerFiles({ ...current, missingImages: true }, { texts: [], images: [] })).toThrow('缺失');
  expect(() => appendComposerFiles(current, { texts: [{ name: 'bad.txt', text: 'bad\0file' }], images: [] })).toThrow('二进制');
  expect(() => appendComposerFiles(current, { texts: [{ name: 'large.txt', text: 'x'.repeat(100) }], images: [] }, 20)).toThrow('合计超过');
  expect(() => appendComposerFiles(current, { texts: Array.from({ length: 9 }, (_, index) => ({ name: `${index}.txt`, text: 'x' })), images: [] })).toThrow('最多 8');
  expect(() => appendComposerFiles(current, { texts: [], images: Array.from({ length: 4 }, (_, index) => image(`${index}`)) })).toThrow('最多 4');
  expect(() => appendComposerFiles(current, { texts: [], images: [{ ...image('broken'), base64: '' }] })).toThrow('未完整读取');
  expect(JSON.stringify(current)).toBe(before);
});
