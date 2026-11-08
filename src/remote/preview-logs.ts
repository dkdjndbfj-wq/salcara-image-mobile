/** Runtime observations are inert text. Only an explicit user action adds them to a draft. */
export type PreviewLogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';
export interface PreviewLogEntry { id: string; level: PreviewLogLevel; message: string; source?: string; line?: number; column?: number; truncated?: boolean }
export const PREVIEW_LOG_LIMIT = 64;
export const PREVIEW_LOG_CHARS = 32000;
const levels = new Set(['debug', 'log', 'info', 'warn', 'error']);
const position = (value: unknown) => value === undefined || Number.isSafeInteger(value) && Number(value) > 0 && Number(value) < 100000000;
export function parsePreviewLog(value: unknown): PreviewLogEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const entry = value as PreviewLogEntry;
  if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(entry.id) || !levels.has(entry.level)
    || typeof entry.message !== 'string' || !entry.message || entry.message.length > 2000
    || entry.source !== undefined && (typeof entry.source !== 'string' || entry.source.length > 1024)
    || !position(entry.line) || !position(entry.column) || entry.truncated !== undefined && typeof entry.truncated !== 'boolean') return;
  const clean = (text: string) => text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return { id: entry.id, level: entry.level, message: clean(entry.message), ...(entry.source ? { source: clean(entry.source) } : {}),
    ...(entry.line ? { line: entry.line } : {}), ...(entry.column ? { column: entry.column } : {}), ...(entry.truncated ? { truncated: true } : {}) };
}
export function appendPreviewLog(entries: readonly PreviewLogEntry[], entry: PreviewLogEntry): PreviewLogEntry[] {
  if (entries.some(item => item.id === entry.id)) return entries as PreviewLogEntry[];
  const next = [...entries, entry].slice(-PREVIEW_LOG_LIMIT);
  let chars = next.reduce((sum, item) => sum + item.message.length + (item.source?.length ?? 0), 0);
  while (chars > PREVIEW_LOG_CHARS && next.length > 1) { const first = next.shift()!; chars -= first.message.length + (first.source?.length ?? 0); }
  return next;
}
export function previewLogLocation(entry: PreviewLogEntry): string {
  return `${entry.source ?? ''}${entry.line ? `:${entry.line}${entry.column ? `:${entry.column}` : ''}` : ''}`;
}
export function previewLogsDraft(entries: readonly PreviewLogEntry[], origin: string): string {
  if (!entries.length) throw new Error('请先选择日志');
  const text = `预览日志\n来源：${origin}\n\n${entries.map(entry => `[${entry.level}] ${entry.message}${entry.truncated ? '\n[本条日志过长，内容已截断]' : ''}${previewLogLocation(entry) ? `\n位置：${previewLogLocation(entry)}` : ''}`).join('\n\n')}`;
  if (new TextEncoder().encode(text).length > 60 * 1024) throw new Error('所选日志过长，请分批加入对话');
  return text;
}
/** Process stdout has no browser source location or reliable severity; do not invent either. */
export function projectRunLogEntries(logs: string, source: string, error?: string): PreviewLogEntry[] {
  const lines = logs.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').split(/\r?\n/);
  let entries: PreviewLogEntry[] = [];
  const fingerprint = (text: string) => { let hash = 2166136261; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return (hash >>> 0).toString(36); };
  lines.forEach((message, index) => { if (message) entries = appendPreviewLog(entries, { id: `process:${index}:${fingerprint(message)}`, level: 'log', message: message.slice(0, 2000), source, ...(message.length > 2000 ? { truncated: true } : {}) }); });
  if (error) entries = appendPreviewLog(entries, { id: 'process:error', level: 'error', message: error.slice(0, 2000), source, ...(error.length > 2000 ? { truncated: true } : {}) });
  return entries;
}
