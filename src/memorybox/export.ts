import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { strToU8, zipSync } from 'fflate';

import { loadBox } from './store';
import { NOTE_TYPE_META, type Character, type MemLink, type MemNote } from './types';

/**
 * Exports a memory box as an Obsidian vault: one Markdown file per note with
 * YAML front matter and [[wiki links]], plus an index note for the character.
 */

/** File names Obsidian (and every OS) accepts; duplicates get “ 2”, “ 3”. */
export function vaultNames(notes: MemNote[]): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const note of notes) {
    const base = note.title.replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '未命名';
    let name = base;
    for (let index = 2; used.has(name.toLowerCase()); index += 1) name = `${base} ${index}`;
    used.add(name.toLowerCase());
    names.set(note.id, name);
  }
  return names;
}

const iso = (time: number | null) => (time ? new Date(time).toISOString().slice(0, 10) : '');
const yaml = (value: string) => JSON.stringify(value);

export function noteMarkdown(note: MemNote, names: Map<string, string>, links: MemLink[]): string {
  const lines = [
    '---',
    `type: ${yaml(NOTE_TYPE_META[note.type]?.label ?? note.type)}`,
    `importance: ${note.importance}`,
    `created: ${iso(note.createdAt)}`,
    `valid_from: ${iso(note.validFrom)}`,
    ...(note.validTo ? [`valid_to: ${iso(note.validTo)}`] : []),
    ...(note.pinned ? ['pinned: true'] : []),
    ...(note.aboutUser ? ['about_user: true'] : []),
    ...(note.rangeStart ? [`covers: ${yaml(`${iso(note.rangeStart)} ~ ${iso(note.rangeEnd)}`)}`] : []),
    `tags: [${[NOTE_TYPE_META[note.type]?.label ?? note.type, ...note.tags].map(yaml).join(', ')}]`,
    '---',
    '',
    `# ${note.title}`,
    '',
    note.content,
  ];
  const outgoing = links.filter((link) => link.source === note.id && names.has(link.target));
  const incoming = links.filter((link) => link.target === note.id && names.has(link.source));
  if (note.supersededBy && names.has(note.supersededBy)) lines.push('', `> 已被 [[${names.get(note.supersededBy)}]] 取代`);
  if (outgoing.length) lines.push('', '## 关联', ...outgoing.map((link) => `- ${link.relation}：[[${names.get(link.target)}]]`));
  if (incoming.length) lines.push('', '## 被提及', ...incoming.map((link) => `- [[${names.get(link.source)}]]（${link.relation}）`));
  return `${lines.join('\n')}\n`;
}

export function vaultFiles(character: Character, notes: MemNote[], links: MemLink[]): Record<string, Uint8Array> {
  const names = vaultNames(notes);
  const folder = character.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || '记忆匣';
  const files: Record<string, Uint8Array> = {};
  for (const note of notes) files[`${folder}/${names.get(note.id)}.md`] = strToU8(noteMarkdown(note, names, links));
  const index = [
    `# ${character.name} 的记忆匣`, '',
    character.coreMemory ? `## 核心记忆\n\n${character.coreMemory}\n` : '',
    '## 全部记忆', '',
    ...notes.filter((note) => note.type !== 'episode').sort((a, b) => b.importance - a.importance).map((note) => `- [[${names.get(note.id)}]]`),
    '', '## 往事', '',
    ...notes.filter((note) => note.type === 'episode').sort((a, b) => (a.rangeStart ?? 0) - (b.rangeStart ?? 0)).map((note) => `- [[${names.get(note.id)}]]`),
  ].join('\n');
  files[`${folder}/_${character.name} 的记忆匣.md`] = strToU8(`${index}\n`);
  return files;
}

export async function exportVault(character: Character): Promise<void> {
  const box = await loadBox(character.id);
  const zipped = zipSync(vaultFiles(character, box.notes, box.links), { level: 6 });
  const directory = new Directory(Paths.cache, 'memory-export');
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${character.name}-记忆匣.zip`);
  file.create({ overwrite: true, intermediates: true });
  file.write(zipped);
  if (!(await Sharing.isAvailableAsync())) throw new Error('当前设备不支持系统分享');
  await Sharing.shareAsync(file.uri, { mimeType: 'application/zip', dialogTitle: `${character.name} 的记忆匣（Obsidian）` });
}
