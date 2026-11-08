import { toolCodeCanvasWidth } from '../remote/tool-detail-layout';

test('command canvas horizontal extent reaches the end of long lines without a viewport multiplier cap', () => {
  const viewport = 516;
  const width = toolCodeCanvasWidth('x'.repeat(400), viewport);
  expect(width).toBeGreaterThan(viewport * 3);
  expect(width).toBeGreaterThan(400 * 7);
});

test('command canvas accounts for full-width source characters and keeps short content at the viewport edge', () => {
  expect(toolCodeCanvasWidth('中'.repeat(20), 100)).toBeGreaterThanOrEqual(260);
  expect(toolCodeCanvasWidth('short command', 516)).toBe(516);
});
