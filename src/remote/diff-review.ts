import { fileEdits } from './blocks';
import { parseDiffForAnnotations } from './diff-annotations';
import type { ContextReference } from './context-references';
import type { TimelineItem } from './store';

/** A queued review must still refer to the newest loaded edit of each path.
 * Missing history is unknown, never evidence that a patch stayed unchanged. */
export function diffReviewProblem(items: readonly TimelineItem[], sessionKey: string, refs?: readonly ContextReference[]): string | undefined {
  const selected = refs?.filter(ref => ref.kind === 'diff'); if (!selected?.length) return;
  const revisions = new Map<string, string | undefined>();
  for (const item of items) {
    if (item.kind !== 'tool' || item.tool !== 'file_change') continue;
    for (const edit of fileEdits(item)) {
      const parsed = parseDiffForAnnotations(edit.path, edit.diff ?? '');
      const revision = item.status === 'done' && !parsed.error ? parsed.revision : undefined;
      const paths = [edit.path, parsed.oldPath, parsed.newPath].filter((path): path is string => Boolean(path));
      const prior = new Set(paths.map(path => revisions.get(path)).filter((value): value is string => Boolean(value)));
      // Follow renames: a later edit of b.ts also invalidates annotations on
      // a.ts's old side of an earlier a.ts -> b.ts patch.
      for (const [path, previous] of revisions) if (previous && prior.has(previous)) revisions.set(path, revision);
      for (const path of paths) revisions.set(path, revision);
    }
  }
  if (selected.some(ref => ref.sessionKey !== sessionKey || !ref.path || revisions.get(ref.path) !== ref.sourceRevision)) return '差异版本已变化或原差异尚未加载。批注草稿已保留，请查看最新差异后重新选择。';
}
