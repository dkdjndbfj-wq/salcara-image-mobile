import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { InlineSentMessageEditor } from '../remote/InlineSentMessageEditor';
import type { SentMessageRevisionHandler, SentUserMessage } from '../remote/sent-message-revision';
import { joinPastedText } from '../remote/pasted-text';

jest.mock('../theme', () => ({ useDesk: () => ({ text: '#222', muted: '#888', line: '#ddd', surface2: '#eee', warn: '#a50' }) }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ Sheet: ({ visible, children }: any) => visible ? children : null }));
jest.mock('../components/MotionPressable', () => ({ MotionPressable: (props: object) => require('react').createElement(require('react-native').Pressable, props) }));
jest.mock('../remote/ConversationMotion', () => ({ WorkbenchReveal: ({ children }: any) => children }));
jest.mock('../remote/SkillComposerInput', () => ({ SkillComposerInput: require('react').forwardRef((props: object, ref: unknown) => require('react').createElement(require('react-native').TextInput, { ...props, ref })) }));
const original = (changes: Partial<SentUserMessage> = {}): SentUserMessage => ({ kind: 'message', id: 'sent-1', role: 'user', text: 'Original request', final: true, ts: 1, ...changes });
const handler = (fn: SentMessageRevisionHandler = async () => true) => jest.fn(fn);
type Props = React.ComponentProps<typeof InlineSentMessageEditor>;
async function mount(changes: Partial<Props> = {}) {
  const props: Props = { message: original(), scopeKey: 'pc-a/session/api', onSubmit: handler(), onClose: jest.fn(), ...changes };
  const view = await render(<InlineSentMessageEditor {...props}/>); return { view, props };
}

test('inline edit submits its text directly, preserves the original and closes only after acceptance', async () => {
  const message = original(), snapshot = JSON.stringify(message), { view, props } = await mount({ message });
  expect(view.getByText(/已进行的文件更改会保留/)).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'), 'Revised request');
  await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  expect(props.onSubmit).toHaveBeenCalledWith(message, 'Revised request', expect.any(AbortSignal));
  expect(props.onClose).toHaveBeenCalledTimes(1); expect(JSON.stringify(message)).toBe(snapshot);
});

test('named text attachments and original feature references survive prompt edits', async () => {
  const text = joinPastedText('Original prompt', [{ name: 'code.ts', text: 'const a = 1;\n🙂' }]);
  const message = original({ text, skills: [{ name: 'review', path: '/review/SKILL.md' }] }), { view, props } = await mount({ message });
  expect(view.getByLabelText('预览文本附件 code.ts')).toBeTruthy();
  await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'), 'Revised prompt');
  await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  expect(props.onSubmit).toHaveBeenCalledWith(message, joinPastedText('Revised prompt', [{ name: 'code.ts', text: 'const a = 1;\n🙂' }]), expect.any(AbortSignal));
});

test.each([false, new Error('电脑已断开')] as const)('rejected submission preserves the edited text and allows explicit retry (%s)', async result => {
  const onSubmit = handler(async () => { if (result instanceof Error) throw result; return result; });
  const { view, props } = await mount({ onSubmit });
  await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'), 'Keep my edit');
  await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  expect(view.getByLabelText('编辑最新消息正文').props.value).toBe('Keep my edit');
  expect(view.getByRole('alert')).toBeTruthy(); expect(props.onClose).not.toHaveBeenCalled();
  onSubmit.mockResolvedValue(true); await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  expect(onSubmit).toHaveBeenCalledTimes(2); expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('duplicate sends and cancellation cannot interrupt an already submitted mutation', async () => {
  let finish!: (value: boolean) => void;
  const onSubmit = handler(() => new Promise(resolve => { finish = resolve; }));
  const { view, props } = await mount({ onSubmit });
  await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  await fireEvent.press(view.getByLabelText('取消编辑最新消息'));
  expect(onSubmit).toHaveBeenCalledTimes(1); expect(props.onClose).not.toHaveBeenCalled();
  expect(onSubmit.mock.calls[0][2].aborted).toBe(false);
  await act(async () => finish(true)); expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('idle cancellation closes without submitting or altering the original message', async () => {
  const { view, props } = await mount();
  await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'), 'Discard this');
  await fireEvent.press(view.getByLabelText('取消编辑最新消息'));
  expect(props.onSubmit).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(props.message.text).toBe('Original request');
});

test.each(['scope', 'identity', 'unmount'] as const)('%s invalidates pending work, including an A to B to A transition', async change => {
  let finish!: (value: boolean) => void;
  const onSubmit = handler(() => new Promise(resolve => { finish = resolve; }));
  const { view, props } = await mount({ onSubmit });
  await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  const signal = onSubmit.mock.calls[0][2];
  if (change === 'unmount') await view.unmount();
  else {
    await view.rerender(<InlineSentMessageEditor {...props} {...(change === 'scope' ? { scopeKey: 'pc-b/session/api' } : { message: { ...props.message, text: 'Changed remotely' } })}/>);
    await view.rerender(<InlineSentMessageEditor {...props}/>);
    expect(view.queryByLabelText('编辑最新消息正文')).toBeNull();
  }
  expect(signal.aborted).toBe(true); await act(async () => finish(true));
  expect(props.onClose).not.toHaveBeenCalled();
});

test('cached image URI refresh preserves the edit and submits the current attachment references', async () => {
  const attachment = { id: `att_${'1'.repeat(32)}`, mime: 'image/png', uri: 'file://old.png' };
  const message = original({ attachments: [attachment], images: ['file://old.png'] }), { view, props } = await mount({ message });
  await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'), 'Keep this');
  const refreshed = { ...message, attachments: [{ ...attachment, uri: 'file://new.png' }], images: ['file://new.png'] };
  await view.rerender(<InlineSentMessageEditor {...props} message={refreshed}/>);
  expect(view.getByLabelText('编辑最新消息正文').props.value).toBe('Keep this');
  await fireEvent.press(view.getByLabelText('发送修改后的消息'));
  expect(props.onSubmit).toHaveBeenCalledWith(refreshed, 'Keep this', expect.any(AbortSignal));
});

test('running or otherwise disabled editing shows its reason and never sends', async () => {
  const { view, props } = await mount({ disabledReason: '请先停止当前任务' });
  expect(view.getByRole('alert').props.children).toBe('请先停止当前任务');
  expect(view.getByLabelText('编辑最新消息正文').props.editable).toBe(false);
  await fireEvent.press(view.getByLabelText('发送修改后的消息')); expect(props.onSubmit).not.toHaveBeenCalled();
});

test('empty text requires content but an image-only latest message remains editable', async () => {
  const { view, props } = await mount();
  await fireEvent.changeText(view.getByLabelText('编辑最新消息正文'), ' ');
  await fireEvent.press(view.getByLabelText('发送修改后的消息')); expect(props.onSubmit).not.toHaveBeenCalled();
  expect(view.getByText('请输入消息内容')).toBeTruthy(); await view.unmount();
  const image = await mount({ message: original({ text: '', images: ['file://image.png'] }) });
  await fireEvent.press(image.view.getByLabelText('发送修改后的消息'));
  expect(image.props.onSubmit).toHaveBeenCalledTimes(1);
});
