import { normalizeRatio, sizeFor, sizeNote, sizeRuleFor } from '../image-sizes';

const check = (size: string) => {
  const [w, h] = size.split('x').map(Number);
  expect(w % 16 === 0 && h % 16 === 0).toBe(true);
  expect(Math.max(w, h) <= 3840).toBe(true);
  expect(w * h >= 655_360 && w * h <= 8_294_400).toBe(true);
  expect(Math.max(w, h) / Math.min(w, h) <= 3).toBe(true);
};

test('ratios are parsed in every common spelling and clamped to 1:3–3:1', () => {
  expect(normalizeRatio('16:9')).toBe('16:9');
  expect(normalizeRatio('32x18')).toBe('16:9');
  expect(normalizeRatio('4：5')).toBe('4:5');
  expect(normalizeRatio('2.39:1')).toBe('239:100');
  expect(normalizeRatio('1.5')).toBe('3:2');
  expect(normalizeRatio('10:1')).toBe('3:1');
  expect(normalizeRatio('1:9')).toBe('1:3');
  expect(normalizeRatio('自动')).toBe('auto');
  expect(normalizeRatio('宽一点')).toBeNull();
});

test('GPT Image 2 gets any ratio within its pixel rules', () => {
  for (const ratio of ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '4:5', '21:9', '1:2', '3:1', '1:3', '239:100', '7:5']) {
    for (const tier of ['1K', '2K', '4K'] as const) check(sizeFor(ratio as never, tier, 'gpt-image-2'));
  }
  expect(sizeFor('3:1', '4K', 'gpt-image-2')).toBe('3840x1280');
  expect(sizeFor('auto', '2K', 'gpt-image-2')).toBe('auto');
});

test('older models snap to the sizes they accept', () => {
  expect(sizeRuleFor('gpt-image-1.5')).toBe('gpt-presets');
  expect(sizeFor('9:16', '4K', 'gpt-image-1')).toBe('1024x1536');
  expect(sizeFor('21:9', '1K', 'gpt-image-1-mini')).toBe('1536x1024');
  expect(sizeFor('16:9', '2K', 'dall-e-3')).toBe('1792x1024');
  expect(sizeFor('auto', '1K', 'dall-e-3')).toBe('1024x1024');
  expect(sizeNote('3:4', '1K', 'gpt-image-1')).toContain('3 种尺寸');
  const [w, h] = sizeFor('16:9', '2K', 'doubao-seedream-4-0').split('x').map(Number);
  expect(w % 64 === 0 && h % 64 === 0 && w > h).toBe(true);
});
