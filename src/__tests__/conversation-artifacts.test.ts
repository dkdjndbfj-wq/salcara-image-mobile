import { sha256 } from '@noble/hashes/sha2.js';
import { command } from '../remote/client';
import { artifactBase64, artifactEditable, ARTIFACT_CHUNK_BYTES, ARTIFACT_EDIT_MAX_BYTES, ARTIFACT_MAX_BYTES,
  captureConversationArtifacts, createConversationArtifacts, parseArtifactDescriptor, type ArtifactDescriptor, type ConversationArtifacts } from '../remote/conversation-artifacts';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../remote/client', () => ({ ...jest.requireActual('../remote/client'), command: jest.fn() }));
let mockState: any, mockCredentials: any, mockScope = '';
const mockListeners = new Set<() => void>();
jest.mock('../remote/store', () => ({
  getRemoteState: () => mockState, watchCredentials: () => mockCredentials, remoteDeliveryScope: () => mockScope,
  timelineKey: (device: string, session: string) => `${device}|${session}`,
  onRemoteChange: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
const hash = (bytes: Uint8Array) => Array.from(sha256(bytes), b => b.toString(16).padStart(2, '0')).join('');
const encode = (text: string) => new TextEncoder().encode(text);
const descriptor = (path: string, bytes: Uint8Array, kind: ArtifactDescriptor['kind'] = 'text', mime = 'text/plain'): ArtifactDescriptor => ({
  id: `artifact_${hash(encode(path))}`, path, name: path.split('/').pop()!, kind, mime, size: bytes.length, revision: hash(bytes), updatedAt: 1000,
});
const chunk = (artifact: ArtifactDescriptor, bytes: Uint8Array, offset = 0) => ({ artifact, encoding: 'base64',
  content: artifactBase64(bytes.slice(offset, offset + ARTIFACT_CHUNK_BYTES)), offset, nextOffset: Math.min(offset + ARTIFACT_CHUNK_BYTES, bytes.length) });
const selection = { deviceId: 'pc', sessionKey: 'codex:original', agentId: 'codex', surface: 'cli' as const, expectedCwd: 'C:/project' };
const services: ConversationArtifacts[] = [];
const service = (send: jest.Mock, guard = () => {}, writable = true) => {
  const result = createConversationArtifacts(send, guard, jest.fn(), { writable: () => writable }); services.push(result); return result;
};
const captured = () => { const result = captureConversationArtifacts(selection); services.push(result); return result; };
const remote = command as jest.Mock;
beforeEach(() => {
  remote.mockReset(); mockListeners.clear(); mockScope = 'station-one';
  mockCredentials = { url: 'https://relay.example', pairToken: 'private-pair-token', deviceId: 'pc' };
  mockState = { devices: [{ deviceId: 'pc', online: true, projects: [{ path: selection.expectedCwd }], capabilities: ['workspace.artifacts.v1', 'workspace.artifacts.write.v1'] }],
    sessions: { pc: { list: [{ sessionKey: selection.sessionKey, tool: 'codex', cwd: selection.expectedCwd, controlSurface: 'cli' }] } }, timelines: {},
    agents: {pc: {list: [{id: 'codex', tool: 'codex', execution: {tool:'codex', controlSurface:'cli'}, api: {accountId:'account-1'}}]}} };
});
afterEach(() => { for (const item of services.splice(0)) item.dispose(); });

test('reads multi-chunk UTF8 across a character boundary with exact revision and byte integrity', async () => {
  const text = 'a'.repeat(ARTIFACT_CHUNK_BYTES - 1) + '中文' + 'x'.repeat(ARTIFACT_CHUNK_BYTES), bytes = encode(text), artifact = descriptor('result.txt', bytes);
  const send = jest.fn(async (_type, payload) => chunk(artifact, bytes, payload.offset));
  await expect(service(send).read(artifact.path)).resolves.toEqual({ artifact, encoding: 'utf8', content: text });
  expect(send).toHaveBeenCalledTimes(3);
  expect(send.mock.calls[0][1]).not.toHaveProperty('expectedRevision');
  expect(send.mock.calls[1][1]).toMatchObject({ offset: ARTIFACT_CHUNK_BYTES, expectedRevision: artifact.revision });
});
test('binary data survives base64 chunk concatenation including padding', async () => {
  const bytes = Uint8Array.from({ length: ARTIFACT_CHUNK_BYTES + 5 }, (_, index) => index % 256), artifact = descriptor('result.pdf', bytes, 'pdf', 'application/pdf');
  const send = jest.fn(async (_type, payload) => chunk(artifact, bytes, payload.offset));
  const result = await service(send).read(artifact.path);
  expect(result).toEqual({ artifact, encoding: 'base64', content: Buffer.from(bytes).toString('base64') });
});
test('empty file yields one verified empty response', async () => {
  const bytes = encode(''), artifact = descriptor('empty.txt', bytes), send = jest.fn().mockResolvedValue(chunk(artifact, bytes));
  await expect(service(send).read(artifact.path)).resolves.toEqual({ artifact, encoding: 'utf8', content: '' });
  expect(send).toHaveBeenCalledTimes(1);
});
test('UTF8 BOM is preserved so downloaded source and revision remain byte-identical', async () => {
  const text='\ufeffhello',bytes=encode(text),artifact=descriptor('bom.txt',bytes);
  await expect(service(jest.fn().mockResolvedValue(chunk(artifact,bytes))).read(artifact.path)).resolves.toEqual({artifact,encoding:'utf8',content:text});
});
test.each(['revision', 'size', 'path', 'offset', 'nextOffset', 'content', 'encoding'])('rejects a corrupt or foreign %s response', async field => {
  const bytes = encode('hello'), artifact = descriptor('result.txt', bytes), reply: any = chunk(artifact, bytes);
  if (field === 'revision') reply.artifact = { ...artifact, revision: 'a'.repeat(64) };
  if (field === 'size') reply.artifact = { ...artifact, size: ARTIFACT_MAX_BYTES + 1 };
  if (field === 'path') reply.artifact = descriptor('other.txt', bytes);
  if (field === 'offset') reply.offset = 1;
  if (field === 'nextOffset') reply.nextOffset = 0;
  if (field === 'content') reply.content = Buffer.from('wrong').toString('base64');
  if (field === 'encoding') reply.encoding = 'utf8';
  await expect(service(jest.fn().mockResolvedValue(reply)).read(artifact.path)).rejects.toThrow();
});
test('rejects a changed revision between chunks and never exposes partial bytes', async () => {
  const bytes = new Uint8Array(ARTIFACT_CHUNK_BYTES + 1), artifact = descriptor('result.pdf', bytes, 'pdf', 'application/pdf');
  const send = jest.fn(async (_type, payload) => chunk(payload.offset ? { ...artifact, revision: 'a'.repeat(64) } : artifact, bytes, payload.offset));
  await expect(service(send).read(artifact.path)).rejects.toMatchObject({ code: 'artifact_changed' });
});
test('abort during a response prevents further chunks', async () => {
  const controller = new AbortController(), bytes = new Uint8Array(ARTIFACT_CHUNK_BYTES + 1), artifact = descriptor('result.pdf', bytes, 'pdf', 'application/pdf');
  const send = jest.fn(async () => { controller.abort(); return chunk(artifact, bytes); });
  await expect(service(send).read(artifact.path, controller.signal)).rejects.toMatchObject({ code: 'artifact_cancelled' }); expect(send).toHaveBeenCalledTimes(1);
});
test('transport guard is rechecked after every response', async () => {
  let valid = true; const send = jest.fn(async () => { valid = false; return { artifacts: [] }; });
  await expect(service(send, () => { if (!valid) throw new Error('owner changed'); }).list()).rejects.toThrow('owner changed');
});
test('lists bounded explicit artifacts and retains next cursor even on empty history pages', async () => {
  const send = jest.fn().mockResolvedValue({ artifacts: [], nextCursor: 'next_page' });
  await expect(service(send).list()).resolves.toEqual({ artifacts: [], nextCursor: 'next_page' });
  send.mockResolvedValue({ artifacts: [], nextCursor: 'next_page' });
  await expect(service(send).list('next_page')).rejects.toThrow();
});
test('list rejects duplicate paths and wrong descriptor kind', async () => {
  const artifact = descriptor('result.txt', encode('test'));
  await expect(service(jest.fn().mockResolvedValue({ artifacts: [artifact, artifact] })).list()).rejects.toThrow();
  expect(() => parseArtifactDescriptor({ ...artifact, kind: 'html' })).toThrow();
});
test('CAS save sends exact expected revision and only accepts a matching readback', async () => {
  const text = '<svg>中文</svg>', artifact = descriptor('chart.svg', encode(text), 'svg', 'image/svg+xml');
  const send = jest.fn().mockResolvedValue({ artifact, encoding: 'utf8', content: text });
  await expect(service(send).save(artifact.path, text, 'a'.repeat(64))).resolves.toEqual({ artifact, encoding: 'utf8', content: text });
  expect(send).toHaveBeenCalledWith('workspace.artifacts', { action: 'save', path: artifact.path, text, expectedRevision: 'a'.repeat(64) });
  send.mockResolvedValue({ artifact: {...artifact, revision: 'c'.repeat(64)} });
  await expect(service(send).save(artifact.path, text, 'a'.repeat(64))).rejects.toMatchObject({ code: 'artifact_save_unconfirmed' });
});
test('save denies Office binaries, excessive UTF8 bytes and missing write capability', async () => {
  const send = jest.fn(), revision = 'a'.repeat(64);
  await expect(service(send).save('sheet.xlsx', 'text', revision)).rejects.toThrow();
  await expect(service(send).save('notes.txt', '中'.repeat(ARTIFACT_EDIT_MAX_BYTES / 2), revision)).rejects.toThrow();
  await expect(service(send, () => {}, false).save('notes.txt', 'text', revision)).rejects.toThrow();
  expect(send).not.toHaveBeenCalled(); expect(artifactEditable({ path: 'notes.md', size: ARTIFACT_EDIT_MAX_BYTES })).toBe(true);
});
test('Hub transport freezes device/session/project and keeps credentials outside command payload', async () => {
  remote.mockResolvedValue({ artifacts: [] }); await captured().list();
  expect(remote.mock.calls[0][2]).toEqual({ type: 'workspace.artifacts', action: 'list', sessionKey: selection.sessionKey, controlSurface: 'cli', expectedCwd: selection.expectedCwd });
  expect(JSON.stringify(remote.mock.calls[0][2])).not.toContain('private-pair-token');
});
test.each(['scope', 'credential', 'project', 'cwd', 'surface', 'capability', 'agent', 'api', 'execution', 'tool'])('captured Hub service invalidates on %s change', async change => {
  const handle = captured();
  if (change === 'scope') mockScope = 'other';
  if (change === 'credential') mockCredentials.pairToken = 'new';
  if (change === 'project') mockState.devices[0].projects = [];
  if (change === 'cwd') mockState.sessions.pc.list[0].cwd = 'C:/other';
  if (change === 'surface') mockState.sessions.pc.list[0].controlSurface = 'desktop';
  if (change === 'capability') mockState.devices[0].capabilities = [];
  if (change === 'agent') mockState.agents.pc.list = [];
  if (change === 'api') mockState.agents.pc.list[0].api.accountId = 'account-2';
  if (change === 'execution') mockState.agents.pc.list[0].execution = null;
  if (change === 'tool') mockState.sessions.pc.list[0].tool = 'claude';
  for (const listener of mockListeners) listener();
  await expect(handle.list()).rejects.toMatchObject({ code: 'workspace_scope_changed' }); expect(remote).not.toHaveBeenCalled();
});
test('late Hub file bytes are discarded after a station change', async () => {
  let resolve!: (value: unknown) => void; remote.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = captured().read('result.txt'), bytes = encode('private'), artifact = descriptor('result.txt', bytes);
  mockScope = 'other-station'; for (const listener of mockListeners) listener(); resolve(chunk(artifact, bytes));
  await expect(pending).rejects.toMatchObject({ code: 'workspace_scope_changed' }); expect(remote.mock.calls[0][4].aborted).toBe(true);
});
