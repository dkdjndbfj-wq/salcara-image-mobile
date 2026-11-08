import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { TemporarySideChat } from '../remote/TemporarySideChat';
import { resetTemporarySideChatsForTests, temporarySideChatSession, type TemporarySideChatTransport } from '../remote/temporary-side-chat';
import type { ModelCatalog } from '../remote/client';
import type { RemoteImage } from '../remote/attachment-chunks';
import type { SideQuestionReading, SideQuestionResult } from '../remote/side-question';

const mockWrite = jest.fn(), mockPick = jest.fn();
jest.mock('../storage/database', () => ({ getSetting: jest.fn(), setSetting: (...args: unknown[]) => mockWrite(...args) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => jest.requireActual('node:crypto').randomUUID() }));
jest.mock('../remote/attachments', () => ({ pickRemoteImages: (...args: unknown[]) => mockPick(...args) }));
jest.mock('../components/MessageContent', () => ({ MessageContent: ({ text }: { text: string }) => {
  const { Text } = require('react-native'); return <Text>{text}</Text>;
} }));

const key = 'codex:parent';
const reading: SideQuestionReading = { scope: 'source-a', value: {
  sessionKey: key, revision: 'snapshot-1', available: true, contextScope: 'loadedSnapshot', contextMessages: 2, contextTruncated: false,
  inputOptions: { version: 1, model: true, effort: true, images: true, readOnly: true, defaultModel: 'model-a' },
} };
const catalog: ModelCatalog = { models: ['model-a'] };
const picture: RemoteImage = { uri: 'data:image/png;base64,YQ==', base64: 'YQ==', mime: 'image/png', width: 1, height: 1 };
const result = (operationId: string): SideQuestionResult => ({ sessionKey: key, operationId, state: 'completed', answer: '临时回答',
  contextScope: 'loadedSnapshot', contextMessages: 2, contextTruncated: false });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function transport(): TemporarySideChatTransport {
  return { isCurrent: () => true, read: jest.fn(async () => reading), ask: jest.fn(async (_, _input, id) => result(id)),
    models: jest.fn(async () => catalog), uploadImages: jest.fn(async () => ['att_11111111222243338444555555555555']) };
}
beforeEach(() => { resetTemporarySideChatsForTests(); jest.clearAllMocks(); mockPick.mockResolvedValue([]); });

test('switching API scope during a model request allows the new source to load its own models', async () => {
  const first = transport(), next = transport(), pending = deferred<ModelCatalog>();
  first.models = jest.fn(() => pending.promise);
  const view = await render(<TemporarySideChat visible scopeKey="api-one" sessionKey={key} transport={first}/>);
  await fireEvent.press(view.getByLabelText('临时聊天模型'));
  expect(first.models).toHaveBeenCalledTimes(1);
  await view.rerender(<TemporarySideChat visible scopeKey="api-two" sessionKey={key} transport={next}/>);
  await act(async () => pending.resolve({ models: ['old-model'] }));
  await fireEvent.press(view.getByLabelText('临时聊天模型'));
  expect(next.models).toHaveBeenCalledTimes(1);
  expect(temporarySideChatSession('api-two', key).snapshot().models?.models).toEqual(['model-a']);
  expect(temporarySideChatSession('api-one', key).snapshot().models).toBeUndefined();
  await view.unmount();
});

test('reopening the model menu reuses its catalog while explicit refresh requests fresh models', async () => {
  const owner = transport(), session = temporarySideChatSession('model-cache', key);
  const view = await render(<TemporarySideChat visible scopeKey="model-cache" sessionKey={key} transport={owner}/>);
  for (let open = 0; open < 2; open++) {
    await fireEvent.press(view.getByLabelText('临时聊天模型'));
    expect(view.getByLabelText('model-a')).toBeTruthy();
    await fireEvent.press(view.getByLabelText('关闭模型选择'));
  }
  expect(owner.models).toHaveBeenCalledTimes(1);
  (owner.models as jest.Mock).mockResolvedValueOnce({ models: ['model-a', 'model-b'] });
  await fireEvent.press(view.getByLabelText('临时聊天模型'));
  await fireEvent.press(view.getByLabelText('刷新模型列表'));
  expect(owner.models).toHaveBeenCalledTimes(2);
  expect(owner.models).toHaveBeenLastCalledWith(true);
  expect(session.snapshot().models?.models).toEqual(['model-a', 'model-b']);
  expect(view.getByLabelText('model-b')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('关闭模型选择'));
  await fireEvent.press(view.getByLabelText('临时聊天模型'));
  expect(owner.models).toHaveBeenCalledTimes(2);
  await view.unmount();
});

