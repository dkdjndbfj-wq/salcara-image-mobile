import { compareVersions, formatBytes, normalizeVersion } from '../update';

describe('app updates', () => {
  test('normalizes release tags', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('1.2.3+12')).toBe('1.2.3');
  });

  test('compares numeric versions without lexical mistakes', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v1.1', '1.1.0')).toBe(0);
    expect(compareVersions('1.0.9', '1.1.0')).toBe(-1);
  });

  test('formats update package sizes', () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
    expect(formatBytes(0)).toBe('未知大小');
  });
});
