jest.mock('../storage/database', () => ({ getSetting: async () => null }));
const mockDirectories = new Set<string>();
const mockFiles = new Map<string, Uint8Array>();
const mockDeleted: string[] = [];
const mockCreated: string[] = [];
let mockBytesGate: (() => Promise<void>) | undefined;
let mockMoveGate: ((source: string, destination: string) => Promise<void>) | undefined;

function mockUri(parts: unknown[]): string {
  return parts.map((part) => typeof part === 'string' ? part.replace(/\/$/, '') : String((part as { uri: string }).uri).replace(/\/$/, '')).join('/');
}
function mockMarkDirectory(uri: string) {
  const pieces = uri.split('/');
  for (let i = 3; i <= pieces.length; i += 1) mockDirectories.add(pieces.slice(0, i).join('/'));
}

jest.mock('expo-file-system', () => {
  function Directory(this: { uri: string }, ...parts: unknown[]) {
    this.uri = mockUri(parts);
  }
  Object.defineProperty(Directory.prototype, 'exists', { get() { return mockDirectories.has(this.uri); } });
  Object.defineProperty(Directory.prototype, 'name', { get() { return this.uri.split('/').pop(); } });
  Directory.prototype.list = function () { return [...mockDirectories].filter(path => path.startsWith(this.uri + '/') && !path.slice(this.uri.length + 1).includes('/')).map(path => new (Directory as any)(path)).concat([...mockFiles.keys()].filter(path => path.startsWith(this.uri + '/') && !path.slice(this.uri.length + 1).includes('/')).map(path => new (File as any)({ uri: this.uri }, path.split('/').pop()))); };
  Directory.prototype.create = function () { mockMarkDirectory(this.uri); };
  Directory.prototype.delete = function () {
    mockDeleted.push(this.uri);
    for (const path of [...mockDirectories]) if (path === this.uri || path.startsWith(`${this.uri}/`)) mockDirectories.delete(path);
    for (const path of [...mockFiles.keys()]) if (path.startsWith(`${this.uri}/`)) mockFiles.delete(path);
  };
  function File(this: { uri: string }, parent: { uri: string }, name: string) { this.uri = `${parent.uri}/${name}`; }
  Object.defineProperty(File.prototype, 'exists', { get() { return mockFiles.has(this.uri); } });
  Object.defineProperty(File.prototype, 'size', { get() { return mockFiles.get(this.uri)?.length ?? 0; } });
  Object.defineProperty(File.prototype, 'name', { get() { return this.uri.split('/').pop(); } });
  Object.defineProperty(File.prototype, 'modificationTime', { get() { return Date.now(); } });
  File.prototype.create = function () { mockCreated.push(this.uri); mockFiles.set(this.uri, new Uint8Array()); };
  File.prototype.open = function () { return { writeBytes: (bytes: Uint8Array) => { mockFiles.set(this.uri, new Uint8Array([...(mockFiles.get(this.uri) ?? []), ...bytes])); }, close: () => undefined }; };
  File.prototype.bytes = async function () { const bytes = mockFiles.get(this.uri) ?? new Uint8Array(); await mockBytesGate?.(); return bytes; };
  File.prototype.move = async function (destination: { uri: string }) {
    const bytes = mockFiles.get(this.uri) ?? new Uint8Array(); await mockMoveGate?.(this.uri, destination.uri);
    mockMarkDirectory(destination.uri.slice(0, destination.uri.lastIndexOf('/')));
    mockFiles.set(destination.uri, bytes); mockFiles.delete(this.uri);
  };
  File.prototype.delete = function () { mockFiles.delete(this.uri); };
  return { Directory, File, FileMode: { Truncate: 'truncate' }, Paths: { cache: 'file://cache/' } };
});

import { cachedAttachment, clearCachedAttachments, resetAttachmentCacheForTests } from '../remote/attachment-cache';

const ref = { id: 'att_0123456789abcdef0123456789abcdef', mime: 'image/png', size: 9 } as const;
const page = { id: ref.id, mime: ref.mime, size: 9, offset: 0, nextOffset: 9, complete: true, data: 'iVBORw0KGgoA' };

beforeEach(() => { resetAttachmentCacheForTests(); mockDirectories.clear(); mockFiles.clear(); mockDeleted.length = 0; mockCreated.length = 0; mockBytesGate = undefined; mockMoveGate = undefined; });

