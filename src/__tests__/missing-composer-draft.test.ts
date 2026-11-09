import { copyMissingComposerDraft, createComposerDraftSession, hydrateComposerImages, undoMissingComposerDraft, type ComposerDraftOrigin } from '../remote/composer-drafts';
import { copyMissingDirectComposerDraft, createDirectComposerDraft } from '../remote/direct-composer-drafts';
import { confirmedMissingSession } from '../remote/composer-draft-origin';

const mockSettings = new Map<string, string>(), mockFiles = new Map<string, string>();
const mockGet = jest.fn(async (key: string): Promise<string | null> => mockSettings.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); });
jest.mock('../storage/database', () => ({ getSetting: (key: string) => mockGet(key), setSetting: (key: string, value: string) => mockSet(key, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, text: string) => require('node:crypto').createHash('sha256').update(text).digest('hex') }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://missing-draft-tests/', EncodingType: { Base64: 'base64' }, getInfoAsync: async (uri: string) => ({ exists: mockFiles.has(uri), isDirectory: false }),
  readAsStringAsync: async (uri: string) => mockFiles.get(uri) ?? '', writeAsStringAsync: async (uri: string, bytes: string) => { mockFiles.set(uri, bytes); }, makeDirectoryAsync: async () => undefined, deleteAsync: async (uri: string) => { mockFiles.delete(uri); } }));
const scope = 'recovery|credential:one', sourceKey = `${scope}|pc|codex:missing`, targetKey = `${scope}|pc|new:agent:code:C%3A%2Fproject`, setting = 'remote_composer_drafts_v1';
const origin: ComposerDraftOrigin = { transport: 'hub', deviceId: 'pc', agentId: 'agent', cwd: 'C:/project', mode: 'code', apiIdentity: 'api-a', sessionKey: 'codex:missing' };
const evidence = { kind: 'session_not_found' as const, deviceId: 'pc', sessionKey: 'codex:missing' };
async function seed(text = 'preserve original', withImage = false) {
  const writer = createComposerDraftSession(sourceKey, scope); await writer.restore();
  const saved = await writer.save({ text, origin, images: withImage ? [{ uri: 'file://picked.png', width: 20, height: 20, mime: 'image/png', base64: Buffer.from('private-image').toString('base64') }] : [] });
  return { writer, saved, input: { scope, sourceKey, targetKey, origin, evidence, expectedRevision: saved.revision, expectedIdentity: saved.identity } };
}
beforeEach(() => { mockSettings.clear(); mockFiles.clear(); mockGet.mockReset().mockImplementation(async key => mockSettings.get(key) ?? null); mockSet.mockReset().mockImplementation(async (key, value) => { mockSettings.set(key, value); }); });

test('confirmed missing session copies text and images atomically, retaining the original and image bytes', async () => {
  const { saved, input } = await seed('continue this', true), original = JSON.parse(mockSettings.get(setting)!)[sourceKey];
  const { receipt, draft } = await copyMissingComposerDraft(input);
  const rows = JSON.parse(mockSettings.get(setting)!);
  expect(rows[sourceKey]).toEqual(original); expect(rows[targetKey].origin).toEqual({ ...origin, sessionKey: undefined });
  expect(draft).toMatchObject({ text: saved.text, images: saved.images, origin: { mode: 'code', cwd: 'C:/project' } });
  expect(draft.origin).not.toHaveProperty('sessionKey'); expect(receipt.targetIdentity).toBe(draft.identity);
  expect(await hydrateComposerImages(scope, draft)).toEqual([{ ...saved.images[0], base64: Buffer.from('private-image').toString('base64') }]);
  expect(mockSettings.get(setting)).not.toContain(Buffer.from('private-image').toString('base64'));
});

test('failed persistence does not remove or mutate source and target; retry can succeed', async () => {
  const { input } = await seed(), before = mockSettings.get(setting);
  mockSet.mockRejectedValueOnce(new Error('disk full'));
  await expect(copyMissingComposerDraft(input)).rejects.toThrow('disk full'); expect(mockSettings.get(setting)).toBe(before);
  await expect(copyMissingComposerDraft(input)).resolves.toMatchObject({ draft: { text: 'preserve original' } });
});

