import { createWorkspaceProjectPreview, parseProjectPreviewInspection, parseProjectPreviewResult, type ProjectPreviewRun } from '../remote/workspace-project-preview';
import { appendProjectPreviewLogs, clearProjectPreviewStart, loadProjectPreviewStart, projectPreviewSource, saveProjectPreviewStart } from '../remote/project-preview-state';
const mockSettings = new Map<string, string>();
let mockWriteError = false;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (mockWriteError) throw new Error('disk full'); if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../remote/store', () => ({}));
const input = { projectPath: 'web', script: 'dev', manifestRevision: 'a'.repeat(64), operationId: '11111111-2222-4333-8444-555555555555' };
const run: ProjectPreviewRun = { runId: 'run_fixture_1234', operationId: input.operationId, projectPath: 'web', script: 'dev', status: 'running', url: 'http://127.0.0.1:5173', logs: 'ready\n', cursor: 6, truncated: false };
const inspection = { projectPath: 'web', manifestRevision: input.manifestRevision, packageName: 'fixture', scripts: [{ name: 'dev', command: 'vite', framework: 'vite', supported: true }], ready: true, dependenciesInstalled: true };
beforeEach(() => { mockSettings.clear(); mockWriteError = false; });

test('inspection and reconnection only query while start and stop require explicit calls', async () => {
  const send = jest.fn(async (payload: Record<string, unknown>) => payload.action === 'inspect' ? inspection : { found: true, run });
  const preview = createWorkspaceProjectPreview(send, () => undefined, () => undefined);
  await preview.inspect('web/src/App.tsx'); await preview.status({ projectPath: 'web', operationId: input.operationId, cursor: 0 });
  expect(send.mock.calls.map(([value]) => value.action)).toEqual(['inspect', 'status']);
  await preview.start(input); await preview.stop({ projectPath: 'web', runId: run.runId });
  expect(send.mock.calls.map(([value]) => value.action)).toEqual(['inspect', 'status', 'start', 'stop']);
});

test('a lost start acknowledgement is never automatically sent again', async () => {
  const send = jest.fn(async () => { throw new Error('response lost'); });
  const preview = createWorkspaceProjectPreview(send, () => undefined, () => undefined);
  await expect(preview.start(input)).rejects.toThrow('response lost');
  expect(send).toHaveBeenCalledTimes(1);
});

test.each([
  { projectPath: 'other' }, { operationId: 'different_operation' }, { runId: 'different_run_id' }, { url: 'http://192.168.1.8:5173' }, { cursor: 1 },
])('rejects mismatched or unsafe run receipt %j', change => {
  expect(() => parseProjectPreviewResult({ found: true, run: { ...run, ...change } }, { projectPath: 'web', operationId: input.operationId, runId: run.runId, cursor: 6 })).toThrow();
});

test('a changed owner rejects a late response and traversal never reaches the transport', async () => {
  let current = true;
  const send = jest.fn(async () => { current = false; return inspection; });
  const preview = createWorkspaceProjectPreview(send, () => { if (!current) throw new Error('scope changed'); }, () => undefined);
  await expect(preview.inspect('../outside/App.tsx')).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
  await expect(preview.inspect('web/App.tsx')).rejects.toThrow('scope changed');
});

test('package inspection cannot smuggle another project or a remote ready URL', () => {
  expect(() => parseProjectPreviewInspection({ ...inspection, projectPath: '../outside' })).toThrow();
  expect(() => parseProjectPreviewInspection({ ...inspection, run: { ...run, projectPath: 'other' } })).toThrow();
  expect(() => parseProjectPreviewResult({ found: false, run }, input)).toThrow();
  expect(parseProjectPreviewResult({ found: false }, input)).toEqual({ found: false });
});

test('pending start survives a new read, scopes isolate it, and a late acknowledgement cannot clear another operation', async () => {
  await saveProjectPreviewStart('binding/session/project/code', input);
  expect(await loadProjectPreviewStart('binding/session/project/code')).toEqual(input);
  expect(await loadProjectPreviewStart('binding/session/project/work')).toBeUndefined();
  await clearProjectPreviewStart('binding/session/project/code', 'unrelated_operation');
  expect(await loadProjectPreviewStart('binding/session/project/code')).toEqual(input);
  await expect(saveProjectPreviewStart('binding/session/project/code', { ...input, operationId: 'another_operation' })).rejects.toThrow('尚未确认');
  await clearProjectPreviewStart('binding/session/project/code', input.operationId);
  expect(await loadProjectPreviewStart('binding/session/project/code')).toBeUndefined();
});

test('storage failure blocks preparation; corrupt recovery records remain intact', async () => {
  mockWriteError = true;
  await expect(saveProjectPreviewStart('scope', input)).rejects.toThrow('disk full');
  mockWriteError = false;
  await saveProjectPreviewStart('scope', input);
  const key = [...mockSettings.keys()][0]; mockSettings.set(key, 'invalid data');
  await expect(loadProjectPreviewStart('scope')).rejects.toThrow('无法读取');
  expect(mockSettings.get(key)).toBe('invalid data');
});

test('incremental logs deduplicate repeated cursors, report truncation, and do not mix different processes', () => {
  expect(appendProjectPreviewLogs(run, { ...run, logs: 'duplicate' }, true).logs).toBe(run.logs);
  expect(appendProjectPreviewLogs(run, { ...run, logs: 'updated\n', cursor: 14 }, true).logs).toBe('ready\nupdated\n');
  expect(appendProjectPreviewLogs(run, { ...run, logs: 'latest', cursor: 40, truncated: true }, true).logs).toContain('[较早日志已截断]');
  expect(appendProjectPreviewLogs(run, { ...run, runId: 'new_process_123', logs: 'new' }, true).logs).toBe('new');
  expect(() => appendProjectPreviewLogs(run, { ...run, cursor: 0 }, true)).toThrow();
});

test('preview entry follows actual source files and never exposes unrelated content as a runnable project', () => {
  expect(['src/App.tsx', 'package.json', 'web/index.html'].every(projectPreviewSource)).toBe(true);
  expect(['../outside.tsx', '/abs/App.tsx', 'image.png', 'notes.md'].some(projectPreviewSource)).toBe(false);
});
