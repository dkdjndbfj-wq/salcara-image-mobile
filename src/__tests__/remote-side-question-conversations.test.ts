import { createSideQuestionConversation, deleteLocalSideQuestionConversation, deleteSideQuestionConversation, loadSideQuestionConversations, markSideQuestionOpening,
  reconcileSideQuestionConversation, rememberSideQuestionHistoryScope, restoreSideQuestionHistoryScope, resetSideQuestionConversationsForTests, submitSideQuestionConversation, updateSideQuestionDraft, updateSideQuestionPresentation } from '../remote/side-question-conversations';
import { SideQuestionNotDispatchedError, type SideQuestionResult, type SideQuestionRemoteConversation } from '../remote/side-question';
const mockSettings = new Map<string, string>();
let mockFail = false;
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null, setSetting: async (key: string, value: string) => { if (mockFail) throw new Error('disk full'); mockSettings.set(key, value); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => jest.requireActual('node:crypto').randomUUID() }));
const answer = (operationId: string): SideQuestionResult => ({ sessionKey: 'codex:s', operationId, state: 'completed', answer: '答复', contextScope: 'loadedSnapshot', contextMessages: 2, contextTruncated: false });
const remote = (chainId: string, turns: SideQuestionRemoteConversation['turns'] = []): SideQuestionRemoteConversation => ({ chainId, sessionKey: 'codex:s', revision: 'r', available: true, contextScope: 'loadedSnapshot', contextMessages: 2, contextTruncated: false, turns, lastOperationId: turns[turns.length - 1]?.operationId });
beforeEach(() => { resetSideQuestionConversationsForTests(); mockSettings.clear(); mockFail = false; });

test('drafts, folding and more than six answers survive restart with no time expiry or eviction', async () => {
  const state = await createSideQuestionConversation('pair|pc|codex:s|account-a', 'codex:s'), id = state.activeId!;
  let previousOperationId: string | undefined;
  for (let i = 0; i < 8; ++i) {
    await submitSideQuestionConversation(state.scope, id, { question: `问题 ${i}`, ...(previousOperationId ? { previousOperationId } : {}) }, async operationId => { previousOperationId = operationId; return answer(operationId); });
  }
  await updateSideQuestionDraft(state.scope, id, '尚未发送的草稿'); await updateSideQuestionPresentation(state.scope, { expanded: false });
  resetSideQuestionConversationsForTests(); const oldNow = Date.now; Date.now = () => oldNow() + 30 * 86400_000;
  try {
    const restored = await loadSideQuestionConversations(state.scope);
    expect(restored.expanded).toBe(false); expect(restored.conversations[0].exchanges).toHaveLength(8); expect(restored.conversations[0].draft).toBe('尚未发送的草稿');
    expect(await loadSideQuestionConversations('pair|pc|codex:s|account-b')).toMatchObject({ conversations: [] });
  } finally { Date.now = oldNow; }
});

test('receipt is durable before transport and a result persists in its original scope after UI leaves', async () => {
  const state = await createSideQuestionConversation('a', 'codex:s'), id = state.activeId!;
  let resolve!: (value: SideQuestionResult) => void, operation!: string;
  const sent = submitSideQuestionConversation('a', id, { question: '问题' }, async operationId => {
    operation = operationId;
    expect(JSON.parse([...mockSettings.values()][0]).conversations[0].pending).toMatchObject({ operationId, state: 'sending' });
    return new Promise<SideQuestionResult>(done => { resolve = done; });
  });
  await loadSideQuestionConversations('a'); await createSideQuestionConversation('b', 'codex:s'); await updateSideQuestionPresentation('a', { expanded: false });
  resolve(answer(operation)); await sent;
  expect((await loadSideQuestionConversations('a')).conversations[0]).toMatchObject({ unread: true, exchanges: [{ answer: '答复' }] });
  expect((await loadSideQuestionConversations('b')).conversations[0].exchanges).toEqual([]);
});

test('uncertain request survives restart, cannot resend, and reconciles only a matching read receipt', async () => {
  const state = await createSideQuestionConversation('a', 'codex:s'), id = state.activeId!; let operation = '';
  await updateSideQuestionDraft('a', id, '问题');
  await submitSideQuestionConversation('a', id, { question: '问题' }, async operationId => { operation = operationId; throw new Error('网络中断'); });
  resetSideQuestionConversationsForTests(); const restored = await loadSideQuestionConversations('a');
  expect(restored.conversations[0].pending?.state).toBe('unconfirmed');
  const ask = jest.fn(); await expect(submitSideQuestionConversation('a', id, { question: '问题' }, ask)).rejects.toThrow('未确认'); expect(ask).not.toHaveBeenCalled();
  await reconcileSideQuestionConversation('a', id, remote(id, [{ operationId: operation, question: '问题', answer: '已完成', state: 'completed', createdAt: 1 }]));
  expect((await loadSideQuestionConversations('a')).conversations[0]).toMatchObject({ draft: '', exchanges: [{ answer: '已完成' }] });
  expect((await loadSideQuestionConversations('a')).conversations[0].pending).toBeUndefined();
});

