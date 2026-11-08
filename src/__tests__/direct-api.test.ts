const mockMessages = new Set<(value: unknown) => void>();
const mockStates = new Set<() => void>();
let mockUuid = 0;
let mockDirectState: { status: 'idle' | 'connecting' | 'authenticating' | 'connected' | 'closed' | 'error'; deviceId?: string; error?: string } = { status: 'connected', deviceId: 'pc-1' };
const mockSendDirectPayload = jest.fn();

jest.mock('../remote/direct-pairing', () => ({
  getDirectConnectionState: () => mockDirectState,
  sendDirectPayload: (payload: unknown) => mockSendDirectPayload(payload),
  subscribeDirectMessages: (listener: (value: unknown) => void) => { mockMessages.add(listener); return () => mockMessages.delete(listener); },
  subscribeDirectConnection: (listener: () => void) => { mockStates.add(listener); return () => mockStates.delete(listener); },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, '0')}` }));

import type { Command } from '../remote/client';
import type { ComputerManagementCommand } from '../remote/direct-computer-management';
import { workspaceCommands } from './fixtures/workspace-commands';
const { cancelDirectRequests, DirectApiError, requestDirect, subscribeDirectEvents } = require('../remote/direct-api') as typeof import('../remote/direct-api');

function deliver(value: unknown) { mockMessages.forEach(listener => listener(value)); }
function changeState(next: typeof mockDirectState) { mockDirectState = next; mockStates.forEach(listener => listener()); }
function sentFrames(): Array<{ type: string; requestId: string; command: Command }> { return mockSendDirectPayload.mock.calls.map(([frame]) => frame as never); }

beforeEach(() => {
  jest.useRealTimers();
  cancelDirectRequests('test reset');
  mockDirectState = { status: 'connected', deviceId: 'pc-1' };
  mockSendDirectPayload.mockReset();
});

test('computer management uses only the authenticated direct socket with its exact allowlisted fields', async () => {
  const commands: ComputerManagementCommand[] = [
    { type: 'computer.management.status', controlSurface: 'cli' },
    { type: 'computer.api.create', controlSurface: 'cli', requestId: 'create-request-0001', name: 'Fixture', baseUrl: 'https://example.invalid/v1', key: 'synthetic-key', wire: 'chat', authMode: 'bearer', models: ['fixture'] },
    { type: 'computer.agent.install', controlSurface: 'cli', requestId: 'install-request-0001', tool: 'codex', confirmed: true },
  ];
  for (const command of commands) {
    const request = requestDirect(command);
    const frame = sentFrames().at(-1)!;
    expect(frame.command).toEqual(command);
    deliver({ type: 'response', requestId: frame.requestId, result: { ok: true } });
    await expect(request).resolves.toEqual({ ok: true });
  }
  expect(mockSendDirectPayload).toHaveBeenCalledTimes(3);
});

test.each([
  { type: 'computer.management.status', controlSurface: 'desktop' },
  { type: 'computer.management.status', controlSurface: 'cli', key: 'must-not-send' },
  { type: 'computer.agent.install', controlSurface: 'cli', requestId: 'install-request-0001', tool: 'codex', confirmed: false },
  { type: 'computer.agent.install', controlSurface: 'cli', requestId: 'short', tool: 'codex', confirmed: true },
  { type: 'computer.agent.install', controlSurface: 'cli', requestId: 'install-request-0001', tool: 'codex', confirmed: true, command: 'arbitrary-shell' },
])('rejects unsafe management request before direct delivery', async command => {
  await expect(requestDirect(command as ComputerManagementCommand)).rejects.toMatchObject({ code: 'protocol' });
  expect(mockSendDirectPayload).not.toHaveBeenCalled();
});

test.each(workspaceCommands)('$type preserves the exact workspace and binary/input fields over paired direct transport', async cmd => {
  const request = requestDirect(cmd);
  const [frame] = sentFrames();
  expect(frame.command).toEqual(cmd);
  deliver({ type: 'response', requestId: frame.requestId, result: { delivered: true } });
  await expect(request).resolves.toEqual({ delivered: true });
});

test.each(['', 'packages/mobile'])('preserves repository scope %j for Git reads and mutations over Direct', async repositoryPath => {
  const scope = { sessionKey: 'codex:workspace', controlSurface: 'cli' as const, expectedCwd: 'C:/workspace', repositoryPath };
  const commands: Command[] = [
    { ...scope, type: 'workspace.git.read', action: 'status' },
    { ...scope, type: 'workspace.git.read', action: 'diff', path: 'src/app.ts' },
    { ...scope, type: 'workspace.git.read', action: 'review', reviewScope: 'unstaged' },
    { ...scope, type: 'workspace.git.mutate', action: 'stage', path: 'src/app.ts', expectedRevision: 'a'.repeat(64) },
    { ...scope, type: 'workspace.git.mutate', action: 'review-apply', reviewScope: 'unstaged', path: 'src/app.ts', expectedRevision: 'a'.repeat(64), patchRevision: 'b'.repeat(64), hunk: 'c'.repeat(64), operation: 'stage' },
  ];
  mockSendDirectPayload.mockImplementation((frame: { requestId: string }) => {
    queueMicrotask(() => deliver({ type: 'response', requestId: frame.requestId, result: { delivered: true } }));
  });
  for (const command of commands) {
    await expect(requestDirect(command)).resolves.toEqual({ delivered: true });
    expect(sentFrames().at(-1)?.command).toEqual(command);
  }
  expect(mockSendDirectPayload).toHaveBeenCalledTimes(commands.length);
});

test.each([null, 42, true, ['packages/mobile'], { path: 'packages/mobile' }])('rejects non-string repository scope %j before Direct delivery', async repositoryPath => {
  for (const type of ['workspace.git.read', 'workspace.git.mutate']) {
    const command = { type, sessionKey: 'codex:workspace', controlSurface: 'cli', expectedCwd: 'C:/workspace', action: type.endsWith('read') ? 'status' : 'stage', ...(type.endsWith('mutate') ? { expectedRevision: 'a'.repeat(64) } : {}), repositoryPath };
    await expect(requestDirect(command as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  }
  expect(mockSendDirectPayload).not.toHaveBeenCalled();
});

test('keeps repository fields exclusive to Git commands and still rejects unknown Git fields', async () => {
  await expect(requestDirect({ type: 'agents.status', repositoryPath: 'packages/mobile' } as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  await expect(requestDirect({ type: 'workspace.git.read', sessionKey: 'codex:workspace', controlSurface: 'cli', expectedCwd: 'C:/workspace', action: 'status', repositoryPath: 'packages/mobile', repositoryRoot: 'C:/outside' } as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  expect(mockSendDirectPayload).not.toHaveBeenCalled();
});

test.each(workspaceCommands)('$type requires explicit session and cwd before direct delivery', async cmd => {
  const missingSession = { ...cmd } as Record<string, unknown>; delete missingSession.sessionKey;
  const missingCwd = { ...cmd } as Record<string, unknown>; delete missingCwd.expectedCwd;
  await expect(requestDirect(missingSession as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  await expect(requestDirect(missingCwd as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  expect(mockSendDirectPayload).not.toHaveBeenCalled();
});

test('terminal binary cursors cannot be smuggled as strings over direct transport', async () => {
  await expect(requestDirect({ type: 'workspace.terminal.read', sessionKey: 'codex:workspace', controlSurface: 'cli', expectedCwd: 'C:/workspace', terminalId: 'terminal-0000001', cursor: '0' } as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  expect(mockSendDirectPayload).not.toHaveBeenCalled();
});

test('paged skills preserve the typed sync version on direct transport', async () => {
  const command:Command={type:'features.list',tool:'codex',controlSurface:'cli',sessionKey:'codex:session',syncVersion:1,pageSize:100};
  const request=requestDirect(command),[frame]=sentFrames();expect(frame.command).toEqual(command);
  deliver({type:'response',requestId:frame.requestId,result:{skills:[]}});await expect(request).resolves.toEqual({skills:[]});
});

test.each([
  {type:'session.side-question.catalog',tool:'codex',sessionKey:'codex:session',controlSurface:'cli',accountId:'account-1'},
  {type:'session.side-question.tools',tool:'codex',sessionKey:'codex:session',controlSurface:'cli',action:'open',chainId:'00000000-0000-4000-8000-000000000001',expectedRevision:'snapshot-1',operationId:'00000000-0000-4000-8000-000000000002',permission:'workspace-write'},
  {type:'session.side-question.tools',tool:'codex',sessionKey:'codex:session',controlSurface:'cli',action:'read',chainId:'00000000-0000-4000-8000-000000000001',expectedRevision:'snapshot-1'},
  {type:'session.side-question.tools',tool:'codex',sessionKey:'codex:session',controlSurface:'cli',action:'features',chainId:'00000000-0000-4000-8000-000000000001',expectedRevision:'snapshot-1',operationId:'00000000-0000-4000-8000-000000000002'},
  {type:'session.side-question.tools',tool:'codex',sessionKey:'codex:session',controlSurface:'cli',action:'send',chainId:'00000000-0000-4000-8000-000000000001',expectedRevision:'snapshot-1',operationId:'00000000-0000-4000-8000-000000000002',question:'检查项目',collaborationMode:'plan',skills:[{name:'inspect',path:'C:/project/.agents/skills/inspect/SKILL.md'}]},
  {type:'session.side-question.ask',tool:'codex',sessionKey:'codex:session',controlSurface:'cli',accountId:'account-1',expectedRevision:'snapshot-1',operationId:'00000000-0000-4000-8000-000000000001',question:'Explain',model:'model-a',effort:'high',attachments:['att_00000000000040008000000000000002']},
] as Command[])('$type preserves the temporary side chat fields over the paired direct socket',async command=>{
  const request=requestDirect(command),[frame]=sentFrames();expect(frame.command).toEqual(command);
  deliver({type:'response',requestId:frame.requestId,result:{accepted:true}});await expect(request).resolves.toEqual({accepted:true});
});

test('sends only the direct command envelope and resolves concurrent responses by exact requestId', async () => {
  const first = requestDirect({ type: 'agents.status' });
  const second = requestDirect({ type: 'projects.list' });
  const [firstFrame, secondFrame] = sentFrames();
  expect(firstFrame).toMatchObject({ type: 'command', command: { type: 'agents.status' } });
  expect(secondFrame).toMatchObject({ type: 'command', command: { type: 'projects.list' } });
  expect(firstFrame.requestId).not.toBe(secondFrame.requestId);
  expect(firstFrame.requestId).toMatch(/^[0-9a-f-]{36}$/i);

  deliver({ type: 'response', requestId: 'forged-request-id', result: 'forged' });
  deliver({ type: 'response', requestId: secondFrame.requestId, result: { projects: [] } });
  deliver({ type: 'response', requestId: firstFrame.requestId, result: { agents: [] } });
  deliver({ type: 'response', requestId: firstFrame.requestId, result: { agents: ['duplicate'] } });
  await expect(first).resolves.toEqual({ agents: [] });
  await expect(second).resolves.toEqual({ projects: [] });
  expect(mockSendDirectPayload).toHaveBeenCalledTimes(2);
});

test('rejects unknown command types, extra fields, and missing required fields before sending', async () => {
  await expect(requestDirect({ type: 'unknown.command' } as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  await expect(requestDirect({ type: 'agents.status', hubUrl: 'https://station.invalid' } as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  await expect(requestDirect({ type: 'session.send' } as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  await expect(requestDirect({ type: 'agents.status', refresh: 'yes' } as unknown as Command)).rejects.toMatchObject({ code: 'protocol' });
  await expect(requestDirect({ type: 'remote.station.receipt', operationId: 'operation-1' })).rejects.toMatchObject({ code: 'protocol' });
  expect(mockSendDirectPayload).not.toHaveBeenCalled();
});

test('direct new-session commands require an explicit CLI surface and preserve the response correlation', async () => {
  await expect(requestDirect({ type: 'session.start', tool: 'codex', cwd: 'C:/work', prompt: 'inspect' } as Command))
    .rejects.toMatchObject({ code: 'protocol' });
  expect(mockSendDirectPayload).not.toHaveBeenCalled();

  const request = requestDirect({ type: 'session.start', tool: 'codex', cwd: 'C:/work', prompt: 'inspect', controlSurface: 'cli', operationId: 'operation-1' });
  const [frame] = sentFrames();
  expect(frame.command).toMatchObject({ type: 'session.start', controlSurface: 'cli', operationId: 'operation-1' });
  deliver({ type: 'response', requestId: frame.requestId, result: { sessionKey: 'codex:new-thread' } });
  await expect(request).resolves.toEqual({ sessionKey: 'codex:new-thread' });
});

test.each([
  'frontend.proxy',
  'frontend.input',
  'port.forward',
  'docker.run',
  'workspace.exec',
  'shell.exec',
])('rejects unsupported direct runtime bridge %s before sending', async type => {
  await expect(requestDirect({ type } as unknown as Command)).rejects.toMatchObject({
    name: 'DirectApiError',
    code: 'protocol',
  });
  expect(mockSendDirectPayload).not.toHaveBeenCalled();
});

test('rejects immediately when the direct channel is unavailable and never falls back', async () => {
  changeState({ status: 'closed', deviceId: 'pc-1' });
  await expect(requestDirect({ type: 'agents.status' })).rejects.toMatchObject({ code: 'disconnected' });
  expect(mockSendDirectPayload).not.toHaveBeenCalled();
});

test('connection close or revocation rejects every pending request and ignores late receipts', async () => {
  const first = requestDirect({ type: 'agents.status' });
  const second = requestDirect({ type: 'projects.list' });
  const frames = sentFrames();
  const firstRejected = expect(first).rejects.toMatchObject({ code: 'disconnected' });
  const secondRejected = expect(second).rejects.toMatchObject({ code: 'disconnected' });
  changeState({ status: 'error', deviceId: 'pc-1', error: '配对已撤销' });
  await Promise.all([firstRejected, secondRejected]);
  deliver({ type: 'response', requestId: frames[0].requestId, result: 'late' });
  expect(mockSendDirectPayload).toHaveBeenCalledTimes(2);
});

test('reconnecting to the same computer never replays an unconfirmed mutation', async () => {
  const command: Command = { type: 'session.send', sessionKey: 'codex:thread-1', text: 'one send only', operationId: 'operation-1', controlSurface: 'cli' };
  const inFlight = requestDirect(command);
  const original = sentFrames()[0];
  const rejected = expect(inFlight).rejects.toMatchObject({ code: 'disconnected' });
  changeState({ status: 'closed', deviceId: 'pc-1' });
  changeState({ status: 'connecting', deviceId: 'pc-1' });
  changeState({ status: 'connected', deviceId: 'pc-1' });
  await rejected;
  deliver({ type: 'response', requestId: original.requestId, result: { ok: true } });
  expect(mockSendDirectPayload).toHaveBeenCalledTimes(1);

  const afterReconnect = requestDirect({ type: 'agents.status' });
  expect(mockSendDirectPayload).toHaveBeenCalledTimes(2);
  const current = sentFrames()[1];
  expect(current.command).toEqual({ type: 'agents.status' });
  deliver({ type: 'response', requestId: current.requestId, result: { agents: [] } });
  await expect(afterReconnect).resolves.toEqual({ agents: [] });
  expect(sentFrames().some(frame => frame.requestId !== original.requestId && frame.command.type === 'session.send'
    && frame.command.operationId === 'operation-1')).toBe(false);
});

test('timeout releases its request and ignores a later receipt', async () => {
  jest.useFakeTimers();
  const request = requestDirect({ type: 'agents.status' }, { timeoutMs: 100 });
  const frame = sentFrames()[0];
  const rejected = expect(request).rejects.toMatchObject({ code: 'timeout' });
  jest.advanceTimersByTime(100);
  await rejected;
  deliver({ type: 'response', requestId: frame.requestId, result: 'late' });
  expect(mockSendDirectPayload).toHaveBeenCalledTimes(1);
});

test('maps a desktop response error to a rejected RPC', async () => {
  const request = requestDirect({ type: 'session.open', sessionKey: 'codex:thread-1' });
  const frame = sentFrames()[0];
  deliver({ type: 'response', requestId: frame.requestId, error: '会话已关闭' });
  await expect(request).rejects.toMatchObject({ name: 'DirectApiError', code: 'remote', message: '会话已关闭' });
});

test('a native send failure rejects immediately and retires its pending request', async () => {
  mockSendDirectPayload.mockImplementationOnce(() => { throw new Error('直连已断开'); });
  await expect(requestDirect({ type: 'agents.status' })).rejects.toMatchObject({ code: 'disconnected', message: '直连已断开' });
  expect(mockSendDirectPayload).toHaveBeenCalledTimes(1);
});

test('rejects malformed matching responses and forwards only event envelopes', async () => {
  const events: unknown[] = [];
  const unsubscribe = subscribeDirectEvents(event => events.push(event));
  const request = requestDirect({ type: 'agents.status' });
  const frame = sentFrames()[0];
  deliver({ type: 'event', event: 'timeline', data: { sessionKey: 'codex:thread-1' } });
  deliver({ type: 'event', data: 'missing-name' });
  deliver({ type: 'response', requestId: frame.requestId });
  await expect(request).rejects.toMatchObject({ code: 'protocol' });
  expect(events).toEqual([{ event: 'timeline', data: { sessionKey: 'codex:thread-1' } }]);
  unsubscribe();
});

test('caller cancellation releases pending work', async () => {
  const request = requestDirect({ type: 'agents.status' });
  const rejected = expect(request).rejects.toBeInstanceOf(DirectApiError);
  cancelDirectRequests('用户离开直连会话');
  await rejected;
  expect(() => deliver({ type: 'response', requestId: sentFrames()[0].requestId, result: 'late' })).not.toThrow();
});
