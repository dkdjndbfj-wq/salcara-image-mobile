import { clearRemoteQueuedScope, loadRemoteQueuedDrafts, readRemoteRetryImages, saveRemoteQueuedDrafts, mutateRemoteQueue, remoteQueueRevision, remoteQueueEditable, type LoadedQueuedRemoteDraft } from '../remote/drafts';
import { handoffQueuedImages, retireQueuedImageScope } from '../remote/queued-image-files';

const mockSettings = new Map<string, string>();
const mockFiles = new Map<string, string>();
const mockSet = jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); });
const mockWrite = jest.fn(async (uri: string, content: string) => { mockFiles.set(uri, content); });
const mockRead = jest.fn(async (uri: string) => mockFiles.get(uri) ?? '');
const mockDelete = jest.fn(async (uri: string) => { mockFiles.delete(uri); });
const mockDirectories = new Set<string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string) => mockSet(key, value) }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://documents/', EncodingType: { Base64: 'base64' },
  getInfoAsync: async (uri: string) => ({ exists: mockFiles.has(uri) || mockDirectories.has(uri), isDirectory: mockDirectories.has(uri),
    size: Buffer.from(mockFiles.get(uri) ?? '', 'base64').length }), readAsStringAsync: (uri: string) => mockRead(uri),
  makeDirectoryAsync: async () => undefined, copyAsync: async ({ from, to }: { from: string; to: string }) => {
    if (!mockFiles.has(from)) throw new Error('missing'); mockFiles.set(to, mockFiles.get(from)!);
  }, writeAsStringAsync: (uri: string, content: string) => mockWrite(uri, content),
  deleteAsync: (uri: string) => mockDelete(uri),
}));
jest.mock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, value: string) =>
  require('node:crypto').createHash('sha256').update(value).digest('hex'), randomUUID: () => '0199aaa1-1234-4678-9abc-000000000001' }));

const setting = 'remote_queued_v1';
const key = 'station|pc|codex:fixture';
const row = (text: string): LoadedQueuedRemoteDraft => ({ id: text, text, images: [], scope: 'paired-fixture', apiIdentity: 'computer:api_fixture',
  state: 'waiting', sendOptions: { model: 'gpt-fixture', accountId: 'api_fixture', surface: 'cli' } });
const bytes = (value: string) => Buffer.from(value).toString('base64');
beforeEach(() => {
  mockSettings.clear(); mockFiles.clear(); mockDirectories.clear(); mockSet.mockReset().mockImplementation(async (key, value) => { mockSettings.set(key, value); });
  mockWrite.mockReset().mockImplementation(async (uri, content) => { mockFiles.set(uri, content); });
  mockRead.mockReset().mockImplementation(async uri => mockFiles.get(uri) ?? '');
  mockDelete.mockReset().mockImplementation(async uri => { mockFiles.delete(uri); });
});

test('queue preserves submission boundaries and frozen metadata across a restart', async () => {
  await saveRemoteQueuedDrafts(key, [row('first'), row('second')]);
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ text: 'first', state: 'waiting', scope: 'paired-fixture' },
    { text: 'second', state: 'waiting', sendOptions: { model: 'gpt-fixture', accountId: 'api_fixture' } }]);
});

test('atomic queue text editing retains frozen options and original image bytes, and never resumes implicitly', async()=>{
  const scope='paired-fixture',target=`${scope}|pc|codex:manage`,image={uri:'file://picker/manage.png',mime:'image/png' as const,width:10,height:10,base64:bytes('original bytes')};
  const saved=await saveRemoteQueuedDrafts(target,[{...row('first'),images:[image]},{...row('second')}]);
  const rows=await mutateRemoteQueue(target,scope,'computer:api_fixture',{type:'edit',id:'first',expected:remoteQueueRevision(saved[0]),text:'changed'},()=>true);
  expect(rows.map(item=>item.state)).toEqual(['blocked','blocked']);
  expect(rows[0]).toMatchObject({text:'changed',attempted:false,sendOptions:row('first').sendOptions,imageCount:1});
  expect(await readRemoteRetryImages(rows[0].images)).toEqual([expect.objectContaining({base64:image.base64})]);
  const restored=await loadRemoteQueuedDrafts(target); expect(restored[0].state).toBe('blocked');
});

