import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { DiffAnnotationEditor } from '../remote/DiffAnnotationEditor';
import { ContextReferenceChips } from '../remote/ContextReferenceChips';
import { diffSelectionReference, parseDiffForAnnotations } from '../remote/diff-annotations';
import { appendContextReference, validContextReferences } from '../remote/context-references';
import { copyTurnFeatures } from '../remote/agent-features';
import { copyComposerFeatureIntent } from '../remote/composer-feature-intent';
import { diffReviewProblem } from '../remote/diff-review';
import type { TimelineItem } from '../remote/store';
jest.mock('../components/ui', () => ({ showToast: jest.fn() }));
const diff = 'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -10,3 +20,3 @@ fn\n same\n-removed 😀\n+added\n tail\n';
const parsed = () => parseDiffForAnnotations('new.ts', diff);
test('old and new coordinates use the correct rename path and exact saved patch', () => {
  const p = parsed(); expect(p.error).toBeUndefined();
  const old = diffSelectionReference(p, 'codex:s', 'old', 11), next = diffSelectionReference(p, 'codex:s', 'new', 21);
  expect(old).toMatchObject({ path: 'old.ts', side: 'old', text: 'removed 😀', startLine: 11, endLine: 11 });
  expect(next).toMatchObject({ path: 'new.ts', side: 'new', text: 'added', startLine: 21, endLine: 21 });
  expect(old.sourceRevision).toBe(next.sourceRevision);
  expect(parseDiffForAnnotations('new.ts', diff.replace('+added', '+changed')).revision).not.toBe(old.sourceRevision);
  expect(diffSelectionReference(p, 'codex:s', 'old', 10, 12).text).toBe('same\nremoved 😀\ntail');
});
test('delete-only patches never invent current file lines', () => {
  const p = parseDiffForAnnotations('/dev/null', '--- a/deleted.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n');
  expect(p.error).toBeUndefined(); expect(diffSelectionReference(p, 'claude:s', 'old', 1, 2).path).toBe('deleted.ts');
  expect(() => diffSelectionReference(p, 'claude:s', 'new', 1)).toThrow();
});
test.each(['@@ -1,2 +1,1 @@\n-old\n+new', '@@ -1 +1 @@\n-old\n+new\n+extra', '@@@ -1,1 -1,1 +1,1 @@@\n-old\n+new', diff + diff, diff.replace('--- a/old.ts', '--- a/../key')])('incomplete or ambiguous diff is read-only', source => {
  expect(parseDiffForAnnotations('a.ts', source).error).toBeTruthy();
});
test('selection cannot span hidden lines or a different hunk', () => {
  const p = parseDiffForAnnotations('a.ts', '@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d');
  expect(p.error).toBeUndefined(); expect(() => diffSelectionReference(p, 'codex:s', 'old', 1, 3)).toThrow('不能跨越');
});
test('a later edit, missing history or incomplete new patch blocks old draft and queued snapshots', () => {
  const items: TimelineItem[] = [{ kind: 'tool', id: 'old-edit', tool: 'file_change', title: 'new.ts', diff, status: 'done', ts: 1 }];
  const ref = diffSelectionReference(parsed(), 'codex:s', 'old', 11, 11, '保留');
  expect(diffReviewProblem(items, 'codex:s', [ref])).toBeUndefined();
  expect(diffReviewProblem([], 'codex:s', [ref])).toContain('尚未加载');
  expect(diffReviewProblem([...items, { kind: 'tool', id: 'next-edit', tool: 'file_change', title: 'new.ts', diff: diff.replace('+added', '+next'), status: 'done', ts: 2 }], 'codex:s', [ref])).toContain('差异版本已变化');
  expect(ref.annotation).toBe('保留'); expect(ref.text).toBe('removed 😀');
});
test('large hunks keep absolute old/new coordinates and reject an empty single line explicitly', () => {
  const p = parseDiffForAnnotations('a.ts', '@@ -900,1000 +1500,1000 @@\n' + Array.from({ length: 1000 }, (_, i) => ` line${i}`).join('\n'));
  expect(diffSelectionReference(p, 'codex:s', 'old', 1800, 1802).text).toBe('line900\nline901\nline902');
  expect(diffSelectionReference(p, 'codex:s', 'new', 2400, 2402).text).toBe('line900\nline901\nline902');
  const blank = parseDiffForAnnotations('a.ts', '@@ -1 +1 @@\n-\n+text'); expect(() => diffSelectionReference(blank, 'codex:s', 'old', 1)).toThrow('所选内容为空');
});
test('multiple old/new comments remain separate in persisted drafts and frozen send input', () => {
  const old = diffSelectionReference(parsed(), 'codex:s', 'old', 11, 11, '保留兼容'), next = diffSelectionReference(parsed(), 'codex:s', 'new', 21, 21, '补充校验');
  const refs = appendContextReference([old], next);
  const saved = copyComposerFeatureIntent({ version: 1, source: { scope: 's', deviceId: 'pc', tool: 'codex', runtimeId: 'codex', surface: 'cli', apiIdentity: 'api', cwd: '/p' }, contextReferences: refs }, '审查');
  const sent = copyTurnFeatures(saved); saved.contextReferences![0].annotation = 'later';
  expect(sent.contextReferences).toEqual(refs); expect(sent.contextReferences![0].annotation).toBe('保留兼容');
  for (const value of [{ ...old, side: 'current' }, { ...old, sourceRevision: undefined }, { ...old, textBasis: 'source' }, { ...old, projectPath: '/p' }, { ...old, messageId: 'm' }, { ...old, startLine: 0 }, { ...old, endLine: 12 }, { ...old, annotation: '中'.repeat(3000) }, { ...old, path: '../a' }]) expect(validContextReferences([value])).toBe(false);
});
test('actual editor adds several review comments to draft without sending; chips edit and remove them', async () => {
  const add = jest.fn(() => true), view = await render(<DiffAnnotationEditor path="new.ts" diff={diff} sessionKey="codex:s" onAdd={add} />);
  await fireEvent.press(view.getByLabelText('选择旧行 11')); await fireEvent.changeText(view.getByLabelText('差异批注评论'), '旧行问题'); await fireEvent.press(view.getByLabelText('加入差异批注草稿'));
  await fireEvent.press(view.getByLabelText('选择新行 21')); await fireEvent.changeText(view.getByLabelText('差异批注评论'), '新行问题'); await fireEvent.press(view.getByLabelText('加入差异批注草稿'));
  expect(add).toHaveBeenCalledTimes(2); const refs = add.mock.calls.map(call => (call as unknown as [Parameters<NonNullable<React.ComponentProps<typeof DiffAnnotationEditor>['onAdd']>>[0]])[0]);
  expect(refs.map(ref => ref.side)).toEqual(['old', 'new']); await view.unmount();
  const change = jest.fn(), remove = jest.fn(), chips = await render(<ContextReferenceChips references={refs} onAnnotationChange={change} onRemove={remove} />);
  await fireEvent.press(chips.getByLabelText('查看 2 条注释')); expect(chips.getByText('removed 😀')).toBeTruthy();
  await fireEvent.press(chips.getByLabelText('编辑注释 1')); await fireEvent.changeText(chips.getByLabelText('注释 1 的评论'), '改好'); expect(change).toHaveBeenCalledWith(0, '改好');
  await fireEvent.press(chips.getByLabelText('删除注释 2')); expect(remove).toHaveBeenCalledWith(1); await chips.unmount();
});
test('old transport capability displays a reason and never collects a comment', async () => {
  const add = jest.fn(), view = await render(<DiffAnnotationEditor path="new.ts" diff={diff} sessionKey="codex:s" unavailableReason="更新 Bridge 和 Hub" onAdd={add} />);
  expect(view.getByText('更新 Bridge 和 Hub')).toBeTruthy(); await fireEvent.press(view.getByLabelText('选择旧行 11')); expect(view.queryByLabelText('加入差异批注草稿')).toBeNull(); expect(add).not.toHaveBeenCalled(); await view.unmount();
});