test('network absence is not deletion, old rows without origin cannot be relabeled, and computer/project/API/mode cannot cross', async () => {
  const { input } = await seed();
  expect(confirmedMissingSession({ ...evidence, kind: 'network_error' } as never)).toBe(false);
  for (const patch of [{ evidence: { ...evidence, kind: 'timeout' } }, { evidence: { ...evidence, deviceId: 'other' } },
    { origin: { ...origin, mode: 'work' } }, { origin: { ...origin, cwd: 'C:/other' } }, { origin: { ...origin, agentId: 'other' } },
    { origin: { ...origin, apiIdentity: 'api-b' } }, { scope: 'other|credential:one' }]) await expect(copyMissingComposerDraft({ ...input, ...patch } as never)).rejects.toThrow();
  const rows = JSON.parse(mockSettings.get(setting)!); delete rows[sourceKey].origin; mockSettings.set(setting, JSON.stringify(rows));
  await expect(copyMissingComposerDraft(input)).rejects.toThrow('原草稿已变化'); expect(JSON.parse(mockSettings.get(setting)!)[targetKey]).toBeUndefined();
});

test('existing new-conversation drafts are never overwritten', async () => {
  const { input } = await seed(); const target = createComposerDraftSession(targetKey, scope); await target.restore(); await target.save({ text: 'my new draft', images: [] });
  await expect(copyMissingComposerDraft(input)).rejects.toThrow('已有草稿'); expect(await target.restore()).toMatchObject({ text: 'my new draft' });
});

test('undo fences the restored revision and leaves subsequent edits untouched', async () => {
  const { input } = await seed(), first = await copyMissingComposerDraft(input);
  expect(await undoMissingComposerDraft(first.receipt)).toBe(true);
  expect(JSON.parse(mockSettings.get(setting)!)[sourceKey].text).toBe('preserve original'); expect(JSON.parse(mockSettings.get(setting)!)[targetKey].text).toBe('');
  const second = await copyMissingComposerDraft(input), target = createComposerDraftSession(targetKey, scope); await target.restore(); await target.save({ text: 'new edit', images: [] });
  expect(await undoMissingComposerDraft(second.receipt)).toBe(false); expect(await target.restore()).toMatchObject({ text: 'new edit' });
});

test('missing images retain their blocked evidence rather than silently turning recovery into a text-only prompt', async () => {
  const { saved, input } = await seed('needs image', true); mockFiles.delete(saved.images[0].uri);
  const { draft } = await copyMissingComposerDraft(input); expect(draft.missingImages).toBe(true); expect(draft.imageCount).toBe(1); expect(draft.images).toHaveLength(1);
  await expect(hydrateComposerImages(scope, draft)).rejects.toThrow('重新选择');
});

test('a replacement mounted source owner or changed selection cancels a delayed copy', async () => {
  const { input } = await seed(); let release!: (value: string | null) => void;
  const before = mockSettings.get(setting)!;
  let waiting = true;
  mockGet.mockImplementation(async key => key === setting && waiting ? (waiting = false, new Promise<string | null>(resolve => { release = resolve; })) : mockSettings.get(key) ?? null);
  const copy = copyMissingComposerDraft(input);
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  createComposerDraftSession(sourceKey, scope); release(before);
  await expect(copy).rejects.toThrow('已变化'); expect(mockSettings.get(setting)).toBe(before);
  await expect(copyMissingComposerDraft({ ...input, isCurrent: () => false })).rejects.toThrow('已变化');
});