test('queue reorder and resume are exact-owner actions and stale snapshots cannot overwrite newer text',async()=>{
  const scope='paired-fixture',target=`${scope}|pc|codex:manage`;
  const saved=await saveRemoteQueuedDrafts(target,[row('first'),row('second')]);
  const moved=await mutateRemoteQueue(target,scope,'computer:api_fixture',{type:'move',id:'second',expected:remoteQueueRevision(saved[1]),offset:-1,order:['first','second']},()=>true);
  expect(moved.map(item=>item.id)).toEqual(['second','first']); expect(moved.every(item=>item.state==='blocked')).toBe(true);
  await expect(mutateRemoteQueue(target,scope,'other-api',{type:'remove',id:'second',expected:remoteQueueRevision(moved[0])},()=>true)).rejects.toThrow('已改变');
  await expect(mutateRemoteQueue(target,scope,'computer:api_fixture',{type:'edit',id:'second',expected:remoteQueueRevision(saved[1]),text:'stale'},()=>true)).rejects.toThrow('已改变');
  const resumed=await mutateRemoteQueue(target,scope,'computer:api_fixture',{type:'resume',id:'second',expected:remoteQueueRevision(moved[0])},()=>true);
  expect(resumed.map(item=>item.state)).toEqual(['waiting','blocked']);
  await expect(mutateRemoteQueue(target,scope,'computer:api_fixture',{type:'pause'},()=>false)).rejects.toThrow('已变化');
});

test('attempted or uncertain legacy entries cannot be edited, moved or resumed by queue management',async()=>{
  const scope='paired-fixture',target=`${scope}|pc|codex:manage`;
  await saveRemoteQueuedDrafts(target,[{...row('old'),state:'attempting'},{...row('next'),attempted:false}]);
  const rows=await loadRemoteQueuedDrafts(target); expect(rows[0].attempted).toBe(true); expect(remoteQueueEditable(rows[0])).toBe(false);
  await expect(mutateRemoteQueue(target,scope,'computer:api_fixture',{type:'edit',id:'old',expected:remoteQueueRevision(rows[0]),text:'unsafe'},()=>true)).rejects.toThrow();
  await expect(mutateRemoteQueue(target,scope,'computer:api_fixture',{type:'move',id:'next',expected:remoteQueueRevision(rows[1]),offset:-1,order:['old','next']},()=>true)).rejects.toThrow('尚未尝试');
});

test('reference-only queue entries retain their snapshot and identity across storage', async () => {
  const reference = { kind: 'file' as const, projectPath: 'C:/project', label: 'a.ts', path: 'a.ts', text: 'selected', capturedAt: 1, startLine: 1, endLine: 1 };
  const selected = { ...row('reference-id'), text: '', sendOptions: { ...row('').sendOptions!, contextReferences: [reference] } };
  await saveRemoteQueuedDrafts(key, [selected]);
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ id: 'reference-id', text: '', state: 'waiting', sendOptions: { contextReferences: [reference] } }]);
});

test('queue freezes the selected permission with each message and blocks unknown future modes', async () => {
  const first = row('permission-first'); first.sendOptions = { ...first.sendOptions!, permissionMode: 'auto_review' };
  const saving = saveRemoteQueuedDrafts(key, [first]); first.sendOptions.permissionMode = 'full_access'; await saving;
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ state: 'waiting', sendOptions: { permissionMode: 'auto_review' } }]);
  mockSettings.set(setting, JSON.stringify({ [key]: [{ ...row('future'), sendOptions: { surface: 'cli', permissionMode: 'invented' } }] }));
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ state: 'blocked' }]);
});

test('an attempting record and legacy merged queue require manual review after restart', async () => {
  await saveRemoteQueuedDrafts(key, [{ ...row('possible send'), state: 'attempting' }]);
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ text: 'possible send', state: 'blocked' }]);
  mockSettings.set(setting, JSON.stringify({ [key]: { text: 'old combined prompt', images: [] } }));
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ text: 'old combined prompt', state: 'blocked' }]);
});

test('Claude queue freezes native approval without inventing a Codex permission mode', async () => {
  const claudeKey = 'station|pc|claude:fixture';
  const first = row('native-approval'); first.sendOptions = { ...first.sendOptions!, approval: 'auto_all' };
  const saving = saveRemoteQueuedDrafts(claudeKey, [first]); first.sendOptions.approval = 'ask'; await saving;
  expect(await loadRemoteQueuedDrafts(claudeKey)).toMatchObject([{ state: 'waiting', sendOptions: { approval: 'auto_all' } }]);
  mockSettings.set(setting, JSON.stringify({ [claudeKey]: [{ ...row('future'), sendOptions: { surface: 'cli', approval: 'unknown' } }] }));
  expect(await loadRemoteQueuedDrafts(claudeKey)).toMatchObject([{ state: 'blocked' }]);
});

