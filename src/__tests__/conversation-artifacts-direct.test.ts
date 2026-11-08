import { createDirectWorkspaceRuntime } from '../remote/direct-workspace';
import { requestDirect } from '../remote/direct-api';
import { command } from '../remote/client';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../remote/client', () => ({ ...jest.requireActual('../remote/client'), command: jest.fn() }));
jest.mock('../remote/direct-api', () => ({ requestDirect: jest.fn() }));
let mockScope = 'binding-1', mockGeneration = 1, mockConnection: any, mockState: any, mockActive: string | null;
const mockListeners = new Set<() => void>();
jest.mock('../remote/direct-pairing', () => ({
  directDeliveryScope: () => mockScope, directConnectionGeneration: () => mockGeneration, getDirectConnectionState: () => mockConnection,
  subscribeDirectConnection: (listener: () => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
jest.mock('../remote/store', () => ({ timelineKey: (device: string, session: string) => `${device}|${session}` }));
const selection = { deviceId: 'pc', sessionKey: 'codex:test', agentId: 'codex', surface: 'cli' as const, expectedCwd: 'C:/project' };
const request = requestDirect as jest.Mock;
const runtime = () => createDirectWorkspaceRuntime(() => mockState, () => mockActive);
beforeEach(() => {
  jest.clearAllMocks(); mockListeners.clear(); mockScope = 'binding-1'; mockGeneration = 1; mockActive = selection.sessionKey;
  mockConnection = { status: 'connected', deviceId: 'pc' };
  mockState = { devices: [{ deviceId: 'pc', online: true, projects: [{ path: selection.expectedCwd }], capabilities: ['workspace.artifacts.v1', 'workspace.artifacts.write.v1'] }],
    sessions: { pc: { list: [{ sessionKey: selection.sessionKey, tool: 'codex', cwd: selection.expectedCwd, controlSurface: 'cli' }] } }, timelines: {},
    agents: { pc: { list: [{ id: 'codex', tool: 'codex', execution: { tool: 'codex', controlSurface: 'cli' }, api: { accountId: 'account-1' } }] } } };
  mockState.timelines['pc|codex:test'] = {session: mockState.sessions.pc.list[0]};
});
test('artifact list uses real Direct RPC owner without Hub fallback', async () => {
  const handle = runtime().captureArtifacts!(selection); request.mockResolvedValue({ artifacts: [] });
  await expect(handle.list()).resolves.toEqual({ artifacts: [] });
  expect(request).toHaveBeenCalledWith({ type: 'workspace.artifacts', action: 'list', sessionKey: selection.sessionKey, controlSurface: 'cli', expectedCwd: selection.expectedCwd });
  expect(command).not.toHaveBeenCalled(); handle.dispose();
});
test.each(['generation', 'session', 'device', 'project', 'api', 'execution'])('Direct artifacts reject changed %s authority', async change => {
  const handle = runtime().captureArtifacts!(selection);
  if (change === 'generation') mockGeneration++;
  if (change === 'session') mockActive = 'codex:other';
  if (change === 'device') mockConnection.deviceId = 'other';
  if (change === 'project') mockState.devices[0].projects = [];
  if (change === 'api') mockState.agents.pc.list[0].api.accountId = 'account-2';
  if (change === 'execution') mockState.agents.pc.list[0].execution = null;
  await expect(handle.list()).rejects.toThrow(); expect(request).not.toHaveBeenCalled(); handle.dispose();
});
test('same-device reconnect discards a delayed artifact response', async () => {
  let resolve!: (value: unknown) => void; request.mockImplementation(() => new Promise(done => { resolve = done; }));
  const handle = runtime().captureArtifacts!(selection), pending = handle.list(); mockGeneration++; resolve({ artifacts: [] });
  await expect(pending).rejects.toThrow(); expect(command).not.toHaveBeenCalled(); handle.dispose();
});
