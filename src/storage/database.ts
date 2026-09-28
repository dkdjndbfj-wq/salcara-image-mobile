import { normalizeBaseUrl } from '../domain-utils';
import * as SQLite from 'expo-sqlite';

import { ALL_CAPABILITIES, parseTrace, traceFileUris, type AgentCapability, type CustomAgent, type HistoryHit, type Memory } from '../agent/types';
import type { ChatMessage, Conversation, DocumentAttachment, ProviderProfile, ReferenceImage } from '../domain';

const DATABASE_NAME = 'salcara-image.db';
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  model: string | null;
  quality: ProviderProfile['quality'];
  aspect_ratio: ProviderProfile['aspectRatio'];
  resolution_tier: ProviderProfile['resolutionTier'];
  chat_model: string | null;
  chat_api: ProviderProfile['chatApi'];
  analysis_provider_id: string | null;
  image_provider_id: string | null;
  created_at: number;
  updated_at: number;
};

type ConversationRow = {
  id: string;
  title: string;
  provider_id: string;
  transparent: number;
  mode: Conversation['mode'];
  agent_id?: string | null;
  kind?: string | null;
  character_id?: string | null;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: ChatMessage['role'];
  prompt: string;
  mode: ChatMessage['mode'];
  status: ChatMessage['status'];
  provider_id: string;
  model: string;
  quality: ChatMessage['quality'];
  size: string;
  transparent: number;
  image_uri: string | null;
  remote_image_url: string | null;
  references_json: string;
  documents_json: string;
  text: string | null;
  prepared_prompt: string | null;
  analysis_model: string | null;
  analysis_provider_id: string | null;
  request_api: ChatMessage['requestApi'];
  analysis_api: ChatMessage['analysisApi'];
  creation_skill_json: string | null;
  creation_notes: string | null;
  mask_uri: string | null;
  error: string | null;
  elapsed_ms: number | null;
  created_at: number;
  agent_json?: string | null;
};

type AgentRow = {
  id: string; name: string; icon: string; color: string; description: string; instructions: string;
  capabilities_json: string; starters_json: string; provider_id: string | null; model: string | null; created_at: number; updated_at: number;
};

/** Shared connection for other storage modules (memory box). */
export function database(): Promise<SQLite.SQLiteDatabase> { return getDatabase(); }

