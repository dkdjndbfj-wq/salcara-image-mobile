import { createComposerDraftSession, type ComposerDraftInput } from '../remote/composer-drafts';
import { copyComposerFeatureIntent, sameComposerFeatureSource, type ComposerFeatureIntent, type ComposerFeatureSource } from '../remote/composer-feature-intent';

const mockSettings = new Map<string, string>();
const mockGet = jest.fn(async (key: string): Promise<string | null> => mockSettings.get(key) ?? null);
const mockSet = jest.fn(async (key: string, value: string) => { mockSettings.set(key, value); });
jest.mock('../storage/database', () => ({ getSetting: (key: string) => mockGet(key), setSetting: (key: string, value: string) => mockSet(key, value) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID(), CryptoDigestAlgorithm: { SHA256: 'SHA256' }, digestStringAsync: async (_algorithm: string, value: string) =>
  require('node:crypto').createHash('sha256').update(value).digest('hex') }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file://feature-intent-test/', EncodingType: { Base64: 'base64' },
  getInfoAsync: async () => ({ exists: false, isDirectory: false }), makeDirectoryAsync: async () => undefined }));

const scope = 'feature-fixture|credential:one', key = `${scope}|pc|codex:thread`, setting = 'remote_composer_drafts_v1';
const source = (): ComposerFeatureSource => ({ scope, deviceId: 'pc', tool: 'codex', runtimeId: 'codex-cli-native-a', surface: 'cli', apiIdentity: 'computer:key-a', cwd: 'C:/project' });
const intent = (path = 'C:/skills/a/SKILL.md'): ComposerFeatureIntent => ({ version: 1, source: source(), collaborationMode: 'plan',
  skills: [{ name: 'review', path }], mentions: [{ start: 0, end: 7, skill: { name: 'review', path } }] });
const input = (featureIntent = intent()): ComposerDraftInput => ({ text: '$review task', images: [], featureIntent });
const opened = async () => { const writer = createComposerDraftSession(key, scope); await writer.restore(); return writer; };
beforeEach(() => {
  mockSettings.clear();
  mockGet.mockReset().mockImplementation(async name => mockSettings.get(name) ?? null);
  mockSet.mockReset().mockImplementation(async (name, value) => { mockSettings.set(name, value); });
});

test('v1 draft round-trips mode, source and exact same-name skill occurrences without promoting literal text', async () => {
  const first = { name: 'review', path: 'C:/skills/a/SKILL.md' }, second = { name: 'review', path: 'C:/skills/b/SKILL.md' };
  const body = '$review $review explain literal $review';
  const featureIntent: ComposerFeatureIntent = { version: 1, source: source(), collaborationMode: 'plan', skills: [first, second],
    mentions: [{ start: 0, end: 7, skill: first }, { start: 8, end: 15, skill: second }] };
  const writer = await opened();
  await writer.save({ text: body, images: [], featureIntent }); writer.dispose();
  const restored = await createComposerDraftSession(key, scope).restore();
  expect(restored?.text).toBe(body); expect(restored?.featureIntent).toEqual(featureIntent);
  expect(restored?.featureIntent?.mentions).toHaveLength(2);
  expect(sameComposerFeatureSource(restored!.featureIntent!.source, source())).toBe(true);
});

test('save freezes nested source, skills and mention paths before asynchronous storage; read results remain detached', async () => {
  const writer = await opened(), supplied = input();
  const saving = writer.save(supplied);
  supplied.featureIntent!.source.runtimeId = 'mutated-runtime';
  supplied.featureIntent!.skills![0].path = 'C:/mutated/SKILL.md';
  supplied.featureIntent!.mentions![0].skill.path = 'C:/mutated-other/SKILL.md';
  supplied.featureIntent!.mentions![0].start = 3;
  const saved = await saving;
  expect(saved.featureIntent).toEqual(intent());
  saved.featureIntent!.source.apiIdentity = 'changed-returned-value';
  saved.featureIntent!.skills![0].path = 'C:/changed-result/SKILL.md';
  saved.featureIntent!.mentions![0].skill.path = 'C:/changed-result-again/SKILL.md';
  const restored = await writer.restore();
  expect(restored?.featureIntent).toEqual(intent());
  restored!.featureIntent!.mentions![0].end = 8;
  expect((await writer.restore())?.featureIntent).toEqual(intent());
});

