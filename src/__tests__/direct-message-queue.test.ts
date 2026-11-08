import { createDirectMessageQueue, clearDirectMessageQueueScope } from '../remote/direct-message-queue';
import { createDirectComposerDraft, directDraftKey, type DirectDraftInput } from '../remote/direct-composer-drafts';

const mockSettings = new Map<string, string>(), mockFiles = new Map<string, string>();
const mockGet = jest.fn(async (key: string) => mockSettings.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); });
jest.mock('../storage/database', () => ({ getSetting: (key: string) => mockGet(key), setSetting: (key: string, value: string) => mockSet(key, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_: string, text: string) => require('node:crypto').createHash('sha256').update(text).digest('hex') }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://queue-tests/', EncodingType: { Base64: 'base64' }, getInfoAsync: async (uri: string) => ({ exists: mockFiles.has(uri), isDirectory: false }), readAsStringAsync: async (uri: string) => mockFiles.get(uri) ?? '', writeAsStringAsync: async (uri: string, data: string) => { mockFiles.set(uri, data); }, makeDirectoryAsync: async () => {}, deleteAsync: async (uri: string) => { mockFiles.delete(uri); } }));
const pairing = 'direct:queue-binding', deviceId = 'pc', owner = 'session/api/code';
const setting = 'direct_message_queues_v1', payloadSetting = 'remote_composer_drafts_v1';
const input: DirectDraftInput = { text: 'Review next', options: { collaborationMode: 'plan', skills: [{ name: 'review', path: 'C:/skills/review/SKILL.md' }] }, model: 'model-a', effort: 'high', permission: 'auto_review', images: [] };
const open = (override = {}) => createDirectMessageQueue({ pairing, deviceId, owner, ...override });
const controllers: ReturnType<typeof open>[] = [];
const queue = (override = {}) => { const value = open(override); controllers.push(value); return value; };
beforeEach(() => { jest.clearAllMocks(); mockSettings.clear(); mockFiles.clear(); mockGet.mockImplementation(async key => mockSettings.get(key) ?? null); mockSet.mockImplementation(async (key, value) => { mockSettings.set(key, value); }); });
afterEach(() => { controllers.splice(0).forEach(item => item.dispose()); });

test('concurrent enqueues persist FIFO and freeze every composer choice', async () => {
  const q = queue();
  const [a, b] = await Promise.all([q.enqueue(input, 'turn-1'), q.enqueue({ ...input, text: 'Second' }, 'turn-1')]);
  input.options.skills![0].name = 'changed';
  try {
    const rows = await q.load();
    expect(rows.map(row => row.id)).toEqual([a.id, b.id]);
    expect(rows[0]).toMatchObject({ state: 'waiting', afterTurnId: 'turn-1', input: { text: 'Review next', model: 'model-a', effort: 'high', permission: 'auto_review', options: { collaborationMode: 'plan', skills: [{ name: 'review' }] } } });
    await expect(q.markAttempting(b.id, b.revision)).rejects.toThrow('前一条');
  } finally { input.options.skills![0].name = 'review'; }
});

test('editing an unsent row preserves every choice and attachment while pausing the queue', async () => {
  const q=queue(), image={uri:'file://picker/edit.png',mime:'image/png' as const,width:10,height:10,base64:Buffer.from('edit-image').toString('base64')};
  const first=await q.enqueue({...input,images:[image]}), second=await q.enqueue({...input,text:'second'});
  const edited=await q.editText(first.id,first.revision,'Updated instruction');
  const rows=await q.load();
  expect(rows.map(row=>row.state)).toEqual(['blocked','blocked']);
  expect(edited.id).not.toBe(first.id); expect(rows[0].input).toMatchObject({...input,text:'Updated instruction',images:[expect.objectContaining({mime:'image/png'})]});
  expect(await q.hydrate(rows[0])).toEqual([expect.objectContaining({base64:image.base64})]);
  expect(rows[1].id).toBe(second.id);
});

test('reordering pauses untouched rows and attempted provenance survives block and resume', async () => {
  const q=queue(), first=await q.enqueue(input), second=await q.enqueue({...input,text:'second'});
  await q.move(second.id,second.revision,-1); const rows=await q.load();
  expect(rows.map(row=>row.id)).toEqual([second.id,first.id]); expect(rows.every(row=>row.state==='blocked')).toBe(true);
  const ready=await q.resume(rows[0].id,rows[0].revision), attempt=await q.markAttempting(ready.id,ready.revision);
  const rejected=await q.block(attempt.id,attempt.revision,'known rejection'), retry=await q.resume(rejected.id,rejected.revision);
  await expect(q.editText(retry.id,retry.revision,'rewrite attempted request')).rejects.toThrow('尝试送达');
  await expect(q.move(retry.id,retry.revision,1)).rejects.toThrow('尚未尝试');
});

test('failed edited metadata commit retains original payload and rejects a stale edit revision', async () => {
  const q=queue(), first=await q.enqueue(input);
  mockSet.mockImplementation(async(key,value)=>{if(key===setting)throw new Error('edit disk failure');mockSettings.set(key,value);});
  await expect(q.editText(first.id,first.revision,'will not commit')).rejects.toThrow('disk failure');
  expect(await q.load()).toMatchObject([{id:first.id,input:{text:input.text}}]);
  mockSet.mockImplementation(async(key,value)=>{mockSettings.set(key,value);}); await q.pause();
  await expect(q.editText(first.id,first.revision,'stale')).rejects.toThrow('已改变');
});

test('private images survive controller restart without storing base64 in metadata', async () => {
  const first = queue();
  const image = { uri: 'file://picker/photo.png', width: 20, height: 20, mime: 'image/png' as const, base64: Buffer.from('private-photo').toString('base64') };
  const saved = await first.enqueue({ ...input, images: [image] }); first.dispose();
  const next = queue(), [restored] = await next.load();
  expect(restored.id).toBe(saved.id); expect(restored.input.imageCount).toBe(1); expect(restored.input.images[0].base64).toBe('');
  expect(mockSettings.get(setting)).not.toContain(image.base64); expect(mockSettings.get(payloadSetting)).not.toContain(image.base64);
  expect(await next.hydrate(restored)).toEqual([{ ...image, uri: restored.input.images[0].uri }]);
});

test('computer, pairing, API and Code/Work queues are isolated', async () => {
  const first = queue(); await first.enqueue(input);
  for (const other of [{ deviceId: 'pc-2' }, { pairing: 'direct:other' }, { owner: 'session/other-api/code' }, { owner: 'session/api/work' }]) {
    const next = queue(other); expect(next.key).not.toBe(first.key); expect(await next.load()).toEqual([]);
  }
  expect(await first.load()).toHaveLength(1);
});

test('attempt is durable before dispatch and becomes unconfirmed after owner disappears', async () => {
  const first = queue(), row = await first.enqueue(input);
  const attempt = await first.markAttempting(row.id, row.revision, 'terminal-before-dispatch');
  expect(JSON.parse(mockSettings.get(setting)!)[first.key].entries[0]).toMatchObject({ state: 'attempting', revision: attempt.revision, afterTurnId: 'terminal-before-dispatch' });
  expect((await first.load())[0].state).toBe('attempting'); first.dispose();
  const next = queue(), [recovered] = await next.load();
  expect(recovered.state).toBe('unconfirmed');
  await expect(next.resume(recovered.id, recovered.revision)).rejects.toThrow('不能重新发送');
  await expect(next.remove(recovered.id, recovered.revision)).rejects.toThrow('请先核对送达状态');
  await expect(first.enqueue(input)).rejects.toThrow('已变化');
});

test('accepted receipt consumes only exact revision and advances next turn boundary', async () => {
  const q = queue(), first = await q.enqueue(input, 'turn-1'), second = await q.enqueue({ ...input, text: 'Second' }, 'turn-1');
  const attempt = await q.markAttempting(first.id, first.revision);
  await expect(q.consume(first.id, first.revision, 'turn-2')).rejects.toThrow('已改变');
  await expect(q.remove(first.id, attempt.revision)).rejects.toThrow('正在提交');
  await q.consume(first.id, attempt.revision, 'turn-2');
  expect(await q.load()).toMatchObject([{ id: second.id, afterTurnId: 'turn-2', revision: second.revision + 1, state: 'waiting' }]);
  await expect(q.remove(second.id, second.revision)).rejects.toThrow('已改变');
});

test('known rejection can resume but unknown result only reconciles an exact accepted operation', async () => {
  const q = queue(), row = await q.enqueue(input), attempt = await q.markAttempting(row.id, row.revision);
  const blocked = await q.block(row.id, attempt.revision, 'Rejected before send');
  const resumed = await q.resume(blocked.id, blocked.revision, 'turn-2');
  const nextAttempt = await q.markAttempting(resumed.id, resumed.revision);
  const unknown = await q.block(nextAttempt.id, nextAttempt.revision, 'Connection lost', true);
  await expect(q.resume(unknown.id, unknown.revision)).rejects.toThrow('不能重新发送');
  await q.reconcileAccepted(unknown.id, unknown.revision, 'turn-2'); expect(await q.load()).toEqual([]);
});

test('metadata failure leaves original draft intact and cleans unique queue payload', async () => {
  const draft = createDirectComposerDraft(pairing, deviceId, 'main-input'); await draft.restore(); await draft.save(input);
  mockSet.mockImplementation(async (key, value) => { if (key === setting) throw new Error('Disk full'); mockSettings.set(key, value); });
  await expect(queue().enqueue(input)).rejects.toThrow('Disk full');
  expect(await draft.restore()).toMatchObject({ text: input.text });
  expect(Object.keys(JSON.parse(mockSettings.get(payloadSetting)!))).toEqual([directDraftKey(pairing, deviceId, 'main-input')]); draft.close();
});

test('scope change during payload save cannot append stale message or leave a payload behind', async () => {
  let current = true;
  mockSet.mockImplementation(async (key, value) => { mockSettings.set(key, value); if (key === payloadSetting) current = false; });
  await expect(queue({ isCurrent: () => current }).enqueue(input)).rejects.toThrow('已变化');
  expect(mockSettings.has(setting)).toBe(false); expect(JSON.parse(mockSettings.get(payloadSetting)!)).toEqual({});
});

test('missing payload stays visible and cannot turn into an empty send', async () => {
  const q = queue(), row = await q.enqueue(input); mockSettings.set(payloadSetting, '{}');
  const [restored] = await q.load(); expect(restored).toMatchObject({ id: row.id, state: 'blocked', input: { missingImages: true } });
  await expect(q.markAttempting(row.id, row.revision)).rejects.toThrow('不能发送空消息');
});

test('malformed queue storage is never overwritten and revocation removes only its scope', async () => {
  const q = queue(); mockSettings.set(setting, '{broken');
  await expect(q.enqueue(input)).rejects.toThrow('原内容未覆盖'); expect(mockSettings.get(setting)).toBe('{broken');
  mockSettings.delete(setting); await q.enqueue(input); const other = queue({ pairing: 'direct:remaining' }); await other.enqueue(input);
  await clearDirectMessageQueueScope(pairing); expect(await q.load()).toEqual([]); expect(await other.load()).toHaveLength(1);
});