test('a reused picker URI cannot replace one queued image with another image or stale prior bytes', async () => {
  const image = { uri: 'file://picker/latest.jpg', mime: 'image/jpeg' as const, width: 40, height: 40 };
  mockFiles.set(image.uri, bytes('new-file-bytes'));
  await saveRemoteQueuedDrafts(key, [{ ...row('first'), images: [{ ...image, base64: bytes('first-snapshot') }] },
    { ...row('second'), images: [{ ...image, base64: bytes('second-snapshot') }] }]);
  mockRead.mockClear();
  const restored = await loadRemoteQueuedDrafts(key);
  expect(restored.map(item => item.images[0].base64)).toEqual(['', '']);
  expect(mockRead).not.toHaveBeenCalled();
  expect((await readRemoteRetryImages(restored[0].images))[0].base64).toBe(bytes('first-snapshot'));
  expect((await readRemoteRetryImages(restored[1].images))[0].base64).toBe(bytes('second-snapshot'));
  expect(restored[0].images[0].uri).not.toBe(restored[1].images[0].uri);
});

test('image snapshot write failure rejects queue acceptance rather than saving a fragile cache URI', async () => {
  mockWrite.mockRejectedValueOnce(new Error('full'));
  await expect(saveRemoteQueuedDrafts(key, [{ ...row('with image'), images: [{ uri: 'file://picker/image.jpg', base64: bytes('bytes'), mime: 'image/jpeg', width: 40, height: 40 }] }]))
    .rejects.toThrow('排队图片保存失败');
  expect(mockSettings.get(setting)).toBeUndefined();
});

test('missing or malformed image metadata is retained as a blocked recovery requirement, not silently omitted', async () => {
  mockSettings.set(setting, JSON.stringify({ [key]: [{ ...row('with image'), images: [{ uri: 'file://gone.jpg', mime: 'image/jpeg', width: 40, height: 40 }] }] }));
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ text: 'with image', imageCount: 1, images: [], missingImages: true }]);
  mockSettings.set(setting, JSON.stringify({ [key]: [{ ...row('with image'), images: [{ uri: 'https://external.test/image.jpg', mime: 'image/jpeg', width: 40, height: 40 }] }] }));
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ text: 'with image', imageCount: 1, images: [], missingImages: true }]);
});

test('bounded queue limits reject instead of truncating prompts or attachments', async () => {
  await expect(saveRemoteQueuedDrafts(key, Array.from({ length: 11 }, (_, index) => row(String(index))))).rejects.toThrow('超出限制');
  await expect(saveRemoteQueuedDrafts(key, [{ ...row('too many'), images: Array.from({ length: 5 }, () => ({ uri: 'file://a.jpg', mime: 'image/jpeg', width: 40, height: 40 })) }])).rejects.toThrow('超出限制');
  expect(mockSettings.get(setting)).toBeUndefined();
});

test('a twenty-first queued conversation is rejected rather than evicting another queued task', async () => {
  for (let index = 0; index < 20; index += 1) await saveRemoteQueuedDrafts(`station|pc|codex:${index}`, [row(String(index))]);
  await expect(saveRemoteQueuedDrafts(key, [row('new')])).rejects.toThrow('排队会话过多');
  expect(await loadRemoteQueuedDrafts('station|pc|codex:0')).toMatchObject([{ text: '0' }]);
  expect(await loadRemoteQueuedDrafts(key)).toEqual([]);
});

test('malformed frozen send options pause restoration rather than silently choosing a new model or effort', async () => {
  mockSettings.set(setting, JSON.stringify({ [key]: [{ ...row('original'), sendOptions: { surface: 'cli', effort: 'unknown' } }] }));
  expect(await loadRemoteQueuedDrafts(key)).toMatchObject([{ text: 'original', state: 'blocked' }]);
});

