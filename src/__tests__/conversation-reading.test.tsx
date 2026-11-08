import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { MessageContent } from '../components/MessageContent';
import { ConversationReadingButton, ConversationReadingPanel, ConversationReadingProvider, useConversationReading } from '../remote/ConversationReading';
import { BlockRow, ThreadUi } from '../remote/thread-rows';
import { buildBlocks, conversationBlocks, type ConversationBlock } from '../remote/blocks';
import { useThreadStyles } from '../remote/thread-styles';
import type { TimelineItem } from '../remote/store';

const mockRead = jest.fn(), mockWrite = jest.fn(), mockToast = jest.fn();
const saved = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: (...args: unknown[]) => mockRead(...args), setSetting: (...args: unknown[]) => mockWrite(...args) }));
jest.mock('../components/ui', () => ({ ...jest.requireActual('../components/ui'), showToast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native'), replacement = Object.create(actual);
  Object.defineProperty(replacement, 'useWindowDimensions', { value: () => ({ width: 1194, height: 834, scale: 1, fontScale: 1 }) });
  return replacement;
});

type Reading = ReturnType<typeof useConversationReading>;
function Probe({ onRead }: { onRead?: (reading: Reading) => void }) {
  const reading = useConversationReading(), styles = useThreadStyles();
  onRead?.(reading);
  return <><Text testID="preferences">{JSON.stringify({ textScale: reading.textScale, simple: reading.simple, open: reading.open })}</Text>
    <MessageContent text="对话正文" /><Text testID="composer-size" style={styles.input}>草稿内容</Text></>;
}
function Page({ scope, blocks = [], onNavigate = jest.fn(), onRead }: { scope: string; blocks?: readonly ConversationBlock[]; onNavigate?: (index: number) => void; onRead?: (reading: Reading) => void }) {
  return <ConversationReadingProvider scope={scope}><ConversationReadingButton /><ConversationReadingPanel blocks={blocks} onNavigate={onNavigate} /><Probe onRead={onRead} /></ConversationReadingProvider>;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const key = (scope: string) => `remote.reading.v1:${scope}`;
const prefs = (view: Awaited<ReturnType<typeof render>>) => JSON.parse(view.getByTestId('preferences').props.children);
const user = (id: string, text: string): TimelineItem => ({ kind: 'message', id, role: 'user', text, final: true, ts: 1 });
const answer = (id: string, text = '完成'): TimelineItem => ({ kind: 'message', id, role: 'assistant', text, final: true, ts: 2 });
const tool = (id: string, status: 'done' | 'failed' | 'running' = 'done'): TimelineItem => ({ kind: 'tool', id, tool: 'command', title: id, detail: `${id} --check`, output: `${id} result`, status, ts: 2 });

beforeEach(() => {
  saved.clear(); jest.clearAllMocks();
  mockRead.mockImplementation(async (storageKey: string) => saved.get(storageKey) ?? null);
  mockWrite.mockImplementation(async (storageKey: string, value: string) => { saved.set(storageKey, value); });
});

test('late preference hydration keeps an already-open reading panel open', async () => {
  const pending = deferred<string | null>(); mockRead.mockReturnValueOnce(pending.promise);
  const view = await render(<Page scope="late-open" />);
  await fireEvent.press(view.getByLabelText('阅读设置与消息导航'));
  expect(view.getByTestId('conversation-reading-panel')).toBeTruthy();
  await act(async () => pending.resolve(JSON.stringify({ textScale: .9, simple: true })));
  expect(prefs(view)).toEqual({ textScale: .9, simple: true, open: true });
  expect(view.getByTestId('conversation-reading-panel')).toBeTruthy();
});

test('a user change outruns delayed storage and scales only conversation content', async () => {
  const pending = deferred<string | null>(); mockRead.mockReturnValueOnce(pending.promise);
  const view = await render(<Page scope="edit-before-hydrate" />);
  await fireEvent.press(view.getByLabelText('阅读设置与消息导航'));
  await fireEvent.press(view.getByRole('radio', { name: '大字' }));
  await act(async () => pending.resolve(JSON.stringify({ textScale: .9, simple: true })));
  expect(prefs(view)).toEqual({ textScale: 1.15, simple: false, open: true });
  expect(StyleSheet.flatten(view.getByText('对话正文').props.style)).toMatchObject({ fontSize: 16.1, lineHeight: 25.3 });
  expect(StyleSheet.flatten(view.getByTestId('composer-size').props.style)).toMatchObject({ fontSize: 15, lineHeight: 22 });
  await waitFor(() => expect(JSON.parse(saved.get(key('edit-before-hydrate'))!)).toEqual({ textScale: 1.15, simple: false }));
});

test('switching sources drops old loads and callbacks without losing the current source preferences', async () => {
  const pending = deferred<string | null>();
  mockRead.mockImplementation(async (storageKey: string) => storageKey === key('computer-a') ? pending.promise : JSON.stringify({ textScale: 1.15, simple: true }));
  let reading!: Reading;
  const view = await render(<Page scope="computer-a" onRead={value => { reading = value; }} />);
  const old = reading;
  await view.rerender(<Page scope="computer-b" onRead={value => { reading = value; }} />);
  await waitFor(() => expect(prefs(view).textScale).toBe(1.15));
  await act(async () => { old.update({ textScale: .9 }); old.toggle(); pending.resolve(JSON.stringify({ textScale: .9, simple: false })); });
  expect(prefs(view)).toEqual({ textScale: 1.15, simple: true, open: false });
  expect(mockWrite).not.toHaveBeenCalled();
  await act(async () => reading.toggle());
  expect(prefs(view)).toEqual({ textScale: 1.15, simple: true, open: true });
});

test('serialized writes restore the newest choice when reopening a source', async () => {
  let reading!: Reading;
  const firstWrite = deferred<void>();
  mockWrite.mockImplementationOnce(async (storageKey: string, value: string) => { await firstWrite.promise; saved.set(storageKey, value); });
  const view = await render(<Page scope="write-order" onRead={value => { reading = value; }} />);
  await act(async () => reading.update({ textScale: .9 }));
  await waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
  await act(async () => reading.update({ simple: true }));
  expect(mockWrite).toHaveBeenCalledTimes(1);
  await view.rerender(<Page scope="write-other" />);
  await view.rerender(<Page scope="write-order" />);
  await act(async () => firstWrite.resolve());
  await waitFor(() => expect(prefs(view)).toEqual({ textScale: .9, simple: true, open: false }));
  expect(JSON.parse(saved.get(key('write-order'))!)).toEqual({ textScale: .9, simple: true });
});

test('storage failure retains the active choice and a later change saves normally', async () => {
  mockWrite.mockRejectedValueOnce(new Error('disk unavailable'));
  let reading!: Reading;
  const view = await render(<Page scope="storage-failure" onRead={value => { reading = value; }} />);
  await act(async () => reading.update({ simple: true }));
  await waitFor(() => expect(mockToast).toHaveBeenCalledWith('阅读设置暂未保存，本次仍然有效', 'alert'));
  expect(prefs(view).simple).toBe(true);
  await act(async () => reading.update({ textScale: .9 }));
  await waitFor(() => expect(JSON.parse(saved.get(key('storage-failure'))!)).toEqual({ textScale: .9, simple: true }));
});

test('message navigation targets user block indices including an attachment-only prompt', async () => {
  const blocks = conversationBlocks(buildBlocks([answer('intro'), user('first', '第一条提问'), tool('check'), answer('middle'), user('attachment', '')], false));
  const onNavigate = jest.fn(), view = await render(<Page scope="navigation" blocks={blocks} onNavigate={onNavigate} />);
  await fireEvent.press(view.getByLabelText('阅读设置与消息导航'));
  expect(view.getAllByRole('button', { name: /^跳到提问/ })).toHaveLength(2);
  await fireEvent.press(view.getByLabelText('跳到提问 2：图片或附件消息'));
  expect(onNavigate).toHaveBeenCalledWith(blocks.findIndex(block => block.type === 'user' && block.item.id === 'attachment'));
  expect(view.queryByTestId('conversation-reading-panel')).toBeNull();
});

function Execution({ scope, items, searchQuery = '', running = false }: { scope: string; items: TimelineItem[]; searchQuery?: string; running?: boolean }) {
  return <ConversationReadingProvider scope={scope}><ConversationReadingButton /><ConversationReadingPanel blocks={[]} onNavigate={jest.fn()} />
    <ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn(), presentation: 'tablet' }}><View>
      {conversationBlocks(buildBlocks(items, running), 'claude').map(block => <BlockRow key={block.id} block={block} tool="claude" onOpenChild={jest.fn()} searchQuery={searchQuery} />)}
    </View></ThreadUi.Provider></ConversationReadingProvider>;
}

