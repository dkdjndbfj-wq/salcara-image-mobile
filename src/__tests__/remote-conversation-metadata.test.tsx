import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { messageOrigin, boundedAgentLabel, childAgentTitle, sessionMetadata } from '../remote/conversation-metadata';
import { applyEvent, mergeHistory, EMPTY_TIMELINE, type TimelineItem } from '../remote/store';
import type { HubEvent } from '../remote/client';
import { BlockRow, ThreadUi } from '../remote/thread-rows';
import { turnControlTarget } from '../remote/turn-control';
import { buildBlocks, conversationBlocks } from '../remote/blocks';

const mockCopyUserMessage = jest.fn((_text: string) => undefined);
const mockContentProps = jest.fn((_props: { text: string; onOpenLink?: (target: string) => void }) => undefined);
// Jest's CJS host cannot execute copyUserMessage's lazy native import. Verify
// the bubble's copy boundary here; browser coverage exercises the clipboard path.
jest.mock('../remote/thread-extras', () => ({ ...jest.requireActual('../remote/thread-extras'),
  copyUserMessage: (text: string) => mockCopyUserMessage(text),
}));
jest.mock('../storage/database', () => ({ getSetting: async () => null, setSetting: async () => undefined }));
jest.mock('../components/MessageContent', () => ({ MessageContent: (props: { text: string; onOpenLink?: (target: string) => void }) => {
  const { text } = props; mockContentProps(props);
  const { Text } = require('react-native'); return <Text>{text}</Text>;
} }));
beforeEach(() => { mockCopyUserMessage.mockClear(); mockContentProps.mockClear(); });

test('own cross-task receipt is displayed without an extra mobile action menu', async () => {
  const item: Extract<TimelineItem, { kind: 'message' }> = { kind: 'message', id: 'own-receipt', role: 'user', text: '请检查', final: true, ts: 1,
    messageOrigin: { kind: 'user_cross_task', verification: 'bridge_receipt', sourceSessionKey: 'codex:source', targetSessionKey: 'codex:target', sourceTitle: '源任务', receiptId: '11111111-2222-4333-8444-555555555555' } };
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn() }}>
    <BlockRow block={{ type: 'user', id: item.id, item }} tool="codex" onOpenChild={jest.fn()} /></ThreadUi.Provider>);
  expect(view.getByText('你从 源任务 发来的消息')).toBeTruthy();
  expect(view.queryByLabelText('打开来源任务')).toBeNull(); expect(view.queryByLabelText('回复到来源任务')).toBeNull();
});

test('a native sender-asserted hint is labelled unverified without actions', async () => {
  const item: Extract<TimelineItem, { kind: 'message' }> = { kind: 'message', id: 'peer-hint', role: 'user', text: '请检查', final: true, ts: 1,
    messageOrigin: { kind: 'delegation', verification: 'native_reported', sourceSessionKey: 'claude:source' } };
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn() }}>
    <BlockRow block={{ type: 'user', id: item.id, item }} tool="claude" onOpenChild={jest.fn()} /></ThreadUi.Provider>);
  expect(view.getByText('来源未核验')).toBeTruthy(); expect(view.queryByLabelText('回复到来源任务')).toBeNull(); expect(view.queryByLabelText('打开来源任务')).toBeNull();
});

const event = (extra: object): HubEvent => ({ type: 'message', id: 'delegate', role: 'user', text: '继续', final: true,
  seq: 3, ts: 3, deviceId: 'pc', sessionKey: 'codex:original', tool: 'codex', ...extra } as HubEvent);

