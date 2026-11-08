import React from 'react';
import { Text } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { appendModelChange, createModelChange, loadModelChanges, withModelChanges } from '../remote/model-change-notices';
import { ModelChangeNoticeRow, useModelChangeNotices } from '../remote/ModelChangeNotice';
import type { ConversationBlock } from '../remote/blocks';

const mockSettings = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: jest.fn(async (key: string) => mockSettings.get(key) ?? null), setSetting: jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); }) }));
jest.mock('../components/ui', () => ({ showToast: jest.fn() }));
jest.mock('../components/Icon', () => ({ Icon: () => null }));

const blocks: ConversationBlock[] = [{ type: 'assistant', id: 'm:reply', item: { kind: 'message', id: 'reply', role: 'assistant', text: 'Reply', final: true, ts: 10 } }];
beforeEach(async () => { await loadModelChanges('drain').catch(() => undefined); mockSettings.clear(); jest.clearAllMocks(); });

test('only an explicit change with an existing conversation produces a local record', () => {
  expect(createModelChange('a', 'a', blocks)).toBeUndefined();
  expect(createModelChange('', 'b', blocks)).toBeUndefined();
  expect(createModelChange('a', 'b', [])).toBeUndefined();
  expect(createModelChange('a', 'b', blocks, 1000)).toMatchObject({ from: 'a', to: 'b', afterBlockId: 'm:reply', afterItemId: 'message:reply', ts: 1000 });
});

test('local rows stay after their anchor and before subsequent messages, without altering native blocks', () => {
  const record = createModelChange('a', 'b', blocks, 1000)!;
  const next: ConversationBlock = { type: 'user', id: 'm:next', item: { kind: 'message', id: 'next', role: 'user', text: 'Next', final: true, ts: 20 } };
  expect(withModelChanges([...blocks, next], [record]).map(block => block.id)).toEqual(['m:reply', record.id, 'm:next']);
  expect(blocks).toHaveLength(1);
  expect(withModelChanges([next], [record])).toEqual([next]);
  expect(withModelChanges([{ ...blocks[0], id: 'regrouped' }], [record])[1].id).toBe(record.id);
});

test('records survive reopening, remain isolated by connection/API scope and preserve repeated real transitions', async () => {
  const first = createModelChange('a', 'b', blocks, 1000)!, second = createModelChange('a', 'b', blocks, 2000)!;
  await appendModelChange('connection-a|api-a|thread', first);
  await appendModelChange('connection-a|api-a|thread', second);
  expect(await loadModelChanges('connection-a|api-a|thread')).toEqual([first, second]);
  expect(await loadModelChanges('connection-a|api-b|thread')).toEqual([]);
  expect(await loadModelChanges('connection-b|api-a|thread')).toEqual([]);
});

test('malformed storage is not silently overwritten by a new record', async () => {
  mockSettings.set('remote_model_changes_v1', '{broken');
  await expect(appendModelChange('source', createModelChange('a', 'b', blocks)!)).rejects.toThrow();
  expect(mockSettings.get('remote_model_changes_v1')).toBe('{broken');
});

let record: (from: string, to: string) => void;
function Harness({ scope = 'source-a', owner = scope, active = true }: { scope?: string; owner?: string; active?: boolean }) {
  const result = useModelChangeNotices(scope, owner, active, blocks); record = result.record;
  return <Text testID="records">{JSON.stringify(result.records)}</Text>;
}

test('restoring a hook creates no new row and late callbacks cannot write after changing owner', async () => {
  const view = await render(<Harness />);
  await act(async () => { await loadModelChanges('source-a'); });
  expect(JSON.parse(view.getByTestId('records').props.children)).toEqual([]);
  const oldRecord = record;
  await view.rerender(<Harness scope="source-b" />);
  await act(() => oldRecord('a', 'b'));
  expect(await loadModelChanges('source-a')).toEqual([]);
  await view.rerender(<Harness />);
  await act(() => oldRecord('a', 'b'));
  expect(await loadModelChanges('source-a')).toEqual([]);
  await act(async () => { record('a', 'b'); await loadModelChanges('source-a'); });
  await view.unmount();
  const reopened = await render(<Harness />);
  await waitFor(() => expect(JSON.parse(reopened.getByTestId('records').props.children)).toHaveLength(1));
  await reopened.rerender(<Harness active={false} />);
  const hiddenRecord = record;
  await act(() => hiddenRecord('b', 'c'));
  expect(await loadModelChanges('source-a')).toHaveLength(1);
});

test('notice is a quiet system line and reveals the next-message semantics only on demand', async () => {
  const view = await render(<ModelChangeNoticeRow record={createModelChange('GPT-6.1 Sol', 'GPT-6 Astra', blocks)!} />);
  expect(view.getByText('模型已从 GPT-6.1 Sol 更改为 GPT-6 Astra。')).toBeTruthy();
  expect(view.queryByText('这是本机对后续消息的模型设置，不影响正在进行的回复。')).toBeNull();
  await fireEvent.press(view.getByLabelText('模型切换说明'));
  expect(view.getByText('这是本机对后续消息的模型设置，不影响正在进行的回复。')).toBeTruthy();
});
