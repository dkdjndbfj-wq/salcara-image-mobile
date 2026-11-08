import React from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { RemoteProjectPreview } from '../remote/RemoteProjectPreview';
import type { ProjectPreviewRun } from '../remote/workspace-project-preview';

const mockSettings = new Map<string, string>();
let mockWriteError = false;
const mockInspect = jest.fn(), mockStart = jest.fn(), mockStatus = jest.fn(), mockStop = jest.fn(), mockDispose = jest.fn();
let mockUuid = 0;
const mockRemote = { devices: [{deviceId:'pc',online:true}], agents: { pc: { list: [{ id: 'codex', api: { accountId: 'local' }, tool: 'codex' }] } } };
const mockRuntime = { scope: 'paired-fixture', remote: mockRemote,
  captureProjectPreview: () => ({ inspect: mockInspect, start: mockStart, status: mockStatus, stop: mockStop, dispose: mockDispose }) };
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string | null) => { if (mockWriteError) throw new Error('disk full'); if (value === null) mockSettings.delete(key); else mockSettings.set(key, value); } }));
jest.mock('../remote/WorkspaceRuntimeContext', () => ({ useWorkspaceRuntime: () => mockRuntime }));
jest.mock('../remote/store', () => ({ useRemote: () => mockRemote, remoteDeliveryScope: () => 'unused-hub' }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `11111111-2222-4333-8444-${String(++mockUuid).padStart(12, '0')}` }));
jest.mock('../remote/RemoteBrowserPage', () => ({ RemoteBrowserPage: ({ target, active }: { target: {url:string}; active: boolean }) => {
  const React = require('react'), { Text } = require('react-native');
  return React.createElement(Text, { testID: 'actual-computer-preview', accessibilityState: { disabled: !active } }, target.url);
} }));
const selection = { deviceId: 'pc', sessionKey: 'codex:project', agentId: 'codex', surface: 'cli' as const, cwd: 'C:/project' };
const inspection = { projectPath: 'web', packageName: 'Design studio', manifestRevision: 'a'.repeat(64),
  scripts: [{ name: 'dev', command: 'vite', framework: 'vite', supported: true }], ready: true, dependenciesInstalled: true };
const run: ProjectPreviewRun = { projectPath: 'web', script: 'dev', runId: 'running_fixture_1', operationId: '11111111-2222-4333-8444-000000000001',
  status: 'running', url: 'http://127.0.0.1:5173', logs: 'ready\n', cursor: 6, truncated: false };
