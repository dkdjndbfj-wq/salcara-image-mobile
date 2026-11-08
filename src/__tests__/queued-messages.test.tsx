import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueuedMessages, type QueuedMessageView, type QueuedMessagesProps } from '../remote/QueuedMessages';

jest.mock('../components/Icon', () => ({ Icon: () => null }));
jest.mock('../components/ui', () => ({ Sheet: ({ visible, subtitle, children }: any) => visible ? require('react').createElement(require('react-native').View,null,subtitle?require('react').createElement(require('react-native').Text,null,subtitle):null,children) : null }));
jest.mock('../theme', () => ({ useDesk: () => ({ text: '#222', muted: '#888', line: '#ddd', warn: '#a50' }) }));
jest.mock('../remote/ManagedImage', () => ({ ManagedImage: ({ uri }: any) => require('react').createElement(require('react-native').Text, null, `thumbnail:${uri}`) }));
jest.mock('../remote/thread-extras', () => ({ ImageViewer: ({ uri }: any) => uri ? require('react').createElement(require('react-native').Text, null, `viewer:${uri}`) : null }));

const rows: QueuedMessageView[] = [
  { id: 'first', text: 'First complete message', images: [], detail: '等待当前回合结束', options: 'model-a · high', editable: true, removable: true },
  { id: 'second', text: 'Second complete message\nwith the final line intact', images: [{ uri: 'file://second-image' }], detail: '已暂停', options: 'model-b · plan', editable: true, removable: true },
];
function props(overrides: Partial<QueuedMessagesProps> = {}): QueuedMessagesProps {
  return { scopeKey: 'pc/agent/code/session/api', entries: rows, onPause: jest.fn(async () => {}), onEdit: jest.fn(async () => {}),
    onMove: jest.fn(async () => {}), onRemove: jest.fn(async () => {}), onResume: jest.fn(async () => {}), ...overrides };
}

test('all queued entries expand and full text, original options and images can be previewed', async () => {
  const view = await render(<QueuedMessages {...props()} />);
  expect(view.queryByLabelText('查看排队消息 2')).toBeNull();
  await fireEvent.press(view.getByLabelText('展开排队消息'));
  await fireEvent.press(view.getByLabelText('查看排队消息 2'));
  expect(view.getAllByText(rows[1].text)).toHaveLength(2);
  expect(view.getByText('model-b · plan')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('预览排队图片 1'));
  expect(view.getByText('viewer:file://second-image')).toBeTruthy();
});

test('editing pauses before opening and saves text with the original revision guard without resuming', async () => {
  const handlers = props();
  const view = await render(<QueuedMessages {...handlers} />);
  await fireEvent.press(view.getByLabelText('展开排队消息'));
  await fireEvent.press(view.getByLabelText('编辑排队消息 2'));
  await waitFor(() => expect(view.getByLabelText('排队消息正文')).toBeTruthy());
  expect(handlers.onPause).toHaveBeenCalledTimes(1);
  await fireEvent.changeText(view.getByLabelText('排队消息正文'), 'Revised message');
  await fireEvent.press(view.getByLabelText('保存排队消息'));
  await waitFor(() => expect(handlers.onEdit).toHaveBeenCalledWith('second', 'Revised message', rows[1].text));
  expect(handlers.onResume).not.toHaveBeenCalled();
});

test('switching scope while pause is pending cannot open the old editor in the new conversation', async () => {
  let finish!: () => void;
  const handlers = props({ onPause: jest.fn(() => new Promise<void>(resolve => { finish = resolve; })) });
  const view = await render(<QueuedMessages {...handlers} />);
  await fireEvent.press(view.getByLabelText('展开排队消息'));
  await fireEvent.press(view.getByLabelText('编辑排队消息 1'));
  await view.rerender(<QueuedMessages {...handlers} scopeKey="other-pc/agent/code/session/api" />);
  await act(async () => { finish(); });
  expect(view.queryByLabelText('排队消息正文')).toBeNull();
  expect(handlers.onEdit).not.toHaveBeenCalled();
});

test('attempted or uncertain rows cannot be edited, removed or crossed by reorder; review remains available', async () => {
  const handlers = props({ entries: [{ ...rows[0], editable: false, removable: false, uncertain: true }, rows[1]], onReview: jest.fn() });
  const view = await render(<QueuedMessages {...handlers} />);
  await fireEvent.press(view.getByLabelText('展开排队消息'));
  await fireEvent.press(view.getByLabelText('编辑排队消息 1'));
  await fireEvent.press(view.getByLabelText('移除排队消息 1'));
  await fireEvent.press(view.getByLabelText('上移排队消息 2'));
  expect(handlers.onPause).not.toHaveBeenCalled();
  expect(handlers.onRemove).not.toHaveBeenCalled();
  expect(handlers.onMove).not.toHaveBeenCalled();
  await view.rerender(<QueuedMessages {...handlers} disabled />);
  await fireEvent.press(view.getByLabelText('核对排队消息送达状态'));
  expect(handlers.onReview).toHaveBeenCalledTimes(1);
});

test('a failed save leaves the editor and its text available for retry', async () => {
  const handlers = props({ onEdit: jest.fn(async () => { throw new Error('Saved version changed'); }) });
  const view = await render(<QueuedMessages {...handlers} />);
  await fireEvent.press(view.getByLabelText('展开排队消息'));
  await fireEvent.press(view.getByLabelText('编辑排队消息 1'));
  await waitFor(() => expect(view.getByLabelText('排队消息正文')).toBeTruthy());
  await fireEvent.changeText(view.getByLabelText('排队消息正文'), 'Keep my changed text');
  await fireEvent.press(view.getByLabelText('保存排队消息'));
  await waitFor(() => expect(view.getByText('Saved version changed')).toBeTruthy());
  expect(view.getByLabelText('排队消息正文').props.value).toBe('Keep my changed text');
});
