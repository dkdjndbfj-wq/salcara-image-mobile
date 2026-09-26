// Upgrade from the 1.3.x schema, where conversations cascaded on provider delete.
const mockNativeDb = new (require('node:sqlite').DatabaseSync)(':memory:');
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async (sql: string) => mockNativeDb.exec(sql),
    runAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).run(...args),
    getAllAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).all(...args),
    getFirstAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).get(...args) ?? null,
  }),
}));

import { deleteProviderRecord, initializeDatabase, listConversations, listMessages } from '../storage/database';

beforeAll(() => {
  mockNativeDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE providers (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT,
      quality TEXT, aspect_ratio TEXT, resolution_tier TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, provider_id TEXT NOT NULL,
      transparent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE);
    CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      prompt TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
      quality TEXT NOT NULL, size TEXT NOT NULL, transparent INTEGER NOT NULL DEFAULT 0, image_uri TEXT,
      references_json TEXT NOT NULL DEFAULT '[]', mask_uri TEXT, error TEXT, elapsed_ms INTEGER, created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
    INSERT INTO providers VALUES ('only', '唯一服务商', 'https://example.com/v1', 'gpt-image-2', 'high', '1:1', '1K', 1, 1);
    INSERT INTO conversations VALUES ('c1', '旧会话', 'only', 0, 1, 5);
    INSERT INTO messages VALUES ('m1', 'c1', 'user', '你好', 'chat', 'complete', 'only', 'm', 'auto', '', 0, NULL, '[]', NULL, NULL, NULL, 1);
  `);
});
afterAll(() => mockNativeDb.close());

test('deleting the only provider keeps every conversation and message', async () => {
  await initializeDatabase();
  expect(mockNativeDb.prepare('PRAGMA foreign_key_list(conversations)').all()).toEqual([]);
  await deleteProviderRecord('only');
  expect((await listConversations()).map((item) => item.id)).toEqual(['c1']);
  expect((await listMessages('c1')).map((item) => item.prompt)).toEqual(['你好']);
  // Messages still cascade with their conversation.
  expect(mockNativeDb.prepare('PRAGMA foreign_key_list(messages)').all()).toEqual([expect.objectContaining({ table: 'conversations' })]);
  // Second start is a no-op.
  await initializeDatabase();
  expect((await listConversations())).toHaveLength(1);
});
