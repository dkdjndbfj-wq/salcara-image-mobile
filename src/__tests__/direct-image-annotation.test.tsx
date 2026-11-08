import React, { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { DirectComposer } from '../remote/DirectComposer';
import type { DirectDraftInput } from '../remote/direct-composer-drafts';
import type { DirectSessionServices } from '../remote/direct-session-services';
import type { AgentProfile, ModelCatalog, SessionInfo } from '../remote/client';
import type { WorkspaceRuntime } from '../remote/WorkspaceRuntimeContext';
import type { ImageAnnotationAppender } from '../remote/image-annotation-draft';
import type { RemoteImage } from '../remote/attachment-chunks';

const mockRestore = jest.fn(), mockSave = jest.fn(), mockConsume = jest.fn(), mockClose = jest.fn();
jest.mock('../remote/direct-composer-drafts', () => ({ createDirectComposerDraft: (_pairing: string, _device: string, owner: string) => ({
  restore: () => mockRestore(owner), save: (value: DirectDraftInput) => mockSave(owner, value), consume: mockConsume,
  hydrate: async (value: DirectDraftInput) => value.images, close: () => mockClose(owner),
}) }));
jest.mock('../remote/attachments', () => ({ pickRemoteImages: jest.fn() }));
jest.mock('../remote/ContextBar', () => ({ ContextBar: require('react').forwardRef(() => null) }));
jest.mock('../remote/ContextReferencePicker', () => ({ ContextReferencePicker: () => null }));

const image = (id: string): RemoteImage => ({ uri: `file:///cache/${id}.png`, base64: `bytes-${id}`, mime: 'image/png', width: 800, height: 500 });
const imageA = image('existing'), imageB = image('annotation');
const initial = (): DirectDraftInput => ({ text: '已有草稿', images: [imageA], imageCount: 1, options: { collaborationMode: 'plan' }, model: 'model-a', effort: 'high', permission: 'ask' });
const snapshot = (value: DirectDraftInput) => ({ ...value, images: value.images.map(row => ({ ...row })), revision: 1, identity: 'saved' });
const profile: AgentProfile = { id: 'codex', tool: 'codex', name: 'Codex', available: true, remoteSendSupported: true,
  api: { accountId: 'api', model: 'model-a', name: 'Computer API', protocol: 'openai', configured: true, pending: false, source: 'computer' },
  capabilities: { list: true, read: true, send: true, interrupt: true, approval: true, questions: true, subagents: true, attachments: true,
    imageInput: true, imageOutput: true, modelOverride: true, features: true, permissionModes: ['ask'] } };
const session: SessionInfo = { sessionKey: 'codex:main', tool: 'codex', client: 'Codex', title: 'Task', cwd: '/project', status: 'idle', controllable: true, updatedAt: 1 };
const runtime = { scope: 'binding', remote: { agents: { pc: { autoAll: false } }, devices: [], sessions: { pc: { list: [] } } } } as unknown as WorkspaceRuntime;
const send = jest.fn(), upload = jest.fn();
let annotation: React.MutableRefObject<ImageAnnotationAppender | undefined>, services: DirectSessionServices, modelCatalog: ModelCatalog;
function Harness({ owner = services, selectedProfile = profile }: { owner?: DirectSessionServices; selectedProfile?: AgentProfile }) {
  const [text, setText] = useState('已有草稿'); const latest = useRef(text); latest.current = text;
  useEffect(() => { if (owner.scope !== 'scope-a') setText('新电脑草稿'); }, [owner.scope]);
  return <View><Pressable accessibilityLabel="外部追加文字" onPress={() => setText('用户后来输入的内容')}><Text>更新</Text></Pressable>
    <DirectComposer services={owner} runtime={runtime} deviceId="pc" profile={selectedProfile} session={session} timeline={{ items: [], loading: false }} tablet text={text}
      onText={setText} getLatestText={() => latest.current} sending={false} canSend uncertain={false} onSend={send} onStop={jest.fn()} onReferenceConsumed={jest.fn()} imageAnnotationRef={annotation} />
  </View>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const ready = async () => { await act(async () => {}); expect(annotation.current).toBeDefined(); };
async function append(text = '请调整原图', images: readonly RemoteImage[] = [imageB]) { let result!: boolean; await act(async () => { result = await annotation.current!(text, images); }); return result; }

beforeEach(() => {
  jest.clearAllMocks(); annotation = { current: undefined };
  modelCatalog = { models: ['model-a'], modelCapabilities: { 'model-a': { source: 'codex-model-list', reasoningKnown: true, reasoningEfforts: ['high'], inputModalities: ['text', 'image'] } } };
  services = { scope: 'scope-a', models: jest.fn(async () => modelCatalog), features: jest.fn(async () => ({ collaborationModes: ['default', 'plan'], skills: [], skillsSupported: true })),
    guard: jest.fn(), isCurrent: () => true, context: {}, sideQuestions: {}, uploadImages: upload } as unknown as DirectSessionServices;
  mockRestore.mockImplementation(async (owner: string) => owner === 'scope-a' ? snapshot(initial()) : undefined);
  mockSave.mockImplementation(async (_owner: string, value: DirectDraftInput) => snapshot(value));
  mockConsume.mockResolvedValue(true); send.mockResolvedValue(true);
});

test('persists annotation text and original images with existing choices before displaying them, without sending', async () => {
  const pending = deferred<ReturnType<typeof snapshot>>(); const view = await render(<Harness />); await ready();
  mockSave.mockImplementationOnce(() => pending.promise);
  let result!: Promise<boolean>; await act(async () => { result = annotation.current!('请调整原图', [imageB]); });
  const input = view.getByLabelText('给电脑上的 Agent 发消息'); expect(input.props.value).toBe('已有草稿');
  const saved = mockSave.mock.calls.find(([, value]) => value.text.includes('请调整原图'))?.[1] as DirectDraftInput;
  expect(saved).toMatchObject({ ...initial(), text: '已有草稿\n\n请调整原图', images: [imageA, imageB], imageCount: 2 });
  await act(async () => pending.resolve(snapshot(saved))); await expect(result).resolves.toBe(true);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('已有草稿\n\n请调整原图');
  expect(view.getAllByLabelText(/^移除待发送图片 \d+$/)).toHaveLength(2);
  expect(send).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled(); expect(mockConsume).not.toHaveBeenCalled();
  await view.unmount();
});

test.each(['agent', 'model'] as const)('rejects an image-incompatible %s before persisting', async kind => {
  if (kind === 'model') modelCatalog.modelCapabilities!['model-a'].inputModalities = ['text'];
  const selectedProfile = kind === 'agent' ? { ...profile, capabilities: { ...profile.capabilities!, imageInput: false } } : profile;
  const view = await render(<Harness selectedProfile={selectedProfile} />); await ready();
  await expect(append()).rejects.toThrow('不支持图片输入');
  expect(mockSave.mock.calls.some(([, value]) => value.text.includes('请调整原图'))).toBe(false);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('已有草稿'); expect(send).not.toHaveBeenCalled(); await view.unmount();
});

test('combined image limit and failed durable save leave the original composer untouched', async () => {
  mockRestore.mockResolvedValueOnce(snapshot({ ...initial(), images: ['a', 'b', 'c', 'd'].map(image), imageCount: 4 }));
  const view = await render(<Harness />); await ready();
  await expect(append()).rejects.toThrow('超过 4 张');
  expect(view.getAllByLabelText(/^移除待发送图片 \d+$/)).toHaveLength(4);
  await view.unmount();
  const second = await render(<Harness />); await ready();
  mockSave.mockRejectedValueOnce(new Error('保存失败'));
  await expect(append()).rejects.toThrow('保存失败');
  expect(second.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('已有草稿');
  expect(second.getAllByLabelText(/^移除待发送图片 \d+$/)).toHaveLength(1); expect(send).not.toHaveBeenCalled();
  await second.unmount();
});

test('a draft edited during save wins and the annotation remains available for retry', async () => {
  const pending = deferred<ReturnType<typeof snapshot>>(), view = await render(<Harness />); await ready();
  mockSave.mockImplementationOnce(() => pending.promise);
  let result!: Promise<boolean>; await act(async () => { result = annotation.current!('请调整原图', [imageB]); });
  const observed = result.catch(reason => reason);
  await fireEvent.press(view.getByLabelText('外部追加文字'));
  await act(async () => pending.resolve(snapshot({ ...initial(), text: '已有草稿\n\n请调整原图', images: [imageA, imageB] })));
  expect((await observed).message).toContain('草稿已变化');
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('用户后来输入的内容');
  expect(view.getAllByLabelText(/^移除待发送图片 \d+$/)).toHaveLength(1);
  expect(mockSave).toHaveBeenLastCalledWith('scope-a', expect.objectContaining({ text: '用户后来输入的内容', images: [imageA] }));
  expect(send).not.toHaveBeenCalled(); await view.unmount();
});

test('switching source invalidates old append callbacks and a pending append cannot lock the new composer', async () => {
  const pending = deferred<ReturnType<typeof snapshot>>(), nextPending = deferred<ReturnType<typeof snapshot>>(), view = await render(<Harness />); await ready();
  const old = annotation.current!;
  mockSave.mockImplementationOnce(() => pending.promise);
  let result!: Promise<boolean>; await act(async () => { result = old('旧电脑批注', [imageB]); });
  services = { ...services, scope: 'scope-b' };
  await view.rerender(<Harness owner={services} />); await ready();
  expect(view.queryAllByLabelText(/^移除待发送图片 \d+$/)).toHaveLength(0);
  mockSave.mockImplementationOnce(() => nextPending.promise);
  let nextResult!: Promise<boolean>; await act(async () => { nextResult = annotation.current!('新电脑批注', [imageB]); });
  const nextSaved = mockSave.mock.calls.find(([owner, value]) => owner === 'scope-b' && value.text.includes('新电脑批注'))?.[1] as DirectDraftInput;
  expect(nextSaved).toMatchObject({ text: '新电脑草稿\n\n新电脑批注', images: [imageB], options: {}, model: '', effort: '', permission: '' });
  await act(async () => pending.resolve(snapshot({ ...initial(), text: '旧电脑批注', images: [imageB] })));
  await expect(result).resolves.toBe(false);
  await expect(old('迟到的批注', [imageB])).resolves.toBe(false);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('新电脑草稿');
  expect(await append('保存期间的重复批注')).toBe(false);
  await act(async () => nextPending.resolve(snapshot(nextSaved))); await expect(nextResult).resolves.toBe(true);
  expect(view.getByLabelText('给电脑上的 Agent 发消息').props.value).toBe('新电脑草稿\n\n新电脑批注');
  expect(view.getAllByLabelText(/^移除待发送图片 \d+$/)).toHaveLength(1);
  expect(mockSave).toHaveBeenLastCalledWith('scope-b', expect.objectContaining({ text: '新电脑草稿\n\n新电脑批注' }));
  expect(send).not.toHaveBeenCalled(); await view.unmount(); expect(annotation.current).toBeUndefined();
});
