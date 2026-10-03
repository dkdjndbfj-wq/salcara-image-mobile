import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { strFromU8, strToU8, Unzip, UnzipInflate, Zip, ZipDeflate } from 'fflate';

import type { Conversation, ChatMessage } from '../domain';
import { database, listMessages } from './database';

/**
 * Getting conversations off the phone.
 *
 * - One conversation as Markdown, shared through the system sheet.
 * - A full backup (.zip): every conversation, the assistant's memories and agents,
 *   the chat characters with their memory boxes, plus the pictures and files they
 *   use. API keys, pairings and app settings are not included. Restoring merges:
 *   anything already on the phone stays as it is.
 *
 * Both archives are written and read in small pieces so a backup with many
 * pictures does not have to fit in memory.
 */

// ——— Markdown ———

const two = (value: number) => String(value).padStart(2, '0');
export function stamp(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function conversationMarkdown(title: string, messages: ChatMessage[], now = Date.now()): string {
  const lines = [`# ${title.trim() || '对话'}`, '', `> 导出自 Salcara · ${stamp(now)} · ${messages.length} 条消息`, ''];
  for (const message of messages) {
    if (message.role === 'user') {
      lines.push(`## 你 · ${stamp(message.createdAt)}`, '');
      if (message.prompt.trim()) lines.push(message.prompt.trim(), '');
      const attached = [
        ...message.references.map((item, index) => item.name ?? `图片 ${index + 1}`),
        ...(message.documents ?? []).map((item) => item.name),
      ];
      if (attached.length) lines.push(`> 附件：${attached.join('、')}`, '');
      continue;
    }
    const who = message.analysisModel || message.model;
    lines.push(`## 助手${who ? `（${who}）` : ''}`, '');
    const text = (message.text ?? '').trim();
    if (text) lines.push(text, '');
    if (message.imageUri || message.remoteImageUrl) lines.push(`> 生成了一张图片${message.preparedPrompt ? `：${message.preparedPrompt.trim()}` : ''}`, '');
    const sources = message.agent?.sources ?? [];
    if (sources.length) lines.push('**来源**', '', ...sources.map((source, index) => `${index + 1}. [${source.title || source.url}](${source.url})`), '');
    if (message.status === 'error' && message.error) lines.push(`> 没有完成：${message.error}`, '');
    if ((message.status === 'cancelled' || message.status === 'interrupted') && !text) lines.push('> 已停止', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function safeFileName(name: string, fallback = '对话'): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;
}

function exportDirectory(): Directory {
  const directory = new Directory(Paths.cache, 'exports');
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

export async function shareConversationMarkdown(conversation: Pick<Conversation, 'id' | 'title'>): Promise<void> {
  const messages = await listMessages(conversation.id);
  if (!messages.length) throw new Error('这个对话还没有消息');
  const file = new File(exportDirectory(), `${safeFileName(conversation.title)}.md`);
  file.create({ overwrite: true, intermediates: true });
  file.write(conversationMarkdown(conversation.title, messages));
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持系统分享');
  await Sharing.shareAsync(file.uri, { mimeType: 'text/markdown', dialogTitle: `导出“${conversation.title}”`, UTI: 'net.daringfireball.markdown' });
}

// ——— Full backup ———

const FORMAT = 'salcara-backup';
const VERSION = 1;
/** Parents first: messages need their conversation (foreign key). */
export const BACKUP_TABLES = ['conversations', 'messages', 'memories', 'agents', 'characters', 'reactions', 'mem_notes', 'mem_links'] as const;
const FILE_FOLDERS = ['generated-images', 'reference-images', 'reference-documents', 'generated-files', 'avatars'];
const CHUNK = 256 * 1024;
const MANIFEST = 'backup.json';

type Row = Record<string, unknown>;
export interface BackupManifest {
  format: typeof FORMAT;
  version: number;
  createdAt: number;
  /** The app's document folder when the backup was made; file paths in rows are rewritten to the new one. */
  root: string;
  tables: Partial<Record<(typeof BACKUP_TABLES)[number], Row[]>>;
}
export interface BackupProgress { stage: 'data' | 'files' | 'writing'; done: number; total: number }

const withSlash = (uri: string) => (uri.endsWith('/') ? uri : `${uri}/`);
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A zip entry name inside the document folder; anything trying to leave it is refused. */
export function safeEntryPath(name: string): string | null {
  if (!name.startsWith('files/')) return null;
  const rel = name.slice('files/'.length);
  if (!rel || rel.endsWith('/') || rel.includes('\\') || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  if (!FILE_FOLDERS.includes(parts[0])) return null;
  return rel;
}

/** Points file paths saved in rows at this install's document folder. */
export function rebaseRows(rows: Row[], from: string, to: string): Row[] {
  if (!from || from === to) return rows;
  return rows.map((row) => {
    const next: Row = {};
    for (const [key, value] of Object.entries(row)) next[key] = typeof value === 'string' && value.includes(from) ? value.split(from).join(to) : value;
    return next;
  });
}

function listFiles(directory: Directory, out: File[]) {
  if (!directory.exists) return;
  for (const item of directory.list()) {
    if (item instanceof Directory) listFiles(item, out);
    else out.push(item);
  }
}

export async function exportBackup(onProgress?: (progress: BackupProgress) => void): Promise<void> {
  const db = await database();
  const tables: BackupManifest['tables'] = {};
  for (const [index, table] of BACKUP_TABLES.entries()) {
    onProgress?.({ stage: 'data', done: index, total: BACKUP_TABLES.length });
    tables[table] = await db.getAllAsync<Row>(`SELECT * FROM ${table}`);
  }
  const root = withSlash(Paths.document.uri);
  const manifest: BackupManifest = { format: FORMAT, version: VERSION, createdAt: Date.now(), root, tables };

  const files: File[] = [];
  for (const folder of FILE_FOLDERS) listFiles(new Directory(Paths.document, folder), files);

  const date = new Date();
  const out = new File(exportDirectory(), `Salcara-备份-${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}.zip`);
  out.create({ overwrite: true, intermediates: true });
  const handle = out.open(FileMode.Truncate);
  let failure: Error | null = null;
  try {
    const zip = new Zip((error, chunk) => { if (error) failure = error; else if (chunk.length) handle.writeBytes(chunk); });
    const data = new ZipDeflate(MANIFEST, { level: 6 });
    zip.add(data);
    data.push(strToU8(JSON.stringify(manifest)), true);
    for (const [index, file] of files.entries()) {
      if (failure) throw failure;
      onProgress?.({ stage: 'files', done: index, total: files.length });
      if (!file.uri.startsWith(root)) continue;
      // Pictures and PDFs are compressed already, so level 0 (stored deflate blocks). Not a plain stored
      // entry: its size is only known at the end, and restoring reads the zip as a stream, which needs
      // the self-terminating deflate format to find where each file ends.
      const entry = new ZipDeflate(`files/${decodeURIComponent(file.uri.slice(root.length))}`, { level: 0 });
      zip.add(entry);
      const input = file.open(FileMode.ReadOnly);
      try {
        for (;;) {
          const bytes = input.readBytes(CHUNK);
          if (!bytes.length) break;
          entry.push(bytes);
          if (bytes.length < CHUNK) break;
        }
      } finally { input.close(); }
      entry.push(new Uint8Array(0), true);
      await pause();
    }
    onProgress?.({ stage: 'writing', done: files.length, total: files.length });
    zip.end();
    if (failure) throw failure;
  } catch (error) {
    handle.close();
    try { out.delete(); } catch { /* best effort */ }
    throw error;
  }
  handle.close();
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持系统分享');
  await Sharing.shareAsync(out.uri, { mimeType: 'application/zip', dialogTitle: '保存 Salcara 备份' });
}

export interface RestoreResult { conversations: number; messages: number; characters: number; files: number }

/** Lets the person pick a backup and merges it in. null: nothing was picked. */
export async function pickAndRestoreBackup(onProgress?: (progress: BackupProgress) => void): Promise<RestoreResult | null> {
  const picked = await DocumentPicker.getDocumentAsync({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], copyToCacheDirectory: true, multiple: false });
  if (picked.canceled || !picked.assets?.[0]) return null;
  const source = new File(picked.assets[0].uri);
  try { return await restoreBackup(source, onProgress); }
  finally { try { source.delete(); } catch { /* the picker's copy; the system clears it anyway */ } }
}

export async function restoreBackup(source: File, onProgress?: (progress: BackupProgress) => void): Promise<RestoreResult> {
  const root = withSlash(Paths.document.uri);
  const manifestChunks: Uint8Array[] = [];
  let files = 0;
  let failure: Error | null = null;
  const open: Array<{ close(): void }> = [];

  const unzip = new Unzip((stream) => {
    if (stream.name === MANIFEST) {
      stream.ondata = (error, chunk) => { if (error) failure = error; else manifestChunks.push(chunk); };
      stream.start();
      return;
    }
    const rel = safeEntryPath(stream.name);
    if (!rel) return; // unknown entries are skipped (not started, never decompressed)
    const target = new File(Paths.document, rel);
    if (target.exists) return; // already on this phone
    target.create({ intermediates: true });
    const handle = target.open(FileMode.Truncate);
    open.push(handle);
    stream.ondata = (error, chunk, final) => {
      if (error) { failure = error; return; }
      if (chunk.length) handle.writeBytes(chunk);
      if (final) { handle.close(); open.splice(open.indexOf(handle), 1); files += 1; }
    };
    stream.start();
  });
  unzip.register(UnzipInflate);

  const input = source.open(FileMode.ReadOnly);
  const total = input.size ?? source.size ?? 0;
  let read = 0;
  try {
    for (;;) {
      const bytes = input.readBytes(CHUNK);
      read += bytes.length;
      const last = bytes.length < CHUNK;
      unzip.push(bytes, last);
      if (failure) throw failure;
      onProgress?.({ stage: 'files', done: read, total });
      if (last) break;
      await pause();
    }
  } catch (error) {
    throw error instanceof Error && /invalid|unexpected|zip/i.test(error.message) ? new Error('这个文件不是 Salcara 备份，或者已经损坏') : error;
  } finally {
    input.close();
    open.forEach((handle) => { try { handle.close(); } catch { /* ignore */ } });
  }

  let manifest: BackupManifest;
  try {
    const length = manifestChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const all = new Uint8Array(length);
    let offset = 0;
    for (const chunk of manifestChunks) { all.set(chunk, offset); offset += chunk.length; }
    manifest = JSON.parse(strFromU8(all)) as BackupManifest;
  } catch { throw new Error('这个文件不是 Salcara 备份，或者已经损坏'); }
  if (manifest?.format !== FORMAT || typeof manifest.tables !== 'object') throw new Error('这个文件不是 Salcara 备份，或者已经损坏');
  if (manifest.version > VERSION) throw new Error('这个备份来自更新版本的 Salcara，请先更新应用');

  onProgress?.({ stage: 'data', done: 0, total: BACKUP_TABLES.length });
  const inserted = await mergeRows(manifest, root);
  return { conversations: inserted.conversations ?? 0, messages: inserted.messages ?? 0, characters: inserted.characters ?? 0, files };
}

async function mergeRows(manifest: BackupManifest, root: string): Promise<Record<string, number>> {
  const db = await database();
  const counts: Record<string, number> = {};
  await db.withTransactionAsync(async () => {
    for (const table of BACKUP_TABLES) {
      const rows = rebaseRows(manifest.tables[table] ?? [], typeof manifest.root === 'string' ? manifest.root : '', root);
      if (!rows.length) continue;
      // Only columns this version knows; a newer backup's extra columns are dropped, missing ones take defaults.
      const columns = new Set((await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`)).map((column) => column.name));
      let count = 0;
      for (const row of rows) {
        const keys = Object.keys(row).filter((key) => columns.has(key));
        if (!keys.length) continue;
        const result = await db.runAsync(
          `INSERT OR IGNORE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
          ...keys.map((key) => row[key] as string | number | null),
        );
        count += result.changes;
      }
      counts[table] = count;
    }
  });
  return counts;
}
