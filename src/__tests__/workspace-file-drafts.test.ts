import { discardWorkspaceFileDraft, discardWorkspaceFileDraftsForScope, readWorkspaceFileDraft, saveWorkspaceFileDraft, workspaceFileDraftUsage, type WorkspaceFileDraftIdentity } from '../remote/workspace-file-drafts';

const identity: WorkspaceFileDraftIdentity = { scope: 'draft-test', deviceId: 'pc', agentId: 'codex', sessionKey: 'codex:chat', surface: 'cli', cwd: '/project', path: 'main.ts' };
const base = { path: 'main.ts', text: 'original', size: 8, modifiedAt: 1, revision: 'a'.repeat(64) };
afterEach(() => { discardWorkspaceFileDraftsForScope('draft-test'); discardWorkspaceFileDraftsForScope('other-identity'); });

test.each(['scope', 'deviceId', 'agentId', 'sessionKey', 'surface', 'cwd', 'path'] as const)('draft identity isolates %s', field => {
  expect(saveWorkspaceFileDraft(identity, base, 'draft').ok).toBe(true);
  expect(readWorkspaceFileDraft({ ...identity, [field]: field === 'surface' ? 'desktop' : 'different' })).toBeUndefined();
  expect(readWorkspaceFileDraft(identity)).toEqual({ base, text: 'draft' });
});

test('capacity rejects the ninth draft without evicting any accepted content', () => {
  for (let i = 0; i < 8; i++) { const path = `file-${i}.ts`; expect(saveWorkspaceFileDraft({ ...identity, path }, { ...base, path }, `draft-${i}`).ok).toBe(true); }
  const result = saveWorkspaceFileDraft(identity, base, 'ninth'); expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('已有草稿已保留');
  expect(workspaceFileDraftUsage().files).toBe(8);
  for (let i = 0; i < 8; i++) expect(readWorkspaceFileDraft({ ...identity, path: `file-${i}.ts` })?.text).toBe(`draft-${i}`);
});

test('byte limit counts base and draft and failed growth preserves the old value', () => {
  const large = { ...base, text: 'a'.repeat(128 * 1024) };
  for (let i = 0; i < 4; i++) { const path = `file-${i}.ts`; expect(saveWorkspaceFileDraft({ ...identity, path }, { ...large, path }, 'b'.repeat(128 * 1024)).ok).toBe(true); }
  expect(workspaceFileDraftUsage()).toEqual({ files: 4, bytes: 1024 * 1024 });
  expect(saveWorkspaceFileDraft(identity, base, 'extra').ok).toBe(false);
  const old = readWorkspaceFileDraft({ ...identity, path: 'file-0.ts' });
  expect(saveWorkspaceFileDraft({ ...identity, path: 'file-0.ts' }, { ...large, path: 'file-0.ts' }, 'c'.repeat(128 * 1024 + 1)).ok).toBe(false);
  expect(readWorkspaceFileDraft({ ...identity, path: 'file-0.ts' })).toEqual(old);
});

test('explicit discard and reverting to the saved contents free the reservation', () => {
  saveWorkspaceFileDraft(identity, base, 'draft'); discardWorkspaceFileDraft(identity);
  expect(workspaceFileDraftUsage()).toEqual({ files: 0, bytes: 0 });
  saveWorkspaceFileDraft(identity, base, 'draft'); saveWorkspaceFileDraft(identity, base, base.text);
  expect(readWorkspaceFileDraft(identity)).toBeUndefined(); expect(workspaceFileDraftUsage()).toEqual({ files: 0, bytes: 0 });
});

test('returned draft objects cannot mutate the cached base revision', () => {
  saveWorkspaceFileDraft(identity, base, 'draft'); const loaded = readWorkspaceFileDraft(identity)!; loaded.base.revision = 'tampered';
  expect(readWorkspaceFileDraft(identity)?.base.revision).toBe(base.revision);
});
