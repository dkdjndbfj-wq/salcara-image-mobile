const mockDeleted: string[] = [];
jest.mock('expo-file-system', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 8, 27);
  // Plain fields (no TS parameter properties): babel-plugin-jest-hoist rejects
  // the identifiers those compile to as out-of-scope references.
  class File {
    uri: string;
    modificationTime: number | null;
    constructor(path: string, modified: number | null = null) {
      this.uri = path;
      this.modificationTime = modified;
    }
    get exists() { return true; }
    delete() { mockDeleted.push(this.uri); }
  }
  const listings: Record<string, unknown[]> = {
    'generated-images': [new File('file:///docs/generated-images/old-used.png', NOW - 3 * DAY), new File('file:///docs/generated-images/old-orphan.png', NOW - 3 * DAY)],
    'reference-images': [new File('file:///docs/reference-images/draft.png', NOW - 60_000), new File('file:///docs/reference-images/mask%20a.png', NOW - 5 * DAY)],
    'reference-documents': [new File('file:///docs/reference-documents/report.pdf', null)],
  };
  class Directory {
    name: string;
    constructor(_base: unknown, folder: string) { this.name = folder; }
    get exists() { return true; }
    create() {}
    list() { return listings[this.name] ?? []; }
  }
  return { File, Directory, Paths: { document: 'file:///docs/', cache: 'file:///cache/' } };
});
jest.mock('expo-media-library', () => ({}));
jest.mock('expo-sharing', () => ({}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

import { sweepUnreferencedFiles } from '../storage/files';

const NOW = Date.UTC(2026, 8, 27);

test('removes only old files that no message refers to', () => {
  const removed = sweepUnreferencedFiles(new Set(['old-used.png', 'mask a.png']), NOW);
  expect(mockDeleted).toEqual(['file:///docs/generated-images/old-orphan.png']);
  expect(removed).toBe(1);
  // Recent drafts, referenced files (even URL-encoded names) and files of unknown age are kept.
});