test('restored drafts retain skill display snapshots in both selection and inline mention', async () => {
  const writer = await opened(), featureIntent = intent();
  const display = { displayName: '代码审查', brandColor: '#2988CC', iconSmall: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
  Object.assign(featureIntent.skills![0], display); Object.assign(featureIntent.mentions![0].skill, display);
  await writer.save(input(featureIntent)); writer.dispose();
  const restored = await createComposerDraftSession(key, scope).restore();
  expect(restored?.featureIntent?.skills?.[0]).toEqual({ name: 'review', path: 'C:/skills/a/SKILL.md', ...display });
  expect(restored?.featureIntent?.mentions?.[0].skill).toEqual(restored?.featureIntent?.skills?.[0]);
});

test('reference-only drafts survive pruning and preserve an immutable content snapshot', async () => {
  const writer = await opened(), reference = { kind: 'file' as const, projectPath: 'C:/project', label: 'main.ts', path: 'main.ts', text: 'const original = 1;', capturedAt: 1000, startLine: 1, endLine: 1 };
  const saving = writer.save({ text: '', images: [], featureIntent: { version: 1, source: source(), contextReferences: [reference] } });
  reference.text = 'changed'; await saving; await writer.pruneEmpty();
  expect((await writer.restore())?.featureIntent?.contextReferences?.[0].text).toBe('const original = 1;');
  await writer.save({ text: '', images: [] }); await writer.pruneEmpty();
  expect((await writer.restore())?.featureIntent).toBeUndefined();
});

test.each([
  ['credential', { scope: 'feature-fixture|credential:two' }],
  ['device', { deviceId: 'other-pc' }],
  ['agent tool', { tool: 'claude' }],
  ['native runtime', { runtimeId: 'codex-cli-native-b' }],
  ['surface', { surface: 'desktop' }],
  ['API', { apiIdentity: 'computer:key-b' }],
  ['project', { cwd: 'C:/different-project' }],
] as const)('restored intent stays explicit and cannot match a different %s', async (_name, changed) => {
  const writer = await opened(); await writer.save(input()); writer.dispose();
  const restored = await createComposerDraftSession(key, scope).restore();
  expect(restored?.featureIntent).toEqual(intent());
  expect(sameComposerFeatureSource(restored!.featureIntent!.source, { ...source(), ...changed })).toBe(false);
});

test('legacy text drafts remain readable without inferring a skill from a literal dollar token', async () => {
  mockSettings.set(setting, JSON.stringify({ [key]: { scope, revision: 1, text: '$review ordinary text', images: [], imageCount: 0 } }));
  const writer = createComposerDraftSession(key, scope), restored = await writer.restore();
  expect(restored).toMatchObject({ text: '$review ordinary text' }); expect(restored).not.toHaveProperty('featureIntent');
  expect(await writer.save({ text: 'edited ordinary text', images: [] })).not.toHaveProperty('featureIntent');
});

test.each([
  ['unknown version', (value: any) => { value.version = 2; }],
  ['unknown field', (value: any) => { value.untrusted = true; }],
  ['unknown source field', (value: any) => { value.source.host = 'unscoped'; }],
  ['missing runtime', (value: any) => { delete value.source.runtimeId; }],
  ['empty identity', (value: any) => { value.source.apiIdentity = ''; }],
  ['wrong credential', (value: any) => { value.source.scope = 'other|credential:two'; }],
  ['wrong device', (value: any) => { value.source.deviceId = 'other'; }],
  ['bad mode', (value: any) => { value.collaborationMode = 'execute'; }],
  ['missing ranges', (value: any) => { delete value.mentions; }],
  ['missing references', (value: any) => { delete value.skills; }],
  ['out-of-bounds range', (value: any) => { value.mentions[0].end = 100; }],
  ['fractional range', (value: any) => { value.mentions[0].start = 0.5; }],
  ['negative range', (value: any) => { value.mentions[0].start = -1; }],
  ['non-token range', (value: any) => { value.mentions[0].start = 1; }],
  ['mismatched path', (value: any) => { value.mentions[0].skill.path = 'C:/different/SKILL.md'; }],
  ['invalid path', (value: any) => { value.skills[0].path = '\nmalformed'; }],
  ['duplicate reference', (value: any) => { value.skills.push({ ...value.skills[0] }); value.mentions.push({ ...value.mentions[0] }); }],
  ['overlapping ranges', (value: any) => { const skill = { name: 'review', path: 'C:/other/SKILL.md' }; value.skills.push(skill); value.mentions.push({ start: 0, end: 7, skill }); }],
] as const)('%s is rejected before replacing a recoverable draft', async (_name, corrupt) => {
  const writer = await opened(); await writer.save(input()); const before = mockSettings.get(setting);
  const invalid = intent(); corrupt(invalid);
  await expect(writer.save(input(invalid))).rejects.toThrow();
  expect(mockSettings.get(setting)).toBe(before);
  expect((await writer.restore())?.featureIntent).toEqual(intent());
});

test('corrupt persisted feature metadata fails restoration and cannot downgrade into a text-only overwrite', async () => {
  const writer = await opened(); await writer.save(input()); writer.dispose();
  const rows = JSON.parse(mockSettings.get(setting)!); rows[key].featureIntent.version = 99;
  const damaged = JSON.stringify(rows); mockSettings.set(setting, damaged);
  const next = createComposerDraftSession(key, scope);
  await expect(next.restore()).rejects.toThrow('记录无效');
  await expect(next.save({ text: '$review overwritten as literal', images: [] })).rejects.toThrow('尚未读取');
  expect(mockSettings.get(setting)).toBe(damaged);
});

test.each(['prefix', 'suffix'])('a token with an attached %s cannot retain path authority', async side => {
  const writer = await opened(); await writer.save(input()); const before = mockSettings.get(setting);
  const featureIntent = intent();
  if (side === 'prefix') { featureIntent.mentions![0].start = 1; featureIntent.mentions![0].end = 8; }
  await expect(writer.save({ text: side === 'prefix' ? 'a$review task' : '$reviewSuffix task', images: [], featureIntent })).rejects.toThrow('技能引用无效');
  expect(mockSettings.get(setting)).toBe(before);
});

test('Unicode whitespace in a skill name cannot create an unsupported attributed token', async () => {
  const writer = await opened(); await writer.save(input()); const before = mockSettings.get(setting);
  const featureIntent = intent(), name = 'review\u00a0risk';
  featureIntent.skills![0].name = name; featureIntent.mentions![0].skill.name = name; featureIntent.mentions![0].end = name.length + 1;
  await expect(writer.save({ text: `$${name} task`, images: [], featureIntent })).rejects.toThrow('技能引用无效');
  expect(mockSettings.get(setting)).toBe(before);
});

test('mode-only intent survives empty pruning and is cleared only when the matching revision is consumed', async () => {
  const writer = await opened();
  const featureIntent: ComposerFeatureIntent = { version: 1, source: source(), collaborationMode: 'plan' };
  const saved = await writer.save({ text: '', images: [], featureIntent });
  await writer.pruneEmpty(); expect((await writer.restore())?.featureIntent).toEqual(featureIntent);
  expect(await writer.consume(saved.revision)).toBe(true);
  const tombstone = await writer.restore(); expect(tombstone).toMatchObject({ text: '', imageCount: 0 }); expect(tombstone).not.toHaveProperty('featureIntent');
  await writer.pruneEmpty(); expect(mockSettings.get(setting)).toBe('{}');
});

test('late acceptance cannot erase a newly selected same-name path, and cannot resurrect the original intent', async () => {
  const old = await opened(), submitted = await old.save(input()); old.dispose();
  const next = createComposerDraftSession(key, scope); await next.restore();
  expect(await old.consume(submitted.revision)).toBe(true);
  await expect(next.save(input())).rejects.toThrow('其他窗口改变');
  const changed = intent('C:/skills/new-native-runtime/SKILL.md');
  const saved = await next.save(input(changed));
  expect(saved.text).toBe(submitted.text); expect(saved.featureIntent).toEqual(changed);
  expect(await old.consume(submitted.revision)).toBe(false); await old.pruneEmpty();
  expect((await next.restore())?.featureIntent).toEqual(changed);
});

test('source or mode changes count as new intent even when visible text is identical', async () => {
  const old = await opened(), submitted = await old.save(input()); old.dispose();
  const next = createComposerDraftSession(key, scope); await next.restore(); await old.consume(submitted.revision);
  const changed = intent(); changed.source.runtimeId = 'different-native-runtime'; changed.collaborationMode = 'default';
  expect((await next.save(input(changed))).featureIntent).toEqual(changed);
});

test('failed feature metadata commit preserves the old revision and can be retried', async () => {
  const writer = await opened(); await writer.save(input()); const before = mockSettings.get(setting);
  const changed = intent('C:/skills/b/SKILL.md');
  mockSet.mockRejectedValueOnce(new Error('synthetic write failure'));
  await expect(writer.save(input(changed))).rejects.toThrow('synthetic write failure');
  expect(mockSettings.get(setting)).toBe(before);
  expect((await writer.save(input(changed))).featureIntent).toEqual(changed);
});

test('copy helper preserves detached source and path metadata and rejects non-corresponding ranges', () => {
  const original = intent(), copied = copyComposerFeatureIntent(original, '$review task');
  expect(copied).toEqual(original); expect(copied.source).not.toBe(original.source);
  expect(copied.skills![0]).not.toBe(original.skills![0]); expect(copied.mentions![0].skill).not.toBe(original.mentions![0].skill);
  expect(copyComposerFeatureIntent(undefined, 'plain')).toBeUndefined();
  expect(() => copyComposerFeatureIntent(original, 'replaced text')).toThrow('技能引用无效');
});