test('clearing one credential removes nested session attachment caches only', async () => {
  const read = async () => page;
  await expect(cachedAttachment('credential-a\u0000pc\u0000codex:one', ref, read)).resolves.toContain('salcara-remote-attachments');
  await expect(cachedAttachment('credential-b\u0000pc\u0000codex:one', ref, read)).resolves.toContain('salcara-remote-attachments');
  clearCachedAttachments('credential-a');
  expect(mockDeleted).toHaveLength(1);
  expect(mockDeleted[0]).toContain('salcara-remote-attachments');
  expect([...mockDirectories].some((path) => path.includes('salcara-remote-attachments'))).toBe(true);
  expect([...mockDirectories].some((path) => path === mockDeleted[0] || path.startsWith(`${mockDeleted[0]}/`))).toBe(false);
  clearCachedAttachments('credential-b');
});

test('clearing a credential aborts an in-flight child download', async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = async (_offset: number, signal: AbortSignal) => {
    started(); await gate;
    if (signal.aborted) throw new Error('aborted');
    return page;
  };
  const pending = cachedAttachment('credential-a\u0000pc\u0000codex:one', ref, read);
  await entered;
  clearCachedAttachments('credential-a');
  const revokedDirectory = mockDeleted[0];
  release();
  await expect(pending).rejects.toThrow();
  expect([...mockDirectories].some((path) => path === revokedDirectory || path.startsWith(`${revokedDirectory}/`))).toBe(false);
});

test('late readers cannot recreate a retired credential cache', async () => {
  clearCachedAttachments('credential-a');
  const read = jest.fn(async () => page);
  await expect(cachedAttachment('credential-a\u0000pc\u0000codex:one', ref, read)).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(mockFiles.size).toBe(0);
});

test('revocation during cached bytes read never returns the stale file URI', async () => {
  const scope = 'credential-a\u0000pc\u0000codex:one';
  await cachedAttachment(scope, ref, async () => page);
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  mockBytesGate = async () => { started(); await gate; };
  const read = jest.fn(async () => page);
  const pending = cachedAttachment(scope, ref, read);
  await entered; clearCachedAttachments('credential-a'); release();
  await expect(pending).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(mockFiles.size).toBe(0);
});

test('revocation during native move removes the late final file and never returns its URI', async () => {
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  mockMoveGate = async () => { started(); await gate; };
  const pending = cachedAttachment('credential-a\u0000pc\u0000codex:one', ref, async () => page);
  await entered; clearCachedAttachments('credential-a'); release();
  await expect(pending).rejects.toThrow();
  expect(mockFiles.size).toBe(0);
});

test('lifecycle reset fences a late native move as well as an unpair', async () => {
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  mockMoveGate = async () => { started(); await gate; };
  const pending = cachedAttachment('credential-a\u0000pc\u0000codex:one', ref, async () => page);
  await entered; resetAttachmentCacheForTests(); release();
  await expect(pending).rejects.toThrow();
  expect(mockFiles.size).toBe(0);
});

const scope = 'credential-a\u0000pc\u0000codex:one';
const originalBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const updatedBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const digest = (bytes: Uint8Array) => require('node:crypto').createHash('sha256').update(bytes).digest('hex') as string;
const bytesPage = (bytes: Uint8Array) => ({ ...page, data: Buffer.from(bytes).toString('base64') });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test.each(['different digest', 'metadata upgraded'] as const)('concurrent %s references never share temporary or final paths and a late old result cannot replace the new image', async kind => {
  const oldRef = kind === 'different digest' ? { ...ref, sha256: digest(originalBytes) } : { id: ref.id, mime: ref.mime };
  const newRef = { ...ref, sha256: digest(updatedBytes) };
  const oldEntered = gate(), oldRelease = gate(), newEntered = gate(), newRelease = gate();
  const older = cachedAttachment(scope, oldRef, async () => { oldEntered.release(); await oldRelease.promise; return bytesPage(originalBytes); });
  await oldEntered.promise;
  const newer = cachedAttachment(scope, newRef, async () => { newEntered.release(); await newRelease.promise; return bytesPage(updatedBytes); });
  await newEntered.promise;
  expect(mockCreated).toHaveLength(2); expect(new Set(mockCreated).size).toBe(2);
  expect(mockCreated.every(uri => uri.endsWith('.part'))).toBe(true);
  newRelease.release(); const newUri = await newer;
  oldRelease.release(); const oldUri = await older;
  expect(oldUri).not.toBe(newUri);
  expect(mockFiles.get(newUri)).toEqual(updatedBytes); expect(mockFiles.get(oldUri)).toEqual(originalBytes);
  expect([...mockFiles.keys()].some(uri => uri.endsWith('.part'))).toBe(false);
  const fetch = jest.fn(async () => bytesPage(updatedBytes));
  expect(await cachedAttachment(scope, newRef, fetch)).toBe(newUri); expect(fetch).not.toHaveBeenCalled();
});