test.each(['live', 'history'] as const)('%s image-only echo matches attachment identity rather than empty text', mode => {
  const ref = (letter: string) => ({ id: `att_${letter.repeat(32)}`, mime: 'image/jpeg' as const, width: 1, height: 1, size: 3 });
  const first: TimelineItem = { kind: 'message', id: 'first', local: true, role: 'user', text: '', final: true, ts: 1, attachments: [ref('a')] };
  const second: TimelineItem = { ...first, id: 'second', ts: 2, attachments: [ref('b')] };
  const current = { ...EMPTY_TIMELINE, items: [first, second] };
  const incoming = event({ id: 'image-echo', text: '', attachments: [ref('b')] });
  const result = mode === 'live' ? applyEvent(current, incoming) : mergeHistory(current, undefined, [incoming]);
  expect(result.items.find(item => item.id === 'first')).toEqual(first);
  expect(result.items.find(item => item.id === 'second')).toBeUndefined();
  expect(result.items.find(item => item.id === 'image-echo')).toMatchObject({ attachments: [ref('b')] });
  const unrelated = event({ id: 'empty-other', text: '' });
  expect((mode === 'live' ? applyEvent(current, unrelated) : mergeHistory(current, undefined, [unrelated])).items).toHaveLength(3);
  const legacy = event({ id: 'image-legacy', text: '[图片]', attachments: [ref('a')] });
  const legacyResult = mode === 'live' ? applyEvent(current, legacy) : mergeHistory(current, undefined, [legacy]);
  expect(legacyResult.items.find(item => item.id === 'first')).toBeUndefined();
  expect(legacyResult.items.find(item => item.id === 'second')).toEqual(second);
});

test('observed delegation cannot steal an equal phone prompt or its images', () => {
  const local: TimelineItem = { kind: 'message', id: 'phone', local: true, role: 'user', text: '继续', final: true,
    ts: 2, clientId: 'delivery-id', images: ['file:///phone-image.jpg'] };
  const delegated = applyEvent({ ...EMPTY_TIMELINE, items: [local] }, event({ messageOrigin: { kind: 'delegation' }, clientId: 'delivery-id' }));
  expect(delegated.items).toHaveLength(2);
  expect(delegated.items.find(item => item.id === 'phone')).toEqual(local);
  expect(delegated.items.find(item => item.id === 'delegate')).toMatchObject({ messageOrigin: { kind: 'delegation' } });
  expect(delegated.items.find(item => item.id === 'delegate')).not.toHaveProperty('images');
  const echoed = applyEvent(delegated, event({ id: 'echo', seq: 4, clientId: 'delivery-id' }));
  expect(echoed.items).toHaveLength(2);
  expect(echoed.items.find(item => item.id === 'echo')).toMatchObject({ images: local.images });
});

test('metadata is allowlisted, not guessed from text or client id', () => {
  expect(messageOrigin({ kind: 'delegation', sourceTask: 'private-task', url: 'https://example.test', token: 'fixture' })).toEqual({ kind: 'delegation' });
  for (const value of [null, [], 'chatgpt', { kind: 'chatgpt' }, { kind: 'user' }]) expect(messageOrigin(value)).toBeUndefined();
  const ordinary = applyEvent(EMPTY_TIMELINE, event({ text: '来自 ChatGPT / another task', clientId: 'chatgpt' }));
  expect(ordinary.items[0]).not.toHaveProperty('messageOrigin', expect.anything());
  const newer = applyEvent(applyEvent(EMPTY_TIMELINE, event({ messageOrigin: { kind: 'delegation' } })), event({ seq: 4 }));
  expect(newer.items[0]).toMatchObject({ messageOrigin: { kind: 'delegation' } });
});

test.each(['live', 'history'] as const)('%s replay without origin cannot consume a phone receipt or attach its image to a delegation', mode => {
  const local: TimelineItem = { kind: 'message', id: 'phone', local: true, role: 'user', text: '继续', final: true,
    ts: 2, clientId: 'delivery-id', images: ['file:///synthetic-phone.jpg'] };
  const current = applyEvent({ ...EMPTY_TIMELINE, items: [local] }, event({ messageOrigin: { kind: 'delegation' }, clientId: 'delivery-id' }));
  const replay = event({ seq: 4, clientId: 'delivery-id' });
  const result = mode === 'live' ? applyEvent(current, replay) : mergeHistory(current, undefined, [replay]);
  expect(result.items).toHaveLength(2);
  expect(result.items.find(item => item.id === 'phone')).toEqual(local);
  expect(result.items.find(item => item.id === 'delegate')).toMatchObject({ messageOrigin: { kind: 'delegation' }, seq: 4 });
  expect(result.items.find(item => item.id === 'delegate')).not.toHaveProperty('images');
});

