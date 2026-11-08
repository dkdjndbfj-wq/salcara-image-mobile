import { attachmentBytes, attachmentMagic, attachmentRef, attachmentRefs } from '../remote/attachment-ref';

const id = 'att_0123456789abcdef0123456789abcdef';

test('attachment metadata is bounded and normalizes the MIME', () => {
  expect(attachmentRef({ id, mime: 'IMAGE/PNG', size: 8 })).toMatchObject({ id, mime: 'image/png', size: 8 });
  expect(attachmentRef({ id: 'att_bad', mime: 'image/png', size: 8 })).toBeNull();
  expect(attachmentRef({ id, mime: 'image/png', size: 0 })).toBeNull();
  expect(attachmentRefs([{ id, mime: 'image/png' }, { id, mime: 'image/png' }])).toHaveLength(1);
});

test('chunk decoder rejects malformed or oversized data and validates image signatures', () => {
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const base64 = Buffer.from(png).toString('base64');
  expect(Array.from(attachmentBytes(base64))).toEqual(Array.from(png));
  expect(attachmentMagic(png, 'image/png')).toBe(true);
  expect(attachmentMagic(png, 'image/jpeg')).toBe(false);
  expect(() => attachmentBytes('not-base64')).toThrow();
});
