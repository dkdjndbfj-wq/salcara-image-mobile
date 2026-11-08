import { parseSideQuestionCatalog, parseSideQuestionConversation, parseSideQuestionResult, sameSideQuestionSelection, validSideQuestionInput } from '../remote/side-question';
const sessionKey = 'codex:s', operationId = '11111111-2222-4333-8444-555555555555';
const catalog = { sessionKey, revision: 'r1', available: true, contextScope: 'loadedSnapshot' as const, contextMessages: 2, contextTruncated: false };
const reading = { value: catalog, scope: 'scope' };
test.each([{ sessionKey: 'codex:other' }, { contextScope: 'fullNativeContext' }, { revision: '' }, { contextMessages: 0 }, { contextMessages: 81 }, { contextTruncated: undefined }])('rejects invalid context claims %#', patch => {
  expect(parseSideQuestionCatalog({ ...catalog, ...patch }, sessionKey)).toBeUndefined();
});
test('unavailable catalog is explicit and needs no usable revision', () => {
  expect(parseSideQuestionCatalog({ ...catalog, revision: '', available: false, contextMessages: 0, unavailableReason: '当前模型未就绪' }, sessionKey)).toMatchObject({ available: false });
});
test('results stay bound to the exact reading and operation, exposing tokens only', () => {
  const raw = { sessionKey, operationId, state: 'completed', answer: '独立答复', contextScope: 'loadedSnapshot', contextMessages: 2, contextTruncated: false, usage: { inputTokens: 10, outputTokens: 5, costUsd: 10 } };
  expect(parseSideQuestionResult(raw, reading, operationId)?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  for (const patch of [{ sessionKey: 'claude:s' }, { operationId: 'other' }, { contextMessages: 1 }, { contextTruncated: true }, { answer: '' }, { usage: { inputTokens: -1, outputTokens: 1 } }]) expect(parseSideQuestionResult({ ...raw, ...patch }, reading, operationId)).toBeUndefined();
});
test('follow-up references cannot inject other sessions or fresh selection context', () => {
  const selection = { kind: 'message' as const, sessionKey, label: '选中文字', text: '文字', messageId: 'older-message', startOffset: 0, endOffset: 2, capturedAt: 1 };
  expect(validSideQuestionInput(sessionKey, { question: '解释', selection })).toBe(true);
  expect(validSideQuestionInput(sessionKey, { question: '解释', selection: { ...selection, sessionKey: 'claude:other' } })).toBe(false);
  expect(validSideQuestionInput(sessionKey, { question: '解释', selection, previousOperationId: operationId })).toBe(false);
  expect(validSideQuestionInput(sessionKey, { question: '继续', previousOperationId: operationId })).toBe(true);
});

test('persistent responses require exact chain, unique bounded receipts and honest deletion state', () => {
  const chainId = '00000000-0000-4000-8000-000000000001';
  const turn = { operationId, question: '解释', answer: '回答', state: 'completed', createdAt: 100 };
  const value = { ...catalog, chainId, turns: [turn], lastOperationId: operationId, nextCursor: '50' };
  expect(parseSideQuestionConversation(value, sessionKey, chainId)).toMatchObject({ chainId, turns: [turn], nextCursor: '50' });
  for (const patch of [{ chainId: operationId }, { turns: [turn, turn] }, { turns: [{ ...turn, answer: '' }] }, { turns: [{ ...turn, createdAt: -1 }] }, { nextCursor: '../history' }, { deleted: true }]) {
    expect(parseSideQuestionConversation({ ...value, ...patch }, sessionKey, chainId)).toBeUndefined();
  }
  expect(parseSideQuestionConversation({ ...value, turns: [], available: false, deleted: true }, sessionKey, chainId)?.deleted).toBe(true);
});

test('selection receipt equality ignores JSON key order while still comparing text and offsets', () => {
  const selection = { kind: 'message' as const, sessionKey, label: '选中文字', text: '文字', messageId: 'older-message', startOffset: 0, endOffset: 2, capturedAt: 1 };
  expect(sameSideQuestionSelection(selection, Object.fromEntries(Object.entries(selection).reverse()) as typeof selection)).toBe(true);
  expect(sameSideQuestionSelection(selection, { ...selection, text: '另文' })).toBe(false);
});