test.each(['live', 'history'] as const)('%s replay without parent cannot consume a phone receipt for a child prompt', mode => {
  const local: TimelineItem = { kind: 'message', id: 'phone', local: true, role: 'user', text: '继续', final: true,
    ts: 2, clientId: 'delivery-id' };
  const current = applyEvent({ ...EMPTY_TIMELINE, items: [local] }, event({ parentId: 'child-task', clientId: 'delivery-id' }));
  const replay = event({ seq: 4, clientId: 'delivery-id' });
  const result = mode === 'live' ? applyEvent(current, replay) : mergeHistory(current, undefined, [replay]);
  expect(result.items.find(item => item.id === 'phone')).toEqual(local);
  expect(result.items.find(item => item.id === 'delegate')).toMatchObject({ parentId: 'child-task' });
});

test.each(['live', 'history'] as const)('%s old prompt replay cannot acknowledge a later equal-text prompt', mode => {
  const old = applyEvent(EMPTY_TIMELINE, event({}));
  const local: TimelineItem = { kind: 'message', id: 'phone', local: true, role: 'user', text: '继续', final: true, ts: 5 };
  const current = { ...old, items: [...old.items, local] };
  const replay = event({ seq: 4 });
  const result = mode === 'live' ? applyEvent(current, replay) : mergeHistory(current, undefined, [replay]);
  expect(result.items.find(item => item.id === 'phone')).toEqual(local);
  expect(result.items).toHaveLength(2);
});

test('a fresh history snapshot cannot confirm a pending phone prompt using a delegation', () => {
  const local: TimelineItem = { kind: 'message', id: 'phone-pending', role: 'user', text: '继续', local: true, final: true, ts: 2, clientId: 'fixture-delivery-id' };
  const history = [event({ messageOrigin: { kind: 'delegation' }, clientId: 'fixture-delivery-id' })];
  const merged = mergeHistory({ ...EMPTY_TIMELINE, items: [local] }, undefined, history);
  expect(merged.items).toHaveLength(2);
  expect(merged.items.find(item => item.id === 'phone-pending')).toEqual(local);
  expect(merged.items.find(item => item.id === 'delegate')).toMatchObject({ messageOrigin: { kind: 'delegation' } });
});

test.each([['codex', 'Codex'], ['claude', 'Claude Code']] as const)('delegated messages identify the %s conversation without claiming the product sent them', async (tool, label) => {
  const item: Extract<TimelineItem, { kind: 'message' }> = { kind: 'message', id: 'one', role: 'user', text: '去检查测试', final: true, ts: 1, messageOrigin: { kind: 'delegation' } };
  const view = await render(<BlockRow block={{ type: 'user', id: 'one', item }} tool={tool} onOpenChild={jest.fn()} />);
  const origin = view.getByTestId('remote-message-origin');
  expect(within(origin).getByText('来自另一项任务')).toBeTruthy();
  expect(view.getByLabelText(`${label} 对话，来自另一项任务`)).toBeTruthy();
  expect(within(origin).queryByTestId(`agent-brand-${tool}`, { includeHiddenElements: true })).toBeNull();
  expect(view.queryByLabelText(label)).toBeNull(); // Decorative brand is not announced as a sender.
  expect(view.queryByText(/来自 (?:ChatGPT|Codex|Claude)/)).toBeNull();
  expect(view.queryByRole('link')).toBeNull();
});

test.each([
  { text: '<task_notification>来自另一项任务：检查测试</task_notification>' },
  { text: 'Message from another task: please check tests', clientId: 'delegation' },
  { text: '{"messageOrigin":{"kind":"delegation"},"sourceTask":"claimed-source"}' },
  { text: '来自 ChatGPT / another task', messageOrigin: { kind: 'chatgpt' } },
  { text: '去检查测试', messageOrigin: 'delegation' },
])('message wrappers and unsupported metadata stay ordinary text: $text', async incoming => {
  const timeline = applyEvent(EMPTY_TIMELINE, event(incoming));
  const block = conversationBlocks(buildBlocks(timeline.items, false), 'codex')[0];
  const view = await render(<BlockRow block={block} tool="codex" onOpenChild={jest.fn()} />);
  expect(view.getByText(incoming.text)).toBeTruthy();
  expect(view.queryByTestId('remote-message-origin')).toBeNull();
  expect(view.queryByTestId('agent-brand-codex', { includeHiddenElements: true })).toBeNull();
});

