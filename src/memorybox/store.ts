import { useEffect, useState, useSyncExternalStore } from 'react';

import { createId } from '../domain-utils';
import { database } from '../storage/database';
import { NOTE_TYPES, type Character, type MemLink, type MemNote, type MemoryMode, type NoteType } from './types';

/**
 * Storage for the memory box. Notes and links of one character are cached in
 * memory once loaded (retrieval scores all of them), and screens subscribe to
 * changes per character.
 */

type NoteRow = {
  id: string; owner: string; type: string; title: string; content: string; tags_json: string; importance: number;
  about_user: number; pinned: number; valid_from: number; valid_to: number | null; superseded_by: string | null;
  source_conversation_id: string | null; source_message_id: string | null; range_start: number | null; range_end: number | null;
  level: number; rolled_up: number; embedding: string | null; embedding_model: string | null; x: number | null; y: number | null;
  access_count: number; last_accessed_at: number | null; created_at: number; updated_at: number;
};
type LinkRow = { id: string; owner: string; source: string; target: string; relation: string; weight: number; created_at: number };
type CharacterRow = {
  id: string; name: string; icon: string; avatar_uri: string | null; color: string; persona: string; style: string; relationship: string; greeting: string;
  can_draw: number; can_search: number; provider_id: string | null; model: string | null; memory_mode: string; core_memory: string;
  conversation_id: string | null; extracted_until: number; compacted_until: number; notes_since_reflection: number;
  last_message_at: number; created_at: number; updated_at: number;
};

