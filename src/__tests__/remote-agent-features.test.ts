import { copyTurnFeatures, parseAgentFeatures, validTurnFeatures } from '../remote/agent-features';
import { encodeNewTask, decodeNewTask } from '../remote/new-task';
import { deliverMessage, pendingDelivery, resetDeliveryForTests } from '../remote/delivery';
import { loadRemoteQueuedDrafts, saveRemoteQueuedDrafts } from '../remote/drafts';
import { HubError } from '../remote/client';
import { buildBlocks, conversationBlocks } from '../remote/blocks';

const mockSettings = new Map<string, string>();
jest.mock('../storage/database', () => ({ getSetting: async (key: string) => mockSettings.get(key) ?? null,
  setSetting: async (key: string, value: string) => { mockSettings.set(key, value); } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '0199aaa1-1234-4678-9abc-000000000001' }));
jest.mock('../remote/queued-image-files', () => ({ markRemoteImagesInUse: () => undefined,
  withQueueImageTransaction: async (run: any) => run({ assertActive: async () => undefined, stage: async (_scope: string, image: any) => image }),
  retireQueuedImageScope: async () => undefined, verifyManagedQueuedImage: async () => undefined }));
const features = { collaborationMode: 'plan' as const, skills: [{ name: 'review', path: 'C:/fixture/SKILL.md', displayName: '代码检查', brandColor: '#8A42EF', iconSmall: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=' }] };
beforeEach(() => { mockSettings.clear(); resetDeliveryForTests(); });
test('catalog preserves same-name skills from separate runtime paths', () => {
  const result = parseAgentFeatures({ collaborationModes: ['default', 'plan', 'fake'], skillsSupported: true,
    skills: [{ name: 'review', path: '/a/SKILL.md' }, { name: 'review', path: '/b/SKILL.md' }, { name: 'bad\nname' }] });
  expect(result.collaborationModes).toEqual(['default', 'plan']); expect(result.skills).toHaveLength(2);
});
test.each([{ collaborationMode: 'fake' }, { skills: [{ name: 'review', extra: 'ignored?' }] }, { skills: [{ name: 'bad\nname' }] }, { skills: [...features.skills, ...features.skills] }])('invalid feature option is rejected instead of silently dropped: %j', value => {
  expect(validTurnFeatures(value)).toBe(false); expect(() => copyTurnFeatures(value)).toThrow();
});
test('native desktop cannot carry CLI plan or skill overrides', () => { expect(validTurnFeatures(features, 'desktop')).toBe(false); });

test('skill catalog and submission respect the Bridge name byte limit and reserved characters', () => {
  const names = ['a'.repeat(161), '技'.repeat(54), 'bad name', '$review', 'bad\tname', '<review>'];
  for (const name of names) expect(validTurnFeatures({ skills: [{ name }] })).toBe(false);
  expect(validTurnFeatures({ skills: [{ name: '技'.repeat(53) }] })).toBe(true);
  expect(parseAgentFeatures({ collaborationModes: ['plan'], skillsSupported: true, skills: names.map(name => ({ name })) }).skills).toEqual([]);
});
test('new task receipt retains exact mode and skill across restart', () => {
  const encoded = encodeNewTask({ version: 1, tool: 'codex', cwd: 'C:/fixture', prompt: 'Review', approval: 'ask', images: [], ...features });
  expect(decodeNewTask(encoded)).toMatchObject(features);
  expect(() => decodeNewTask(encoded.replace('"plan"', '"fake"'))).toThrow();
});
test('same receipt retry retains mode and deep-frozen skill after caller mutation and restart', async () => {
  const input = { scope: 'pair', deviceId: 'pc', sessionKey: 'codex:one', surface: 'cli' as const, text: 'Review', idempotent: true };
  const selected = copyTurnFeatures(features);
  const send = deliverMessage({ ...input, sendOptions: selected, perform: async () => { throw new HubError('lost response'); } });
  selected.skills![0].name = 'changed';
  await expect(send).rejects.toMatchObject({ retryable: true });
  resetDeliveryForTests(); const original = await pendingDelivery('pair', 'pc', 'codex:one');
  expect(original?.sendOptions).toEqual(features);
  original!.sendOptions!.skills![0].name = 'mutated read';
  await deliverMessage({ ...input, sendOptions: { collaborationMode: 'default' }, perform: async receipt => {
    expect(receipt.requestId).toBe(original?.requestId); expect(receipt.sendOptions).toEqual(features);
  } });
});
test('queued draft retains mode and skill through disk read without borrowing caller objects', async () => {
  const options = { surface: 'cli' as const, ...copyTurnFeatures(features) };
  const save = saveRemoteQueuedDrafts('pair|pc|codex:one', [{ id: 'q1', text: 'Review', images: [], scope: 'pair', apiIdentity: 'api:fixture', state: 'waiting', sendOptions: options }]);
  options.skills![0].name = 'changed'; await save;
  expect((await loadRemoteQueuedDrafts('pair|pc|codex:one'))[0].sendOptions).toMatchObject(features);
});
test('proposed plan remains a visible block while progress checklist stays in activity', () => {
  const blocks = conversationBlocks(buildBlocks([
    { kind: 'tool', id: 'progress', tool: 'plan', title: '计划', output: '○ investigate', status: 'done', ts: 1 },
    { kind: 'tool', id: 'proposal', tool: 'plan', planKind: 'proposal', title: '方案', output: '# Proposal', status: 'done', ts: 2 },
  ], false));
  expect(blocks.map(block => block.type)).toEqual(['activity', 'plan']);
});
