const mockMessages = new Set<(value: unknown) => void>();
const mockConnections = new Set<() => void>();
const mockSend = jest.fn();
let mockGeneration = 1;
let mockUuid = 0;

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../remote/client', () => ({ ...jest.requireActual('../remote/client'), command: jest.fn() }));
jest.mock('../remote/store', () => ({ timelineKey: (device: string, session: string) => `${device}|${session}` }));
jest.mock('../remote/direct-pairing', () => ({
  directDeliveryScope: () => 'git-binding',
  directConnectionGeneration: () => mockGeneration,
  getDirectConnectionState: () => ({ status: 'connected', deviceId: 'pc' }),
  sendDirectPayload: (frame: unknown) => mockSend(frame),
  subscribeDirectMessages: (listener: (value: unknown) => void) => { mockMessages.add(listener); return () => mockMessages.delete(listener); },
  subscribeDirectConnection: (listener: () => void) => { mockConnections.add(listener); return () => mockConnections.delete(listener); },
}));

import type { RemoteState } from '../remote/store';
import type { WorkspaceGit } from '../remote/workspace-git';
const { createDirectWorkspaceRuntime } = require('../remote/direct-workspace') as typeof import('../remote/direct-workspace');
const { cancelDirectRequests } = require('../remote/direct-api') as typeof import('../remote/direct-api');
const { command } = require('../remote/client') as typeof import('../remote/client');

const selection = { deviceId: 'pc', sessionKey: 'codex:git', agentId: 'codex', surface: 'cli' as const, cwd: 'C:/project' };
const revision = 'a'.repeat(64);
const repository = (path: string) => ({ path, name: path || 'project', id: (path ? 'b' : 'c').repeat(64) });
const gitState = (path: string) => ({ revision, branch: 'main', head: 'd'.repeat(40), upstream: '', files: [], branches: ['main'], worktrees: [], githubCLI: false, repository: repository(path) });
const reply = (requestId: string, result: unknown) => mockMessages.forEach(listener => listener({ type: 'response', requestId, result }));
let state: RemoteState;

beforeEach(() => {
  cancelDirectRequests('test reset');
  jest.clearAllMocks();
  mockSend.mockReset();
  mockGeneration = 1;
  state = {
    devices: [{ deviceId: 'pc', online: true, projects: [{ path: selection.cwd }], capabilities: ['workspace.git.v1', 'workspace.git.review.v1', 'workspace.git.repositories.v1'] }],
    sessions: { pc: { list: [{ sessionKey: selection.sessionKey, cwd: selection.cwd, controlSurface: 'cli' }] } },
    timelines: {},
  } as unknown as RemoteState;
});

test.each(['', 'packages/mobile'])('runtime reads and mutates repository %j through the actual Direct protocol encoder', async repositoryPath => {
  mockSend.mockImplementation((frame: { requestId: string; command: Record<string, string> }) => {
    const request = frame.command;
    const result = request.action === 'repositories' ? { repositories: [repository(repositoryPath)], truncated: false }
      : request.action === 'review' ? { scope: request.reviewScope, ref: '', base: '', state: gitState(repositoryPath), files: [], commits: [] }
      : request.type === 'workspace.git.mutate' ? { action: request.action, state: gitState(repositoryPath) }
      : gitState(repositoryPath);
    queueMicrotask(() => reply(frame.requestId, result));
  });
  const git = createDirectWorkspaceRuntime(() => state, () => selection.sessionKey).captureGit!(selection);
  try {
    const discovery = await git.repositories!();
    const path = discovery.repositories[0].path;
    await expect(git.status(path)).resolves.toEqual(gitState(path));
    await expect(git.review({ repositoryPath: path, reviewScope: 'unstaged' })).resolves.toMatchObject({ state: gitState(path) });
    await expect(git.mutate('stage', revision, { repositoryPath: path, path: 'src/app.ts' })).resolves.toEqual({ state: gitState(path) });
    const commands = mockSend.mock.calls.map(([frame]) => frame.command);
    expect(commands).toHaveLength(4);
    expect(commands[0]).toEqual({ type: 'workspace.git.read', action: 'repositories', sessionKey: selection.sessionKey, controlSurface: 'cli', expectedCwd: selection.cwd });
    expect(commands.slice(1).every(request => request.repositoryPath === repositoryPath)).toBe(true);
    expect(commands.at(-1)).toEqual({ type: 'workspace.git.mutate', action: 'stage', sessionKey: selection.sessionKey, controlSurface: 'cli', expectedCwd: selection.cwd, expectedRevision: revision, repositoryPath, path: 'src/app.ts' });
    expect(command).not.toHaveBeenCalled();
  } finally { git.dispose(); }
});

test('runtime rejects a wrong-repository receipt after successful Direct delivery', async () => {
  mockSend.mockImplementation((frame: { requestId: string }) => queueMicrotask(() => reply(frame.requestId, gitState('packages/other'))));
  const git = createDirectWorkspaceRuntime(() => state, () => selection.sessionKey).captureGit!(selection);
  try {
    await expect(git.status('packages/mobile')).rejects.toThrow('来源不匹配');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
  } finally { git.dispose(); }
});

test('runtime blocks invalid repository paths and revoked capabilities before the Direct socket', async () => {
  const git = createDirectWorkspaceRuntime(() => state, () => selection.sessionKey).captureGit!(selection);
  try {
    await expect(git.status('../outside')).rejects.toThrow('仓库范围');
    state.devices[0].capabilities = ['workspace.git.v1'];
    await expect(git.status('packages/mobile')).rejects.toThrow('尚未开放多仓库');
    expect(mockSend).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  } finally { git.dispose(); }
});

const delayedGitRequests: Array<{ name: string; run: (git: WorkspaceGit) => Promise<unknown>; result: unknown }> = [
  { name: 'repositories', run: git => git.repositories!(), result: { repositories: [repository('packages/mobile')], truncated: false } },
  { name: 'status', run: git => git.status('packages/mobile'), result: gitState('packages/mobile') },
  { name: 'diff', run: git => git.diff('src/app.ts', false, 'packages/mobile'), result: { path: 'src/app.ts', diff: '+new', revision, repository: repository('packages/mobile') } },
  { name: 'staged-diff', run: git => git.diff('src/app.ts', true, 'packages/mobile'), result: { path: 'src/app.ts', diff: '+new', revision, repository: repository('packages/mobile') } },
  { name: 'review', run: git => git.review({ repositoryPath: 'packages/mobile', reviewScope: 'unstaged' }), result: { scope: 'unstaged', ref: '', base: '', state: gitState('packages/mobile'), files: [], commits: [] } },
  { name: 'mutate', run: git => git.mutate('stage', revision, { repositoryPath: 'packages/mobile', path: 'src/app.ts' }), result: { action: 'stage', state: gitState('packages/mobile') } },
];

test.each(delayedGitRequests)('$name retains the Bridge Git budget through the real Direct request timer', async ({ run, result }) => {
  jest.useFakeTimers();
  const git = createDirectWorkspaceRuntime(() => state, () => selection.sessionKey).captureGit!(selection);
  let settled = false;
  const pending = run(git).then(value => { settled = true; return { value }; }, reason => { settled = true; return { reason }; });
  try {
    expect(mockSend).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(99_999);
    expect(settled).toBe(false);
    const frame = mockSend.mock.calls[0][0];
    reply(frame.requestId, result);
    const outcome = await pending;
    expect(outcome).toHaveProperty('value');
    expect(outcome).not.toHaveProperty('reason');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
  } finally {
    git.dispose();
    cancelDirectRequests('test cleanup');
    jest.useRealTimers();
  }
});