async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync(DATABASE_NAME).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS providers (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          model TEXT,
          quality TEXT,
          aspect_ratio TEXT,
          resolution_tier TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          transparent INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY NOT NULL,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          prompt TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          quality TEXT NOT NULL,
          size TEXT NOT NULL,
          transparent INTEGER NOT NULL DEFAULT 0,
          image_uri TEXT,
          remote_image_url TEXT,
          references_json TEXT NOT NULL DEFAULT '[]',
          mask_uri TEXT,
          error TEXT,
          elapsed_ms INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY NOT NULL,
          content TEXT NOT NULL,
          conversation_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          instructions TEXT NOT NULL DEFAULT '',
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          starters_json TEXT NOT NULL DEFAULT '[]',
          provider_id TEXT,
          model TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS characters (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          icon TEXT NOT NULL DEFAULT '',
          avatar_uri TEXT,
          color TEXT NOT NULL DEFAULT '',
          persona TEXT NOT NULL DEFAULT '',
          style TEXT NOT NULL DEFAULT '',
          relationship TEXT NOT NULL DEFAULT '',
          greeting TEXT NOT NULL DEFAULT '',
          can_draw INTEGER NOT NULL DEFAULT 1,
          can_search INTEGER NOT NULL DEFAULT 1,
          provider_id TEXT,
          model TEXT,
          memory_mode TEXT NOT NULL DEFAULT 'auto',
          core_memory TEXT NOT NULL DEFAULT '',
          conversation_id TEXT,
          extracted_until INTEGER NOT NULL DEFAULT 0,
          compacted_until INTEGER NOT NULL DEFAULT 0,
          notes_since_reflection INTEGER NOT NULL DEFAULT 0,
          last_message_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reactions (
          message_id TEXT PRIMARY KEY NOT NULL,
          conversation_id TEXT NOT NULL,
          emoji TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS reactions_conversation ON reactions(conversation_id);
        CREATE TABLE IF NOT EXISTS mem_notes (
          id TEXT PRIMARY KEY NOT NULL,
          owner TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          tags_json TEXT NOT NULL DEFAULT '[]',
          importance INTEGER NOT NULL DEFAULT 5,
          about_user INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          valid_from INTEGER NOT NULL,
          valid_to INTEGER,
          superseded_by TEXT,
          source_conversation_id TEXT,
          source_message_id TEXT,
          range_start INTEGER,
          range_end INTEGER,
          level INTEGER NOT NULL DEFAULT 0,
          rolled_up INTEGER NOT NULL DEFAULT 0,
          embedding TEXT,
          embedding_model TEXT,
          x REAL,
          y REAL,
          access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mem_links (
          id TEXT PRIMARY KEY NOT NULL,
          owner TEXT NOT NULL,
          source TEXT NOT NULL,
          target TEXT NOT NULL,
          relation TEXT NOT NULL DEFAULT '相关',
          weight REAL NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_mem_notes_owner ON mem_notes(owner, created_at);
        CREATE INDEX IF NOT EXISTS idx_mem_links_owner ON mem_links(owner);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_links_pair ON mem_links(source, target, relation);
      `);
      await addMissingColumns(db, 'providers', {
        chat_model: 'TEXT',
        chat_api: "TEXT NOT NULL DEFAULT 'chat-completions'",
        analysis_provider_id: 'TEXT',
        image_provider_id: 'TEXT',
      });
      // Existing installs receive the legacy image default for rows created by
      // the old schema; all new rows are written explicitly as auto below.
      await addMissingColumns(db, 'characters', { avatar_uri: 'TEXT' });
      await addMissingColumns(db, 'conversations', { mode: "TEXT NOT NULL DEFAULT 'image'", agent_id: 'TEXT', kind: "TEXT NOT NULL DEFAULT 'assistant'", character_id: 'TEXT' });
      await addMissingColumns(db, 'messages', {
        remote_image_url: 'TEXT',
        documents_json: "TEXT NOT NULL DEFAULT '[]'",
        text: 'TEXT',
        prepared_prompt: 'TEXT',
        analysis_model: 'TEXT',
        analysis_provider_id: 'TEXT',
        request_api: 'TEXT',
        analysis_api: 'TEXT',
        creation_skill_json: 'TEXT',
        creation_notes: 'TEXT',
        agent_json: 'TEXT',
      });
      await detachConversationsFromProviders(db);
      await db.runAsync(
        `UPDATE messages SET status = 'interrupted', error = '应用在生成期间被关闭' WHERE status = 'pending'`,
      );
      return db;
    });
  }
  return databasePromise;
}

/**
 * Installs up to 1.4 created conversations with ON DELETE CASCADE to their
 * provider, so removing a provider silently deleted its chat history. History
 * now outlives providers: rebuild the table once without that foreign key
 * (SQLite's documented table-rebuild procedure; messages are untouched).
 */
async function detachConversationsFromProviders(db: SQLite.SQLiteDatabase): Promise<void> {
  const keys = await db.getAllAsync<{ table: string }>('PRAGMA foreign_key_list(conversations)');
  if (!keys.some((key) => key.table === 'providers')) return;
  try {
    await db.execAsync(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE conversations_detached (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        transparent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'image',
        agent_id TEXT,
        kind TEXT NOT NULL DEFAULT 'assistant',
        character_id TEXT
      );
      INSERT INTO conversations_detached (id, title, provider_id, transparent, created_at, updated_at, mode, agent_id, kind, character_id)
        SELECT id, title, provider_id, transparent, created_at, updated_at, mode, agent_id, kind, character_id FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_detached RENAME TO conversations;
      CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } catch {
    // Leave the old table untouched and usable; the rebuild is retried on the next launch.
    try { await db.execAsync('ROLLBACK;'); } catch { /* no open transaction */ }
    await db.execAsync('PRAGMA foreign_keys = ON;');
  }
}

async function addMissingColumns(
  db: SQLite.SQLiteDatabase,
  table: 'providers' | 'conversations' | 'messages' | 'characters',
  columns: Record<string, string>,
): Promise<void> {
  const existing = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.some((column) => column.name === name)) {
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
    }
  }
}

export async function initializeDatabase(): Promise<void> {
  await getDatabase();
}

export async function listProviders(): Promise<ProviderProfile[]> {
  const rows = await (await getDatabase()).getAllAsync<ProviderRow>('SELECT * FROM providers ORDER BY updated_at DESC');
  return rows.map(mapProvider);
}

export async function upsertProvider(profile: ProviderProfile): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO providers
      (id, name, base_url, model, quality, aspect_ratio, resolution_tier, chat_model, chat_api, analysis_provider_id, image_provider_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      model = excluded.model,
      quality = excluded.quality,
      aspect_ratio = excluded.aspect_ratio,
      resolution_tier = excluded.resolution_tier,
      chat_model = excluded.chat_model,
      chat_api = excluded.chat_api,
      analysis_provider_id = excluded.analysis_provider_id,
      image_provider_id = excluded.image_provider_id,
      updated_at = excluded.updated_at`,
    profile.id,
    profile.name,
    profile.baseUrl,
    profile.model,
    profile.quality,
    profile.aspectRatio,
    profile.resolutionTier,
    profile.chatModel ?? null,
    profile.chatApi ?? 'chat-completions',
    profile.analysisProviderId ?? null,
    profile.imageProviderId ?? null,
    profile.createdAt,
    profile.updatedAt,
  );
}

export async function deleteProviderRecord(providerId: string): Promise<void> {
  await (await getDatabase()).runAsync('DELETE FROM providers WHERE id = ?', providerId);
}

export async function getActiveProviderId(): Promise<string | null> {
  const row = await (await getDatabase()).getFirstAsync<{ value: string }>(
    `SELECT value FROM app_settings WHERE key = 'active_provider_id'`,
  );
  return row?.value ?? null;
}

export async function setActiveProviderId(providerId: string | null): Promise<void> {
  const db = await getDatabase();
  if (!providerId) {
    await db.runAsync(`DELETE FROM app_settings WHERE key = 'active_provider_id'`);
    return;
  }
  await db.runAsync(
    `INSERT INTO app_settings (key, value) VALUES ('active_provider_id', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    providerId,
  );
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await (await getDatabase()).getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string | null): Promise<void> {
  const db = await getDatabase();
  if (value === null) { await db.runAsync('DELETE FROM app_settings WHERE key = ?', key); return; }
  await db.runAsync(
    `INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, value,
  );
}

/** Conversations are no longer owned by one provider; keep them when a provider is removed. */
export async function reassignConversations(fromProviderId: string, toProviderId: string): Promise<void> {
  await (await getDatabase()).runAsync('UPDATE conversations SET provider_id = ? WHERE provider_id = ?', toProviderId, fromProviderId);
}

/** File names of every local file a saved message refers to (images, masks, references, documents). */
export async function listReferencedFileNames(): Promise<Set<string>> {
  const rows = await (await getDatabase()).getAllAsync<{ image_uri: string | null; mask_uri: string | null; references_json: string; documents_json: string; agent_json: string | null }>(
    'SELECT image_uri, mask_uri, references_json, documents_json, agent_json FROM messages',
  );
  const names = new Set<string>();
  const add = (uri: unknown) => {
    if (typeof uri !== 'string' || !uri) return;
    const name = decodeURIComponent(uri.split('?')[0].replace(/\/+$/, '').split('/').pop() ?? '');
    if (name) names.add(name);
  };
  for (const row of rows) {
    add(row.image_uri);
    add(row.mask_uri);
    for (const json of [row.references_json, row.documents_json]) {
      try { (JSON.parse(json || '[]') as Array<{ uri?: unknown }>).forEach((item) => add(item?.uri)); } catch { /* malformed row */ }
    }
    traceFileUris(parseTrace(row.agent_json)).forEach(add);
  }
  return names;
}

/** Removes conversation rows that never received a message (legacy blank drafts). */
export async function deleteEmptyConversations(): Promise<void> {
  await (await getDatabase()).runAsync("DELETE FROM conversations WHERE kind != 'companion' AND id NOT IN (SELECT DISTINCT conversation_id FROM messages)");
}

export async function listConversations(): Promise<Conversation[]> {
  const rows = await (await getDatabase()).getAllAsync<ConversationRow>(
    'SELECT * FROM conversations ORDER BY updated_at DESC',
  );
  return rows.map(mapConversation);
}

export async function insertConversation(conversation: Conversation): Promise<void> {
  await (await getDatabase()).runAsync(
    `INSERT INTO conversations (id, title, provider_id, transparent, mode, agent_id, kind, character_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    conversation.id,
    conversation.title,
    conversation.providerId,
    conversation.transparent ? 1 : 0,
    conversation.mode ?? 'auto',
    conversation.agentId ?? null,
    conversation.kind ?? 'assistant',
    conversation.characterId ?? null,
    conversation.createdAt,
    conversation.updatedAt,
  );
}

export async function updateConversation(conversation: Conversation): Promise<void> {
  await (await getDatabase()).runAsync(
    `UPDATE conversations SET title = ?, provider_id = ?, transparent = ?, mode = ?, agent_id = ?, updated_at = ? WHERE id = ?`,
    conversation.title,
    conversation.providerId,
    conversation.transparent ? 1 : 0,
    conversation.mode ?? 'auto',
    conversation.agentId ?? null,
    conversation.updatedAt,
    conversation.id,
  );
}

export async function deleteConversationRecord(conversationId: string): Promise<ChatMessage[]> {
  const db = await getDatabase();
  const messages = await listMessages(conversationId);
  await db.runAsync('DELETE FROM conversations WHERE id = ?', conversationId);
  return messages;
}

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  const rows = await (await getDatabase()).getAllAsync<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    conversationId,
  );
  return rows.map(mapMessage);
}

export async function insertMessage(message: ChatMessage): Promise<void> {
  await (await getDatabase()).runAsync(
    `INSERT INTO messages
      (id, conversation_id, role, prompt, mode, status, provider_id, model, quality, size,
       transparent, image_uri, remote_image_url, references_json, mask_uri, error, elapsed_ms, created_at,
       documents_json, text, prepared_prompt, analysis_model, analysis_provider_id, request_api, analysis_api, creation_skill_json, creation_notes, agent_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    message.id,
    message.conversationId,
    message.role,
    message.prompt,
    message.mode,
    message.status,
    message.providerId,
    message.model,
    message.quality,
    message.size,
    message.transparent ? 1 : 0,
    message.imageUri,
    message.remoteImageUrl,
    JSON.stringify(message.references),
    message.maskUri,
    message.error,
    message.elapsedMs,
    message.createdAt,
    JSON.stringify(message.documents ?? []),
    message.text ?? null,
    message.preparedPrompt ?? null,
    message.analysisModel ?? null,
    message.analysisProviderId ?? null,
    message.requestApi ?? null,
    message.analysisApi ?? null,
    null,
    null,
    serializeTrace(message),
  );
}

export async function updateMessage(message: ChatMessage): Promise<void> {
  await (await getDatabase()).runAsync(
    `UPDATE messages SET status = ?, image_uri = ?, remote_image_url = ?, error = ?, elapsed_ms = ?, references_json = ?, mask_uri = ?,
       documents_json = ?, text = ?, prepared_prompt = ?, analysis_model = ?, analysis_provider_id = ?, request_api = ?, analysis_api = ?, creation_skill_json = ?, creation_notes = ?,
       mode = ?, provider_id = ?, model = ?, quality = ?, size = ?, transparent = ?, prompt = ?, agent_json = ?
     WHERE id = ?`,
    message.status,
    message.imageUri,
    message.remoteImageUrl,
    message.error,
    message.elapsedMs,
    JSON.stringify(message.references),
    message.maskUri,
    JSON.stringify(message.documents ?? []),
    message.text ?? null,
    message.preparedPrompt ?? null,
    message.analysisModel ?? null,
    message.analysisProviderId ?? null,
    message.requestApi ?? null,
    message.analysisApi ?? null,
    null,
    null,
    message.mode,
    message.providerId,
    message.model,
    message.quality,
    message.size,
    message.transparent ? 1 : 0,
    message.prompt,
    serializeTrace(message),
    message.id,
  );
}

function serializeTrace(message: ChatMessage): string | null {
  return message.agent ? JSON.stringify(message.agent) : null;
}

/** Addresses saved by older versions could carry a wrong trailing /v1 (e.g. …/api/v3/v1); read them repaired. */
function repairedBaseUrl(value: string): string {
  try { return normalizeBaseUrl(value); } catch { return value; }
}

function mapProvider(row: ProviderRow): ProviderProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: repairedBaseUrl(row.base_url),
    model: row.model,
    quality: row.quality,
    aspectRatio: row.aspect_ratio,
    resolutionTier: row.resolution_tier,
    chatModel: row.chat_model ?? null,
    chatApi: row.chat_api === 'responses' || row.chat_api === 'anthropic' ? row.chat_api : 'chat-completions',
    analysisProviderId: row.analysis_provider_id ?? null,
    imageProviderId: row.image_provider_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    providerId: row.provider_id,
    transparent: row.transparent === 1,
    mode: row.mode === 'chat' ? 'chat' : row.mode === 'auto' ? 'auto' : 'image',
    agentId: row.agent_id ?? null,
    kind: row.kind === 'companion' ? 'companion' : 'assistant',
    characterId: row.character_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): ChatMessage {
  let references: ReferenceImage[] = [];
  try {
    references = JSON.parse(row.references_json) as ReferenceImage[];
  } catch {
    references = [];
  }
  let documents: DocumentAttachment[] = [];
  try {
    const parsed: unknown = JSON.parse(row.documents_json || '[]');
    documents = Array.isArray(parsed) ? parsed as DocumentAttachment[] : [];
  } catch {
    documents = [];
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    prompt: row.prompt,
    mode: row.mode,
    status: row.status,
    providerId: row.provider_id,
    model: row.model,
    quality: row.quality,
    size: row.size,
    transparent: row.transparent === 1,
    imageUri: row.image_uri,
    remoteImageUrl: row.remote_image_url,
    references,
    documents,
    text: row.text ?? null,
    preparedPrompt: row.prepared_prompt ?? null,
    analysisModel: row.analysis_model ?? null,
    analysisProviderId: row.analysis_provider_id ?? null,
    requestApi: row.request_api ?? undefined,
    analysisApi: row.analysis_api ?? undefined,
    maskUri: row.mask_uri,
    error: row.error,
    elapsedMs: row.elapsed_ms,
    createdAt: row.created_at,
    agent: parseTrace(row.agent_json),
  };
}

// ——— Memories ———

export async function listMemories(): Promise<Memory[]> {
  const rows = await (await getDatabase()).getAllAsync<{ id: string; content: string; conversation_id: string | null; created_at: number; updated_at: number }>(
    'SELECT * FROM memories ORDER BY created_at ASC',
  );
  return rows.map((row) => ({ id: row.id, content: row.content, conversationId: row.conversation_id, createdAt: row.created_at, updatedAt: row.updated_at }));
}

export async function insertMemory(memory: Memory): Promise<void> {
  await (await getDatabase()).runAsync(
    'INSERT INTO memories (id, content, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    memory.id, memory.content, memory.conversationId, memory.createdAt, memory.updatedAt,
  );
}

export async function updateMemoryContent(id: string, content: string): Promise<void> {
  await (await getDatabase()).runAsync('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?', content, Date.now(), id);
}

export async function deleteMemoryRecord(id: string): Promise<void> {
  await (await getDatabase()).runAsync('DELETE FROM memories WHERE id = ?', id);
}

export async function clearMemoryRecords(): Promise<void> {
  await (await getDatabase()).runAsync('DELETE FROM memories');
}

// ——— Custom agents ———

export async function listAgents(): Promise<CustomAgent[]> {
  const rows = await (await getDatabase()).getAllAsync<AgentRow>('SELECT * FROM agents ORDER BY created_at ASC');
  return rows.map(mapAgent);
}

export async function upsertAgent(agent: CustomAgent): Promise<void> {
  await (await getDatabase()).runAsync(
    `INSERT INTO agents (id, name, icon, color, description, instructions, capabilities_json, starters_json, provider_id, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, color = excluded.color, description = excluded.description,
       instructions = excluded.instructions, capabilities_json = excluded.capabilities_json, starters_json = excluded.starters_json,
       provider_id = excluded.provider_id, model = excluded.model, updated_at = excluded.updated_at`,
    agent.id, agent.name, agent.icon, agent.color, agent.description, agent.instructions,
    JSON.stringify(agent.capabilities), JSON.stringify(agent.starters), agent.providerId, agent.model, agent.createdAt, agent.updatedAt,
  );
}

/** Conversations keep their history; they simply fall back to the default assistant. */
export async function deleteAgentRecord(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM agents WHERE id = ?', id);
  await db.runAsync('UPDATE conversations SET agent_id = NULL WHERE agent_id = ?', id);
}

function parseList(json: string): unknown[] {
  try { const value: unknown = JSON.parse(json || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}

function mapAgent(row: AgentRow): CustomAgent {
  return {
    id: row.id, name: row.name, icon: row.icon, color: row.color, description: row.description, instructions: row.instructions,
    capabilities: parseList(row.capabilities_json).filter((item): item is AgentCapability => ALL_CAPABILITIES.includes(item as AgentCapability)),
    starters: parseList(row.starters_json).filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 4),
    providerId: row.provider_id, model: row.model, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// ——— History search ———

/** Splits a query into up to four terms; every term must appear. */
export function historyTerms(query: string): string[] {
  return [...new Set(query.trim().split(/[\s,，。、;；]+/).map((term) => term.trim()).filter((term) => term.length > 0))].slice(0, 4);
}

function escapeLike(term: string): string { return term.replace(/[\\%_]/g, (match) => `\\${match}`); }

/** Plain-text search over saved messages (prompt and reply text), newest first. */
export async function searchMessages(query: string, options: { limit?: number; excludeConversationId?: string | null; conversationId?: string } = {}): Promise<HistoryHit[]> {
  const terms = historyTerms(query);
  if (!terms.length) return [];
  const where = terms.map(() => "(m.prompt LIKE ? ESCAPE '\\' OR IFNULL(m.text, '') LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')").join(' AND ');
  const params: Array<string | number> = [];
  for (const term of terms) { const like = `%${escapeLike(term)}%`; params.push(like, like, like); }
  let sql = `SELECT m.id AS id, m.conversation_id AS conversation_id, m.role AS role, m.prompt AS prompt, m.text AS text, m.created_at AS created_at, c.title AS title
    FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${where}`;
  if (options.excludeConversationId) { sql += ' AND m.conversation_id != ?'; params.push(options.excludeConversationId); }
  // Chat-space conversations are private to their character unless searched explicitly.
  if (options.conversationId) { sql += ' AND m.conversation_id = ?'; params.push(options.conversationId); }
  else sql += " AND IFNULL(c.kind, 'assistant') != 'companion'";
  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(Math.max(1, Math.min(options.limit ?? 30, 100)));
  const rows = await (await getDatabase()).getAllAsync<{ id: string; conversation_id: string; role: 'user' | 'assistant'; prompt: string; text: string | null; created_at: number; title: string }>(sql, ...params);
  return rows.map((row) => {
    const body = row.role === 'user' ? row.prompt : (row.text ?? '');
    return { conversationId: row.conversation_id, title: row.title, messageId: row.id, role: row.role, snippet: snippetAround(body || row.title, terms[0]), createdAt: row.created_at };
  });
}

/** About 90 characters around the first match, on one line. */
export function snippetAround(text: string, term: string, radius = 45): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const index = flat.toLowerCase().indexOf(term.toLowerCase());
  if (index < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat;
  const start = Math.max(0, index - radius);
  const end = Math.min(flat.length, index + term.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

// ——— Long conversations (chat space) ———

/** The newest `limit` messages, optionally only those older than `before` (for loading earlier history). */
export async function listRecentMessages(conversationId: string, limit: number, before?: number): Promise<ChatMessage[]> {
  const rows = await (await getDatabase()).getAllAsync<MessageRow>(
    before === undefined
      ? 'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
    ...(before === undefined ? [conversationId, limit] : [conversationId, before, limit]),
  );
  return rows.map(mapMessage).reverse();
}

/** Messages in a time window, oldest first. */
export async function listMessagesBetween(conversationId: string, after: number, until = Number.MAX_SAFE_INTEGER, limit = 400): Promise<ChatMessage[]> {
  const rows = await (await getDatabase()).getAllAsync<MessageRow>(
    'SELECT * FROM messages WHERE conversation_id = ? AND created_at > ? AND created_at <= ? ORDER BY created_at ASC LIMIT ?',
    conversationId, after, until, limit,
  );
  return rows.map(mapMessage);
}
