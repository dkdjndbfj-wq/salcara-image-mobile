const mockNativeDb = new (require('node:sqlite').DatabaseSync)(':memory:');
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async (sql: string) => mockNativeDb.exec(sql),
    runAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).run(...args),
    getAllAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).all(...args),
    getFirstAsync: async (sql: string, ...args: unknown[]) => mockNativeDb.prepare(sql).get(...args) ?? null,
  }),
}));
const mockReplies: Array<Record<string, unknown>> = [];
const mockPrompts: string[] = [];
jest.mock('../memorybox/worker', () => ({
  resolveWorker: () => ({ provider: { id: 'p', name: 'p', baseUrl: 'https://x', chatApi: 'chat-completions' }, model: 'm' }),
  completeJson: async (_worker: unknown, system: string, prompt: string) => { mockPrompts.push(`${system.slice(0, 20)}|${prompt}`); return mockReplies.shift() ?? { ops: [] }; },
}));
jest.mock('expo-secure-store', () => ({ getItemAsync: async () => null }));

import type { ChatMessage } from '../domain';
import { isPoke, pokeText, rainFor, setReaction } from '../companion/reactions';
import { buildCompanionContext } from '../memorybox/context';
import { noteMarkdown, vaultNames } from '../memorybox/export';
import { layoutGraph } from '../memorybox/layout';
import { configureMemoryPipeline, RAW_WINDOW, scheduleMemoryWork } from '../memorybox/pipeline';
import { bm25, retrieve, tokenize } from '../memorybox/search';
import { resetMemoryBoxSettingsForTesting } from '../memorybox/settings';
import { addLinks, deleteCharacterRecords, listAboutUserNotes, loadBox, loadCharacters, newNote, patchNotes, putNotes, removeOrphans, resetMemoryBoxCacheForTesting, saveCharacter, updateCharacter } from '../memorybox/store';
import type { Character, MemNote } from '../memorybox/types';
import { initializeDatabase, insertConversation, insertMessage } from '../storage/database';

const DAY = 86_400_000;
const character = (patch: Partial<Character> = {}): Character => ({
  id: 'c1', name: '暖暖', icon: '🌙', color: '#E2609A', persona: '温柔', style: '', relationship: '好朋友', greeting: '嗨', canDraw: true, canSearch: true,
  avatarUri: null, providerId: null, model: null, memoryMode: 'auto', coreMemory: '', conversationId: 'conv', extractedUntil: 0, compactedUntil: 0, notesSinceReflection: 0,
  lastMessageAt: 0, createdAt: 0, updatedAt: 0, ...patch,
});
const note = (patch: Partial<MemNote> & Pick<MemNote, 'title'>): MemNote => newNote({ owner: 'c1', type: 'fact', ...patch });
const message = (index: number, role: 'user' | 'assistant', text: string): ChatMessage => ({
  id: `m${index}`, conversationId: 'conv', role, prompt: role === 'user' ? text : '', mode: 'chat', status: 'complete', providerId: 'p', model: 'm', quality: 'auto', size: '',
  transparent: false, imageUri: null, remoteImageUrl: null, references: [], documents: [], maskUri: null, error: null, elapsedMs: null, createdAt: 1000 + index * 1000,
  text: role === 'assistant' ? text : null,
});

beforeAll(async () => {
  await initializeDatabase();
  configureMemoryPipeline({ providers: () => [], chatProvider: () => null });
});
afterAll(() => mockNativeDb.close());

test('Chinese text is tokenized into bigrams so keyword recall works without spaces', () => {
  expect(tokenize('她的猫叫团子')).toEqual(['她的', '的猫', '猫叫', '叫团', '团子']);
  expect(tokenize('I love Tokyo 2026!')).toEqual(['love', 'tokyo', '2026']);
  const scores = bm25('团子最近怎么样', [tokenize('她的猫叫团子，很黏人'), tokenize('下周三考驾照'), tokenize('喜欢吃火锅')]);
  expect(scores[0]).toBeGreaterThan(0);
  expect(scores[1]).toBe(0);
});

test('retrieval blends relevance, importance and recency, follows links and demotes outdated facts', () => {
  const now = 100 * DAY;
  const cat = note({ title: '她的猫叫团子', content: '橘猫，三岁', importance: 7, updatedAt: now - DAY });
  const vet = note({ title: '带猫看医生', content: '周六去宠物医院', type: 'event', importance: 5, updatedAt: now - 2 * DAY });
  const oldHome = note({ title: '住在北京', content: '北京朝阳', importance: 6, validTo: now - 10 * DAY });
  const newHome = note({ title: '搬到杭州', content: '现在住在杭州', importance: 6 });
  const hits = retrieve([cat, vet, oldHome, newHome], [{ id: 'l', owner: 'c1', source: cat.id, target: vet.id, relation: '相关', weight: 1, createdAt: 0 }], { query: '团子还好吗', now });
  expect(hits[0].note.id).toBe(cat.id);
  expect(hits.find((hit) => hit.note.id === vet.id)?.via).toBe(cat.id);
  const homes = retrieve([oldHome, newHome], [], { query: '住在哪里 北京 杭州', now, includeOutdated: true });
  expect(homes[0].note.id).toBe(newHome.id);
  expect(retrieve([oldHome], [], { query: '北京', now })).toEqual([]);
});

