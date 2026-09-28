// Agent data on a database created by an earlier version (no agent columns or tables yet).
const mockNativeDb = new (require('node:sqlite').DatabaseSync)(':memory:');
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async (sql: string) => mockNativeDb.exec(sql),
    runAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).run(...args),
    getAllAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).all(...args),
    getFirstAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).get(...args) ?? null,
  }),
}));

import type { AgentTrace, CustomAgent } from '../agent/types';
import type { ChatMessage } from '../domain';
import {
  clearMemoryRecords, deleteAgentRecord, deleteMemoryRecord, historyTerms, initializeDatabase, insertConversation, insertMemory, insertMessage,
  listAgents, listConversations, listMemories, listMessages, listReferencedFileNames, searchMessages, snippetAround, updateMessage, upsertAgent,
} from '../storage/database';

beforeAll(() => {
  mockNativeDb.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, provider_id TEXT NOT NULL,
      transparent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'image');
    CREATE TABLE messages (id TEXT PRIMARY KEY NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      prompt TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL,
      quality TEXT NOT NULL, size TEXT NOT NULL, transparent INTEGER NOT NULL DEFAULT 0, image_uri TEXT,
      references_json TEXT NOT NULL DEFAULT '[]', mask_uri TEXT, error TEXT, elapsed_ms INTEGER, created_at INTEGER NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE);
    INSERT INTO conversations VALUES ('old', '旧对话：装修预算', 'p', 0, 1, 1, 'auto');
    INSERT INTO messages (id, conversation_id, role, prompt, mode, status, provider_id, model, quality, size, created_at)
      VALUES ('o1', 'old', 'user', '厨房装修 100% 要多少钱_预算', 'chat', 'complete', 'p', 'm', 'auto', '', 1);
  `);
});
afterAll(() => mockNativeDb.close());

const message = (patch: Partial<ChatMessage>): ChatMessage => ({
  id: 'x', conversationId: 'c1', role: 'assistant', prompt: 'p', mode: 'chat', status: 'complete', providerId: 'p', model: 'm', quality: 'auto', size: '',
  transparent: false, imageUri: null, remoteImageUrl: null, references: [], maskUri: null, error: null, elapsedMs: null, createdAt: 10, ...patch,
});

test('old databases gain agent columns and tables; traces round-trip', async () => {
  await initializeDatabase();
  expect((await listConversations())[0]).toMatchObject({ id: 'old', agentId: null });
  await insertConversation({ id: 'c1', title: '天气', providerId: 'p', transparent: false, mode: 'auto', agentId: 'agent-1', createdAt: 5, updatedAt: 5 });
  const trace: AgentTrace = {
    steps: [{ id: 's', kind: 'search', title: '搜索：天气', status: 'done', startedAt: 1 }],
    sources: [{ title: 'W', url: 'https://w.example' }],
    files: [{ id: 'f', uri: 'file:///docs/generated-files/abc/%E9%A2%84%E7%AE%97.csv', name: '预算.csv', mimeType: 'text/csv', size: 3 }],
    drafts: ['file:///docs/generated-images/draft.png'],
  };
  await insertMessage(message({ id: 'u', role: 'user', prompt: '明天杭州天气', createdAt: 9 }));
  await insertMessage(message({ id: 'a', text: null, agent: null }));
  await updateMessage(message({ id: 'a', text: '明天晴，适合出游 [1]', agent: trace }));
  const [, assistant] = await listMessages('c1');
  expect(assistant.agent).toEqual(trace);
  expect((await listConversations()).find((item) => item.id === 'c1')?.agentId).toBe('agent-1');
  const names = await listReferencedFileNames();
  expect(names.has('预算.csv')).toBe(true);
  expect(names.has('draft.png')).toBe(true);
});

test('history search matches every term in prompts, replies or titles, and escapes wildcards', async () => {
  expect(historyTerms(' 杭州，天气  明天 ')).toEqual(['杭州', '天气', '明天']);
  expect((await searchMessages('出游 晴')).map((hit) => hit.messageId)).toEqual(['a']);
  expect((await searchMessages('杭州 天气')).map((hit) => hit.messageId)).toEqual(['u']);
  expect((await searchMessages('装修')).map((hit) => hit.conversationId)).toEqual(['old']);
  expect((await searchMessages('天气', { excludeConversationId: 'c1' }))).toEqual([]);
  expect((await searchMessages('100%')).map((hit) => hit.messageId)).toEqual(['o1']);
  expect((await searchMessages('%'))).toHaveLength(1);
  expect((await searchMessages('_预算')).map((hit) => hit.messageId)).toEqual(['o1']);
  expect(await searchMessages('   ')).toEqual([]);
  expect(snippetAround('a'.repeat(100) + '关键词' + 'b'.repeat(100), '关键词', 5)).toBe('…aaaaa关键词bbbbb…');
});

test('memories and agents are stored; deleting an agent keeps its conversations', async () => {
  await insertMemory({ id: 'm1', content: '住在杭州', conversationId: 'c1', createdAt: 1, updatedAt: 1 });
  await insertMemory({ id: 'm2', content: '是老师', conversationId: null, createdAt: 2, updatedAt: 2 });
  expect((await listMemories()).map((item) => item.content)).toEqual(['住在杭州', '是老师']);
  await deleteMemoryRecord('m1');
  expect((await listMemories()).map((item) => item.id)).toEqual(['m2']);
  await clearMemoryRecords();
  expect(await listMemories()).toEqual([]);

  const agent: CustomAgent = { id: 'agent-1', name: '旅行', icon: '✈', color: '#F08A3C', description: 'd', instructions: 'i', capabilities: ['search', 'files'], starters: ['去哪玩'], providerId: null, model: null, createdAt: 1, updatedAt: 1 };
  await upsertAgent(agent);
  await upsertAgent({ ...agent, name: '旅行规划', updatedAt: 2 });
  expect(await listAgents()).toEqual([{ ...agent, name: '旅行规划', updatedAt: 2 }]);
  await deleteAgentRecord('agent-1');
  expect(await listAgents()).toEqual([]);
  expect((await listConversations()).find((item) => item.id === 'c1')).toMatchObject({ agentId: null });
  expect(await listMessages('c1')).toHaveLength(2);
});
