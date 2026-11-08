import { sha256 } from '@noble/hashes/sha2.js';
import { contextBytes, validContextReferences, type ContextReference } from './context-references';

export interface SelectedMessageText {
  text: string; start: number; end: number; blockIndex: number; textBasis: 'source' | 'rendered'; sourceText: string;
}
export const messageSourceRevision = (text: string) => Array.from(sha256(new TextEncoder().encode(text)), n => n.toString(16).padStart(2, '0')).join('');

/** A selection is already verified against its native TextView/DOM block by the
 * selection surface. Source coordinates additionally verify against raw text. */
export function selectedMessageReference(selection: SelectedMessageText, source: { sessionKey: string; id: string; text: string; role: 'user' | 'assistant' }): ContextReference {
  if (selection.sourceText !== source.text || !selection.text.trim() || !Number.isSafeInteger(selection.start) || selection.start < 0
    || !Number.isSafeInteger(selection.end) || selection.end - selection.start !== selection.text.length
    || selection.textBasis === 'source' && source.text.slice(selection.start, selection.end) !== selection.text) throw new Error('选区已变化，请重新选择文字');
  const reference: ContextReference = { kind: 'message', sessionKey: source.sessionKey, messageId: source.id,
    label: source.role === 'user' ? '我的消息' : 'Agent 回复', text: selection.text, startOffset: selection.start, endOffset: selection.end,
    textBasis: selection.textBasis, ...(selection.textBasis === 'rendered' ? { blockIndex: selection.blockIndex } : {}),
    sourceRevision: messageSourceRevision(source.text), capturedAt: Date.now() };
  if (!validContextReferences([reference])) throw new Error(contextBytes(selection.text) > 32768 ? '选区超过 32 KB，请缩小范围' : '文字选区无效，请重新选择');
  return reference;
}
