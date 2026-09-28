import { contextTokens, fitHistory, historyBudget, pairsToFold, summaryInstruction, summaryPrompt } from '../agent/context-window';
import type { ChatMessage } from '../domain';

let clock = 1000;
function turn(prompt: string, answer: string): ChatMessage[] {
  const base = { conversationId: 'c', quality: 'auto', size: '', transparent: false, error: null, elapsedMs: null, remoteImageUrl: null, imageUri: null, status: 'complete', mode: 'chat', providerId: 'p', model: 'm', references: [] as ChatMessage['references'], documents: [] as NonNullable<ChatMessage['documents']>, maskUri: null } as const;
  clock += 10;
  return [
    { ...base, id: `u${clock}`, role: 'user', prompt, createdAt: clock } as ChatMessage,
    { ...base, id: `a${clock}`, role: 'assistant', prompt, text: answer, createdAt: clock + 1 } as ChatMessage,
  ];
}
const long = (count: number) => Array.from({ length: count }, (_, index) => turn(`问题${index} ${'字'.repeat(2000)}`, `回答${index} ${'答'.repeat(2000)}`)).flat();

test('context sizes follow the model family', () => {
  expect(contextTokens('gemini-2.5-pro')).toBe(1_000_000);
  expect(contextTokens('claude-sonnet-4-5')).toBe(200_000);
  expect(contextTokens('deepseek-chat')).toBe(128_000);
  expect(contextTokens('some-unknown-model')).toBe(64_000);
  expect(historyBudget('gemini-2.5-pro')).toBe(160_000);
  expect(historyBudget('tiny-8k')).toBe(28_800);
});

test('there is no fixed round cap: everything that fits is sent', () => {
  const history = Array.from({ length: 40 }, (_, index) => turn(`q${index}`, `a${index}`)).flat();
  expect(fitHistory(history, null, historyBudget('deepseek-chat')).history).toHaveLength(80);
});

test('a smaller model keeps the newest turns and reports what did not fit', () => {
  const history = long(30);
  const big = fitHistory(history, null, historyBudget('gemini-2.5-pro'));
  const small = fitHistory(history, null, historyBudget('some-unknown-model'));
  expect(big.dropped).toBe(0);
  expect(small.dropped).toBeGreaterThan(0);
  expect(small.history[small.history.length - 1].id).toBe(history[history.length - 1].id);
  expect(summaryInstruction(null, small.dropped)).toContain(`${small.dropped} 轮`);
});

test('turns already in the summary are not resent, and folding keeps the last rounds raw', () => {
  const history = long(20);
  const fold = pairsToFold(history, null);
  expect(fold.length).toBeGreaterThan(0);
  expect(fold.length <= 14).toBe(true);
  const summary = { text: '用户在做一个 App', until: fold[fold.length - 1][1].createdAt, updatedAt: 0 };
  const fit = fitHistory(history, summary, 1_000_000);
  expect(fit.history).toHaveLength((20 - fold.length) * 2);
  expect(summaryInstruction(summary, 0)).toContain('用户在做一个 App');
  expect(summaryPrompt('旧摘要', fold.slice(0, 1))).toContain('【已有摘要】\n旧摘要');
  // Small backlogs wait; forced folding (switching to a smaller model) doesn't.
  expect(pairsToFold(Array.from({ length: 8 }, (_, index) => turn(`q${index}`, `a${index}`)).flat(), null)).toHaveLength(0);
  expect(pairsToFold(Array.from({ length: 8 }, (_, index) => turn(`q${index}`, `a${index}`)).flat(), null, true)).toHaveLength(2);
});