test('Direct recovery rewrites the owner while preserving model, effort, permissions, skills and references', async () => {
  const directOrigin: ComposerDraftOrigin = { ...origin, transport: 'direct', mode: 'work', apiIdentity: '' };
  const sourceOwner = JSON.stringify([scope, 'pc', origin.sessionKey, 'agent', '', origin.cwd]);
  const targetOwner = JSON.stringify([scope, 'pc', null, 'agent', '', origin.cwd, 'work']);
  const first = createDirectComposerDraft(scope, 'pc', sourceOwner); await first.restore();
  const value = { text: 'continue work', images: [], model: 'model-a', effort: 'high' as const, permission: 'auto_review' as const,
    options: { collaborationMode: 'plan' as const, skills: [{ name: 'review', path: 'C:/skills/review/SKILL.md' }], contextReferences: [{ kind: 'message' as const, sessionKey: 'codex:missing', messageId: 'msg', label: 'source', text: 'exact', startOffset: 0, endOffset: 5, capturedAt: 1 }] }, origin: directOrigin };
  const saved = await first.save(value);
  const args = { pairing: scope, deviceId: 'pc', sourceOwner, targetOwner, origin: directOrigin, evidence, expectedRevision: saved.revision, expectedIdentity: saved.identity };
  await expect(copyMissingDirectComposerDraft({ ...args, targetOwner: targetOwner.replace('work', 'code') })).rejects.toThrow('不匹配');
  const result = await copyMissingDirectComposerDraft(args), target = createDirectComposerDraft(scope, 'pc', targetOwner), restored = await target.restore();
  const { sessionKey: _session, ...newOrigin } = directOrigin;
  expect(restored).toMatchObject({ ...value, origin: newOrigin });
  expect(restored?.origin).not.toHaveProperty('sessionKey'); expect(result.draft.text).toBe('continue work');
  expect(await first.restore()).toMatchObject({ text: 'continue work', origin: directOrigin });
  expect(await undoMissingComposerDraft(result.receipt)).toBe(true); expect(await target.restore()).toBeUndefined();
});


test('missing projectless session recovery keeps the draft but never reuses its managed cwd',async()=>{
 const independent={...origin,projectless:true as const,cwd:'C:/managed/original'},writer=createComposerDraftSession(sourceKey,scope);await writer.restore();
 const saved=await writer.save({text:'keep this',images:[],origin:independent});
 const target=`${scope}|pc|new:agent:code:projectless`;
 const result=await copyMissingComposerDraft({scope,sourceKey,targetKey:target,origin:independent,evidence,expectedRevision:saved.revision,expectedIdentity:saved.identity});
 expect(result.draft.origin).toEqual({...independent,cwd:'',sessionKey:undefined});
 expect(JSON.parse(mockSettings.get(setting)!)[sourceKey].origin.cwd).toBe('C:/managed/original');
 expect(await undoMissingComposerDraft(result.receipt)).toBe(true);
});


test('direct projectless recovery rewrites its owner and preserves the original managed session draft',async()=>{
 const independent={...origin,transport:'direct' as const,projectless:true as const,cwd:'C:/managed/original'},sourceOwner=JSON.stringify([scope,'pc',origin.sessionKey,origin.agentId,origin.apiIdentity,independent.cwd]);
 const targetOwner=JSON.stringify([scope,'pc',null,origin.agentId,origin.apiIdentity,'',origin.mode,'projectless']);
 const writer=createDirectComposerDraft(scope,'pc',sourceOwner);await writer.restore();const saved=await writer.save({text:'direct keep',images:[],origin:independent,options:{},model:'',effort:'',permission:''});
 const result=await copyMissingDirectComposerDraft({pairing:scope,deviceId:'pc',sourceOwner,targetOwner,origin:independent,evidence,expectedRevision:saved.revision,expectedIdentity:saved.identity});
 expect(result.draft).toMatchObject({text:'direct keep',origin:{projectless:true,cwd:''}});
 expect(await createDirectComposerDraft(scope,'pc',targetOwner).restore()).toMatchObject({text:'direct keep',origin:{projectless:true,cwd:''}});
 expect(await createDirectComposerDraft(scope,'pc',sourceOwner).restore()).toMatchObject({origin:{cwd:independent.cwd}});
});