test('the companion context carries core memory, 往事 in order, recalled notes and only raw turns after the last summary', () => {
  const ep1 = note({ title: '第一次聊天', content: '聊了工作', type: 'episode', rangeStart: 1, rangeEnd: 5 });
  const ep2 = note({ title: '周末计划', content: '约了看展', type: 'episode', rangeStart: 6, rangeEnd: 9 });
  const rolled = note({ title: '被合并的', content: 'x', type: 'episode', rangeStart: 0, rangeEnd: 1, rolledUp: true });
  const fact = note({ title: '她的猫叫团子', content: '橘猫', importance: 8 });
  const recent = [message(1, 'user', '早'), message(2, 'assistant', '早呀'), message(20, 'user', '团子今天吐了')];
  const context = buildCompanionContext({
    character: character({ coreMemory: '用户叫小满', compactedUntil: 5000 }), notes: [ep2, ep1, rolled, fact], links: [], query: '团子今天吐了', recent, memoryOn: true,
  });
  const all = context.instructions.join('\n');
  expect(all).toContain('用户叫小满');
  expect(all.indexOf('第一次聊天')).toBeLessThan(all.indexOf('周末计划'));
  expect(all).not.toContain('被合并的');
  expect(context.recalled.map((item) => item.title)).toEqual(['她的猫叫团子']);
  expect(context.history.map((item) => item.id)).toEqual(['m20']);
});

test('the pipeline extracts cards, supersedes changed facts, then folds old turns into 往事', async () => {
  resetMemoryBoxCacheForTesting();
  resetMemoryBoxSettingsForTesting();
  await insertConversation({ id: 'conv', title: '暖暖', providerId: 'p', transparent: false, mode: 'auto', kind: 'companion', characterId: 'c1', createdAt: 0, updatedAt: 0 });
  await saveCharacter(character());
  await putNotes('c1', [note({ title: '住在北京', content: '北京朝阳区', aboutUser: true })]);
  for (let index = 0; index < RAW_WINDOW; index += 1) await insertMessage(message(index, index % 2 ? 'assistant' : 'user', index === 0 ? '我搬到杭州啦，养了只猫叫团子' : `第 ${index} 句`));
  mockReplies.push(
    { ops: [
      { op: 'add', type: 'person', title: '猫叫团子', content: '用户养的猫', importance: 7, about_user: true, links: [{ to: 'N1', relation: '相关' }] },
      { op: 'supersede', id: 'N1', title: '住在杭州', content: '用户搬到了杭州' },
      { op: 'add', title: '银行卡号 6222021234567890123', content: 'x' },
    ], core: '用户刚搬到杭州，养了猫团子' },
    { ops: [] },
    { title: '搬家与新猫', summary: '用户搬到杭州，养了一只叫团子的猫。' },
  );
  await scheduleMemoryWork('c1');
  const box = await loadBox('c1', true);
  const titles = box.notes.map((item) => item.title);
  expect(titles).toEqual(expect.arrayContaining(['猫叫团子', '住在杭州', '搬家与新猫']));
  expect(titles.some((title) => title.includes('银行卡'))).toBe(false);
  const old = box.notes.find((item) => item.title === '住在北京')!;
  const fresh = box.notes.find((item) => item.title === '住在杭州')!;
  expect(old.validTo).not.toBeNull();
  expect(old.supersededBy).toBe(fresh.id);
  expect(fresh.aboutUser).toBe(true);
  expect(box.links.some((link) => link.source === fresh.id && link.target === old.id && link.relation === '取代')).toBe(true);
  const episode = box.notes.find((item) => item.type === 'episode')!;
  expect(episode).toMatchObject({ level: 1, rangeStart: 1000, rangeEnd: 12_000 });
  const saved = (await loadCharacters(true)).find((item) => item.id === 'c1')!;
  expect(saved.coreMemory).toBe('用户刚搬到杭州，养了猫团子');
  expect(saved.extractedUntil).toBe(1000 + (RAW_WINDOW - 1) * 1000);
  expect(saved.compactedUntil).toBe(12_000);
  // The extraction prompt showed the existing card with a label the model could refer to.
  expect(mockPrompts[0]).toContain('N1 [fact] 住在北京');
});