function parseList(json: string | null): unknown[] {
  try { const value: unknown = JSON.parse(json || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}

export function mapNote(row: NoteRow): MemNote {
  let embedding: number[] | null = null;
  if (row.embedding) { const list = parseList(row.embedding); embedding = list.length && list.every((value) => typeof value === 'number') ? list as number[] : null; }
  return {
    id: row.id, owner: row.owner, type: (NOTE_TYPES as string[]).includes(row.type) ? row.type as NoteType : 'fact',
    title: row.title, content: row.content, tags: parseList(row.tags_json).filter((item): item is string => typeof item === 'string'),
    importance: Math.max(1, Math.min(10, Math.round(row.importance || 5))), aboutUser: row.about_user === 1, pinned: row.pinned === 1,
    validFrom: row.valid_from, validTo: row.valid_to, supersededBy: row.superseded_by,
    sourceConversationId: row.source_conversation_id, sourceMessageId: row.source_message_id,
    rangeStart: row.range_start, rangeEnd: row.range_end, level: row.level, rolledUp: row.rolled_up === 1,
    embedding, embeddingModel: row.embedding_model, x: row.x, y: row.y,
    accessCount: row.access_count, lastAccessedAt: row.last_accessed_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapCharacter(row: CharacterRow): Character {
  return {
    id: row.id, name: row.name, icon: row.icon, avatarUri: row.avatar_uri ?? null, color: row.color, persona: row.persona, style: row.style, relationship: row.relationship,
    greeting: row.greeting, canDraw: row.can_draw === 1, canSearch: row.can_search === 1, providerId: row.provider_id, model: row.model,
    memoryMode: (['auto', 'explicit', 'off'] as MemoryMode[]).includes(row.memory_mode as MemoryMode) ? row.memory_mode as MemoryMode : 'auto',
    coreMemory: row.core_memory, conversationId: row.conversation_id, extractedUntil: row.extracted_until, compactedUntil: row.compacted_until,
    notesSinceReflection: row.notes_since_reflection, lastMessageAt: row.last_message_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// ——— Characters ———

let characters: Character[] = [];
let charactersLoaded = false;
const characterListeners = new Set<() => void>();
const notifyCharacters = () => characterListeners.forEach((listener) => listener());

export async function loadCharacters(force = false): Promise<Character[]> {
  if (!charactersLoaded || force) {
    const rows = await (await database()).getAllAsync<CharacterRow>('SELECT * FROM characters ORDER BY last_message_at DESC, created_at DESC');
    characters = rows.map(mapCharacter);
    charactersLoaded = true;
    notifyCharacters();
  }
  return characters;
}
function subscribeCharacters(listener: () => void) {
  characterListeners.add(listener);
  if (!charactersLoaded) void loadCharacters().catch(() => undefined);
  return () => { characterListeners.delete(listener); };
}
const charactersSnapshot = () => characters;
export function useCharacters(): Character[] { return useSyncExternalStore(subscribeCharacters, charactersSnapshot, charactersSnapshot); }
export function characterById(id: string | null | undefined): Character | null { return (id && characters.find((item) => item.id === id)) || null; }

export async function saveCharacter(character: Character): Promise<void> {
  await (await database()).runAsync(
    `INSERT INTO characters (id, name, icon, avatar_uri, color, persona, style, relationship, greeting, can_draw, can_search, provider_id, model, memory_mode,
       core_memory, conversation_id, extracted_until, compacted_until, notes_since_reflection, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, avatar_uri = excluded.avatar_uri, color = excluded.color, persona = excluded.persona,
       style = excluded.style, relationship = excluded.relationship, greeting = excluded.greeting, can_draw = excluded.can_draw,
       can_search = excluded.can_search, provider_id = excluded.provider_id, model = excluded.model, memory_mode = excluded.memory_mode,
       core_memory = excluded.core_memory, conversation_id = excluded.conversation_id, extracted_until = excluded.extracted_until,
       compacted_until = excluded.compacted_until, notes_since_reflection = excluded.notes_since_reflection,
       last_message_at = excluded.last_message_at, updated_at = excluded.updated_at`,
    character.id, character.name, character.icon, character.avatarUri ?? null, character.color, character.persona, character.style, character.relationship, character.greeting,
    character.canDraw ? 1 : 0, character.canSearch ? 1 : 0, character.providerId, character.model, character.memoryMode, character.coreMemory,
    character.conversationId, character.extractedUntil, character.compactedUntil, character.notesSinceReflection, character.lastMessageAt,
    character.createdAt, character.updatedAt,
  );
  const exists = characters.some((item) => item.id === character.id);
  characters = exists ? characters.map((item) => (item.id === character.id ? character : item)) : [character, ...characters];
  characters = [...characters].sort((a, b) => b.lastMessageAt - a.lastMessageAt || b.createdAt - a.createdAt);
  notifyCharacters();
}

const CHARACTER_COLUMNS: { [K in keyof Character]?: [string, (value: Character[K]) => string | number | null] } = {
  name: ['name', (v) => v], icon: ['icon', (v) => v], avatarUri: ['avatar_uri', (v) => v ?? null], color: ['color', (v) => v], persona: ['persona', (v) => v],
  style: ['style', (v) => v], relationship: ['relationship', (v) => v], greeting: ['greeting', (v) => v], canDraw: ['can_draw', (v) => (v ? 1 : 0)],
  canSearch: ['can_search', (v) => (v ? 1 : 0)], providerId: ['provider_id', (v) => v], model: ['model', (v) => v], memoryMode: ['memory_mode', (v) => v],
  coreMemory: ['core_memory', (v) => v], conversationId: ['conversation_id', (v) => v], extractedUntil: ['extracted_until', (v) => v],
  compactedUntil: ['compacted_until', (v) => v], notesSinceReflection: ['notes_since_reflection', (v) => v], lastMessageAt: ['last_message_at', (v) => v],
};

/** Writes only the patched columns (the pipeline and the UI may both edit a character at once). */
export async function updateCharacter(id: string, patch: Partial<Character>): Promise<Character | null> {
  if (!(await loadCharacters()).some((item) => item.id === id)) return null;
  const updatedAt = Date.now();
  const sets: string[] = ['updated_at = ?'];
  const values: Array<string | number | null> = [updatedAt];
  for (const key of Object.keys(patch) as Array<keyof Character>) {
    const column = CHARACTER_COLUMNS[key] as [string, (value: unknown) => string | number | null] | undefined;
    if (!column || patch[key] === undefined) continue;
    sets.push(`${column[0]} = ?`);
    values.push(column[1](patch[key]));
  }
  await (await database()).runAsync(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`, ...values, id);
  // Merge onto the cache as it is now, not as it was before the write.
  const current = characters.find((item) => item.id === id);
  if (!current) return null;
  const next = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt };
  characters = characters.map((item) => (item.id === id ? next : item)).sort((a, b) => b.lastMessageAt - a.lastMessageAt || b.createdAt - a.createdAt);
  notifyCharacters();
  return next;
}

/** Deletes the character, its memory box and its conversation rows. Returns the conversation id (for file cleanup). */
export async function deleteCharacterRecords(id: string): Promise<string | null> {
  const db = await database();
  const character = (await loadCharacters()).find((item) => item.id === id);
  // All or nothing: a crash midway must not leave a character without its notes (or notes without a character).
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM mem_links WHERE owner = ?', id);
    await db.runAsync('DELETE FROM mem_notes WHERE owner = ?', id);
    await db.runAsync('DELETE FROM characters WHERE id = ?', id);
    if (character?.conversationId) await db.runAsync('DELETE FROM reactions WHERE conversation_id = ?', character.conversationId);
  });
  characters = characters.filter((item) => item.id !== id);
  notesCache.delete(id);
  notifyCharacters();
  notifyNotes(id);
  return character?.conversationId ?? null;
}

// ——— Notes and links ———

interface Box { notes: MemNote[]; links: MemLink[] }
const notesCache = new Map<string, Box>();
const noteListeners = new Map<string, Set<() => void>>();
function notifyNotes(owner: string) { noteListeners.get(owner)?.forEach((listener) => listener()); }
const EMPTY: Box = { notes: [], links: [] };

/** After a backup was restored: characters and every memory box shown so far are read again. */
export async function reloadMemoryStore(): Promise<void> {
  await loadCharacters(true);
  for (const owner of [...notesCache.keys()]) await loadBox(owner, true);
}

export async function loadBox(owner: string, force = false): Promise<Box> {
  const cached = notesCache.get(owner);
  if (cached && !force) return cached;
  const db = await database();
  const [noteRows, linkRows] = await Promise.all([
    db.getAllAsync<NoteRow>('SELECT * FROM mem_notes WHERE owner = ? ORDER BY created_at ASC', owner),
    db.getAllAsync<LinkRow>('SELECT * FROM mem_links WHERE owner = ? ORDER BY created_at ASC', owner),
  ]);
  const box: Box = {
    notes: noteRows.map(mapNote),
    links: linkRows.map((row) => ({ id: row.id, owner: row.owner, source: row.source, target: row.target, relation: row.relation, weight: row.weight, createdAt: row.created_at })),
  };
  notesCache.set(owner, box);
  notifyNotes(owner);
  return box;
}

function setBox(owner: string, box: Box) { notesCache.set(owner, box); notifyNotes(owner); }

/** Live notes and links of one character's memory box. */
export function useBox(owner: string | null): Box {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!owner) return undefined;
    const listener = () => setTick((value) => value + 1);
    if (!noteListeners.has(owner)) noteListeners.set(owner, new Set());
    noteListeners.get(owner)!.add(listener);
    if (!notesCache.has(owner)) void loadBox(owner).catch(() => undefined);
    return () => { noteListeners.get(owner)?.delete(listener); };
  }, [owner]);
  return (owner && notesCache.get(owner)) || EMPTY;
}

export type NoteDraft = Partial<MemNote> & Pick<MemNote, 'owner' | 'type' | 'title'>;

export function newNote(draft: NoteDraft): MemNote {
  const now = Date.now();
  return {
    id: createId(), content: '', tags: [], importance: 5, aboutUser: false, pinned: false, validFrom: now, validTo: null, supersededBy: null,
    sourceConversationId: null, sourceMessageId: null, rangeStart: null, rangeEnd: null, level: 0, rolledUp: false,
    embedding: null, embeddingModel: null, x: null, y: null, accessCount: 0, lastAccessedAt: null, createdAt: now, updatedAt: now,
    ...draft,
  };
}

const NOTE_COLUMNS = ['id', 'owner', 'type', 'title', 'content', 'tags_json', 'importance', 'about_user', 'pinned', 'valid_from', 'valid_to', 'superseded_by',
  'source_conversation_id', 'source_message_id', 'range_start', 'range_end', 'level', 'rolled_up', 'embedding', 'embedding_model', 'x', 'y',
  'access_count', 'last_accessed_at', 'created_at', 'updated_at'];

function noteValues(note: MemNote): Array<string | number | null> {
  return [note.id, note.owner, note.type, note.title, note.content, JSON.stringify(note.tags), note.importance, note.aboutUser ? 1 : 0, note.pinned ? 1 : 0,
    note.validFrom, note.validTo, note.supersededBy, note.sourceConversationId, note.sourceMessageId, note.rangeStart, note.rangeEnd, note.level,
    note.rolledUp ? 1 : 0, note.embedding ? JSON.stringify(note.embedding.map((value) => Math.round(value * 10000) / 10000)) : null, note.embeddingModel,
    note.x, note.y, note.accessCount, note.lastAccessedAt, note.createdAt, note.updatedAt];
}

export async function putNotes(owner: string, notes: MemNote[]): Promise<void> {
  if (!notes.length) return;
  // Background work that finishes after its character was deleted must not leave orphan notes behind.
  if (!(await loadCharacters()).some((item) => item.id === owner)) return;
  const db = await database();
  const placeholders = NOTE_COLUMNS.map(() => '?').join(', ');
  const updates = NOTE_COLUMNS.filter((column) => column !== 'id').map((column) => `${column} = excluded.${column}`).join(', ');
  for (const note of notes) {
    // The EXISTS check closes the gap between the check above and a delete that lands meanwhile.
    await db.runAsync(`INSERT INTO mem_notes (${NOTE_COLUMNS.join(', ')}) SELECT ${placeholders} WHERE EXISTS (SELECT 1 FROM characters WHERE id = ?) ON CONFLICT(id) DO UPDATE SET ${updates}`,
      ...noteValues({ ...note, owner }), owner);
  }
  if (!characters.some((item) => item.id === owner)) return;
  const box = await loadBox(owner);
  const byId = new Map(box.notes.map((note) => [note.id, note]));
  for (const note of notes) byId.set(note.id, note);
  setBox(owner, { ...box, notes: [...byId.values()].sort((a, b) => a.createdAt - b.createdAt) });
}

const NOTE_FIELDS: { [K in keyof MemNote]?: string } = {
  type: 'type', title: 'title', content: 'content', tags: 'tags_json', importance: 'importance', aboutUser: 'about_user', pinned: 'pinned',
  validFrom: 'valid_from', validTo: 'valid_to', supersededBy: 'superseded_by', sourceConversationId: 'source_conversation_id', sourceMessageId: 'source_message_id',
  rangeStart: 'range_start', rangeEnd: 'range_end', level: 'level', rolledUp: 'rolled_up', embedding: 'embedding', embeddingModel: 'embedding_model',
  x: 'x', y: 'y', accessCount: 'access_count', lastAccessedAt: 'last_accessed_at', updatedAt: 'updated_at',
};

/** Writes only the patched columns of existing notes, so work that awaited in between can't restore stale fields. */
export async function patchNotes(owner: string, patches: Array<{ id: string; patch: Partial<MemNote> }>): Promise<MemNote[]> {
  if (!patches.length) return [];
  const db = await database();
  const stamped = patches.map(({ id, patch }) => ({ id, patch: { ...patch, updatedAt: patch.updatedAt ?? Date.now() } }));
  for (const { id, patch } of stamped) {
    // noteValues serializes every field; pick the patched ones by column index.
    const values = noteValues({ ...newNote({ owner, type: 'fact', title: '' }), ...patch } as MemNote);
    const keys = (Object.keys(patch) as Array<keyof MemNote>).filter((key) => NOTE_FIELDS[key] && patch[key] !== undefined);
    const columns = keys.map((key) => NOTE_FIELDS[key]!);
    await db.runAsync(`UPDATE mem_notes SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ? AND owner = ?`,
      ...columns.map((column) => values[NOTE_COLUMNS.indexOf(column)]), id, owner);
  }
  const box = await loadBox(owner);
  const byId = new Map(stamped.map((item) => [item.id, item.patch]));
  const changed: MemNote[] = [];
  const notes = box.notes.map((note) => {
    const patch = byId.get(note.id);
    if (!patch) return note;
    const next = { ...note, ...patch, id: note.id, owner: note.owner };
    changed.push(next);
    return next;
  });
  setBox(owner, { ...box, notes });
  return changed;
}

export async function updateNote(owner: string, id: string, patch: Partial<MemNote>): Promise<MemNote | null> {
  const box = await loadBox(owner);
  if (!box.notes.some((note) => note.id === id)) return null;
  return (await patchNotes(owner, [{ id, patch }]))[0] ?? null;
}

export async function deleteNote(owner: string, id: string): Promise<void> {
  const db = await database();
  await db.runAsync('DELETE FROM mem_links WHERE source = ? OR target = ?', id, id);
  await db.runAsync('DELETE FROM mem_notes WHERE id = ?', id);
  await db.runAsync('UPDATE mem_notes SET superseded_by = NULL WHERE superseded_by = ?', id);
  const box = await loadBox(owner);
  setBox(owner, {
    notes: box.notes.filter((note) => note.id !== id).map((note) => (note.supersededBy === id ? { ...note, supersededBy: null } : note)),
    links: box.links.filter((link) => link.source !== id && link.target !== id),
  });
}

/**
 * Forgets what memory took from a conversation since a moment (a regenerated or edited turn):
 * notes extracted from then on (except pinned ones), their links, and summaries reaching past it.
 * Returns the time memory should re-read from: the last kept extraction from this conversation.
 */
export async function forgetNotesSince(owner: string, conversationId: string, since: number): Promise<number> {
  const db = await database();
  const box = await loadBox(owner, true);
  const gone = new Set(box.notes.filter((note) => !note.pinned && note.sourceConversationId === conversationId
    && (note.level === 0 ? note.validFrom >= since : (note.rangeEnd ?? 0) >= since)).map((note) => note.id));
  if (gone.size) {
    const ids = [...gone];
    const marks = ids.map(() => '?').join(',');
    await db.withTransactionAsync(async () => {
      await db.runAsync(`DELETE FROM mem_links WHERE source IN (${marks}) OR target IN (${marks})`, ...ids, ...ids);
      await db.runAsync(`UPDATE mem_notes SET superseded_by = NULL WHERE superseded_by IN (${marks})`, ...ids);
      await db.runAsync(`DELETE FROM mem_notes WHERE id IN (${marks})`, ...ids);
    });
    setBox(owner, {
      notes: box.notes.filter((note) => !gone.has(note.id)).map((note) => (note.supersededBy && gone.has(note.supersededBy) ? { ...note, supersededBy: null } : note)),
      links: box.links.filter((link) => !gone.has(link.source) && !gone.has(link.target)),
    });
  }
  const kept = box.notes.filter((note) => !gone.has(note.id) && note.level === 0 && note.sourceConversationId === conversationId && note.validFrom < since);
  return kept.reduce((latest, note) => Math.max(latest, note.validFrom), 0);
}

export async function addLinks(owner: string, links: Array<Pick<MemLink, 'source' | 'target' | 'relation'> & { weight?: number }>): Promise<void> {
  const box = await loadBox(owner);
  const ids = new Set(box.notes.map((note) => note.id));
  const db = await database();
  const added: MemLink[] = [];
  for (const link of links) {
    const relation = link.relation.trim().slice(0, 12) || '相关';
    if (link.source === link.target || !ids.has(link.source) || !ids.has(link.target)) continue;
    if (box.links.some((item) => item.source === link.source && item.target === link.target && item.relation === relation)
      || added.some((item) => item.source === link.source && item.target === link.target && item.relation === relation)) continue;
    const row: MemLink = { id: createId(), owner, source: link.source, target: link.target, relation, weight: link.weight ?? 1, createdAt: Date.now() };
    await db.runAsync('INSERT OR IGNORE INTO mem_links (id, owner, source, target, relation, weight, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM characters WHERE id = ?)',
      row.id, owner, row.source, row.target, row.relation, row.weight, row.createdAt, owner);
    added.push(row);
  }
  if (added.length && characters.some((item) => item.id === owner)) setBox(owner, { ...box, links: [...box.links, ...added] });
}

export async function deleteLink(owner: string, id: string): Promise<void> {
  await (await database()).runAsync('DELETE FROM mem_links WHERE id = ?', id);
  const box = await loadBox(owner);
  setBox(owner, { ...box, links: box.links.filter((link) => link.id !== id) });
}

/** Records that notes were recalled (recency and use count feed retrieval). */
export async function touchNotes(owner: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const now = Date.now();
  const db = await database();
  for (const id of ids) await db.runAsync('UPDATE mem_notes SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?', now, id);
  const box = await loadBox(owner);
  const set = new Set(ids);
  // Cache only; screens don't need to re-render for this.
  notesCache.set(owner, { ...box, notes: box.notes.map((note) => (set.has(note.id) ? { ...note, accessCount: note.accessCount + 1, lastAccessedAt: now } : note)) });
}

/** Saves canvas positions without notifying (the canvas already shows them). */
export async function savePositions(owner: string, positions: Map<string, { x: number; y: number }>): Promise<void> {
  if (!positions.size) return;
  const db = await database();
  for (const [id, point] of positions) await db.runAsync('UPDATE mem_notes SET x = ?, y = ? WHERE id = ?', point.x, point.y, id);
  const box = await loadBox(owner);
  notesCache.set(owner, { ...box, notes: box.notes.map((note) => { const point = positions.get(note.id); return point ? { ...note, x: point.x, y: point.y } : note; }) });
}

/** Facts about the user from every character (read-only for the assistant space). */
export async function listAboutUserNotes(): Promise<MemNote[]> {
  const rows = await (await database()).getAllAsync<NoteRow>(
    `SELECT n.* FROM mem_notes n JOIN characters c ON c.id = n.owner
     WHERE n.about_user = 1 AND n.valid_to IS NULL AND n.type != 'episode' ORDER BY n.importance DESC, n.updated_at DESC LIMIT 300`,
  );
  return rows.map(mapNote);
}

/** Removes notes and links left behind by characters deleted while background work was still writing. */
export async function removeOrphans(): Promise<void> {
  const db = await database();
  await db.runAsync('DELETE FROM mem_notes WHERE owner NOT IN (SELECT id FROM characters)');
  await db.runAsync('DELETE FROM mem_links WHERE owner NOT IN (SELECT id FROM characters) OR source NOT IN (SELECT id FROM mem_notes) OR target NOT IN (SELECT id FROM mem_notes)');
}

export async function clearBox(owner: string): Promise<void> {
  const db = await database();
  await db.runAsync('DELETE FROM mem_links WHERE owner = ?', owner);
  await db.runAsync('DELETE FROM mem_notes WHERE owner = ?', owner);
  setBox(owner, { notes: [], links: [] });
}

/** Test hook. */
export function resetMemoryBoxCacheForTesting(): void { notesCache.clear(); characters = []; charactersLoaded = false; }
