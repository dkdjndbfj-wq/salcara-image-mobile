import { command } from '../remote/client';
import {
  captureWorkspaceFiles, captureProjectWorkspaceFiles, parseWorkspaceFilesPage, parseWorkspaceFileText, workspaceRelativePath,
  WORKSPACE_FILE_BYTES, type WorkspaceFileReader,
} from '../remote/workspace-files';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }));
jest.mock('../remote/client', () => ({ ...jest.requireActual('../remote/client'), command: jest.fn() }));
let mockState: any;
let mockCredentials: any;
let mockScope = '';
const mockListeners = new Set<() => void>();
jest.mock('../remote/store', () => ({
  getRemoteState: () => mockState,
  watchCredentials: () => mockCredentials,
  remoteDeliveryScope: () => mockScope,
  timelineKey: (device: string, session: string) => `${device}|${session}`,
  onRemoteChange: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));

const mockCommand = command as jest.Mock;
const selection = { deviceId: 'pc', sessionKey: 'codex:original', agentId: 'codex', surface: 'cli' as const };
const readers: WorkspaceFileReader[] = [];
const textReply = { path: 'src/app.ts', text: '你好\n', size: 7, modifiedAt: 1000 };
function reader(surface: 'cli' | 'desktop' = 'cli', callback?: () => void) {
  const result = captureWorkspaceFiles({ ...selection, surface }, callback); readers.push(result); return result;
}
function changed() { for (const listener of [...mockListeners]) listener(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

beforeEach(() => {
  mockCommand.mockReset(); mockListeners.clear(); mockScope = 'synthetic-A|pair-generation';
  mockCredentials = { url: 'https://relay.example/salcara-hub', pairToken: 'synthetic-phone-token', deviceId: 'pc' };
  const session = { sessionKey: selection.sessionKey, cwd: 'C:/synthetic/project', controlSurface: 'cli' };
  mockState = {
    devices: [{ deviceId: 'pc', online: true, capabilities: ['workspace.files.v1'] }],
    sessions: { pc: { list: [session], native: { list: [{ ...session, controlSurface: 'desktop' }] } } },
    timelines: {},
    agents: { pc: { list: [{ id: 'codex', desktopLive: { expiresAt: Date.now() + 60_000, sessionKeys: [selection.sessionKey], capabilities: { list: true, read: true } } }] } },
  };
});
afterEach(() => { for (const item of readers.splice(0)) item.dispose(); });

test.each(['src/app.ts', '目录/文件.ts', 'dir with spaces/app.ts', 'README.md'])('relative workspace path accepts literal source names: %s', value => {
  expect(workspaceRelativePath(value)).toBe(true);
});
test.each(['', '../file.ts', 'a/../file.ts', '/absolute.ts', 'C:/file.ts', 'a\\file.ts', 'a//file.ts', 'a/./file.ts', '.env', 'a/.git/file.ts', 'a.ts:stream', 'a?x.ts', 'a.ts ', 'a./b.ts', 'a\u202efile.ts', 'a\u0001file.ts'])('relative workspace path rejects traversal or ambiguous names: %s', value => {
  expect(workspaceRelativePath(value)).toBe(false);
});
test('root and length/type validation remain explicit', () => {
  expect(workspaceRelativePath('', true)).toBe(true);
  expect(workspaceRelativePath(null, true)).toBe(false);
  expect(workspaceRelativePath('a'.repeat(256))).toBe(false);
  expect(workspaceRelativePath(Array(8).fill('a'.repeat(200)).join('/'))).toBe(false);
});

test('directory parser returns only bounded relative entries and public fields', () => {
  expect(parseWorkspaceFilesPage({ path: 'src', entries: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file', size: 10, private: 'ignored' }], nextCursor: 'eyJ2IjoxfQ', truncated: true }, 'src'))
    .toEqual({ path: 'src', entries: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file', size: 10 }], nextCursor: 'eyJ2IjoxfQ', truncated: true });
  expect(parseWorkspaceFilesPage({ path: '', entries: [] }, '')).toEqual({ path: '', entries: [], truncated: false });
});
test.each([
  null, [], { path: 'other', entries: [] }, { path: '', entries: Array(51).fill({ name: 'x.ts', path: 'x.ts', kind: 'file' }) },
  { path: '', entries: [{ name: 'x.ts', path: '../x.ts', kind: 'file' }] },
  { path: '', entries: [{ name: 'a/b.ts', path: 'a/b.ts', kind: 'file' }] },
  { path: '', entries: [{ name: 'x.ts', path: 'x.ts', kind: 'file', size: WORKSPACE_FILE_BYTES + 1 }] },
  { path: '', entries: [{ name: 'x.ts', path: 'x.ts', kind: 'file', size: -1 }] },
  { path: '', entries: [{ name: 'x.ts', path: 'x.ts', kind: 'symlink' }] },
  { path: '', entries: [{ name: 'x.ts', path: 'x.ts', kind: 'file' }, { name: 'x.ts', path: 'x.ts', kind: 'file' }] },
  { path: '', entries: [], nextCursor: 'bad+/cursor' }, { path: '', entries: [], nextCursor: 'a'.repeat(513) }, { path: '', entries: [], truncated: 'true' },
])('directory parser rejects malformed/bounded response %#', value => {
  expect(() => parseWorkspaceFilesPage(value, '')).toThrow();
});

test('text parser checks UTF-8 byte length rather than character count', () => {
  expect(parseWorkspaceFileText(textReply, textReply.path)).toEqual(textReply);
  const boundary = { path: 'x.ts', text: 'a'.repeat(WORKSPACE_FILE_BYTES), size: WORKSPACE_FILE_BYTES, modifiedAt: 0 };
  expect(parseWorkspaceFileText(boundary, 'x.ts').size).toBe(WORKSPACE_FILE_BYTES);
});
test.each([
  { ...textReply, path: 'other.ts' }, { ...textReply, size: textReply.text.length }, { ...textReply, size: -1 },
  { ...textReply, text: 'a\u0000b', size: 3 }, { ...textReply, text: 'a\u001bb', size: 3 },
  { ...textReply, text: 'a'.repeat(WORKSPACE_FILE_BYTES + 1), size: WORKSPACE_FILE_BYTES + 1 },
  { ...textReply, modifiedAt: NaN }, { ...textReply, modifiedAt: -1 }, { ...textReply, modifiedAt: 1.5 },
])('text parser rejects binary/partial/foreign response %#', value => { expect(() => parseWorkspaceFileText(value, textReply.path)).toThrow(); });

test('reader freezes exact station/device/session/surface and never sends credentials in command JSON', async () => {
  mockCommand.mockResolvedValue(textReply);
  await expect(reader().read(textReply.path)).resolves.toEqual(textReply);
  expect(mockCommand).toHaveBeenCalledTimes(1);
  const [hub, device, payload, timeout, signal] = mockCommand.mock.calls[0];
  expect(hub).toEqual(mockCredentials); expect(device).toBe('pc'); expect(timeout).toBeUndefined();
  expect(payload).toEqual({ type: 'workspace.files.read', sessionKey: selection.sessionKey, controlSurface: 'cli', expectedCwd: 'C:/synthetic/project', path: textReply.path });
  expect(JSON.stringify(payload)).not.toContain('synthetic-phone-token'); expect(signal).toBeInstanceOf(AbortSignal);
});

test('file save requires write capability and a revision, and confirms the returned full content', async () => {
  const selected = reader(), revision = 'a'.repeat(64);
  await expect(selected.write!(textReply.path, textReply.text, revision)).rejects.toMatchObject({ code: 'workspace_write_unavailable' });
  expect(mockCommand).not.toHaveBeenCalled();
  mockState.devices[0].capabilities.push('workspace.files.write.v1');
  mockCommand.mockResolvedValue({ ...textReply, revision: 'b'.repeat(64) });
  await expect(selected.write!(textReply.path, textReply.text, revision)).resolves.toMatchObject({ revision: 'b'.repeat(64) });
  expect(mockCommand.mock.calls[0][2]).toEqual({ type: 'workspace.files.write', sessionKey: selection.sessionKey, controlSurface: 'cli', expectedCwd: 'C:/synthetic/project', path: textReply.path, text: textReply.text, expectedRevision: revision });
  mockCommand.mockResolvedValue({ ...textReply, revision });
  await expect(selected.write!(textReply.path, 'different', revision)).rejects.toMatchObject({ code: 'workspace_file_save_unconfirmed' });
});

test('a save response cannot survive a device scope change or write capability revocation', async () => {
  mockState.devices[0].capabilities.push('workspace.files.write.v1');
  const selected = reader(), pending = deferred<unknown>(); mockCommand.mockReturnValue(pending.promise);
  const save = selected.write!(textReply.path, textReply.text, 'a'.repeat(64));
  mockScope = 'other-computer'; changed();
  pending.resolve({ ...textReply, revision: 'b'.repeat(64) });
  await expect(save).rejects.toMatchObject({ code: 'workspace_scope_changed' });
  expect(mockCommand.mock.calls[0][4].aborted).toBe(true);
});

test('file lifecycle commands preserve scope, revision and exclusive destination semantics',async()=>{
 const selected=reader(),revision='a'.repeat(64);
 await expect(selected.create!('new.ts','')).rejects.toMatchObject({code:'workspace_manage_unavailable'});
 mockState.devices[0].capabilities.push('workspace.files.manage.v1');
 mockCommand.mockResolvedValueOnce({action:'create',path:'new.ts',file:{path:'new.ts',text:'',size:0,modifiedAt:1,revision}});
 await selected.create!('new.ts','');expect(mockCommand.mock.calls[0][2]).toMatchObject({type:'workspace.files.mutate',action:'create',path:'new.ts',text:'',expectedCwd:'C:/synthetic/project',sessionKey:selection.sessionKey});
 mockCommand.mockResolvedValueOnce({action:'rename',path:'new.ts',destination:'renamed.ts',file:{path:'renamed.ts',text:'',size:0,modifiedAt:1,revision}});
 await selected.rename!('new.ts','renamed.ts',revision);expect(mockCommand.mock.calls[1][2]).toMatchObject({action:'rename',destination:'renamed.ts',expectedRevision:revision});
 await expect(selected.rename!('new.ts','folder/new.ts',revision)).rejects.toThrow('参数');
 mockCommand.mockResolvedValueOnce({action:'delete',path:'renamed.ts'});await selected.remove!('renamed.ts',revision);expect(mockCommand.mock.calls[2][2]).toMatchObject({action:'delete',path:'renamed.ts',expectedRevision:revision});
});
test('a late file create response cannot change another computer scope',async()=>{
 mockState.devices[0].capabilities.push('workspace.files.manage.v1');const selected=reader(),pending=deferred<unknown>();mockCommand.mockReturnValue(pending.promise);
 const response=selected.create!('new.ts','');mockScope='replacement';changed();pending.resolve({action:'create',path:'new.ts',file:{path:'new.ts',text:'',size:0,modifiedAt:1,revision:'a'.repeat(64)}});
 await expect(response).rejects.toMatchObject({code:'workspace_scope_changed'});
});

test.each([
  { expectedCwd: 'C:/synthetic/previous-project' },
  { expectedSessionKey: 'codex:previous-session' },
  { expectedSurface: 'desktop' as const },
])('a hyperlink selection cannot recapture a changed session/root/surface %#', async expectation => {
  const selected = captureWorkspaceFiles({ ...selection, ...expectation }); readers.push(selected);
  await expect(selected.read(textReply.path)).rejects.toThrow('文件授权或连接已变化');
  expect(mockCommand).not.toHaveBeenCalled();
});

test.each(['scope', 'url', 'pairToken', 'offline', 'capability', 'cwd', 'surface', 'removed-session'])('late reply is rejected after %s changes', async mode => {
  const pending = deferred<unknown>(); mockCommand.mockReturnValue(pending.promise);
  const invalidated = jest.fn(), selected = reader('cli', invalidated);
  const response = selected.read(textReply.path);
  if (mode === 'scope') mockScope = 'new-scope';
  if (mode === 'url') mockCredentials = { ...mockCredentials, url: 'https://other.example/salcara-hub' };
  if (mode === 'pairToken') mockCredentials = { ...mockCredentials, pairToken: 'new-synthetic-generation' };
  if (mode === 'offline') mockState.devices[0].online = false;
  if (mode === 'capability') mockState.devices[0].capabilities = [];
  if (mode === 'cwd') mockState.sessions.pc.list[0].cwd = 'C:/different/project';
  if (mode === 'surface') mockState.sessions.pc.list[0].controlSurface = 'read-only';
  if (mode === 'removed-session') mockState.sessions.pc.list = [];
  changed();
  expect(mockCommand.mock.calls[0][4].aborted).toBe(true); expect(invalidated).toHaveBeenCalled();
  pending.resolve(textReply);
  await expect(response).rejects.toMatchObject({ status: 499, code: 'workspace_scope_changed' });
});

test('scope guard also rejects a changed owner without an event notification', async () => {
  const pending = deferred<unknown>(); mockCommand.mockReturnValue(pending.promise);
  const response = reader().read(textReply.path); mockCredentials.pairToken = 'changed-synthetic-owner';
  pending.resolve(textReply); await expect(response).rejects.toMatchObject({ code: 'workspace_scope_changed' });
});

test('invalidation is terminal and notifies once even if old device metadata later recovers', async () => {
  const invalidated = jest.fn(), selected = reader('cli', invalidated);
  mockState.devices[0].online = false; changed(); changed();
  mockState.devices[0].online = true; changed();
  await expect(selected.list()).rejects.toMatchObject({ code: 'workspace_scope_changed' });
  expect(invalidated).toHaveBeenCalledTimes(1); expect(mockCommand).not.toHaveBeenCalled();
  mockCommand.mockResolvedValue({ path: '', entries: [] });
  await expect(reader().list()).resolves.toEqual({ path: '', entries: [], truncated: false });
});

test('capability restored after invalidation requires a fresh reader, never reuses an aborted signal', async () => {
  const selected = reader(); mockState.devices[0].capabilities = []; changed();
  mockState.devices[0].capabilities = ['workspace.files.v1']; changed();
  await expect(selected.read(textReply.path)).rejects.toMatchObject({ code: 'workspace_scope_changed' });
  expect(mockCommand).not.toHaveBeenCalled(); mockCommand.mockResolvedValue(textReply);
  await expect(reader().read(textReply.path)).resolves.toEqual(textReply);
  expect(mockCommand.mock.calls[0][4].aborted).toBe(false);
});

test('dispose cancels IO, unsubscribes and suppresses late reply', async () => {
  const pending = deferred<unknown>(); mockCommand.mockReturnValue(pending.promise);
  const selected = reader(), response = selected.read(textReply.path);
  expect(mockListeners.size).toBe(1); selected.dispose(); selected.dispose();
  expect(mockListeners.size).toBe(0); expect(mockCommand.mock.calls[0][4].aborted).toBe(true);
  pending.resolve(textReply); await expect(response).rejects.toMatchObject({ code: 'workspace_scope_changed' });
});

test('only one operation can be in flight per captured reader, and settled failures release admission', async () => {
  const pending = deferred<unknown>(); mockCommand.mockReturnValueOnce(pending.promise).mockResolvedValue(textReply);
  const selected = reader(), first = selected.read(textReply.path);
  await expect(selected.list()).rejects.toThrow('请稍后'); expect(mockCommand).toHaveBeenCalledTimes(1);
  pending.resolve({ bad: true }); await expect(first).rejects.toThrow();
  await expect(selected.read(textReply.path)).resolves.toEqual(textReply); expect(mockCommand).toHaveBeenCalledTimes(2);
});

test.each(['missing-capability', 'missing-device', 'offline', 'missing-cwd'])('deferred metadata never guesses file support: %s', async mode => {
  if (mode === 'missing-capability') delete mockState.devices[0].capabilities;
  if (mode === 'missing-device') mockState.devices = [];
  if (mode === 'offline') mockState.devices[0].online = false;
  if (mode === 'missing-cwd') mockState.sessions.pc.list[0].cwd = '';
  await expect(reader().list()).rejects.toMatchObject({ code: 'workspace_scope_changed' }); expect(mockCommand).not.toHaveBeenCalled();
});

test.each(['missing', 'expired', 'wrong-session', 'no-list', 'no-read'])('native file reader requires current exact lease: %s', async mode => {
  const profile = mockState.agents.pc.list[0];
  if (mode === 'missing') delete profile.desktopLive;
  if (mode === 'expired') profile.desktopLive.expiresAt = Date.now() - 1;
  if (mode === 'wrong-session') profile.desktopLive.sessionKeys = ['codex:other'];
  if (mode === 'no-list') profile.desktopLive.capabilities.list = false;
  if (mode === 'no-read') profile.desktopLive.capabilities.read = false;
  await expect(reader('desktop').list()).rejects.toMatchObject({ code: 'workspace_scope_changed' }); expect(mockCommand).not.toHaveBeenCalled();
});

test('native read sends desktop surface, and lease expiry fences a late result even without change event', async () => {
  const pending = deferred<unknown>(); mockCommand.mockReturnValue(pending.promise);
  const response = reader('desktop').read(textReply.path);
  expect(mockCommand.mock.calls[0][2].controlSurface).toBe('desktop');
  mockState.agents.pc.list[0].desktopLive.expiresAt = Date.now() - 1;
  pending.resolve(textReply); await expect(response).rejects.toMatchObject({ code: 'workspace_scope_changed' });
});

function projectReader(callback?: () => void) {
  const result = captureProjectWorkspaceFiles({ deviceId: 'pc', tool: 'codex', cwd: 'C:/synthetic/project' }, callback);
  readers.push(result); return result;
}
function enableProjectFiles() {
  mockState.devices[0].capabilities.push('workspace.project.files.v1');
  mockState.devices[0].projects = [{ path: 'C:/synthetic/project' }];
  mockState.sessions = {}; mockState.timelines = {};
}
test('first-task files use the saved project without inventing or creating a native session', async () => {
  enableProjectFiles(); mockCommand.mockResolvedValue(textReply);
  await expect(projectReader().read(textReply.path)).resolves.toEqual(textReply);
  expect(mockCommand.mock.calls[0][2]).toEqual({ type: 'workspace.project.files.read', tool: 'codex', cwd: 'C:/synthetic/project', expectedCwd: 'C:/synthetic/project', controlSurface: 'cli', path: textReply.path });
  expect(mockCommand.mock.calls[0][2]).not.toHaveProperty('sessionKey');
});
test.each(['project-removed', 'capability', 'offline', 'scope', 'pairToken'])('first-task read rejects a late reply after %s', async mode => {
  enableProjectFiles(); const pending = deferred<unknown>(); mockCommand.mockReturnValue(pending.promise);
  const invalidated = jest.fn(), selected = projectReader(invalidated), response = selected.read(textReply.path);
  if (mode === 'project-removed') mockState.devices[0].projects = [];
  if (mode === 'capability') mockState.devices[0].capabilities = ['workspace.files.v1'];
  if (mode === 'offline') mockState.devices[0].online = false;
  if (mode === 'scope') mockScope = 'another-station';
  if (mode === 'pairToken') mockCredentials.pairToken = 'new-generation';
  changed(); expect(mockCommand.mock.calls[0][4].aborted).toBe(true); expect(invalidated).toHaveBeenCalledTimes(1);
  pending.resolve(textReply); await expect(response).rejects.toMatchObject({ code: 'workspace_scope_changed' });
});
test('first-task reader rejects an unconfigured project before sending any command', async () => {
  enableProjectFiles(); mockState.devices[0].projects = [{ path: 'C:/different/project' }];
  await expect(projectReader().list()).rejects.toMatchObject({ code: 'workspace_scope_changed' }); expect(mockCommand).not.toHaveBeenCalled();
});
