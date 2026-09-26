// Exercise upgrades against real SQLite, including the older installed schema.
// Node 22+ (the project's CI runtime) provides this built-in test database.
const mockNativeDb = new (require('node:sqlite').DatabaseSync)(':memory:');
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async (sql: string) => mockNativeDb.exec(sql),
    runAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).run(...args),
    getAllAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).all(...args),
    getFirstAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).get(...args) ?? null,
  }),
}));

import { initializeDatabase, insertConversation, insertMessage, listConversations, listMessages, listProviders, updateMessage, upsertProvider } from '../storage/database';
import type { ChatMessage, ProviderProfile } from '../domain';
import { snapshotCreationSkill } from '../creation-skills';

beforeAll(() => {
  mockNativeDb.exec(`
    CREATE TABLE providers (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT,
      quality TEXT, aspect_ratio TEXT, resolution_tier TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, provider_id TEXT NOT NULL,
      transparent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      prompt TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
      quality TEXT NOT NULL, size TEXT NOT NULL, transparent INTEGER NOT NULL DEFAULT 0, image_uri TEXT,
      references_json TEXT NOT NULL DEFAULT '[]', mask_uri TEXT, error TEXT, elapsed_ms INTEGER, created_at INTEGER NOT NULL);
    INSERT INTO providers VALUES ('old', '原服务商', 'https://example.com/v1', 'gpt-image-2', 'high', '1:1', '1K', 1, 1);
    INSERT INTO conversations VALUES ('old-c', '原会话', 'old', 1, 1, 1);
    INSERT INTO messages VALUES ('old-m', 'old-c', 'assistant', '原提示词', 'generate', 'complete', 'old', 'gpt-image-2',
      'high', '1024x1024', 0, 'file:///original.png', '[]', NULL, NULL, 1000, 1);
  `);
});

afterAll(() => mockNativeDb.close());

test('additive migrations preserve installed providers, conversations and images', async () => {
  await initializeDatabase();
  expect((await listProviders())[0]).toMatchObject({ id: 'old', model: 'gpt-image-2', chatModel: null, chatApi: 'chat-completions', imageProviderId: null });
  expect((await listConversations())[0]).toMatchObject({ id: 'old-c', mode: 'image', transparent: true });
  expect((await listMessages('old-c'))[0]).toMatchObject({ imageUri: 'file:///original.png', documents: [], text: null, preparedPrompt: null, creationSkill: null, creationNotes: null });
  await initializeDatabase();
  expect(await listProviders()).toHaveLength(1);
});

test('roundtrips chat settings, document attachments and resumable prepared prompts', async () => {
  const profile: ProviderProfile = {
    id: 'new', name: '聊天', baseUrl: 'https://chat.example.com/v1', model: null, quality: null, aspectRatio: null,
    resolutionTier: null, createdAt: 2, updatedAt: 2, chatModel: 'custom-vision', chatApi: 'responses', analysisProviderId: 'old', imageProviderId: 'old',
  };
  await upsertProvider(profile);
  await insertConversation({ id: 'new-c', title: '文档对话', providerId: 'new', mode: 'chat', transparent: false, createdAt: 2, updatedAt: 2 });
  const message: ChatMessage = {
    id: 'new-m', conversationId: 'new-c', role: 'assistant', prompt: '解析资料', mode: 'chat', status: 'pending', providerId: 'new',
    model: 'custom-vision', quality: 'auto', size: '', transparent: false, imageUri: null, remoteImageUrl: null, references: [], maskUri: null,
    error: null, elapsedMs: null, createdAt: 2, requestApi: 'responses', analysisApi: 'chat-completions',
    documents: [{ id: 'd', uri: 'file:///source.pdf', name: '方案.pdf', mimeType: 'application/pdf', size: 10 }],
    creationSkill: snapshotCreationSkill('poster-layout'),
  };
  await insertMessage(message);
  expect((await listMessages('new-c'))[0].creationSkill).toEqual(message.creationSkill);
  await updateMessage({ ...message, status: 'complete', text: '已解析', preparedPrompt: '根据场地尺寸生图', analysisModel: 'vision', analysisProviderId: 'old', creationNotes: '底部正文尚未叠排：欢迎参加' });
  expect((await listProviders()).find((item) => item.id === 'new')).toMatchObject(profile);
  expect((await listConversations()).find((item) => item.id === 'new-c')?.mode).toBe('chat');
  expect((await listMessages('new-c'))[0]).toMatchObject({
    documents: message.documents, text: '已解析', preparedPrompt: '根据场地尺寸生图', analysisModel: 'vision', analysisProviderId: 'old',
    requestApi: 'responses', analysisApi: 'chat-completions',
    creationSkill: message.creationSkill, creationNotes: '底部正文尚未叠排：欢迎参加',
  });
});

test('retains the native Claude protocol after reloading a saved provider', async () => {
  await upsertProvider({
    id: 'claude', name: 'Claude', baseUrl: 'https://example.com/v1', model: null, quality: null, aspectRatio: null,
    resolutionTier: null, createdAt: 3, updatedAt: 3, chatModel: 'claude-test', chatApi: 'anthropic',
  });
  expect((await listProviders()).find((item) => item.id === 'claude')).toMatchObject({ chatApi: 'anthropic', chatModel: 'claude-test' });
});