test('retry images are all-or-nothing and external URLs are never fetched', async () => {
  const image = { uri: 'file://image.jpg', mime: 'image/jpeg' as const, width: 40, height: 40 };
  mockFiles.set(image.uri, bytes('snapshot'));
  expect(await readRemoteRetryImages([image])).toEqual([{ ...image, base64: bytes('snapshot') }]);
  await expect(readRemoteRetryImages([image, { ...image, uri: 'file://missing.jpg' }])).rejects.toThrow('不存在');
  await expect(readRemoteRetryImages([{ ...image, uri: 'https://external.test/image.jpg' }])).rejects.toThrow('无法恢复');
});

const imageRow = (text: string, scope = 'paired-fixture'): LoadedQueuedRemoteDraft => ({ ...row(text), scope,
  images: [{ uri: 'file://picker/reused.jpg', mime: 'image/jpeg', width: 40, height: 40, base64: bytes(text) }] });
const manifest = () => JSON.parse(mockSettings.get('remote_image_files_v2') ?? '{}');

test('every image byte write is preceded by its durable exact produced-file intent', async () => {
  mockWrite.mockImplementation(async (uri, content) => {
    expect(manifest().files.some((file: { uri: string }) => file.uri === uri)).toBe(true);
    mockFiles.set(uri, content);
  });
  const saved = await saveRemoteQueuedDrafts(key, [imageRow('immutable')]);
  expect(saved[0].images[0]).toMatchObject({ base64: '', uri: expect.stringMatching(/^file:\/\/documents\/remote-images-v2\/[a-f0-9]{64}\/queue-[a-f0-9]{64}\.jpg$/) });
  expect(JSON.stringify(manifest())).not.toContain('paired-fixture');
});

test('resaving and restoring metadata do not read all image payloads; sending verifies only requested payloads', async () => {
  const staged = await saveRemoteQueuedDrafts(key, Array.from({ length: 10 }, (_, index) => imageRow(`image-${index}`)));
  mockRead.mockClear();
  expect(await saveRemoteQueuedDrafts(key, staged)).toEqual(staged);
  expect(await loadRemoteQueuedDrafts(key)).toEqual(staged.map(entry => ({ ...entry, imageCount: 1 })));
  expect(mockRead).not.toHaveBeenCalled();
  await readRemoteRetryImages(staged[0].images);
  expect(mockRead).toHaveBeenCalledTimes(1);
  expect(mockRead).toHaveBeenCalledWith(staged[0].images[0].uri);
});

test('same reused picker URI and same content are isolated by pairing scope', async () => {
  const a = (await saveRemoteQueuedDrafts(key, [imageRow('same', 'pair-a')]))[0];
  const b = (await saveRemoteQueuedDrafts('other|pc|codex:other', [imageRow('same', 'pair-b')]))[0];
  expect(a.images[0].uri).not.toBe(b.images[0].uri);
  await clearRemoteQueuedScope('pair-a');
  expect(await loadRemoteQueuedDrafts(key)).toEqual([]);
  expect(await readRemoteRetryImages(b.images)).toMatchObject([{ base64: bytes('same') }]);
  expect(mockDelete.mock.calls.map(call => call[0])).toEqual([a.images[0].uri]);
});

test('retirement removes only proven scoped files, retaining legacy files and historical queue snapshots until unpair', async () => {
  const staged = await saveRemoteQueuedDrafts(key, [imageRow('queue')]);
  const uri = staged[0].images[0].uri;
  const legacy = 'file://documents/remote-queued/old.jpg'; mockFiles.set(legacy, bytes('legacy'));
  await saveRemoteQueuedDrafts(key, []);
  expect(mockFiles.has(uri)).toBe(true); expect(mockDelete).not.toHaveBeenCalled();
  await clearRemoteQueuedScope('paired-fixture');
  expect(mockFiles.has(uri)).toBe(false); expect(mockFiles.has(legacy)).toBe(true);
  await expect(saveRemoteQueuedDrafts(key, [imageRow('late')])).rejects.toThrow('原配对已解除');
  await expect(saveRemoteQueuedDrafts(key, [row('late text')])).rejects.toThrow('原配对已解除');
});

test('a writer already started before unpair is drained and removed; a late writer cannot resurrect the scope', async () => {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = new Promise<void>(resolve => { entered = resolve; });
  mockWrite.mockImplementationOnce(async (uri, content) => { entered(); await gate; mockFiles.set(uri, content); });
  const writing = saveRemoteQueuedDrafts(key, [imageRow('pending')]);
  await start;
  const retiring = clearRemoteQueuedScope('paired-fixture');
  release(); await writing; await retiring;
  expect(await loadRemoteQueuedDrafts(key)).toEqual([]); expect(mockFiles.size).toBe(0);
  await expect(saveRemoteQueuedDrafts(key, [imageRow('late')])).rejects.toThrow('原配对已解除');
});

