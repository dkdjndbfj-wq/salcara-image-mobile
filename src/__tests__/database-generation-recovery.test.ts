// Reopen the same real SQLite database to exercise cold-start recovery, not a
// mocked UPDATE: saved pictures and resumable jobs must survive app restarts.
let mockNativeDb: InstanceType<typeof import('node:sqlite').DatabaseSync>;
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async (sql: string) => mockNativeDb.exec(sql),
    runAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).run(...args as never[]),
    getAllAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).all(...args as never[]),
    getFirstAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).get(...args as never[]) ?? null,
  }),
}));

import type { AgentTrace } from '../agent/types';
import type { ChatMessage } from '../domain';

let storage: typeof import('../storage/database');
const closedError = '应用在生成期间被关闭';

beforeEach(async () => {
  mockNativeDb = new (require('node:sqlite').DatabaseSync)(':memory:');
  jest.resetModules();
  storage = require('../storage/database');
  await storage.initializeDatabase();
  await storage.insertConversation({ id: 'c', title: '海报', providerId: 'p', mode: 'auto', transparent: false, createdAt: 1, updatedAt: 1 });
});

afterEach(() => mockNativeDb.close());

function message(patch: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm', conversationId: 'c', role: 'assistant', prompt: '修改海报', mode: 'edit', status: 'pending',
    providerId: 'p', model: 'image-model', quality: 'auto', size: '1024x1024', transparent: false,
    imageUri: null, remoteImageUrl: null, references: [], maskUri: null, error: null, elapsedMs: null, createdAt: 1,
    preparedPrompt: '每个城市只保留一个坐标', ...patch,
  };
}

async function restart(): Promise<ChatMessage[]> {
  jest.resetModules();
  storage = require('../storage/database');
  await storage.initializeDatabase();
  return storage.listMessages('c');
}

test('an image saved before follow-up completion remains delivered after restart', async () => {
  const agent: AgentTrace = {
    steps: [
      { id: 'draw', kind: 'image', title: '绘制海报', status: 'running', startedAt: 1 },
      { id: 'check', kind: 'check', title: '检查文字', status: 'running', startedAt: 2 },
      { id: 'search', kind: 'search', title: '搜索完成', status: 'done', startedAt: 1, endedAt: 2 },
    ],
    drafts: ['file:///previous.png'],
  };
  await storage.insertMessage(message({ imageUri: 'file:///generated-images/poster.png', text: '我来修改海报', agent }));

  const [recovered] = await restart();
  expect(recovered).toMatchObject({ status: 'complete', error: null, imageUri: 'file:///generated-images/poster.png', text: '我来修改海报' });
  expect(recovered.agent?.steps[0]).toMatchObject({ id: 'draw', status: 'done', detail: '已生成', endedAt: expect.any(Number) });
  expect(recovered.agent?.steps[1]).toMatchObject({ id: 'check', status: 'error', error: '已中断', endedAt: expect.any(Number) });
  expect(recovered.agent?.steps[2]).toEqual(agent.steps[2]);
  expect(recovered.agent?.drafts).toEqual(agent.drafts);
  const savedTrace = JSON.parse((mockNativeDb.prepare('SELECT agent_json FROM messages WHERE id = ?').get('m') as { agent_json: string }).agent_json);
  expect(savedTrace.steps.every((step: { status: string }) => step.status !== 'running')).toBe(true);
  expect((await restart())[0]).toEqual(recovered);
});

test.each(['file:///poster.png', 'content://media/poster', '/documents/poster.png', 'C:\\images\\poster.png', 'generated-images/poster.png'])(
  'repairs the old false interruption for a saved local image (%s)', async (imageUri) => {
    await storage.insertMessage(message({ status: 'interrupted', error: closedError, imageUri }));
    expect((await restart())[0]).toMatchObject({ status: 'complete', error: null, imageUri });
  },
);

test('keeps download URLs, accepted upstream jobs and unfinished drawing attempts retryable', async () => {
  await storage.insertMessage(message({ id: 'download', remoteImageUrl: 'https://images.example/poster.png' }));
  await storage.insertMessage(message({ id: 'redownload', imageUri: 'file:///old.png', remoteImageUrl: 'https://images.example/new.png' }));
  await storage.insertMessage(message({ id: 'redraw', agent: {
    steps: [{ id: 'draw', kind: 'image', title: '重绘', status: 'running', startedAt: 1 }], drafts: ['file:///previous.png'],
  } }));
  await storage.setSetting('image_task:redraw', JSON.stringify({ id: 'task-1', url: 'https://images.example/tasks/task-1' }));

  const recovered = await restart();
  expect(recovered.every((item) => item.status === 'interrupted' && item.error === closedError)).toBe(true);
  expect(recovered.find((item) => item.id === 'download')?.remoteImageUrl).toBe('https://images.example/poster.png');
  expect(recovered.find((item) => item.id === 'redownload')).toMatchObject({ imageUri: 'file:///old.png', remoteImageUrl: 'https://images.example/new.png' });
  expect(recovered.find((item) => item.id === 'redraw')?.agent).toMatchObject({
    steps: [{ id: 'draw', status: 'error', error: '已中断' }], drafts: ['file:///previous.png'],
  });
  expect(JSON.parse((await storage.getSetting('image_task:redraw'))!)).toMatchObject({ id: 'task-1' });
});

