import React, { useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { DirectComposer } from '../remote/DirectComposer';
import { createDirectComposerDraft, directDraftKey } from '../remote/direct-composer-drafts';
import type { ComposerDraftRecoveryReceipt } from '../remote/composer-drafts';
import type { DirectSessionServices } from '../remote/direct-session-services';
import type { WorkspaceRuntime } from '../remote/WorkspaceRuntimeContext';
import type { AgentProfile } from '../remote/client';

const mockSettings = new Map<string, string>();
const mockSet = jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); });
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null, setSetting: (key: string, value: string) => mockSet(key, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, value: string) => require('node:crypto').createHash('sha256').update(value).digest('hex') }));
jest.mock('../remote/attachments', () => ({ pickRemoteImages: jest.fn() }));
jest.mock('../remote/ContextBar', () => ({ ContextBar: require('react').forwardRef(() => null) }));
const scope = 'direct-missing-integration', deviceId = 'pc', cwd = 'C:/project', sessionKey = 'codex:missing';
const profile: AgentProfile = { id: 'codex', tool: 'codex', name: 'Codex', available: true, remoteSendSupported: true, api: { accountId: 'api-a', model: 'model-a' } as any };
const runtime = { scope, remote: { devices: [{ deviceId, projects: [{ path: cwd }] }], agents: { pc: { autoAll: false } }, sessions: {} } } as unknown as WorkspaceRuntime;
const sourceOwner = JSON.stringify([scope, deviceId, sessionKey, profile.id, 'api-a', cwd]);
const targetOwner = JSON.stringify([scope, deviceId, null, profile.id, 'api-a', cwd, 'work']);
const send = jest.fn();
const rows = () => JSON.parse(mockSettings.get('remote_composer_drafts_v1') ?? '{}');
const inputLabel = '给电脑上的 Agent 发消息';

function Harness({ missing = true, account = 'api-a' }: { missing?: boolean; account?: string }) {
  const [text, setText] = useState('Unsent work'), [receipt, setReceipt] = useState<ComposerDraftRecoveryReceipt>();
  const [isNew, setNew] = useState(false);
  const owner = JSON.stringify([scope, deviceId, isNew ? null : sessionKey, profile.id, account, cwd, ...(isNew ? ['work'] : [])]);
  const services = useMemo(() => ({ scope: owner, isCurrent: () => true, guard: () => {}, context: {}, models: async () => ({ models: [] }) }) as unknown as DirectSessionServices, [owner]);
  return <DirectComposer key={owner} services={services} runtime={runtime} deviceId={deviceId} profile={{ ...profile, api: { ...profile.api, accountId: account } }}
    session={{ cwd, ...(isNew ? {} : { sessionKey }) }} timeline={{ items: [], loading: false, ...(!isNew && missing ? { readErrorCode: 'session_not_found' as const } : {}) }} workspaceMode="work"
    tablet text={text} onText={setText} sending={false} canSend uncertain={false} onSend={send} onStop={() => {}} onReferenceConsumed={() => {}}
    onRecoverMissingDraft={value => { setReceipt(value); setText(''); setNew(true); }} recoveryReceipt={receipt} onRecoveryUndone={() => setReceipt(undefined)} />;
}

beforeEach(() => { mockSettings.clear(); mockSet.mockReset().mockImplementation(async (key, value) => { mockSettings.set(key, value); }); send.mockReset().mockResolvedValue(true); jest.useFakeTimers(); jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove: jest.fn() })); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

