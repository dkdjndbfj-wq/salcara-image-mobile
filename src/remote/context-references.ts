/** Explicit, immutable user-selected snapshots. These labels never authorize
 * reading a file, navigating a task, or executing an instruction. */
export interface ContextReference {
  kind: 'file' | 'message' | 'diff'; sessionKey?: string; projectPath?: string; label: string; text: string; capturedAt: number;
  path?: string; messageId?: string; startLine?: number; endLine?: number; startOffset?: number; endOffset?: number;
  /** Selection coordinates are explicitly either canonical source or one rendered block. */
  textBasis?: 'source' | 'rendered'; blockIndex?: number; sourceRevision?: string; annotation?: string;
  /** Diff coordinates always identify the old or new side of a saved patch. */
  side?: 'old' | 'new';
}
export const MAX_CONTEXT_REFERENCE_BYTES = 32 * 1024;
export const MAX_CONTEXT_ANNOTATION_BYTES = 8 * 1024;
export const MAX_CONTEXT_TOTAL_BYTES = 64 * 1024;
export const contextBytes = (text: string) => new TextEncoder().encode(text).length;
const fields = new Set(['kind', 'sessionKey', 'projectPath', 'label', 'text', 'capturedAt', 'path', 'messageId', 'startLine', 'endLine', 'startOffset', 'endOffset', 'textBasis', 'blockIndex', 'sourceRevision', 'annotation', 'side']);
const safe = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && contextBytes(v) <= max && !/[\p{Cc}\p{Cf}]/u.test(v);
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
export function validContextReferences(value: unknown): value is ContextReference[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  let bytes = 0;
  return value.every(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !fields.has(key))) return false;
    const v = raw as ContextReference;
    if (v.sessionKey !== undefined && (!safe(v.sessionKey, 256) || !/^[a-z][a-z0-9_-]*:[^|]+$/i.test(v.sessionKey)) || !safe(v.label, 200)
      || typeof v.text !== 'string' || !v.text.length || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.text)
      || !integer(v.capturedAt, 1)) return false;
    if (v.annotation !== undefined && (typeof v.annotation !== 'string' || contextBytes(v.annotation) > MAX_CONTEXT_ANNOTATION_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.annotation))) return false;
    const annotated = v.textBasis !== undefined;
    if (v.kind === 'diff' ? v.textBasis !== undefined || v.blockIndex !== undefined || typeof v.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(v.sourceRevision) || (v.side !== 'old' && v.side !== 'new')
      : v.side !== undefined || (annotated ? (v.textBasis !== 'source' && v.textBasis !== 'rendered' || typeof v.sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(v.sourceRevision)
      || (v.textBasis === 'rendered' ? !integer(v.blockIndex) || v.blockIndex! > 100000 : v.blockIndex !== undefined))
      : v.blockIndex !== undefined || v.sourceRevision !== undefined || v.annotation !== undefined)) return false;
    const size = contextBytes(v.text); bytes += size + contextBytes(v.annotation ?? '');
    if (size > MAX_CONTEXT_REFERENCE_BYTES || bytes > MAX_CONTEXT_TOTAL_BYTES) return false;
    if (v.kind === 'file' || v.kind === 'diff') return (v.kind === 'diff' ? v.sessionKey !== undefined && v.projectPath === undefined
      : v.sessionKey !== undefined && v.projectPath === undefined || v.sessionKey === undefined && safe(v.projectPath, 4096)) && safe(v.path, 1024) && !/[\\:*?"<>|]/.test(v.path)
      && v.path.split('/').every(part => part && part !== '.' && part !== '..' && part.trim() === part)
      && integer(v.startLine, 1) && integer(v.endLine, v.startLine!) && v.endLine! - v.startLine! + 1 === v.text.split('\n').length
      && v.messageId === undefined && v.startOffset === undefined && v.endOffset === undefined && !annotated;
    return v.kind === 'message' && v.sessionKey !== undefined && v.projectPath === undefined && safe(v.messageId, 256) && integer(v.startOffset) && integer(v.endOffset, v.startOffset!)
      && v.endOffset! - v.startOffset! === v.text.length && v.path === undefined && v.startLine === undefined && v.endLine === undefined;
  });
}
export function copyContextReferences(value: unknown): ContextReference[] | undefined {
  return validContextReferences(value) ? value.map(item => ({ ...item })) : undefined;
}
export const contextReferenceKey = (r: ContextReference) => JSON.stringify([r.kind, r.sessionKey ?? r.projectPath, r.path ?? r.messageId, r.startLine ?? r.startOffset, r.endLine ?? r.endOffset, r.textBasis ?? null, r.blockIndex ?? null, r.sourceRevision ?? null, ...(r.kind === 'diff' ? [r.side] : [])]);
export const isResponseAnnotation = (r: ContextReference) => r.kind === 'message' && r.textBasis !== undefined;
export const isContextAnnotation = (r: ContextReference) => r.kind === 'diff' || isResponseAnnotation(r);
export const hasDiffAnnotations = (references?: readonly ContextReference[]) => references?.some(r => r.kind === 'diff') === true;
export const hasResponseAnnotations = (references?: readonly ContextReference[]) => references?.some(isResponseAnnotation) === true;
export function appendContextReference(current: readonly ContextReference[], next: ContextReference): ContextReference[] {
  const result = [...current.filter(item => contextReferenceKey(item) !== contextReferenceKey(next)), { ...next }];
  if (!validContextReferences(result)) throw new Error('最多引用 8 项，每项不超过 32 KB、合计不超过 64 KB；请缩小引用范围');
  return result;
}
export interface ContextQuery { query: string; start: number; end: number; source: string }
export function parseContextQuery(text: string, caret = text.length): ContextQuery | undefined {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return;
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0, caret));
  return match ? { query: match[1], start: caret - match[1].length - 1, end: caret, source: text } : undefined;
}
/** Line selection retains every character in the selected lines, including code. */
export function referenceLineRange(text: string, first: number, last: number): { text: string; start: number; end: number } {
  const lines = text.split('\n');
  if (!integer(first, 1) || !integer(last, first) || last > lines.length) throw new Error('引用行范围无效');
  const start = lines.slice(0, first - 1).reduce((n, line) => n + line.length + 1, 0);
  const selected = lines.slice(first - 1, last).join('\n');
  if (!selected.length || contextBytes(selected) > MAX_CONTEXT_REFERENCE_BYTES) throw new Error('所选内容为空或超过 32 KB，请缩小引用范围');
  return { text: selected, start, end: start + selected.length };
}

export function validateContextPrompt(text: string, references?: readonly ContextReference[], skillCount = 0): void {
  if ((references?.length || skillCount) && contextBytes(text) > 64 * 1024) throw new Error('带技能或引用的任务正文最多 64 KB，请缩短正文后发送');
}
