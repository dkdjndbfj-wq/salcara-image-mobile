/**
 * Turns a streamed Markdown reply into speakable sentences. Sentences are cut
 * as soon as they end so speech can start while the model is still writing;
 * the first piece is cut early (at a comma) to make the reply feel instant.
 */

const HARD_STOPS = new Set(['。', '！', '？', '!', '?', '；', ';', '\n', '…']);
const SOFT_STOPS = new Set(['，', ',', '、', '：', ':']);

/** Removes Markdown so a voice doesn't read symbols aloud. */
export function toSpeakable(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, '（这里有一段代码，可以在对话里查看）')
    .replace(/<<<IMAGE[\s\S]*?(>>>|$)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/\|/g, '，')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function isSentenceEnd(text: string, index: number): boolean {
  const char = text[index];
  if (HARD_STOPS.has(char)) return true;
  // English full stop followed by whitespace (not a decimal point like 3.14).
  return char === '.' && /\s/.test(text[index + 1] ?? '') && !/\d/.test(text[index - 1] ?? '');
}

/**
 * Returns the complete sentences in `raw` after `from`, and where the next call
 * should continue. With `final`, the remainder is flushed too.
 */
export function takeSentences(raw: string, from: number, final: boolean, first = false): { sentences: string[]; next: number } {
  const sentences: string[] = [];
  let start = from;
  let fence = (raw.slice(0, from).match(/```/g)?.length ?? 0) % 2 === 1;
  const push = (end: number) => {
    const speakable = toSpeakable(raw.slice(start, end));
    if (/[\p{L}\p{N}]/u.test(speakable)) sentences.push(speakable);
    start = end;
  };
  for (let index = from; index < raw.length; index += 1) {
    if (raw.startsWith('```', index)) {
      fence = !fence;
      index += 2;
      if (!fence) push(index + 1);
      continue;
    }
    if (fence) continue;
    const length = index - start;
    if (isSentenceEnd(raw, index) && length >= 1) { push(index + 1); continue; }
    const wantSoft = (first && sentences.length === 0 && length >= 8) || length >= 60;
    if (wantSoft && SOFT_STOPS.has(raw[index])) push(index + 1);
  }
  if (final && !fence && start < raw.length) push(raw.length);
  if (final && fence && start < raw.length) push(raw.length);
  return { sentences, next: start };
}