test('confirmed missing Direct chat restores into its same Work project and Undo survives idle autosave without sending', async () => {
  const view = await render(<Harness />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  await act(async () => {});
  expect(view.getByLabelText(inputLabel).props.value).toBe('Unsent work');
  expect(view.getByLabelText('撤销草稿恢复').props.accessibilityState?.disabled).not.toBe(true);
  const targetKey = directDraftKey(scope, deviceId, targetOwner), original = rows()[directDraftKey(scope, deviceId, sourceOwner)], target = rows()[targetKey];
  expect(target.origin).toMatchObject({ mode: 'work', cwd, apiIdentity: 'api-a' });
  expect(target.origin.sessionKey).toBeUndefined();
  await act(async () => { jest.advanceTimersByTime(1000); });
  expect(rows()[targetKey]).toEqual(target);
  await fireEvent.press(view.getByLabelText('撤销草稿恢复'));
  expect(view.getByLabelText(inputLabel).props.value).toBe('');
  expect(rows()[directDraftKey(scope, deviceId, sourceOwner)]).toEqual(original);
  expect(rows()[targetKey].text).toBe('');
  expect(send).not.toHaveBeenCalled();
  await view.unmount();
});

test('later edits disable Undo and persist as a new revision without changing the source draft', async () => {
  const view = await render(<Harness />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  await act(async () => {});
  const source = rows()[directDraftKey(scope, deviceId, sourceOwner)];
  await fireEvent.changeText(view.getByLabelText(inputLabel), 'Later edit');
  await fireEvent.press(view.getByLabelText('撤销草稿恢复'));
  expect(view.getByLabelText(inputLabel).props.value).toBe('Later edit');
  await act(async () => { jest.advanceTimersByTime(400); });
  expect(JSON.parse(rows()[directDraftKey(scope, deviceId, targetOwner)].text).text).toBe('Later edit');
  expect(rows()[directDraftKey(scope, deviceId, sourceOwner)]).toEqual(source);
  expect(send).not.toHaveBeenCalled();
  await view.unmount();
});

test('a different API owner cannot use the old recovery receipt or alter its target', async () => {
  const view = await render(<Harness />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  await act(async () => {});
  const targetKey = directDraftKey(scope, deviceId, targetOwner), target = rows()[targetKey];
  await view.rerender(<Harness account="api-b" />);
  expect(view.queryByLabelText('撤销草稿恢复')).toBeNull();
  expect(rows()[targetKey]).toEqual(target);
  expect(send).not.toHaveBeenCalled();
  await view.unmount();
});

test('a queued native edit during the Undo write is retained and durably saved', async () => {
  const view = await render(<Harness />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  await act(async () => {});
  const targetKey = directDraftKey(scope, deviceId, targetOwner);
  let release: (() => void) | undefined;
  mockSet.mockImplementation(async (key, value) => {
    if (key === 'remote_composer_drafts_v1' && JSON.parse(value)[targetKey]?.consumedFrom) await new Promise<void>(resolve => { release = resolve; });
    mockSettings.set(key, value);
  });
  await fireEvent.press(view.getByLabelText('撤销草稿恢复'));
  await act(async () => {});
  expect(release).toBeDefined();
  await act(async () => view.getByLabelText(inputLabel).props.onChangeText('Native edit arrived late'));
  await act(async () => { release!(); });
  expect(view.getByLabelText(inputLabel).props.value).toBe('Native edit arrived late');
  expect(JSON.parse(rows()[targetKey].text).text).toBe('Native edit arrived late');
  expect(send).not.toHaveBeenCalled();
  await view.unmount();
});

test('ordinary read failure has no recovery action and an existing destination draft is preserved', async () => {
  let view = await render(<Harness missing={false} />);
  expect(view.queryByLabelText('恢复草稿到新对话')).toBeNull();
  await view.unmount();
  const target = createDirectComposerDraft(scope, deviceId, targetOwner); await target.restore();
  await target.save({ text: 'Existing new work', options: {}, model: '', effort: '', permission: '', images: [] }); target.close();
  view = await render(<Harness />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  expect(view.getByLabelText(inputLabel).props.value).toBe('Unsent work');
  expect(view.queryByLabelText('撤销草稿恢复')).toBeNull();
  expect(view.getByText(/已有草稿/)).toBeTruthy();
  expect(JSON.parse(rows()[directDraftKey(scope, deviceId, targetOwner)].text).text).toBe('Existing new work');
  expect(send).not.toHaveBeenCalled();
  await view.unmount();
});

test.each(['api', 'text'] as const)('a source %s change during the final copy write rolls back only the abandoned target copy', async change => {
  const targetKey = directDraftKey(scope, deviceId, targetOwner), sourceKey = directDraftKey(scope, deviceId, sourceOwner);
  let release: (() => void) | undefined, waiting = true;
  mockSet.mockImplementation(async (key, value) => {
    if (waiting && key === 'remote_composer_drafts_v1' && JSON.parse(value)[targetKey]?.text) {
      waiting = false;
      await new Promise<void>(resolve => { release = resolve; });
    }
    mockSettings.set(key, value);
  });
  const view = await render(<Harness />);
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话'));
  await act(async () => {});
  expect(release).toBeDefined();
  if (change === 'api') await view.rerender(<Harness account="api-b" />);
  else await act(async () => view.getByLabelText(inputLabel).props.onChangeText('New edit during copy'));
  await act(async () => { release!(); });
  expect(view.queryByLabelText('撤销草稿恢复')).toBeNull();
  expect(rows()[targetKey].text).toBe('');
  expect(JSON.parse(rows()[sourceKey].text).text).toBe('Unsent work');
  if (change === 'text') {
    expect(view.getByLabelText(inputLabel).props.value).toBe('New edit during copy');
    await act(async () => { jest.advanceTimersByTime(400); });
    expect(JSON.parse(rows()[sourceKey].text).text).toBe('New edit during copy');
  }
  expect(send).not.toHaveBeenCalled();
  await view.unmount();
});