test.each(['abort', 'failed move', 'reset'] as const)('same-identity replacement waits for the old native move and cleanup after %s', async stop => {
  const entered = gate(), release = gate(); let moves = 0; let originalTarget = '';
  mockMoveGate = async (_source, destination) => {
    if (++moves !== 1) return;
    originalTarget = destination; entered.release(); await release.promise;
    if (stop === 'failed move') throw new Error('synthetic native move failure');
  };
  const controller = new AbortController();
  const old = cachedAttachment(scope, ref, async () => page, controller.signal).catch(error => error);
  await entered.promise;
  if (stop === 'reset') resetAttachmentCacheForTests(); else controller.abort();
  const fetch = jest.fn(async () => page);
  const current = cachedAttachment(scope, ref, fetch);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled(); expect(moves).toBe(1);
  release.release();
  const uri = await current;
  expect(await old).toBeInstanceOf(Error);
  expect(uri).toBe(originalTarget); expect(mockFiles.get(uri)).toEqual(originalBytes);
  expect(fetch).toHaveBeenCalledTimes(1); expect(moves).toBe(2);
  expect(new Set(mockCreated).size).toBe(2);
  expect([...mockFiles.keys()].filter(path => path.endsWith('.part'))).toHaveLength(0);
});

test('late aborted move cannot delete a completed image with upgraded metadata', async () => {
  const entered = gate(), release = gate(); let moves = 0;
  mockMoveGate = async () => { if (++moves === 1) { entered.release(); await release.promise; } };
  const controller = new AbortController();
  const old = cachedAttachment(scope, { id: ref.id, mime: ref.mime }, async () => page, controller.signal).catch(error => error);
  await entered.promise; controller.abort();
  const current = await cachedAttachment(scope, { ...ref, sha256: digest(updatedBytes) }, async () => bytesPage(updatedBytes));
  release.release(); await old;
  // Drain the old native operation via the same original reference identity.
  await cachedAttachment(scope, { id: ref.id, mime: ref.mime }, async () => page);
  expect(mockFiles.get(current)).toEqual(updatedBytes);
});

test('one cancelled thumbnail consumer does not abort a shared viewer request', async () => {
  const entered = gate(), release = gate(); const controller = new AbortController();
  const fetch = jest.fn(async () => { entered.release(); await release.promise; return page; });
  const thumbnail = cachedAttachment(scope, ref, fetch, controller.signal).catch(error => error);
  await entered.promise;
  const viewer = cachedAttachment(scope, ref, fetch);
  controller.abort(); expect(await thumbnail).toBeInstanceOf(Error);
  release.release(); const uri = await viewer;
  expect(fetch).toHaveBeenCalledTimes(1); expect(mockFiles.get(uri)).toEqual(originalBytes);
});

test('validated legacy id-only files remain readable without downloading or rewriting them', async () => {
  const current = await cachedAttachment(scope, ref, async () => page);
  const legacy = current.replace(/-[a-f0-9]{64}(?=\.png$)/, '');
  expect(legacy).not.toBe(current);
  mockFiles.set(legacy, mockFiles.get(current)!); mockFiles.delete(current);
  const fetch = jest.fn(async () => page); const before = mockCreated.length;
  expect(await cachedAttachment(scope, { ...ref, sha256: digest(originalBytes) }, fetch)).toBe(legacy);
  expect(fetch).not.toHaveBeenCalled(); expect(mockCreated).toHaveLength(before);
  expect(mockFiles.get(legacy)).toEqual(originalBytes);
});

test('a different verified digest downloads to its own path without overwriting an old legacy image', async () => {
  const current = await cachedAttachment(scope, ref, async () => page);
  const legacy = current.replace(/-[a-f0-9]{64}(?=\.png$)/, '');
  mockFiles.set(legacy, originalBytes); mockFiles.delete(current);
  const fetch = jest.fn(async () => bytesPage(updatedBytes));
  const updated = await cachedAttachment(scope, { ...ref, sha256: digest(updatedBytes) }, fetch);
  expect(updated).not.toBe(legacy); expect(fetch).toHaveBeenCalledTimes(1);
  expect(mockFiles.get(updated)).toEqual(updatedBytes); expect(mockFiles.get(legacy)).toEqual(originalBytes);
});