test('does not reinterpret unrelated errors, cancellations or completed messages', async () => {
  await storage.insertMessage(message({ id: 'failed', status: 'error', error: '网络请求失败', imageUri: 'file:///poster.png' }));
  await storage.insertMessage(message({ id: 'cancelled', status: 'cancelled', error: '已停止', imageUri: 'file:///poster.png' }));
  await storage.insertMessage(message({ id: 'interrupted', status: 'interrupted', error: '下载未完成', imageUri: 'file:///poster.png' }));
  await storage.insertMessage(message({ id: 'complete', status: 'complete', error: null, imageUri: 'file:///poster.png' }));
  const before = await storage.listMessages('c');
  expect(await restart()).toEqual(before);
});

test('an empty path, remote-only URI or partial text is not a delivered local image', async () => {
  await storage.insertMessage(message({ id: 'blank', imageUri: '   ' }));
  await storage.insertMessage(message({ id: 'remote', imageUri: 'https://images.example/poster.png' }));
  await storage.insertMessage(message({ id: 'text', mode: 'chat', text: '我来修改地图上的坐标' }));
  const recovered = await restart();
  expect(recovered.every((item) => item.status === 'interrupted')).toBe(true);
  expect(recovered.find((item) => item.id === 'text')?.text).toBe('我来修改地图上的坐标');
});

test('preserves malformed legacy trace data while recovering the saved image', async () => {
  await storage.insertMessage(message({ imageUri: 'file:///poster.png' }));
  await mockNativeDb.prepare('UPDATE messages SET agent_json = ? WHERE id = ?').run('{incomplete', 'm');
  expect((await restart())[0]).toMatchObject({ status: 'complete', error: null, agent: null });
  expect(mockNativeDb.prepare('SELECT agent_json FROM messages WHERE id = ?').get('m')).toMatchObject({ agent_json: '{incomplete' });
});

test('restart preserves each completed result, marks only unfinished images interrupted, and protects all files from cleanup', async () => {
  const images = [
    { id: 'image-1', uri: 'file:///generated-images/one.png', status: 'complete' as const },
    { id: 'image-2', uri: null, remoteUrl: 'https://images.example/two.png', status: 'pending' as const },
    { id: 'image-3', uri: 'file:///generated-images/three.png', status: 'complete' as const },
  ];
  await storage.insertMessage(message({ imageUri: images[0].uri, imageCount: 3, generatedImages: images }));
  const [saved] = await restart();
  expect(saved).toMatchObject({ status: 'complete', error: null, imageCount: 3 });
  expect(saved.generatedImages).toMatchObject([images[0], { ...images[1], status: 'error', error: '图片下载已中断' }, images[2]]);
  expect(await storage.listReferencedFileNames()).toEqual(new Set(['one.png', 'three.png']));
  expect((await restart())[0]).toEqual(saved);
});

test('ten images round trip and a corrupt batch cannot masquerade as delivered images', async () => {
  const images = Array.from({ length: 10 }, (_, index) => ({ id: `image-${index}`, uri: `file:///generated-images/${index}.png`, status: 'complete' as const }));
  await storage.insertMessage(message({ imageCount: 10, generatedImages: images }));
  expect((await storage.listMessages('c'))[0].generatedImages).toHaveLength(10);
  const [saved] = await restart();
  expect(saved.status).toBe('complete');
  expect(await storage.listReferencedFileNames()).toHaveProperty('size', 10);
  await mockNativeDb.prepare('UPDATE messages SET generated_images_json = ?, status = ?, image_count = ? WHERE id = ?').run('{broken', 'pending', 999, 'm');
  expect((await restart())[0]).toMatchObject({ status: 'interrupted', generatedImages: [], imageCount: 1 });
});

test('cold-start cleanup retains files in accepted task checkpoints only while their message exists', async () => {
  await storage.insertMessage(message({}));
  await storage.setSetting('image_task:m', JSON.stringify({ id: 'accepted', url: 'https://images.example/tasks/accepted', results: [
    { localUri: 'file:///generated-images/accepted.png' },
    { localUri: 'file:///private/outside.png' },
    { localUri: 'file:///generated-images/%2e%2e/outside.png' },
  ] }));
  await storage.setSetting('image_task:gone', JSON.stringify({ results: [{ localUri: 'file:///generated-images/orphan.png' }] }));
  await restart();
  expect(await storage.listReferencedFileNames()).toEqual(new Set(['accepted.png']));
  mockNativeDb.prepare('DELETE FROM messages WHERE id = ?').run('m');
  expect(await storage.listReferencedFileNames()).toEqual(new Set());
});
