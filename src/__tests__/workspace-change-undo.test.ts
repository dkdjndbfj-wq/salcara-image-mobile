import { reverseWorkspaceDiff, undoWorkspaceChanges } from '../remote/workspace-change-undo';
import type { FileEdit } from '../remote/blocks';
import type { WorkspaceFileReader } from '../remote/workspace-files';

jest.mock('../remote/workspace-files', () => ({ ...jest.requireActual('../remote/workspace-files'), captureWorkspaceFiles: jest.fn() }));
const diff = '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n';
const selection = { deviceId: 'pc', sessionKey: 'codex:session', agentId: 'codex', surface: 'cli' as const, expectedCwd: 'C:/project' };
const edit = (path = 'main.ts', value = diff): FileEdit => ({ id: path + value, path, add: 1, del: 1, diff: value, status: 'done' });

test('strict reversal preserves unrelated lines and the current CRLF format', () => {
  expect(reverseWorkspaceDiff('keep\nnew\nuntouched\n', diff)).toBe('keep\nold\nuntouched\n');
  expect(reverseWorkspaceDiff('keep\r\nnew\r\nuntouched\r\n', diff)).toBe('keep\r\nold\r\nuntouched\r\n');
});

test('standard headers bind the diff to the intended path', () => {
  const headers = '--- a/main.ts\n+++ b/main.ts\n';
  expect(reverseWorkspaceDiff('keep\nnew\n', headers + diff, 'C:/project/main.ts', 'C:/project')).toBe('keep\nold\n');
  expect(() => reverseWorkspaceDiff('keep\nnew\n', headers + diff, 'other.ts', 'C:/project')).toThrow('目标不一致');
});

test.each([
  ['keep\nchanged later\n', diff],
  ['inserted\nkeep\nnew\n', diff],
  ['keep\nnew\n', diff.replace('-1,2', '-1,3')],
  ['keep\nnew\n', '--- /dev/null\n+++ b/main.ts\n' + diff],
  ['keep\nnew\n', '--- a/main.ts\n+++ b/renamed.ts\n' + diff],
  ['keep\nnew\n', '@@ -2,1 +1,0 @@\n-old\n'],
  ['keep\nnew', diff],
])('unsafe or no-longer-matching diff cannot be reversed %#', (text, patch) => {
  expect(() => reverseWorkspaceDiff(text, patch)).toThrow();
});

test('explicit no-newline metadata is honored only at end of the file', () => {
  const value = '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
  expect(reverseWorkspaceDiff('new', value)).toBe('old');
  expect(() => reverseWorkspaceDiff('new\nafter\n', value)).toThrow();
});

function fakeReader(files: Record<string, string>, failPath?: string) {
  const read = jest.fn(async (path: string) => ({ path, text: files[path], size: files[path].length, modifiedAt: 1, revision: path + '-revision' }));
  const write = jest.fn(async (path: string, text: string, expectedRevision: string) => {
    if (path === failPath) throw new Error('workspace_file_conflict');
    expect(expectedRevision).toBe(path + '-revision'); files[path] = text;
    return { path, text, size: text.length, modifiedAt: 2, revision: 'saved' };
  });
  const reader: WorkspaceFileReader = { list: jest.fn(), read, writable: true, write, dispose: jest.fn() };
  return { reader, factory: jest.fn(() => reader), write, read };
}

test('every file is preflighted before the first write and same-file history reverses newest first', async () => {
  const files = { 'main.ts': 'keep\nnewest\n', 'other.ts': 'keep\nnew\n' };
  const mock = fakeReader(files);
  const result = await undoWorkspaceChanges(selection, [edit(), edit('main.ts', diff.replace('-old', '-new').replace('+new', '+newest')), edit('other.ts')], mock.factory);
  expect(result.complete).toBe(true); expect(result.restoredPaths).toEqual(['main.ts', 'other.ts']);
  expect(files).toEqual({ 'main.ts': 'keep\nold\n', 'other.ts': 'keep\nold\n' });
  expect(mock.write).toHaveBeenCalledTimes(2);
  expect(mock.read.mock.invocationCallOrder[1]).toBeLessThan(mock.write.mock.invocationCallOrder[0]);
  expect(mock.reader.dispose).toHaveBeenCalledTimes(1);
});