test('pagination only adds older history, never replaces or silently prunes stored answers', async () => {
  const state = await createSideQuestionConversation('a', 'codex:s'), id = state.activeId!;
  const turn = (n: number) => ({ operationId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, question: `Q${n}`, answer: `A${n}`, state: 'completed' as const, createdAt: n });
  await reconcileSideQuestionConversation('a', id, remote(id, [turn(3), turn(4)]));
  await reconcileSideQuestionConversation('a', id, remote(id, [turn(1), turn(2)]), true);
  expect((await loadSideQuestionConversations('a')).conversations[0].exchanges.map(item => item.answer)).toEqual(['A1', 'A2', 'A3', 'A4']);
  expect((await loadSideQuestionConversations('a')).conversations[0].lastOperationId).toBe(turn(4).operationId);
});

test('remote pending head stays ahead of completed history and stale reads cannot roll it back', async () => {
  const state = await createSideQuestionConversation('a', 'codex:s'), id = state.activeId!;
  const first = { operationId: '00000000-0000-4000-8000-000000000001', question: '第一问', answer: '回答', state: 'completed' as const, createdAt: 1 };
  const pending = { operationId: '00000000-0000-4000-8000-000000000002', question: '第二问', answer: '', state: 'pending' as const, createdAt: 2 };
  await reconcileSideQuestionConversation('a', id, remote(id, [first, pending]));
  expect((await loadSideQuestionConversations('a')).conversations[0]).toMatchObject({ lastOperationId: pending.operationId, pending: { operationId: pending.operationId } });
  await reconcileSideQuestionConversation('a', id, remote(id, [first]));
  expect((await loadSideQuestionConversations('a')).conversations[0].lastOperationId).toBe(pending.operationId);
});

test('explicit delete fences a late response and does not revive a removed chain', async () => {
  const state = await createSideQuestionConversation('a', 'codex:s'), id = state.activeId!; let resolve!: (value: SideQuestionResult) => void, operation = '';
  const sent = submitSideQuestionConversation('a', id, { question: '问题' }, operationId => { operation = operationId; return new Promise(done => { resolve = done; }); });
  await loadSideQuestionConversations('a'); await deleteLocalSideQuestionConversation('a', id); resolve(answer(operation)); await sent;
  resetSideQuestionConversationsForTests(); expect((await loadSideQuestionConversations('a')).conversations).toEqual([]);
});

test('an attempted open must be deleted remotely, and uncertain deletion keeps its id for an explicit retry', async () => {
  const state = await createSideQuestionConversation('a', 'codex:s'), id = state.activeId!; await markSideQuestionOpening('a', id);
  const remove = jest.fn(async () => { throw new Error('未确认'); });
  await expect(deleteSideQuestionConversation('a', id, remove)).rejects.toThrow('未确认');
  const receipt = (await loadSideQuestionConversations('a')).conversations[0].deleteOperationId;
  const retry = jest.fn(async () => undefined); await deleteSideQuestionConversation('a', id, retry);
  expect(retry).toHaveBeenCalledWith(receipt); expect((await loadSideQuestionConversations('a')).conversations).toEqual([]);
});

test('storage failure prevents sending, and a malformed record is not overwritten', async () => {
  const state = await createSideQuestionConversation('a', 'codex:s'); mockFail = true; const ask = jest.fn();
  await expect(submitSideQuestionConversation('a', state.activeId!, { question: '问题' }, ask)).rejects.toThrow('disk full'); expect(ask).not.toHaveBeenCalled();
  mockFail = false; const key = [...mockSettings.keys()][0]; mockSettings.set(key, '{broken'); resetSideQuestionConversationsForTests();
  await expect(createSideQuestionConversation('a', 'codex:s')).rejects.toThrow('原记录仍保留'); expect(mockSettings.get(key)).toBe('{broken');
});

test('last verified source index survives process reset and belongs to the exact pairing credential', async () => {
  await rememberSideQuestionHistoryScope('credential-a|pc|codex:s', 'credential-a|pc|codex:s|account-one');
  resetSideQuestionConversationsForTests();
  expect(await restoreSideQuestionHistoryScope('credential-a|pc|codex:s')).toBe('credential-a|pc|codex:s|account-one');
  expect(await restoreSideQuestionHistoryScope('credential-b|pc|codex:s')).toBeUndefined();
  expect(await restoreSideQuestionHistoryScope('credential-a|pc2|codex:s')).toBeUndefined();
});

test('only a typed local preflight failure releases a receipt; matching remote error text remains uncertain', async () => {
  const state = await createSideQuestionConversation('a', 'codex:s'), id = state.activeId!; await updateSideQuestionDraft('a', id, '问题');
  await submitSideQuestionConversation('a', id, { question: '问题' }, async () => { throw new SideQuestionNotDispatchedError('来源已改变'); });
  expect((await loadSideQuestionConversations('a')).conversations[0]).toMatchObject({ draft: '问题' });
  expect((await loadSideQuestionConversations('a')).conversations[0].pending).toBeUndefined();
  await submitSideQuestionConversation('a', id, { question: '问题' }, async () => { throw new Error('来源已改变'); });
  expect((await loadSideQuestionConversations('a')).conversations[0].pending?.state).toBe('unconfirmed');
});