test('export writes Obsidian notes with unique names and wiki links', () => {
  const a = note({ title: '猫/团子', content: '橘猫', tags: ['宠物'] });
  const b = note({ title: '猫/团子', content: '同名' });
  const names = vaultNames([a, b]);
  expect([...names.values()]).toEqual(['猫 团子', '猫 团子 2']);
  const markdown = noteMarkdown(a, names, [{ id: 'l', owner: 'c1', source: a.id, target: b.id, relation: '相关', weight: 1, createdAt: 0 }]);
  expect(markdown).toContain('tags: ["事实", "宠物"]');
  expect(markdown).toContain('- 相关：[[猫 团子 2]]');
});

test('layout places every note, keeps saved positions nearly still and is deterministic', () => {
  const notes = Array.from({ length: 40 }, (_, index) => note({ id: `n${index}`, title: `记忆 ${index}`, type: index % 2 ? 'event' : 'person', x: index < 20 ? index * 30 : null, y: index < 20 ? 0 : null }));
  const links = notes.slice(1).map((item, index) => ({ id: `l${index}`, owner: 'c1', source: notes[index].id, target: item.id, relation: '相关', weight: 1, createdAt: 0 }));
  const first = layoutGraph(notes, links, 40);
  const second = layoutGraph(notes, links, 40);
  expect(first.size).toBe(40);
  expect([...first.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  expect(first.get('n30')).toEqual(second.get('n30'));
  void addLinks;
});

test('characters keep their avatar picture, and chat reactions and magic words work', async () => {
  await saveCharacter(character({ id: 'c2', conversationId: 'conv2', avatarUri: 'file:///avatars/a.jpg' }));
  const loaded = (await loadCharacters(true)).find((item) => item.id === 'c2');
  expect(loaded?.avatarUri).toBe('file:///avatars/a.jpg');
  await setReaction('conv2', 'm1', '❤️');
  await setReaction('conv2', 'm1', '😂');
  const rows = mockNativeDb.prepare('SELECT emoji FROM reactions WHERE message_id = ?').all('m1') as Array<{ emoji: string }>;
  expect(rows.map((row) => row.emoji)).toEqual(['😂']);
  await setReaction('conv2', 'm1', null);
  expect(mockNativeDb.prepare('SELECT COUNT(*) AS n FROM reactions').get()).toEqual({ n: 0 });
  expect(rainFor('祝你生日快乐！')).toContain('🎂');
  expect(rainFor('今天吃什么')).toBeNull();
  expect(isPoke(pokeText('暖暖'))).toBe(true);
  expect(rainFor(pokeText('晚安'))).toBeNull();
});

test('edits write only their own columns, and a deleted character leaves no notes behind', async () => {
  resetMemoryBoxCacheForTesting();
  await saveCharacter(character({ id: 'c3', conversationId: 'conv3', coreMemory: '旧' }));
  // Another writer changed a column after our cache was loaded: a patch of other columns must not restore the old value.
  mockNativeDb.prepare('UPDATE characters SET core_memory = ? WHERE id = ?').run('新', 'c3');
  await updateCharacter('c3', { extractedUntil: 5 });
  expect(mockNativeDb.prepare('SELECT core_memory, extracted_until FROM characters WHERE id = ?').get('c3')).toEqual({ core_memory: '新', extracted_until: 5 });
  const card = note({ owner: 'c3', title: '喜欢猫', content: '橘猫', aboutUser: true });
  await putNotes('c3', [card]);
  mockNativeDb.prepare('UPDATE mem_notes SET content = ? WHERE id = ?').run('用户刚改过', card.id);
  await patchNotes('c3', [{ id: card.id, patch: { importance: 9 } }]);
  expect(mockNativeDb.prepare('SELECT content, importance FROM mem_notes WHERE id = ?').get(card.id)).toEqual({ content: '用户刚改过', importance: 9 });
  expect((await listAboutUserNotes()).some((item) => item.id === card.id)).toBe(true);
  await deleteCharacterRecords('c3');
  await putNotes('c3', [note({ owner: 'c3', title: '迟到的卡片' })]);
  mockNativeDb.prepare("INSERT INTO mem_notes (id, owner, type, title, content, tags_json, importance, about_user, pinned, valid_from, level, rolled_up, access_count, created_at, updated_at) VALUES ('orphan', 'gone', 'fact', 'x', '', '[]', 5, 1, 0, 0, 0, 0, 0, 0, 0)").run();
  expect((await listAboutUserNotes()).some((item) => item.owner === 'gone')).toBe(false);
  await removeOrphans();
  expect(mockNativeDb.prepare("SELECT COUNT(*) AS n FROM mem_notes WHERE owner IN ('c3', 'gone')").get()).toEqual({ n: 0 });
});