test('simple mode folds successful steps while plans, failures, subagents and result cards stay usable', async () => {
  saved.set(key('simple-results'), JSON.stringify({ textScale: 1, simple: true }));
  const items: TimelineItem[] = [tool('completed-command'),
    { kind: 'tool', id: 'plan', tool: 'plan', title: '计划', output: '✓ 检查布局', status: 'done', ts: 3 },
    tool('failed-command', 'failed'), answer('progress', '继续修复'),
    { kind: 'tool', id: 'child', tool: 'subagent', title: '检查侧栏', output: '子任务已验证', status: 'done', childSessionKeys: ['claude:child'], ts: 4 },
    { kind: 'tool', id: 'edit', tool: 'file_change', title: 'src/main.ts', detail: 'src/main.ts', status: 'done', ts: 5 },
    { kind: 'tool', id: 'web', tool: 'web', title: '打开预览', status: 'done', browser: { action: 'open', url: 'https://example.com/', pageId: 'preview-1' }, ts: 6 },
    { kind: 'notice', id: 'warning', text: '连接需要重新核对', level: 'warn', ts: 7 }, answer('final')];
  const view = await render(<Execution scope="simple-results" items={items} />);
  await waitFor(() => expect(view.queryByTestId('execution-row:completed-command')).toBeNull());
  expect(view.getByTestId('remote-plan-summary')).toBeTruthy();
  expect(view.getByTestId('execution-row:failed-command')).toBeTruthy();
  expect(view.getByText('连接需要重新核对')).toBeTruthy();
  expect(view.getByTestId('conversation-changes-card')).toBeTruthy();
  expect(view.getByTestId('conversation-preview-card')).toBeTruthy();
  await fireEvent.press(view.getByLabelText('检查侧栏：子任务详情'));
  expect(view.getByText('子任务已验证')).toBeTruthy();
  const summaries = view.getAllByLabelText('展开已完成过程');
  await fireEvent.press(summaries[0]);
  expect(view.getByTestId('execution-row:completed-command')).toBeTruthy();
});