test('failed intent or unlink is retained for exact safe retry; unrelated file paths are never guessed', async () => {
  mockWrite.mockRejectedValueOnce(new Error('full'));
  await expect(saveRemoteQueuedDrafts(key, [imageRow('failed')])).rejects.toThrow('保存失败');
  expect(manifest().files).toHaveLength(1); expect(mockFiles.size).toBe(0);
  const staged = await saveRemoteQueuedDrafts(key, [imageRow('failed')]);
  mockDelete.mockRejectedValueOnce(new Error('busy'));
  await clearRemoteQueuedScope('paired-fixture');
  expect(manifest().files).toHaveLength(1); expect(manifest().retired).toHaveLength(1);
  await retireQueuedImageScope('paired-fixture');
  expect(manifest().files).toHaveLength(0); expect(mockFiles.has(staged[0].images[0].uri)).toBe(false);
});

test('corrupted manifest paths or directory substitutions fail closed and never delete a directory', async () => {
  const saved = await saveRemoteQueuedDrafts(key, [imageRow('directory')]);
  const uri = saved[0].images[0].uri;
  mockFiles.delete(uri); mockDirectories.add(uri);
  await retireQueuedImageScope('paired-fixture');
  expect(mockDelete).not.toHaveBeenCalled(); expect(manifest().files).toHaveLength(1);
  const corrupt = manifest(); corrupt.files[0].uri = 'file://documents/unrelated.jpg';
  mockSettings.set('remote_image_files_v2', JSON.stringify(corrupt));
  await expect(retireQueuedImageScope('paired-fixture')).rejects.toThrow('清单无效');
  expect(mockDelete).not.toHaveBeenCalled();
});

test('independent handoff retains queue ownership until exact unpair and rejects a mismatched pairing', async () => {
  const saved = await saveRemoteQueuedDrafts(key, [imageRow('transfer')]);
  const images = await readRemoteRetryImages(saved[0].images);
  await expect(handoffQueuedImages('other-pair', images)).rejects.toThrow('来源已改变');
  const transferred = await handoffQueuedImages('paired-fixture', images);
  expect(transferred[0].uri).not.toBe(images[0].uri); expect(transferred[0].uri).toContain('/submission-');
  expect(mockFiles.has(images[0].uri)).toBe(true); expect(mockFiles.has(transferred[0].uri)).toBe(true);
  await clearRemoteQueuedScope('paired-fixture'); expect(mockFiles.size).toBe(0);
});

test('changed managed payloads are rejected at sending; newer supplied bytes never overwrite an older content path', async () => {
  const saved = await saveRemoteQueuedDrafts(key, [imageRow('original')]);
  const oldURI = saved[0].images[0].uri;
  const next = await saveRemoteQueuedDrafts(key, [{ ...saved[0], images: [{ ...saved[0].images[0], base64: bytes('new') }] }]);
  expect(next[0].images[0].uri).not.toBe(oldURI); expect(mockFiles.get(oldURI)).toBe(bytes('original'));
  mockFiles.set(next[0].images[0].uri, bytes('corrupt'));
  await expect(readRemoteRetryImages(next[0].images)).rejects.toThrow('内容已改变');
});

test('per-scope managed-image budget rejects further snapshots instead of accumulating indefinitely', async () => {
  const saved = await saveRemoteQueuedDrafts(key, [imageRow('budget')]);
  const record = manifest(); const base = record.files[0];
  // Synthetic ownership records model sixteen 8 MiB produced files without
  // allocating a 128 MiB payload in this unit test.
  record.files = Array.from({ length: 16 }, (_, index) => {
    const digest = index.toString(16).padStart(64, '0');
    return { ...base, digest, size: 8 * 1024 * 1024,
      uri: `file://documents/remote-images-v2/${base.scope}/queue-${digest}.jpg` };
  });
  mockSettings.set('remote_image_files_v2', JSON.stringify(record));
  await expect(saveRemoteQueuedDrafts(key, [imageRow('over budget')])).rejects.toThrow('存储已满');
  expect(saved[0].images[0].base64).toBe('');
});
