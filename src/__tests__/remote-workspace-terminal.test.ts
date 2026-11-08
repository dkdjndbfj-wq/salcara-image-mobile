import { command } from '../remote/client';
import { captureWorkspaceTerminal, parseTerminalOutput, type WorkspaceTerminal } from '../remote/workspace-terminal';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '11111111-2222-4333-8444-555555555555' }));
jest.mock('../remote/client', () => ({ ...jest.requireActual('../remote/client'), command: jest.fn() }));
let mockState: any, mockCredentials: any, mockScope = '';
const mockListeners = new Set<() => void>();
jest.mock('../remote/store', () => ({ getRemoteState: () => mockState, watchCredentials: () => mockCredentials, remoteDeliveryScope: () => mockScope,
  timelineKey: (device: string, session: string) => `${device}|${session}`, onRemoteChange: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); } }));
const mockCommand = command as jest.Mock;
const selection = { deviceId: 'pc', sessionKey: 'codex:session', agentId: 'codex', surface: 'cli' as const, cwd: 'C:/synthetic/project' };
const terminalId = 'synthetic-terminal-0001';
const empty = { terminalId, cursor: 0, startCursor: 0, dataBase64: '', truncated: false, exited: false, exitCode: 0, nextSequence: 1 };
const terminals: WorkspaceTerminal[] = [];
const create = () => { const terminal = captureWorkspaceTerminal(selection); terminals.push(terminal); return terminal; };
const changed = () => { for (const listener of [...mockListeners]) listener(); };
beforeEach(() => {
  mockCommand.mockReset(); mockListeners.clear(); mockScope = 'station|pc|phone1';
  mockCredentials = { url: 'https://relay.example/salcara-hub', pairToken: 'synthetic-token', deviceId: 'pc' };
  mockState = { devices: [{ deviceId: 'pc', online: true, capabilities: ['workspace.terminal.v1'], projects: [{ path: selection.cwd }] }],
    sessions: { pc: { list: [{ sessionKey: selection.sessionKey, cwd: selection.cwd, controlSurface: 'cli' }] } }, timelines: {}, agents: {} };
  mockCommand.mockImplementation(async (_hub, _device, payload) => payload.type === 'workspace.terminal.input' ? { terminalId, sequence: payload.sequence } : empty);
});
afterEach(() => { for (const terminal of terminals.splice(0)) terminal.dispose(); });

test('output validates binary byte cursors without treating ANSI as plain text', () => {
  expect(parseTerminalOutput({ ...empty, dataBase64: 'G1szMW0=', cursor: 5 }).cursor).toBe(5);
  expect(() => parseTerminalOutput({ ...empty, dataBase64: 'G1szMW0=', cursor: 4 })).toThrow();
  expect(() => parseTerminalOutput({ ...empty, dataBase64: '*bad*' })).toThrow();
  expect(() => parseTerminalOutput(empty, 'another-terminal')).toThrow();
});
test('PTY inputs serialize with monotonically increasing sequences and frozen owner', async () => {
  const terminal = create(); await terminal.open(80, 24);
  await Promise.all([terminal.input('cd src\r'), terminal.input('pwd\r'), terminal.input('\x03')]);
  const calls = mockCommand.mock.calls.filter(call => call[2].type === 'workspace.terminal.input');
  expect(calls.map(call => call[2].sequence)).toEqual([1, 2, 3]);
  expect(calls.map(call => call[2].data)).toEqual(['cd src\r', 'pwd\r', '\x03']);
  expect(calls.every(call => call[1] === 'pc' && call[2].expectedCwd === selection.cwd && call[2].sessionKey === selection.sessionKey)).toBe(true);
  expect(JSON.stringify(calls.map(call => call[2]))).not.toContain('synthetic-token');
});
test('ambiguous input never becomes a new retry and stops subsequent commands', async () => {
  const terminal = create(); await terminal.open(80, 24);
  mockCommand.mockRejectedValueOnce(new Error('connection lost after write'));
  await expect(terminal.input('npm run build\r')).rejects.toThrow('connection lost');
  await expect(terminal.input('next command\r')).rejects.toThrow('输入已暂停');
  expect(mockCommand.mock.calls.filter(call => call[2].type === 'workspace.terminal.input')).toHaveLength(1);
});
test.each(['computer', 'binding', 'offline', 'session', 'project', 'capability'])('PTY cannot follow a changed %s', async change => {
  const terminal = create(); await terminal.open(80, 24);
  if (change === 'computer') mockScope = 'another-computer';
  if (change === 'binding') mockCredentials.pairToken = 'another-generation';
  if (change === 'offline') mockState.devices[0].online = false;
  if (change === 'session') mockState.sessions.pc.list[0].cwd = 'C:/other/project';
  if (change === 'project') mockState.devices[0].projects = [];
  if (change === 'capability') mockState.devices[0].capabilities = [];
  changed();
  await expect(terminal.input('echo not sent\r')).rejects.toMatchObject({ code: 'terminal_scope_changed' });
  await expect(terminal.read(0)).rejects.toMatchObject({ code: 'terminal_scope_changed' });
  expect(mockCommand.mock.calls).toHaveLength(1);
  expect(mockCommand.mock.calls[0][4].aborted).toBe(true);
});
test('dispose explicitly closes the same live terminal and unregisters its listener', async () => {
  const terminal = create(); await terminal.open(80, 24); terminal.dispose();
  expect(mockCommand.mock.calls.at(-1)?.[2]).toMatchObject({ type: 'workspace.terminal.close', terminalId, sessionKey: selection.sessionKey });
  expect(mockListeners.size).toBe(0);
});
test('read rejects duplicate or foreign cursor bytes', async () => {
  const terminal = create(); await terminal.open(80, 24);
  mockCommand.mockResolvedValue({ ...empty, dataBase64: 'YQ==', cursor: 1 });
  await expect(terminal.read(1)).rejects.toThrow('输出顺序无效');
});
