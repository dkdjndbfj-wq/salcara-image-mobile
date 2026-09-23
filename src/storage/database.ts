import * as SQLite from 'expo-sqlite';

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
  created_at: number;
  updated_at: number;
};

type ConversationRow = {
  id: string;
  title: string;
  provider_id: string;
  transparent: number;
  mode: Conversation['mode'];
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
  mask_uri: string | null;
  error: string | null;
  elapsed_ms: number | null;
  created_at: number;
};

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
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
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
        CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
      `);
      await addMissingColumns(db, 'providers', {
        chat_model: 'TEXT',
        chat_api: "TEXT NOT NULL DEFAULT 'chat-completions'",
        analysis_provider_id: 'TEXT',
      });
      // Existing installs receive the legacy image default for rows created by
      // the old schema; all new rows are written explicitly as auto below.
      await addMissingColumns(db, 'conversations', { mode: "TEXT NOT NULL DEFAULT 'image'" });
      await addMissingColumns(db, 'messages', {
        remote_image_url: 'TEXT',
        documents_json: "TEXT NOT NULL DEFAULT '[]'",
        text: 'TEXT',
        prepared_prompt: 'TEXT',
        analysis_model: 'TEXT',
        analysis_provider_id: 'TEXT',
        request_api: 'TEXT',
        analysis_api: 'TEXT',
      });
      await db.runAsync(
        `UPDATE messages SET status = 'interrupted', error = '应用在生成期间被关闭' WHERE status = 'pending'`,
      );
      return db;
    });
  }
  return databasePromise;
}

async function addMissingColumns(
  db: SQLite.SQLiteDatabase,
  table: 'providers' | 'conversations' | 'messages',
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
      (id, name, base_url, model, quality, aspect_ratio, resolution_tier, chat_model, chat_api, analysis_provider_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export async function listConversations(): Promise<Conversation[]> {
  const rows = await (await getDatabase()).getAllAsync<ConversationRow>(
    'SELECT * FROM conversations ORDER BY updated_at DESC',
  );
  return rows.map(mapConversation);
}

export async function insertConversation(conversation: Conversation): Promise<void> {
  await (await getDatabase()).runAsync(
    `INSERT INTO conversations (id, title, provider_id, transparent, mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    conversation.id,
    conversation.title,
    conversation.providerId,
    conversation.transparent ? 1 : 0,
    conversation.mode ?? 'auto',
    conversation.createdAt,
    conversation.updatedAt,
  );
}

export async function updateConversation(conversation: Conversation): Promise<void> {
  await (await getDatabase()).runAsync(
    `UPDATE conversations SET title = ?, provider_id = ?, transparent = ?, mode = ?, updated_at = ? WHERE id = ?`,
    conversation.title,
    conversation.providerId,
    conversation.transparent ? 1 : 0,
    conversation.mode ?? 'auto',
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
       documents_json, text, prepared_prompt, analysis_model, analysis_provider_id, request_api, analysis_api)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
}

export async function updateMessage(message: ChatMessage): Promise<void> {
  await (await getDatabase()).runAsync(
    `UPDATE messages SET status = ?, image_uri = ?, remote_image_url = ?, error = ?, elapsed_ms = ?, references_json = ?, mask_uri = ?,
       documents_json = ?, text = ?, prepared_prompt = ?, analysis_model = ?, analysis_provider_id = ?, request_api = ?, analysis_api = ?
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
    message.id,
  );
}

function mapProvider(row: ProviderRow): ProviderProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    quality: row.quality,
    aspectRatio: row.aspect_ratio,
    resolutionTier: row.resolution_tier,
    chatModel: row.chat_model ?? null,
    chatApi: row.chat_api === 'responses' || row.chat_api === 'anthropic' ? row.chat_api : 'chat-completions',
    analysisProviderId: row.analysis_provider_id ?? null,
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
  };
}
