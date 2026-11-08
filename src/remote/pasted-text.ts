export interface PastedText { name: string; text: string }
export const LARGE_PASTE_LENGTH = 3000;
const end = '\n[文本附件结束]';
const header = /(?:^|\n\n)\[文本附件：([^\[\]\r\n；\0]{1,120})；字符数：(\d+)\]\n/g;
/** Content stays in the durable message itself. No temporary-file pointer can
 * outlive its bytes; old clients and agents receive the complete labelled text. */
export function splitPastedText(value: string): { prompt: string; attachments: PastedText[] } {
  const pattern = new RegExp(header), match = pattern.exec(value);
  if (!match) return { prompt: value, attachments: [] };
  const prompt = value.slice(0, match.index), attachments: PastedText[] = [];
  let next: RegExpExecArray | null = match;
  while (next && attachments.length < 8) {
    const length: number = Number(next[2]), start: number = pattern.lastIndex, finish: number = start + length;
    if (!Number.isSafeInteger(length) || length < 1 || length > 100_000 || value.slice(finish, finish + end.length) !== end) break;
    attachments.push({ name: next[1], text: value.slice(start, finish) });
    const at: number = finish + end.length;
    if (at === value.length) return { prompt, attachments };
    pattern.lastIndex = at;
    next = pattern.exec(value);
    if (next?.index !== at) break;
  }
  // Malformed or user-edited wrappers remain fully visible, never discarded.
  return { prompt: value, attachments: [] };
}
export function joinPastedText(prompt: string, attachments: readonly PastedText[]): string {
  return [prompt, ...attachments.map(item => `[文本附件：${item.name}；字符数：${item.text.length}]\n${item.text}${end}`)].filter((value, index) => index > 0 || value.length > 0).join('\n\n');
}
export function nextPastedText(text: string, attachments: readonly PastedText[]): PastedText {
  let n = 1; while (attachments.some(item => item.name === `粘贴内容-${n}.txt`)) n++;
  return { name: `粘贴内容-${n}.txt`, text };
}
export function namedTextAttachment(name: string, text: string, attachments: readonly PastedText[]): PastedText {
  const cleaned = (name.split(/[\\/]/).pop() || '文件.txt').replace(/[\[\]\r\n；\0]/g, '_').slice(0, 100) || '文件.txt';
  let unique = cleaned, n = 2;
  while (attachments.some(item => item.name === unique)) unique = `${cleaned} (${n++})`;
  return { name: unique, text };
}
export function largeInsertion(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let a = before.length, b = after.length;
  while (a > start && b > start && before[a - 1] === after[b - 1]) { a--; b--; }
  return b - start > LARGE_PASTE_LENGTH ? { start, end: a, text: after.slice(start, b) } : undefined;
}