test('a preflight conflict leaves every file unchanged', async () => {
  const files = { 'main.ts': 'keep\nnew\n', 'other.ts': 'later edit\n' }, mock = fakeReader(files);
  const result = await undoWorkspaceChanges(selection, [edit(), edit('other.ts')], mock.factory);
  expect(result).toMatchObject({ complete: false, restoredPaths: [], failedPath: 'other.ts' });
  expect(mock.write).not.toHaveBeenCalled(); expect(files['main.ts']).toBe('keep\nnew\n');
});

test('a save conflict reports partial completion accurately and stops subsequent writes', async () => {
  const files = { 'first.ts': 'keep\nnew\n', 'second.ts': 'keep\nnew\n', 'third.ts': 'keep\nnew\n' }, mock = fakeReader(files, 'second.ts');
  const result = await undoWorkspaceChanges(selection, Object.keys(files).map(path => edit(path)), mock.factory);
  expect(result).toMatchObject({ complete: false, restoredPaths: ['first.ts'], failedPath: 'second.ts' });
  expect(result.message).toContain('其余已停止'); expect(mock.write).toHaveBeenCalledTimes(2); expect(files['third.ts']).toBe('keep\nnew\n');
});

test('out-of-project and unfinished edits are rejected before capturing a reader', async () => {
  const mock = fakeReader({ 'main.ts': 'keep\nnew\n' });
  expect((await undoWorkspaceChanges(selection, [edit('C:/other/main.ts')], mock.factory)).complete).toBe(false);
  expect((await undoWorkspaceChanges(selection, [{ ...edit(), status: 'running' }], mock.factory)).complete).toBe(false);
  expect(mock.factory).not.toHaveBeenCalled();
});

function lifecycleReader(files: Record<string, string>) {
 const mock = fakeReader(files);
 Object.defineProperty(mock.reader,'manageable',{value:true});
 mock.reader.list = jest.fn(async parent => ({path:parent??'',entries:Object.keys(files).map(path=>({path,name:path,kind:'file' as const})),truncated:false}));
 mock.reader.create = jest.fn(async (path,text)=>{if(path in files)throw new Error('exists');files[path]=text;return {path,text,size:text.length,modifiedAt:1,revision:'created'};});
 mock.reader.remove = jest.fn(async (path,revision)=>{expect(revision).toBe(path+'-revision');delete files[path];});
 mock.reader.rename = jest.fn(async (path,destination)=>{if(destination in files)throw new Error('exists');const text=files[path];delete files[path];files[destination]=text;return {path:destination,text,size:text.length,modifiedAt:1,revision:'renamed'};});
 return mock;
}
const createdDiff='diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n';
const deletedDiff='diff --git a/old.ts b/old.ts\ndeleted file mode 100644\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n';
test('whole-file create/delete and same-directory rename undo real file lifecycle', async()=>{
 const files:Record<string,string>={'new.ts':'new\n','renamed.ts':'preserved\n'},mock=lifecycleReader(files);
 const rename='diff --git a/original.ts b/renamed.ts\nsimilarity index 100%\nrename from original.ts\nrename to renamed.ts\n';
 const result=await undoWorkspaceChanges(selection,[edit('new.ts',createdDiff),edit('old.ts',deletedDiff),edit('renamed.ts',rename)],mock.factory);
 expect(result.complete).toBe(true);expect(files).toEqual({'old.ts':'old\n','original.ts':'preserved\n'});
});
test('a changed created file and mismatched lifecycle header never delete a file', async()=>{
 for(const [path,text] of [['new.ts','later edit\n'],['other.ts','new\n']]) {
  const files={[path]:text},mock=lifecycleReader(files);expect((await undoWorkspaceChanges(selection,[edit(path,createdDiff)],mock.factory)).complete).toBe(false);expect(mock.reader.remove).not.toHaveBeenCalled();
 }
});
test('deleted-file restore rejects an occupied target before any file write',async()=>{
 const mock=lifecycleReader({'old.ts':'recreated by user\n'});expect((await undoWorkspaceChanges(selection,[edit('old.ts',deletedDiff)],mock.factory)).complete).toBe(false);expect(mock.reader.create).not.toHaveBeenCalled();
});
test('reversing a full content deletion works only while the file remains empty',()=>{
 const patch='@@ -1 +0,0 @@\n-old\n';expect(reverseWorkspaceDiff('',patch)).toBe('old\n');expect(()=>reverseWorkspaceDiff('later\n',patch)).toThrow();
});
