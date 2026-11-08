import { sha256 } from '@noble/hashes/sha2.js';
import { validContextReferences, type ContextReference } from './context-references';

export interface DiffLine { raw: string; text: string; hunk: number; oldLine?: number; newLine?: number }
export interface ParsedDiff { lines: DiffLine[]; oldPath?: string; newPath?: string; revision: string; error?: string }
const safePath = (path: string) => path.length > 0 && new TextEncoder().encode(path).length <= 1024 && !/[\\:*?"<>|\p{Cc}\p{Cf}]/u.test(path)
  && path.split('/').every(part => part && part !== '.' && part !== '..' && part.trim() === part);
export const diffSourceRevision = (path: string, diff: string) => Array.from(sha256(new TextEncoder().encode(JSON.stringify(['diff-v1', path, diff]))), n => n.toString(16).padStart(2, '0')).join('');

/** Coordinates come only from complete unified hunks, never from display rows.
 * Combined patches, malformed/truncated hunks and missing file names stay read-only. */
export function parseDiffForAnnotations(path: string, diff: string): ParsedDiff {
  const result: ParsedDiff = { lines: [], revision: diffSourceRevision(path, diff) };
  const fail = (reason: string) => ({ ...result, error: reason });
  let oldPath: string | undefined, newPath: string | undefined, old = 0, next = 0, leftOld = 0, leftNew = 0, hunk = -1;
  let oldEnd = 0, newEnd = 0, oldHeader = false, newHeader = false, fileHeaders = 0;
  const lines = diff.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  for (const raw of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(raw);
    if (match) {
      if (leftOld || leftNew) return fail('差异内容不完整，无法可靠标注行号');
      old = Number(match[1]); leftOld = match[2] === undefined ? 1 : Number(match[2]);
      next = Number(match[3]); leftNew = match[4] === undefined ? 1 : Number(match[4]);
      if (![old, next, leftOld, leftNew, old + leftOld, next + leftNew].every(Number.isSafeInteger)
        || (leftOld > 0 && old < 1) || (leftNew > 0 && next < 1) || old < oldEnd || next < newEnd) return fail('差异行号无效，暂时只能查看');
      oldEnd = old + leftOld; newEnd = next + leftNew; hunk += 1;
      result.lines.push({ raw, text: raw, hunk }); continue;
    }
    if (hunk >= 0 && (leftOld || leftNew)) {
      if (raw === '\\ No newline at end of file') { result.lines.push({ raw, text: raw, hunk }); continue; }
      const line: DiffLine = { raw, text: raw.slice(1), hunk };
      if (raw[0] === ' ' && leftOld > 0 && leftNew > 0) { line.oldLine = old++; line.newLine = next++; leftOld--; leftNew--; }
      else if (raw[0] === '-' && leftOld > 0) { line.oldLine = old++; leftOld--; }
      else if (raw[0] === '+' && leftNew > 0) { line.newLine = next++; leftNew--; }
      else return fail('差异内容与行号不一致，暂时只能查看');
      result.lines.push(line); continue;
    }
    if (raw.startsWith('--- ')) {
      if (oldHeader || hunk >= 0) return fail('请分别打开每个文件后添加批注');
      oldHeader = true; oldPath = raw.slice(4).split('\t')[0].replace(/^a\//, '');
      result.oldPath = oldPath === '/dev/null' ? undefined : oldPath;
    } else if (raw.startsWith('+++ ')) {
      if (newHeader || hunk >= 0) return fail('请分别打开每个文件后添加批注');
      newHeader = true; newPath = raw.slice(4).split('\t')[0].replace(/^b\//, '');
      result.newPath = newPath === '/dev/null' ? undefined : newPath;
    } else if (raw.startsWith('diff --git ')) {
      if (++fileHeaders > 1 || hunk >= 0) return fail('请分别打开每个文件后添加批注');
    } else if (raw.startsWith('@@') || /^[ +\-]/.test(raw)) return fail('差异格式不完整，暂时只能查看');
    result.lines.push({ raw, text: raw, hunk: -1 });
  }
  if (leftOld || leftNew || hunk < 0) return fail('没有完整差异行号，暂时只能查看');
  if (oldHeader !== newHeader) return fail('差异文件头不完整，暂时只能查看');
  if (!oldHeader) oldPath = newPath = path;
  result.oldPath = oldPath === '/dev/null' ? undefined : oldPath;
  result.newPath = newPath === '/dev/null' ? undefined : newPath;
  if ((!result.oldPath && !result.newPath) || (result.oldPath && !safePath(result.oldPath)) || (result.newPath && !safePath(result.newPath))) return fail('差异文件路径无法确认，暂时只能查看');
  if (result.lines.some(line => line.oldLine !== undefined && !result.oldPath || line.newLine !== undefined && !result.newPath)) return fail('差异行号与文件版本不一致');
  return result;
}

export function diffSelectionReference(parsed: ParsedDiff, sessionKey: string, side: 'old' | 'new', first: number, last = first, annotation = ''): ContextReference {
  const path = side === 'old' ? parsed.oldPath : parsed.newPath, coordinate = side === 'old' ? 'oldLine' : 'newLine';
  if (parsed.error || !path || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) throw new Error('请在同一侧选择有效的差异行');
  const selected = parsed.lines.filter(line => line[coordinate] !== undefined && line[coordinate]! >= first && line[coordinate]! <= last);
  if (selected.length !== last - first + 1 || selected.some((line, index) => line[coordinate] !== first + index || line.hunk !== selected[0].hunk)) throw new Error('不能跨越未显示的行或不同差异段，请分开添加批注');
  const ref: ContextReference = { kind: 'diff', sessionKey, path, side, label: path.split('/').pop()!, sourceRevision: parsed.revision,
    startLine: first, endLine: last, text: selected.map(line => line.text).join('\n'), annotation, capturedAt: Date.now() };
  if (!validContextReferences([ref])) throw new Error('所选内容为空、路径过长或超过引用限制，请缩小范围');
  return ref;
}