test('search expands matching completed work and a live activity is never folded', async () => {
  saved.set(key('simple-search'), JSON.stringify({ textScale: 1, simple: true }));
  const items = [tool('find-this'), answer('final')];
  const view = await render(<Execution scope="simple-search" items={items} />);
  await waitFor(() => expect(view.queryByTestId('execution-row:find-this')).toBeNull());
  await view.rerender(<Execution scope="simple-search" items={items} searchQuery="find-this" />);
  expect(view.getByTestId('execution-row:find-this')).toBeTruthy();
  expect(view.getByText('find-this result')).toBeTruthy();
  await view.rerender(<Execution scope="simple-search" items={[tool('completed'), tool('still-running', 'running')]} running />);
  expect(view.getByTestId('execution-row:completed')).toBeTruthy();
  expect(view.getByTestId('execution-row:still-running')).toBeTruthy();
});

test('an interrupted historical turn or denied approval must not disappear inside a completed work group', async () => {
  saved.set(key('simple-interruption'), JSON.stringify({ textScale: 1, simple: true }));
  const items: TimelineItem[] = [user('old', '旧任务'), tool('old-command'),
    { kind: 'turn', id: 'stopped', turnId: 'old-turn', status: 'interrupted', error: '用户停止', ts: 3 },
    user('new', '继续任务'), { kind: 'turn', id: 'new-turn-start', turnId: 'new-turn', status: 'started', ts: 4 },
    { kind: 'approval', id: 'denied', approval: 'command', title: '删除文件', state: 'deny', ts: 4 }, answer('final')];
  const view = await render(<Execution scope="simple-interruption" items={items} />);
  await waitFor(() => expect(view.queryByTestId('execution-row:old-command')).toBeTruthy());
  expect(view.getByText(/本轮已中断/)).toBeTruthy();
  expect(view.getByText(/已拒绝：删除文件/)).toBeTruthy();
});
