import { appendImageAnnotation } from '../remote/image-annotation-draft';
import type { RemoteImage } from '../remote/attachment-chunks';

const image = (id: string): RemoteImage => ({ uri: `file:///cache/${id}.png`, base64: `encoded-${id}`, mime: 'image/png', width: 800, height: 500 });

test('annotation append preserves existing text, images and all execution choices without mutating them', () => {
  const existing = image('original'), attached = image('annotated');
  const options = { collaborationMode: 'plan', skills: [{ name: 'review', path: '/skills/review' }] };
  const current = { text: '未发送的草稿', images: [existing], options, model: 'chosen-model', effort: 'high', permission: 'ask', imageCount: 1 };
  const next = appendImageAnnotation(current, '修改右上角按钮', [attached]);
  expect(next).toEqual({ ...current, text: '未发送的草稿\n\n修改右上角按钮', images: [existing, attached], imageCount: 2, missingImages: false });
  expect(current.text).toBe('未发送的草稿'); expect(current.images).toEqual([existing]);
  expect(next.options).toBe(options);
});

test('deduplicates only identical source bytes and enforces the combined image limit', () => {
  const existing = image('same');
  expect(appendImageAnnotation({ text: '', images: [existing] }, '批注', [existing, { ...existing }]).images).toEqual([existing]);
  expect(appendImageAnnotation({ text: '', images: [existing] }, '批注', [{ ...existing, base64: 'new-revision' }]).images).toHaveLength(2);
  const current = { text: '原草稿', images: ['a', 'b', 'c', 'd'].map(image) };
  expect(() => appendImageAnnotation(current, '批注', [image('e')])).toThrow('超过 4 张');
  expect(current.images).toHaveLength(4);
});

test('does not downgrade missing images or an overlong prompt into a text-only draft', () => {
  expect(() => appendImageAnnotation({ text: '原草稿', images: [], missingImages: true }, '批注', [image('a')])).toThrow('缺失的图片');
  expect(() => appendImageAnnotation({ text: '', images: [] }, '批注', [])).toThrow('原图未完整读取');
  expect(() => appendImageAnnotation({ text: '', images: [] }, '批注', [{ ...image('a'), base64: '' }])).toThrow('原图未完整读取');
  const current = { text: 'x'.repeat(40000), images: [] as RemoteImage[] };
  expect(() => appendImageAnnotation(current, '批注', [image('a')])).toThrow('消息过长');
  expect(current.text).toHaveLength(40000); expect(current.images).toEqual([]);
});
