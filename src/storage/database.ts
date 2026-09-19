import * as SQLite from 'expo-sqlite';

import type { ChatMessage, Conversation, ProviderProfile, ReferenceImage } from '../domain';

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
  created_at: number;
  updated_at: number;
};

type ConversationRow = {
  id: string;
  title: string;
  provider_id: string;
  transparent: number;
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
  references_json: string;
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
      await db.runAsync(
        `UPDATE messages SET status = 'interrupted', error = '应用在生成期间被关闭' WHERE status = 'pending'`,
      );
      return db;
    });
  }
  return databasePromise;
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
      (id, name, base_url, model, quality, aspect_ratio, resolution_tier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      model = excluded.model,
      quality = excluded.quality,
      aspect_ratio = excluded.aspect_ratio,
      resolution_tier = excluded.resolution_tier,
      updated_at = excluded.updated_at`,
    profile.id,
    profile.name,
    profile.baseUrl,
    profile.model,
    profile.quality,
    profile.aspectRatio,
    profile.resolutionTier,
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
    `INSERT INTO conversations (id, title, provider_id, transparent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    conversation.id,
    conversation.title,
    conversation.providerId,
    conversation.transparent ? 1 : 0,
    conversation.createdAt,
    conversation.updatedAt,
  );
}

export async function updateConversation(conversation: Conversation): Promise<void> {
  await (await getDatabase()).runAsync(
    `UPDATE conversations SET title = ?, provider_id = ?, transparent = ?, updated_at = ? WHERE id = ?`,
    conversation.title,
    conversation.providerId,
    conversation.transparent ? 1 : 0,
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
       transparent, image_uri, references_json, mask_uri, error, elapsed_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    JSON.stringify(message.references),
    message.maskUri,
    message.error,
    message.elapsedMs,
    message.createdAt,
  );
}

export async function updateMessage(message: ChatMessage): Promise<void> {
  await (await getDatabase()).runAsync(
    `UPDATE messages SET status = ?, image_uri = ?, error = ?, elapsed_ms = ?, references_json = ?, mask_uri = ?
     WHERE id = ?`,
    message.status,
    message.imageUri,
    message.error,
    message.elapsedMs,
    JSON.stringify(message.references),
    message.maskUri,
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
    references,
    maskUri: row.mask_uri,
    error: row.error,
    elapsedMs: row.elapsed_ms,
    createdAt: row.created_at,
  };
}