test('a delegation with only an attachment keeps its source outside a nonexistent text bubble', async () => {
  const item: Extract<TimelineItem, { kind: 'message' }> = { kind: 'message', id: 'image-delegation', role: 'user', text: '', final: true, ts: 1,
    messageOrigin: { kind: 'delegation' }, attachments: [{ id: `att_${'a'.repeat(32)}`, mime: 'image/png', width: 20, height: 20, size: 3, uri: 'file:///delegated.png' }] };
  const openImage = jest.fn();
  const view = await render(<ThreadUi.Provider value={{ openImage, openDiff: jest.fn(), requestAttachment: jest.fn() }}>
    <BlockRow block={{ type: 'user', id: item.id, item }} tool="claude" onOpenChild={jest.fn()} />
  </ThreadUi.Provider>);
  expect(view.getByLabelText('Claude Code 对话，来自另一项任务')).toBeTruthy();
  expect(view.queryByRole('button', { name: '复制消息' })).toBeNull();
  await fireEvent.press(view.getByLabelText('查看图片'));
  expect(openImage).toHaveBeenCalledWith('file:///delegated.png'); expect(mockCopyUserMessage).not.toHaveBeenCalled();
});

test('source and bubble are siblings, and expanding or copying a long delegation never changes its original body', async () => {
  const text = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 行：保留原始请求、标点，以及正文中的 $review。`).join('\n');
  const item: Extract<TimelineItem, { kind: 'message' }> = { kind: 'message', id: 'long-delegation', role: 'user', text, final: true, ts: 1, messageOrigin: { kind: 'delegation' } };
  const view = await render(<BlockRow block={{ type: 'user', id: item.id, item }} tool="codex" onOpenChild={jest.fn()} />);
  const origin = view.getByTestId('remote-message-origin'), bubble = view.getByTestId('remote-user-message-bubble');
  expect(within(bubble).queryByTestId('remote-message-origin')).toBeNull();
  const contains = (root: unknown, testID: string): boolean => {
    if (!root || typeof root !== 'object') return false;
    const node = root as { props?: { testID?: string }; children?: unknown[] };
    return node.props?.testID === testID || Boolean(node.children?.some(child => contains(child, testID)));
  };
  const tree = view.toJSON();
  expect(contains(tree, 'remote-message-origin')).toBe(true);
  expect(contains(tree, 'remote-user-message-bubble')).toBe(true);
  expect(within(origin).queryByTestId('remote-user-message-bubble')).toBeNull();
  await fireEvent(origin, 'longPress'); expect(mockCopyUserMessage).not.toHaveBeenCalled();
  await fireEvent(view.getByTestId('user-message-measure-full',{includeHiddenElements:true}),'textLayout',{nativeEvent:{lines:Array(6).fill({})}});
  expect(view.getByText(text).props.numberOfLines).toBe(2);
  expect(view.getByText(text).props.selectable).toBe(true);
  await fireEvent(view.getByText(text), 'longPress'); expect(mockCopyUserMessage).not.toHaveBeenCalled();
  expect(within(bubble).queryByRole('button', { name: '复制消息' })).toBeNull();
  await fireEvent.press(view.getByRole('button', { name: '复制消息' }));
  expect(mockCopyUserMessage).toHaveBeenCalledWith(text);
  await fireEvent.press(view.getByLabelText('展开消息'));
  expect(view.getByText(text).props.numberOfLines).toBeUndefined(); expect(view.getAllByTestId('remote-message-origin')).toHaveLength(1);
  await fireEvent.press(view.getByRole('button', { name: '复制消息' }));
  expect(mockCopyUserMessage.mock.calls).toEqual([[text], [text]]);
  await fireEvent.press(view.getByLabelText('收起消息'));
  expect(view.getByText(text).props.numberOfLines).toBe(2);
});

test('nested delegation source remains informational and cannot grant navigation or parent file scope', async () => {
  let timeline = applyEvent(EMPTY_TIMELINE, event({ type: 'tool', id: 'child-task', kind: 'subagent', title: '子任务检查', status: 'running', seq: 1 }));
  timeline = applyEvent(timeline, event({ id: 'child-request', text: '[子文件](src/child.ts)', parentId: 'child-task', seq: 2,
    messageOrigin: { kind: 'delegation', sourceTask: 'codex:unverified-task', url: 'codex://threads/unverified-task' } }));
  const block = conversationBlocks(buildBlocks(timeline.items, true), 'codex')[0];
  const openChild = jest.fn(), openLink = jest.fn();
  const view = await render(<ThreadUi.Provider value={{ openDiff: jest.fn(), openImage: jest.fn(), requestAttachment: jest.fn(), openLink }}>
    <BlockRow block={block} tool="codex" onOpenChild={openChild} />
  </ThreadUi.Provider>);
  expect(view.queryByTestId('remote-message-origin')).toBeNull();
  await fireEvent.press(view.getByLabelText('子任务检查：子任务详情'));
  const origin = view.getByTestId('remote-message-origin');
  expect(within(origin).getByLabelText('Codex 对话，来自另一项任务')).toBeTruthy();
  expect(view.queryByLabelText(/打开子智能体对话/)).toBeNull(); expect(view.queryByRole('link')).toBeNull();
  await fireEvent.press(origin); expect(openChild).not.toHaveBeenCalled(); expect(openLink).not.toHaveBeenCalled();
  const content = mockContentProps.mock.calls.map(([props]) => props).find(props => props.text === '[子文件](src/child.ts)')!;
  expect(content.onOpenLink).toEqual(expect.any(Function));
  await act(async () => { content.onOpenLink!('src/child.ts'); });
  expect(openLink).toHaveBeenCalledWith('src/child.ts', false);
  expect(timeline.items.find(item => item.id === 'child-request')).toMatchObject({ parentId: 'child-task', messageOrigin: { kind: 'delegation' } });
  expect((timeline.items.find(item => item.id === 'child-request') as Extract<TimelineItem, { kind: 'message' }>).messageOrigin).toEqual({ kind: 'delegation' });
});

test('informational retry notices do not render as terminal failures', async () => {
  const view = await render(<BlockRow block={{ type: 'notice', id: 'retry', item: { kind: 'notice', id: 'retry', level: 'error', retrying: true, text: '正在重试', ts: 1 } }} tool="codex" onOpenChild={jest.fn()} />);
  expect(view.getByText('正在重试')).toBeTruthy();
  expect(view.queryByText('已完成')).toBeNull();
});

test('native history keeps turn identity and shows old interruptions in the execution timeline', async () => {
  let timeline = applyEvent(EMPTY_TIMELINE, event({ type: 'turn', turnId: 'old', status: 'interrupted', error: '执行被中断', seq: 1 }));
  timeline = applyEvent(timeline, event({ type: 'tool', id: 'working', kind: 'command', title: '运行检查', status: 'running', turnId: 'new', seq: 2 }));
  timeline = applyEvent(timeline, event({ type: 'tool', id: 'working', kind: 'command', title: '运行检查', status: 'running', seq: 3 }));
  expect(timeline.items.find(item => item.id === 'working')).toMatchObject({ turnId: 'new' });
  const blocks = conversationBlocks(buildBlocks(timeline.items, true), 'codex');
  expect(blocks).toHaveLength(1);
  const view = await render(<BlockRow block={blocks[0]} tool="codex" onOpenChild={jest.fn()} />);
  expect(view.queryByText('已停止')).toBeNull();
  expect(view.getByText('本轮已中断：执行被中断')).toBeTruthy();
});

test('a current interruption reports the actual round and error, without claiming the user stopped it', async () => {
  const view = await render(<BlockRow block={{ type: 'turn', id: 'end', item: {
    kind: 'turn', id: 'end', turnId: 'current', status: 'interrupted', error: '连接已中断', ts: 1,
  } }} tool="codex" onOpenChild={jest.fn()} />);
  expect(view.getByText('本轮已中断：连接已中断')).toBeTruthy();
  expect(view.queryByText('已停止')).toBeNull();
  expect(view.queryByText('已完成')).toBeNull();
});

test('a child interruption is visible in child details, never as a parent stop banner', async () => {
  let timeline = applyEvent(EMPTY_TIMELINE, event({ type: 'tool', id: 'child-task', kind: 'subagent', title: '子任务检查', status: 'running', seq: 1 }));
  timeline = applyEvent(timeline, event({ type: 'turn', turnId: 'child-turn', parentId: 'child-task', status: 'interrupted', error: '子任务退出', seq: 2 }));
  const blocks = conversationBlocks(buildBlocks(timeline.items, true), 'claude');
  expect(blocks.some(block => block.type === 'turn')).toBe(false);
  const view = await render(<BlockRow block={blocks[0]} tool="claude" onOpenChild={jest.fn()} />);
  expect(view.queryByText(/本轮已中断/)).toBeNull();
  await fireEvent.press(view.getByLabelText('子任务检查：子任务详情'));
  expect(view.getByText('本轮已中断：子任务退出')).toBeTruthy();
});

test('child labels are bounded upstream display metadata', () => {
  expect(childAgentTitle({ title: '子智能体', agentNickname: '  Atlas  ' })).toBe('Atlas');
  expect(childAgentTitle({ title: '保留标题', agentNickname: 'bad\nlabel' })).toBe('保留标题');
  expect(boundedAgentLabel('x'.repeat(161))).toBeUndefined();
  expect(boundedAgentLabel('名'.repeat(160))).toHaveLength(160);
  expect(boundedAgentLabel(null)).toBeUndefined();
});

test('turn controls never reuse a stale active ID after a newer terminal boundary', () => {
  const base = { snapshotAt: Date.now(), loading: false, session: { sessionKey: 'codex:x', tool: 'codex' as const, client: 'cli', title: 'x', cwd: 'C:/x', updatedAt: 2, status: 'running' as const, controllable: true, activeTurnId: 'old-turn', controlSurface: 'cli' as const } };
  const timeline = { ...base, items: [
    { kind: 'turn' as const, id: 'turn:old-turn:terminal', turnId: 'old-turn', status: 'completed' as const, ts: 2, seq: 2, orderSeq: 2 },
  ] };
  expect(turnControlTarget(timeline, 'stop')).toBeUndefined();
});

test('turn controls select the newest observed generation and continue only from a terminal one', () => {
  const running = { snapshotAt: Date.now(), loading: false, session: { sessionKey: 'codex:x', tool: 'codex' as const, client: 'cli', title: 'x', cwd: 'C:/x', updatedAt: 3, status: 'running' as const, controllable: true, activeTurnId: 'new-turn', controlSurface: 'cli' as const }, items: [
    { kind: 'turn' as const, id: 'turn:old:started', turnId: 'old', status: 'started' as const, ts: 1, seq: 1, orderSeq: 1 },
    { kind: 'turn' as const, id: 'turn:old:terminal', turnId: 'old', status: 'completed' as const, ts: 2, seq: 2, orderSeq: 2 },
    { kind: 'turn' as const, id: 'turn:new:started', turnId: 'new', status: 'started' as const, ts: 3, seq: 3, orderSeq: 3 },
  ] };
  expect(turnControlTarget(running, 'stop')).toBe('new');
  const idle = { ...running, session: { ...running.session, status: 'idle' as const, activeTurnId: undefined, lastTerminalTurnId: 'old' }, items: running.items.slice(0, 2) };
  expect(turnControlTarget(idle, 'continue')).toBe('old');
});

test('session metadata bounds control IDs before a cache can retain arbitrary text', () => {
  const value = sessionMetadata({ sessionKey: 'codex:x', tool: 'codex', client: 'cli', title: 'x', cwd: 'C:/x', updatedAt: 1, status: 'idle', controllable: true,
    activeTurnId: 'bad id', lastTerminalTurnId: 'ok-turn' });
  expect(value.activeTurnId).toBeUndefined();
  expect(value.lastTerminalTurnId).toBe('ok-turn');
});
