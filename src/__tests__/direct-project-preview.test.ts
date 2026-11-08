const mockMessages = new Set<(value: unknown) => void>();
const mockSend = jest.fn();
let mockGeneration = 1, mockUuid = 0;
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../remote/client', () => ({ ...jest.requireActual('../remote/client'), command: jest.fn() }));
jest.mock('../remote/store', () => ({ timelineKey: (device: string, session: string) => `${device}|${session}` }));
jest.mock('../remote/direct-pairing', () => ({ directDeliveryScope: () => 'preview-binding', directConnectionGeneration: () => mockGeneration,
  getDirectConnectionState: () => ({ status: 'connected', deviceId: 'pc' }), sendDirectPayload: (frame: unknown) => mockSend(frame),
  subscribeDirectMessages: (listener: (value: unknown) => void) => { mockMessages.add(listener); return () => mockMessages.delete(listener); }, subscribeDirectConnection: () => () => undefined }));
import type { RemoteState } from '../remote/store';
const { createDirectWorkspaceRuntime } = require('../remote/direct-workspace') as typeof import('../remote/direct-workspace');
const { cancelDirectRequests } = require('../remote/direct-api') as typeof import('../remote/direct-api');
const { command } = require('../remote/client') as typeof import('../remote/client');
const selection = { deviceId: 'pc', sessionKey: 'codex:preview', agentId: 'codex', surface: 'cli' as const, cwd: 'C:/project' };
const operationId = '11111111-2222-4333-8444-555555555555';
const revision = 'a'.repeat(64);
const run = { runId: 'preview_run_fixture', operationId, projectPath: 'web', script: 'dev', status: 'running', url: 'http://127.0.0.1:5173', logs: '', cursor: 9, truncated: false };
let state: RemoteState;
beforeEach(() => {
  cancelDirectRequests('reset'); jest.clearAllMocks(); mockGeneration = 1;
  state = { devices: [{ deviceId: 'pc', online: true, projects: [{ path: selection.cwd }], capabilities: ['workspace.project.preview.v1'] }],
    agents: { pc: { list: [{ id: 'codex', tool: 'codex', api: { accountId: 'one' } }] } },
    sessions: { pc: { list: [{ sessionKey: selection.sessionKey, cwd: selection.cwd, controlSurface: 'cli', tool: 'codex' }] } }, timelines: {} } as unknown as RemoteState;
  mockSend.mockImplementation((frame: { requestId: string; command: Record<string, unknown> }) => {
    const result = frame.command.action === 'inspect' ? { projectPath: 'web', manifestRevision: revision, packageName: 'fixture', scripts: [], ready: false, dependenciesInstalled: false }
      : { found: true, run: { ...run, ...(frame.command.action === 'stop' ? { status: 'stopped' } : {}) } };
    queueMicrotask(() => mockMessages.forEach(listener => listener({ type: 'response', requestId: frame.requestId, result })));
  });
});
afterEach(() => cancelDirectRequests('cleanup'));

test('inspect, start, numeric log cursor and stop survive the actual Direct encoder with exact workspace scope', async () => {
  const service = createDirectWorkspaceRuntime(() => state, () => selection.sessionKey).captureProjectPreview!(selection);
  try {
    await service.inspect('web/src/App.tsx');
    await service.start({ projectPath: 'web', script: 'dev', manifestRevision: revision, operationId });
    await service.status({ projectPath: 'web', runId: run.runId, cursor: 9 });
    await service.stop({ projectPath: 'web', runId: run.runId });
    const sent = mockSend.mock.calls.map(([frame]) => frame.command);
    expect(sent.map(value => value.action)).toEqual(['inspect', 'start', 'status', 'stop']);
    expect(sent.every(value => value.type === 'workspace.project.preview' && value.sessionKey === selection.sessionKey && value.controlSurface === 'cli' && value.expectedCwd === selection.cwd)).toBe(true);
    expect(sent[2].cursor).toBe(9); expect(command).not.toHaveBeenCalled();
  } finally { service.dispose(); }
});

test('revoked capabilities and changed API stop a retained preview control before it can dispatch', async () => {
  const service = createDirectWorkspaceRuntime(() => state, () => selection.sessionKey).captureProjectPreview!(selection);
  try {
    state.agents.pc.list[0].api.accountId = 'other';
    await expect(service.inspect('web/src/App.tsx')).rejects.toThrow('API');
    expect(mockSend).not.toHaveBeenCalled();
    state.agents.pc.list[0].api.accountId = 'one'; state.devices[0].capabilities = [];
    await expect(service.inspect('web/src/App.tsx')).rejects.toThrow('授权');
    expect(mockSend).not.toHaveBeenCalled();
  } finally { service.dispose(); }
});

test('a reconnect fences an in-flight start response instead of attaching it to a new connection', async () => {
  let pending: { requestId: string } | undefined;
  mockSend.mockImplementation(frame => { pending = frame; });
  const service = createDirectWorkspaceRuntime(() => state, () => selection.sessionKey).captureProjectPreview!(selection);
  const waiting = service.start({ projectPath: 'web', script: 'dev', manifestRevision: revision, operationId });
  mockGeneration += 1;
  mockMessages.forEach(listener => listener({ type: 'response', requestId: pending!.requestId, result: { found: true, run } }));
  await expect(waiting).rejects.toThrow('变化'); expect(mockSend).toHaveBeenCalledTimes(1); service.dispose();
});
