import { lastTurnFiles } from '../remote/last-turn-files';
import type { ConversationBlock, FileEdit } from '../remote/blocks';
const file = (id: string, path = 'app.ts'): FileEdit => ({ id, path, add: 1, del: 1, status: 'done', diff: id });
const user = (id: string) => ({ type: 'user', id, item: { kind: 'message', id, role: 'user', text: id, final: true, ts: 1 } }) as ConversationBlock;
const activity = (...files: FileEdit[]) => ({ type: 'activity', id: files[0]?.id, parts: [], files, live: false, summary: '', subagentCount: 0, collapsible: true }) as ConversationBlock;
test('review keeps only edits after the latest user boundary in original order, including successive versions', () => {
  const a = file('new-a'), b = file('new-b'), c = file('new-c', 'other.ts');
  expect(lastTurnFiles([user('old'), activity(file('old-a')), user('new'), activity(a, b), activity(c)])).toEqual([a, b, c]);
});
test('a new turn without changes never reuses the previous turn and an unloaded boundary is not invented', () => {
  expect(lastTurnFiles([user('old'), activity(file('old-a')), user('new')])).toEqual([]);
  expect(lastTurnFiles([activity(file('unbounded'))])).toEqual([]);
});