test('repeated menu taps after a failed preload share one model request', async () => {
  const owner = transport(), pending = deferred<ModelCatalog>(), session = temporarySideChatSession('model-retry', key);
  owner.models = jest.fn().mockRejectedValueOnce(new Error('目录暂时不可用')).mockImplementation(() => pending.promise);
  const view = await render(<TemporarySideChat visible scopeKey="model-retry" sessionKey={key} transport={owner}/>);
  expect(owner.models).toHaveBeenCalledTimes(1);
  expect(session.snapshot().error).toBe('目录暂时不可用');
  const button = view.getByLabelText('临时聊天模型');
  await act(async () => { await fireEvent.press(button); await fireEvent.press(button); });
  expect(owner.models).toHaveBeenCalledTimes(2);
  expect(view.getByLabelText('刷新模型列表').props.accessibilityState.disabled).toBe(true);
  await act(async () => pending.resolve(catalog));
  expect(session.snapshot()).toMatchObject({ models: catalog, error: '' });
  expect(view.getByLabelText('刷新模型列表').props.accessibilityState.disabled).toBe(false);
  await view.unmount();
});

test('switching API scope while selecting a picture does not leave the new composer busy', async () => {
  const first = transport(), next = transport(), pending = deferred<RemoteImage[]>();
  mockPick.mockReturnValueOnce(pending.promise);
  const view = await render(<TemporarySideChat visible scopeKey="api-one" sessionKey={key} transport={first}/>);
  await fireEvent.press(view.getByLabelText('临时聊天添加附件'));
  await fireEvent.press(view.getByLabelText('选择图片'));
  expect(mockPick).toHaveBeenCalledTimes(1);
  await view.rerender(<TemporarySideChat visible scopeKey="api-two" sessionKey={key} transport={next}/>);
  await act(async () => pending.resolve([picture]));
  expect(temporarySideChatSession('api-two', key).snapshot().images).toHaveLength(0);
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '新来源的问题');
  await fireEvent.press(view.getByLabelText('发送临时聊天'));
  expect(next.ask).toHaveBeenCalledTimes(1);
  expect(first.ask).not.toHaveBeenCalled();
  await view.unmount();
});

test('changing source during image upload preserves the draft without dispatching inference', async () => {
  const owner = transport(), pending = deferred<string[]>(), session = temporarySideChatSession('upload', key);
  let current = true; owner.isCurrent = () => current; owner.uploadImages = jest.fn(() => pending.promise);
  await session.read(owner); session.update({ draft: '图片问题', images: [picture] });
  const flight = session.send(owner); current = false;
  pending.resolve(['att_11111111222243338444555555555555']); await flight;
  expect(owner.ask).not.toHaveBeenCalled();
  expect(session.snapshot()).toMatchObject({ phase: 'ready', draft: '图片问题', images: [picture], turns: [] });
  expect(mockWrite).not.toHaveBeenCalled();
});

test('closing and restoring a tab while its question is running never duplicates that request', async () => {
  const owner = transport(), pending = deferred<SideQuestionResult>();
  owner.ask = jest.fn((_reading, _input, id) => pending.promise.then(() => result(id)));
  let view = await render(<TemporarySideChat visible scopeKey="restore" sessionKey={key} transport={owner}/>);
  await fireEvent.changeText(view.getByLabelText('临时侧边聊天输入'), '正在进行的问题');
  await fireEvent.press(view.getByLabelText('发送临时聊天')); await view.unmount();
  view = await render(<TemporarySideChat visible scopeKey="restore" sessionKey={key} transport={owner}/>);
  expect(owner.ask).toHaveBeenCalledTimes(1);
  await fireEvent.press(view.getByLabelText('发送临时聊天'));
  expect(owner.ask).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(result('unused')));
  expect(view.getByText('临时回答')).toBeTruthy();
  expect(mockWrite).not.toHaveBeenCalled(); await view.unmount();
});

test('a stale capability response cannot authorize a question from another source', async () => {
  const owner = transport(), pending = deferred<SideQuestionReading>();
  let current = true; owner.isCurrent = () => current; owner.read = jest.fn(() => pending.promise);
  const old = temporarySideChatSession('old', key), flight = old.read(owner);
  current = false; const next = temporarySideChatSession('new', key);
  pending.resolve(reading); await flight;
  expect(old.snapshot().reading).toBeUndefined(); expect(old.snapshot().phase).toBe('unavailable');
  expect(next.snapshot()).toMatchObject({ phase: 'idle', turns: [] });
  expect(mockWrite).not.toHaveBeenCalled();
});
