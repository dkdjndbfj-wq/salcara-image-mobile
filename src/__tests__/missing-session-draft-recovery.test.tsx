import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { MissingSessionDraftRecovery } from '../remote/MissingSessionDraftRecovery';
const evidence = { kind: 'session_not_found' as const, deviceId: 'pc', sessionKey: 'codex:missing' };
function handler(view: Awaited<ReturnType<typeof render>>, label: string): () => void {
  let fiber = view.getByLabelText(label).unstable_fiber;
  while (fiber) { if (typeof fiber.memoizedProps?.onPress === 'function') return fiber.memoizedProps.onPress; fiber = fiber.return; }
  throw new Error('Missing press handler');
}
test('missing evidence and network failures never show recovery; confirmed deletion with a draft does', async () => {
  const view = await render(<MissingSessionDraftRecovery scopeKey="one" hasDraft />);
  expect(view.queryByTestId('missing-session-draft-recovery')).toBeNull();
  await view.rerender(<MissingSessionDraftRecovery scopeKey="one" hasDraft evidence={{ ...evidence, kind: 'network_error' } as never} />);
  expect(view.queryByTestId('missing-session-draft-recovery')).toBeNull();
  await view.rerender(<MissingSessionDraftRecovery scopeKey="one" hasDraft evidence={evidence} onRestore={jest.fn()} />);
  expect(view.getByLabelText('恢复草稿到新对话')).toBeTruthy();
});
test('double activation dispatches once, failure is retryable, and changed scope ignores old handlers and outcomes', async () => {
  let reject!: (reason: Error) => void;
  const restore = jest.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const view = await render(<MissingSessionDraftRecovery scopeKey="one" hasDraft evidence={evidence} onRestore={restore} />);
  const old = handler(view, '恢复草稿到新对话');
  await act(async () => { old(); old(); }); expect(restore).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('disk full')); }); expect(view.getByText('disk full')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('恢复草稿到新对话')); expect(restore).toHaveBeenCalledTimes(2);
  await view.rerender(<MissingSessionDraftRecovery scopeKey="two" hasDraft evidence={evidence} onRestore={restore} />);
  await act(async () => { old(); reject(new Error('old outcome')); }); expect(restore).toHaveBeenCalledTimes(2); expect(view.queryByText('old outcome')).toBeNull();
});
test('restored drafts expose explicit undo, and later edits disable it without calling restore or focusing input', async () => {
  const undo = jest.fn(() => true), restore = jest.fn();
  const props = { scopeKey: 'new', hasDraft: true, restored: true, onUndo: undo, onRestore: restore };
  const view = await render(<MissingSessionDraftRecovery {...props} undoDisabled />);
  expect(view.getByLabelText('撤销草稿恢复')).toBeDisabled(); await fireEvent.press(view.getByLabelText('撤销草稿恢复')); expect(undo).not.toHaveBeenCalled();
  await view.rerender(<MissingSessionDraftRecovery {...props} />); await fireEvent.press(view.getByLabelText('撤销草稿恢复')); expect(undo).toHaveBeenCalledTimes(1); expect(restore).not.toHaveBeenCalled();
});
