import { Directory, File, Paths } from 'expo-file-system';
import { getSetting } from '../storage/database';

export const ATTACHMENT_CACHE_BYTES = 64 * 1024 * 1024;
export const ATTACHMENT_CACHE_TTL = 7 * 86400_000;
const ROOT = 'salcara-remote-attachments';
const owners = ['remote_composer_drafts_v1', 'remote_queued_v1', 'remote_pending_delivery_v1', 'remote_image_canvas_sessions_v2'];
const leases = new Map<string, number>(), touched = new Map<string, number>();
let reserved = 0, tail: Promise<unknown> = Promise.resolve();
const serial = <T,>(run: () => Promise<T>): Promise<T> => { const next = tail.then(run, run); tail = next.catch(() => undefined); return next; };
const rootURI = () => new Directory(Paths.cache, ROOT).uri.replace(/\/$/, '') + '/';

/** A visible preview/editor holds a lease; retirement never deletes its file.
 * Draft/operation/canvas owners are also checked from disk before collection. */
export function retainCachedAttachment(uri?: string): () => void {
  try { if (!uri?.startsWith(rootURI())) return () => undefined; } catch { return () => undefined; }
  if (!uri) return () => undefined;
  leases.set(uri, (leases.get(uri) ?? 0) + 1); touched.set(uri, Date.now());
  let released = false;
  return () => { if (released) return; released = true; const count = (leases.get(uri) ?? 1) - 1;
    if (count > 0) leases.set(uri, count); else leases.delete(uri); touched.set(uri, Date.now()); };
}
export function touchCachedAttachment(uri: string): void { if (uri.startsWith(rootURI())) touched.set(uri, Date.now()); }

type Candidate = { file: File; bytes: number; access: number; partial: boolean; derived: boolean; id: string };
async function collect(reserve: number): Promise<{ bytes: number; removed: number }> {
  const root = new Directory(Paths.cache, ROOT), now = Date.now();
  if (!root.exists) return { bytes: 0, removed: 0 };
  // Unknown/corrupt ownership is never permission to remove a possible draft.
  const records = await Promise.all(owners.map(key => getSetting(key)));
  for (const raw of records) if (raw !== null) { if (raw.length > 16 * 1024 * 1024) throw new Error('图片引用记录过大，未清理'); JSON.parse(raw); }
  const files: Candidate[] = [];
  const walk = (directory: Directory, depth: number) => {
    for (const item of directory.list()) {
      if (!item.uri.startsWith(rootURI())) throw new Error('图片缓存路径无效');
      if (item instanceof Directory) {
        if (depth < 2 && /^[a-f0-9]{32}$/.test(item.name)) walk(item, depth + 1);
      } else if (item instanceof File) {
        const match = /^(att_[a-f0-9]{32})(?:-[A-Za-z0-9-]+)?\.(jpg|png|webp|part)$/.exec(item.name);
        if (!match) continue;
        if (files.length >= 10000) throw new Error('图片缓存清单过大，未清理');
        files.push({ file: item, bytes: item.size ?? 0, access: touched.get(item.uri) ?? item.modificationTime ?? now, partial: match[2] === 'part', derived: /-(?:thumbnail|preview|detail)-v1-/.test(item.name), id: match[1] });
      }
    }
  };
  walk(root, 0);
  let bytes = files.reduce((sum, item) => sum + item.bytes, 0), removed = 0, freed = 0;
  for (const candidate of files.sort((a, b) => Number(b.partial) - Number(a.partial) || Number(b.derived) - Number(a.derived) || a.access - b.access)) {
    const uri = candidate.file.uri;
    if (leases.has(uri) || now - candidate.access < 60_000) continue;
    // A canvas note stores attachment identity, while composers store URI.
    if (records.some(raw => raw?.includes(uri) || !candidate.derived && raw?.includes(candidate.id))) continue;
    const expired = candidate.access + (candidate.partial ? 3600_000 : ATTACHMENT_CACHE_TTL) <= now;
    if (!expired && (candidate.partial || bytes + reserved + reserve <= ATTACHMENT_CACHE_BYTES)) continue;
    if (removed >= 500 || freed + candidate.bytes > 50 * 1024 * 1024) break;
    if (leases.has(uri)) continue;
    try { if (candidate.file.exists) candidate.file.delete(); if (candidate.file.exists) continue; }
    catch { continue; }
    bytes -= candidate.bytes; freed += candidate.bytes; removed++; touched.delete(uri);
  }
  return { bytes, removed };
}
export function collectAttachmentCache(): Promise<{ bytes: number; removed: number }> { return serial(() => collect(0)); }
export async function reserveAttachmentCache(bytes: number): Promise<() => void> {
  await serial(async () => {
    const result = await collect(bytes);
    if (result.bytes + reserved + bytes > ATTACHMENT_CACHE_BYTES) throw new Error('图片缓存空间不足；待发送图片已保留，请关闭预览或处理待确认内容');
    reserved += bytes;
  });
  let released = false;
  return () => { if (!released) { released = true; reserved -= bytes; } };
}
