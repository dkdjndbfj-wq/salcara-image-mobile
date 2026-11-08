import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { BlockRow, ThreadUi } from '../remote/thread-rows';
import type { SentUserMessage } from '../remote/sent-message-revision';

const mockToast = jest.fn();
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../components/ui', () => ({ ...jest.requireActual('../components/ui'), showToast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('../remote/SkillComposerInput', () => ({ SkillComposerInput: require('react').forwardRef((props: object, ref: unknown) => require('react').createElement(require('react-native').TextInput, { ...props, ref })) }));
const message: SentUserMessage = { kind: 'message', id: 'user-1', role: 'user', text: 'Original request', final: true, ts: 1 };
const ui = { openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn(), presentation: 'tablet' as const,
  artifactScope: 'computer-a/session-a/api-a', latestEditableMessageId: message.id, onEditMessage: jest.fn(async () => true) };
const row = (context: React.ContextType<typeof ThreadUi> = ui, item = message) => <ThreadUi.Provider value={context}>
  <BlockRow tool="codex" block={{ type: 'user', id: `m:${item.id}`, item }} onOpenChild={jest.fn()}/>
</ThreadUi.Provider>;
beforeEach(() => { mockToast.mockClear(); ui.onEditMessage.mockClear(); });

test('the latest bubble owns inline editing and sends directly without opening a second composer or modal', async () => {
  const view = await render(row());
  await fireEvent.press(view.getByLabelText('编辑最新消息'));
  expect(view.queryByTestId('message-selectable-text')).toBeNull();
  expect(view.queryByLabelText('复制消息')).toBeNull();
  await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'), 'Changed inline');
  await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  expect(ui.onEditMessage).toHaveBeenCalledWith(message, 'Changed inline', expect.any(AbortSignal));
  expect(view.queryByLabelText('编辑最新消息正文')).toBeNull();
  expect(view.getByTestId('message-selectable-text').props.children).toBe('Original request');
});

test('older, pending and delegated user rows never expose the latest-turn edit action', async () => {
  const view = await render(row({ ...ui, latestEditableMessageId: 'newest-id' }));
  expect(view.queryByLabelText('编辑最新消息')).toBeNull();
  for (const extra of [{ local: true }, { final: false }, { parentId: 'child-task' }, { messageOrigin: { type: 'agent' } }]) {
    await view.rerender(row(ui, { ...message, ...extra } as SentUserMessage));
    expect(view.queryByLabelText('编辑最新消息')).toBeNull();
  }
});

test('a running turn explains the disabled action and does not open editing or stop the agent', async () => {
  const view = await render(row({ ...ui, editMessageDisabledReason: '请先停止当前任务' }));
  await fireEvent.press(view.getByLabelText('编辑最新消息'));
  expect(mockToast).toHaveBeenCalledWith('请先停止当前任务', 'alert');
  expect(view.queryByLabelText('编辑最新消息正文')).toBeNull(); expect(ui.onEditMessage).not.toHaveBeenCalled();
});

test('source changes and a newer user message close the inline editor without leaking its text', async () => {
  const view = await render(row());
  await fireEvent.press(view.getByLabelText('编辑最新消息'));
  await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'), 'Private A edit');
  await view.rerender(row({ ...ui, artifactScope: 'computer-b/session-a/api-b' }));
  expect(view.queryByLabelText('编辑最新消息正文')).toBeNull();
  await view.rerender(row());
  expect(view.queryByLabelText('编辑最新消息正文')).toBeNull();
  await fireEvent.press(view.getByLabelText('编辑最新消息'));
  expect(view.getByLabelText('编辑最新消息正文').props.value).toBe('Original request');
  await view.rerender(row({ ...ui, latestEditableMessageId: 'newer-user' }));
  expect(view.queryByLabelText('编辑最新消息正文')).toBeNull(); expect(view.queryByLabelText('编辑最新消息')).toBeNull();
  expect(ui.onEditMessage).not.toHaveBeenCalled();
});

test('an image-only user message has a compact edit action without an empty text bubble', async () => {
  const view = await render(row(ui, { ...message, text: '', images: ['file://image.png'] }));
  expect(view.queryByTestId('remote-user-message-bubble')).toBeNull();
  await fireEvent.press(view.getByLabelText('编辑最新消息'));
  expect(view.getByLabelText('编辑最新消息正文')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('取消编辑最新消息'));
  expect(view.queryByTestId('remote-user-message-bubble')).toBeNull(); expect(ui.onEditMessage).not.toHaveBeenCalled();
});
