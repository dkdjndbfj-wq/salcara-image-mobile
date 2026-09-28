import type { ChatMessage } from '../domain';
import { selectedHistoryPairs } from './labels';

/**
 * Endless assistant conversations. Nothing is ever cut off by a fixed round count: older turns are
 * folded into a rolling summary in the background, and the raw history that is still sent is sized
 * to whichever model answers this turn — so switching from a 1M-context model to a 64K one mid
 * conversation simply sends less raw history (the summary covers the rest).
 */

/** Rough context window in tokens for common model families (unknown models get a safe default). */
export function contextTokens(model: string): number {
  const name = model.toLowerCase();
  if (/gemini|gemma-3n|qwen-long|qwen[\d.]*-(plus|turbo|flash)-?.*1m|minimax-(m1|text-01)|llama-4|grok-4/.test(name)) return 1_000_000;
  if (/claude|gpt-4\.1|gpt-5|o[134](-|$)|grok|kimi-k2|glm-4\.[5-9]|glm-[5-9]|qwen3|qwen-(max|plus|turbo|flash)|doubao-(seed|1\.5-pro-256k)|256k/.test(name)) return 200_000;
  if (/deepseek|kimi|moonshot|glm|qwen|doubao|ernie|hunyuan|step-|yi-|spark|baichuan|mistral|llama|gpt-4o|128k/.test(name)) return 128_000;
  if (/32k/.test(name)) return 32_000;
  return 64_000;
}

/**
 * Characters of raw history to send. Chinese is roughly one token per character, so about 45% of
 * the window leaves room for instructions, tools, attachments and the answer. Very long windows are
 * capped: the summary carries older turns, and resending 400K characters every turn is slow and costly.
 */
export function historyBudget(model: string): number {
  return Math.min(160_000, Math.max(16_000, Math.floor(contextTokens(model) * 0.45)));
}

/** Characters of the whole request the current turn alone may use (its own documents and text). */
export function turnBudget(model: string): number {
  return Math.max(120_000, Math.floor(contextTokens(model) * 0.7));
}

/** How much of the history a turn pair costs to resend (text, drawing prompt, attachment estimate). */
export function pairCharacters([user, assistant]: [ChatMessage, ChatMessage]): number {
  const documents = (user.documents ?? []).reduce((sum, item) => sum + Math.min(40_000, Math.max(2_000, Math.round((item.size ?? 0) / 2))), 0);
  return user.prompt.length + (assistant.text?.length ?? 0) + (assistant.preparedPrompt?.length ?? 0) + documents
    + (user.references.length + (assistant.imageUri ? 1 : 0)) * 400 + 200;
}

export interface ConversationSummary {
  /** The rolling summary of every turn up to `until`. */
  text: string;
  /** createdAt of the last assistant message folded into the summary. */
  until: number;
  updatedAt: number;
}

/**
 * The raw history for this turn: turns after the summary, newest first until `budget` is used.
 * Returns the kept messages and how many unsummarized turns did not fit (they are covered only if the
 * summary catches up; the caller compacts first when this is non-zero).
 */
export function fitHistory(history: ChatMessage[], summary: ConversationSummary | null, budget: number): { history: ChatMessage[]; dropped: number } {
  const pairs = selectedHistoryPairs(history, Infinity).filter(([, assistant]) => !summary || assistant.createdAt > summary.until);
  let used = summary ? summary.text.length : 0;
  let start = pairs.length;
  while (start > 0) {
    const cost = pairCharacters(pairs[start - 1]);
    // The newest turn is always kept, even when it alone is large.
    if (start < pairs.length && used + cost > budget) break;
    used += cost;
    start -= 1;
  }
  return { history: pairs.slice(start).flat(), dropped: start };
}

/** The instruction that carries the summary into a request. */
export function summaryInstruction(summary: ConversationSummary | null, dropped: number): string | null {
  const parts: string[] = [];
  if (summary?.text.trim()) parts.push(`这是同一段对话更早部分的摘要（由系统自动整理，作为你的记忆；用户看不到这段摘要，不要提及“摘要”）：\n<earlier_conversation>\n${summary.text.trim()}\n</earlier_conversation>`);
  if (dropped > 0) parts.push(`（另有 ${dropped} 轮较早的对话因篇幅没有附带原文。若用户提到其中的细节而你不确定，请直接请用户补充。）`);
  return parts.length ? parts.join('\n\n') : null;
}

/** Raw turns kept out of the summary so the last few exchanges are always verbatim. */
export const KEEP_RAW_ROUNDS = 6;
/** Fold only once this much unsummarized text sits beyond the kept rounds (keeps background calls rare). */
export const FOLD_THRESHOLD = 12_000;
/** Longest stretch of old turns sent to one summarizing call. */
export const FOLD_CHUNK = 48_000;

/** Which turns the next compaction should fold, or none yet. */
export function pairsToFold(history: ChatMessage[], summary: ConversationSummary | null, force = false): Array<[ChatMessage, ChatMessage]> {
  const pairs = selectedHistoryPairs(history, Infinity).filter(([, assistant]) => !summary || assistant.createdAt > summary.until);
  const candidates = pairs.slice(0, Math.max(0, pairs.length - KEEP_RAW_ROUNDS));
  const total = candidates.reduce((sum, pair) => sum + pairCharacters(pair), 0);
  if (!candidates.length || (!force && total < FOLD_THRESHOLD && candidates.length < 20)) return [];
  const chunk: Array<[ChatMessage, ChatMessage]> = [];
  let used = 0;
  for (const pair of candidates) {
    const cost = pairCharacters(pair);
    if (chunk.length && used + cost > FOLD_CHUNK) break;
    chunk.push(pair);
    used += cost;
  }
  return chunk;
}

export const SUMMARY_SYSTEM = [
  '你负责为一段很长的 AI 助手对话维护“滚动摘要”，让助手在原文不再附带时仍记得前情。',
  '把【已有摘要】和【新对话】合并成一份新的摘要，直接输出摘要正文，不要任何前言。',
  '要求：用中文；按主题分条；保留用户的目标、偏好、已确定的决定和约束、关键事实与数字、专有名词、文件名、链接、代码或配置的要点、生成过的图片编号与描述、尚未完成的事项；',
  '删去寒暄和重复；新信息与旧信息冲突时以新的为准并注明已变更；总长不超过 2500 字。',
].join('\n');

/** The prompt for one compaction step. */
export function summaryPrompt(previous: string, pairs: Array<[ChatMessage, ChatMessage]>): string {
  const lines = pairs.map(([user, assistant]) => {
    const extra: string[] = [];
    if (user.references.length) extra.push(`[用户附了 ${user.references.length} 张图片]`);
    if (user.documents?.length) extra.push(`[用户附件：${user.documents.map((item) => item.name).join('、')}]`);
    if (assistant.imageUri || assistant.preparedPrompt) extra.push(`[助手作图：${(assistant.preparedPrompt ?? '').slice(0, 300)}]`);
    if (assistant.agent?.files?.length) extra.push(`[助手生成文件：${assistant.agent.files.map((file) => file.name).join('、')}]`);
    return `用户：${user.prompt.slice(0, 6000)}\n${extra.join(' ')}\n助手：${(assistant.text ?? '').slice(0, 8000)}`;
  });
  return `【已有摘要】\n${previous.trim() || '（无）'}\n\n【新对话】\n${lines.join('\n\n---\n\n')}`;
}