const props = { selection, sourcePath: 'web/src/App.tsx', active: true };
let foreground: (state: string) => void;
beforeEach(() => {
  jest.clearAllMocks(); jest.useFakeTimers(); mockSettings.clear(); mockWriteError = false; mockUuid = 0; AppState.currentState = 'active'; mockRemote.devices[0].online=true;
  mockInspect.mockResolvedValue(inspection); mockStart.mockResolvedValue({ found: true, run }); mockStatus.mockResolvedValue({ found: true, run });
  mockStop.mockResolvedValue({ found: true, run: { ...run, status: 'stopped' } });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { foreground = listener as (state: string) => void; return { remove: jest.fn() }; });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('opening a source only inspects, explicit start reaches the computer preview, stop is scoped to that run', async () => {
  const view = await render(<RemoteProjectPreview {...props}/>);
  expect(mockInspect).toHaveBeenCalledWith(props.sourcePath); expect(mockStart).not.toHaveBeenCalled();
  await fireEvent.press(view.getByLabelText('启动项目预览'));
  expect(mockStart).toHaveBeenCalledWith(expect.objectContaining({ projectPath: 'web', script: 'dev', manifestRevision: inspection.manifestRevision }));
  expect(view.getByTestId('actual-computer-preview').props.children).toBe(run.url);
  await fireEvent.press(view.getByLabelText('停止项目预览'));
  expect(mockStop).toHaveBeenCalledWith({ projectPath: 'web', runId: run.runId, operationId: run.operationId });
  expect(view.getByText('已停止')).toBeTruthy();
  expect(view.getByTestId('actual-computer-preview')).toBeTruthy();
  await view.unmount();
});

test('a lost start receipt survives remount and queries the original operation without executing twice', async () => {
  mockStart.mockRejectedValueOnce(new Error('connection lost'));
  const view = await render(<RemoteProjectPreview {...props}/>);
  await fireEvent.press(view.getByLabelText('启动项目预览'));
  expect(mockSettings.size).toBe(1);
  await fireEvent.press(view.getByLabelText('启动项目预览')); expect(mockStart).toHaveBeenCalledTimes(1);
  await view.unmount();
  const reopened = await render(<RemoteProjectPreview {...props}/>);
  expect(mockStatus).toHaveBeenCalledWith({ projectPath: 'web', operationId: run.operationId });
  expect(mockStart).toHaveBeenCalledTimes(1); expect(mockSettings.size).toBe(0);
  expect(reopened.getByTestId('actual-computer-preview')).toBeTruthy();
  await reopened.unmount();
});

test('failure to persist the intent prevents sending the start command', async () => {
  const view = await render(<RemoteProjectPreview {...props}/>); mockWriteError = true;
  await fireEvent.press(view.getByLabelText('启动项目预览'));
  expect(mockStart).not.toHaveBeenCalled(); expect(view.getByText('disk full')).toBeTruthy();
  await view.unmount();
});

test('a lost start acknowledgement is automatically reconciled by identity without a second start', async () => {
  mockStart.mockRejectedValueOnce(new Error('lost reply'));
  const view = await render(<RemoteProjectPreview {...props}/>);
  await fireEvent.press(view.getByLabelText('启动项目预览'));
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(mockStatus).toHaveBeenCalledWith({ projectPath: 'web', operationId: run.operationId });
  expect(mockStart).toHaveBeenCalledTimes(1); expect(mockSettings.size).toBe(0);
  expect(view.getByTestId('actual-computer-preview')).toBeTruthy(); await view.unmount();
});

test('a moved source cannot prevent recovery or stopping of an already started process', async () => {
  mockStart.mockRejectedValueOnce(new Error('lost reply'));
  const view = await render(<RemoteProjectPreview {...props}/>);
  await fireEvent.press(view.getByLabelText('启动项目预览')); await view.unmount();
  mockInspect.mockRejectedValueOnce(new Error('source moved'));
  const reopened = await render(<RemoteProjectPreview {...props}/>);
  expect(mockStatus).toHaveBeenCalledWith({ projectPath: 'web', operationId: run.operationId });
  expect(reopened.getByText('source moved')).toBeTruthy();
  await fireEvent.press(reopened.getByLabelText('停止项目预览'));
  expect(mockStop).toHaveBeenCalledWith({ projectPath: 'web', runId: run.runId, operationId: run.operationId });
  expect(mockStart).toHaveBeenCalledTimes(1); await reopened.unmount();
});

test('computer reconnect recaptures the lease and only queries its existing run', async () => {
  mockInspect.mockResolvedValue({ ...inspection, run });
  const view = await render(<RemoteProjectPreview {...props}/>);
  mockRemote.devices[0].online=false; await view.rerender(<RemoteProjectPreview {...props}/>);
  await act(async () => { jest.advanceTimersByTime(60000); }); expect(mockStatus).not.toHaveBeenCalled();
  mockRemote.devices[0].online=true; await view.rerender(<RemoteProjectPreview {...props}/>);
  expect(mockInspect).toHaveBeenCalledTimes(2); expect(mockStart).not.toHaveBeenCalled();
  expect(reopenedPreview(view)).toBe(true); await view.unmount();
});

function reopenedPreview(view: Awaited<ReturnType<typeof render>>) { return !view.getByTestId('actual-computer-preview').props.accessibilityState.disabled; }

test('real project output and its failure can be selected into the current draft without running another command',async()=>{
 mockInspect.mockResolvedValue({...inspection,run:{...run,status:'failed',logs:'compiler output\n',error:'Build failed'}});
 const compose=jest.fn((_text:string)=>true),view=await render(<RemoteProjectPreview {...props} onCompose={compose}/>);
 await fireEvent.press(view.getByLabelText('展开项目日志'));
 expect(view.getByText('compiler output')).toBeTruthy();
 await fireEvent.press(view.getByLabelText('将日志 process:error 加入对话'));
 expect(compose).toHaveBeenCalledWith(expect.stringContaining('[error] Build failed'));
 expect(mockStart).not.toHaveBeenCalled();expect(mockStop).not.toHaveBeenCalled();
 await view.rerender(<RemoteProjectPreview {...props} active={false} onCompose={compose}/>);await fireEvent.press(view.getByLabelText('将日志 process:error 加入对话'));
 expect(compose).toHaveBeenCalledTimes(1);
});

test('background stops status reads and foreground recovers the existing process without starting it', async () => {
  mockInspect.mockResolvedValue({ ...inspection, run });
  const view = await render(<RemoteProjectPreview {...props}/>);
  await act(async () => { jest.advanceTimersByTime(2000); }); expect(mockStatus).toHaveBeenCalledTimes(1);
  await act(async () => { AppState.currentState = 'background'; foreground('background'); });
  await act(async () => { jest.advanceTimersByTime(60000); }); expect(mockStatus).toHaveBeenCalledTimes(1);
  await act(async () => { AppState.currentState = 'active'; foreground('active'); });
  expect(mockInspect).toHaveBeenCalledTimes(2); expect(mockStart).not.toHaveBeenCalled();
  await view.unmount();
});

test('disconnect and failed status preserve the last preview while hiding controls for other sources', async () => {
  mockInspect.mockResolvedValue({ ...inspection, run });
  mockStatus.mockRejectedValueOnce(new Error('phone offline'));
  const view = await render(<RemoteProjectPreview {...props}/>);
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(view.getByText('phone offline')).toBeTruthy(); expect(view.getByTestId('actual-computer-preview')).toBeTruthy();
  mockInspect.mockResolvedValueOnce({ ...inspection, run: undefined });
  await view.rerender(<RemoteProjectPreview {...props} sourcePath="other/App.tsx"/>);
  expect(view.queryByTestId('actual-computer-preview')).toBeNull(); expect(mockStart).not.toHaveBeenCalled();
  await view.unmount();
});

test('missing dependencies show the concrete reason and never start on inspection or click', async () => {
  mockInspect.mockResolvedValue({ ...inspection, ready: false, dependenciesInstalled: false, reason: '请先在电脑安装项目依赖' });
  const view = await render(<RemoteProjectPreview {...props}/>);
  expect(view.getByText('请先在电脑安装项目依赖')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('启动项目预览')); expect(mockStart).not.toHaveBeenCalled();
  await view.unmount();
});
