import type { FileEdit } from './blocks';
import type { AgentId } from './client';
import { captureWorkspaceFiles, workspaceRelativePath, WORKSPACE_FILE_BYTES, type WorkspaceFileReader, type WorkspaceFileText } from './workspace-files';

type Selection = { deviceId: string; sessionKey: string; agentId: AgentId; surface: 'cli' | 'desktop'; expectedCwd: string };
export interface WorkspaceUndoResult { complete: boolean; restoredPaths: string[]; message: string; failedPath?: string }
type Hunk = { at: number; before: string[]; after: string[]; beforeNoNewline: boolean; afterNoNewline: boolean };

function fail(message: string): never { throw new Error(message); }
function relativeFile(path: string, cwd: string): string {
  let value = path.replace(/\\/g, '/'), root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(value)) value = value[0].toLowerCase() + value.slice(1);
  if (/^[A-Za-z]:\//.test(root)) root = root[0].toLowerCase() + root.slice(1);
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    if (!root || !value.startsWith(`${root}/`)) return fail('文件不在当前会话项目中');
    value = value.slice(root.length + 1);
  }
  if (value.startsWith('./')) value = value.slice(2);
  if (!workspaceRelativePath(value)) return fail('文件路径不支持安全撤销');
  return value;
}

/** Exact, position-preserving reversal only: never fuzzy-match an edited file. */
export function reverseWorkspaceDiff(current: string, diff: string, expectedPath?: string, cwd = ''): string {
  if (!diff || diff.length > WORKSPACE_FILE_BYTES * 3 || /^(?:new file mode|deleted file mode|rename |copy |Binary files|GIT binary patch)/m.test(diff)) return fail('新增、删除、重命名或二进制文件暂不支持撤销');
  const source = diff.replace(/\r\n/g, '\n').split('\n');
  const hunks: Hunk[] = [];
  let i = 0, oldHeader: string | undefined, newHeader: string | undefined;
  while (i < source.length) {
    const line = source[i++];
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const name = line.slice(4).split('\t')[0];
      if (name === '/dev/null' || name.startsWith('"')) return fail('新增、删除或带转义路径的文件暂不支持撤销');
      if (line.startsWith('--- ')) { if (oldHeader !== undefined) return fail('变更包含多个文件'); oldHeader = name.replace(/^a\//, ''); }
      else { if (newHeader !== undefined) return fail('变更包含多个文件'); newHeader = name.replace(/^b\//, ''); }
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (!header) {
      if (!line && i === source.length || !hunks.length && /^(?:diff --git |index )/.test(line)) continue;
      return fail('变更不是完整的文本差异，无法安全撤销');
    }
    const oldStart = Number(header[1]), oldCount = Number(header[2] ?? 1), newStart = Number(header[3]), newCount = Number(header[4] ?? 1);
    if (![oldStart, oldCount, newStart, newCount].every(n => Number.isSafeInteger(n) && n >= 0 && n <= WORKSPACE_FILE_BYTES) || newCount && !newStart || oldCount && !oldStart) return fail('该变更缺少可核对的上下文');
    const hunk: Hunk = { at: newCount ? newStart - 1 : newStart, before: [], after: [], beforeNoNewline: false, afterNoNewline: false };
    let previous = '';
    while (i < source.length && !source[i].startsWith('@@ ') && !(source[i] === '' && i === source.length - 1)) {
      const row = source[i++], kind = row[0];
      if (row === '\\ No newline at end of file') {
        if (!previous) return fail('换行标记无效');
        if (previous !== '+') hunk.beforeNoNewline = true;
        if (previous !== '-') hunk.afterNoNewline = true;
        previous = ''; continue;
      }
      if (kind !== ' ' && kind !== '+' && kind !== '-') return fail('变更内容不完整');
      if (kind !== '+' && hunk.beforeNoNewline || kind !== '-' && hunk.afterNoNewline) return fail('换行标记后存在其他内容');
      if (kind !== '+') hunk.before.push(row.slice(1));
      if (kind !== '-') hunk.after.push(row.slice(1));
      previous = kind;
    }
    if (hunk.before.length !== oldCount || hunk.after.length !== newCount) return fail('变更行数不完整');
    if (hunks.length && hunk.at < hunks[hunks.length - 1].at + hunks[hunks.length - 1].after.length) return fail('变更区间重叠');
    hunks.push(hunk);
  }
  if (hunks.some(hunk => !hunk.after.length) && !(hunks.length === 1 && current === '' && hunks[0].at === 0)) return fail('删除差异缺少可核对的上下文');
  if (!hunks.length || Boolean(oldHeader) !== Boolean(newHeader) || oldHeader !== newHeader) return fail('缺少差异或文件发生重命名');
  if (expectedPath && oldHeader && relativeFile(oldHeader, cwd) !== relativeFile(expectedPath, cwd)) return fail('差异文件与目标不一致');
  if (/\r(?!\n)/.test(current) || current.includes('\r\n') && /(?<!\r)\n/.test(current)) return fail('混合换行格式暂不支持撤销');
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const lines = current.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const hunk of [...hunks].reverse()) {
    const expected = hunk.after.map((line, index) => line + (index === hunk.after.length - 1 && hunk.afterNoNewline ? '' : newline));
    const before = hunk.before.map((line, index) => line + (index === hunk.before.length - 1 && hunk.beforeNoNewline ? '' : newline));
    if (hunk.at + expected.length > lines.length || expected.some((line, index) => line !== lines[hunk.at + index])
        || hunk.afterNoNewline && hunk.at + expected.length !== lines.length
        || hunk.beforeNoNewline && hunk.at + expected.length !== lines.length) return fail('电脑文件已有后续修改，已停止撤销');
    lines.splice(hunk.at, expected.length, ...before);
  }
  const result = lines.join('');
  if (new TextEncoder().encode(result).length > WORKSPACE_FILE_BYTES) return fail('超出大小限制的变更暂不支持撤销');
  return result;
}

/** Whole-file additions/deletions must include the complete file, never a
 * partial tool preview. A rename without hunks must explicitly claim 100%. */
function lifecycle(diff: string, cwd: string): { kind: 'create' | 'delete' | 'rename'; before: string; after: string; text?: string; editDiff?: string } | undefined {
  if (/^(?:Binary files|GIT binary patch|copy )/m.test(diff)) fail('二进制或复制变更无法自动撤销');
  const before = diff.match(/^--- (.+)$/m)?.[1]?.replace(/^a\//, '').trim();
  const after = diff.match(/^\+\+\+ (.+)$/m)?.[1]?.replace(/^b\//, '').trim();
  const from = diff.match(/^rename from (.+)$/m)?.[1], to = diff.match(/^rename to (.+)$/m)?.[1];
  if (from || to) {
    if (!from || !to) fail('重命名记录不完整');
    const source = relativeFile(from!, cwd), destination = relativeFile(to!, cwd);
    if (source.split('/').slice(0, -1).join('/') !== destination.split('/').slice(0, -1).join('/')) fail('跨目录移动请在电脑上核对后撤销');
    const hasHunks = /^@@ /m.test(diff);
    if (!hasHunks && !/^similarity index 100%$/m.test(diff)) fail('缺少重命名内容证据');
    const editDiff = hasHunks ? diff.split('\n').filter(line => !/^(?:rename |similarity index )/.test(line)).map(line => line.startsWith('--- ') ? `--- a/${destination}` : line).join('\n') : undefined;
    return { kind: 'rename', before: source, after: destination, editDiff };
  }
  if (before !== '/dev/null' && after !== '/dev/null') return;
  if (!before || !after || before === after) fail('新增或删除记录缺少文件路径');
  const created = before === '/dev/null', rawPath = created ? after : before;
  const headers = [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm)];
  if (headers.length !== 1) fail('新增或删除记录必须含完整文件差异');
  const h = headers[0], oldCount = Number(h[2] ?? 1), newCount = Number(h[4] ?? 1);
  if (created ? Number(h[1]) !== 0 || oldCount !== 0 || Number(h[3]) !== 1 : Number(h[3]) !== 0 || newCount !== 0 || Number(h[1]) !== 1) fail('新增或删除差异不完整');
  const body = diff.slice(h.index! + h[0].length).replace(/^\n/, '').split('\n');
  if (body.at(-1) === '') body.pop();
  let noNewline = false; const rows: string[] = [];
  for (const line of body) {
    if (line === '\\ No newline at end of file' && rows.length && !noNewline) { noNewline = true; continue; }
    if (noNewline || !line.startsWith(created ? '+' : '-')) fail('新增或删除内容不是完整文本');
    rows.push(line.slice(1));
  }
  if (rows.length !== (created ? newCount : oldCount)) fail('新增或删除行数不完整');
  const text = rows.join('\n') + (rows.length && !noNewline ? '\n' : '');
  return { kind: created ? 'create' : 'delete', before: relativeFile(rawPath!, cwd), after: relativeFile(rawPath!, cwd), text };
}

async function assertMissing(reader: WorkspaceFileReader, path: string): Promise<void> {
  const parent = path.split('/').slice(0, -1).join('/'); let cursor: string | undefined;
  for (let page = 0; page < 84; page++) {
    const result = await reader.list(parent, cursor);
    if (result.entries.some(entry => entry.path === path)) fail('恢复路径已存在，已停止撤销');
    if (!result.nextCursor) { if (result.truncated) fail('目录未完整读取，无法确认恢复路径'); return; }
    cursor = result.nextCursor;
  }
  fail('目录过大，无法确认恢复路径');
}

/** Preflight every file before the first write. Each write still uses the
 * original revision, so a competing editor is never silently overwritten. */
export async function undoWorkspaceChanges(selection: Selection, edits: FileEdit[], createReader: typeof captureWorkspaceFiles = captureWorkspaceFiles): Promise<WorkspaceUndoResult> {
  const restoredPaths: string[] = [];
  let reader: WorkspaceFileReader | undefined, failedPath: string | undefined;
  let partialNotice = '';
  try {
    if (!edits.length || edits.length > 100) fail('变更数量无效，请分批撤销');
    const groups = new Map<string, FileEdit[]>();
    for (const edit of edits) {
      if (edit.status !== 'done' || !edit.diff) fail('存在未完成或缺少差异的变更，无法撤销');
      const path = relativeFile(edit.path, selection.expectedCwd);
      groups.set(path, [...(groups.get(path) ?? []), edit]);
    }
    if (groups.size > 24) fail('一次最多撤销 24 个文本文件');
    reader = createReader(selection);
    if (!reader.writable || !reader.write) fail('当前电脑尚未开放文件保存');
    const plan: { path: string; before?: WorkspaceFileText; text?: string; action: 'write' | 'create' | 'delete' | 'rename'; destination?: string }[] = [];
    for (const [path, history] of groups) {
      failedPath = path;
      const special = history.map(edit => lifecycle(edit.diff!, selection.expectedCwd));
      if (special.some(Boolean)) {
        if (!reader.manageable || !reader.create || !reader.remove || !reader.rename) fail('电脑尚未开放新增、删除和重命名撤销');
        if (special.filter(Boolean).length !== 1) fail('同一文件包含多次生命周期变化，请分组核对后撤销');
        const index = special.findIndex(Boolean), change = special[index]!;
        if (path !== change.after) fail('差异文件与目标不一致');
        if (change.kind === 'delete') {
          if (index !== history.length - 1) fail('删除后还有修改记录，无法确认文件状态');
          await assertMissing(reader, path);
          let text = change.text!;
          for (const edit of history.slice(0, index).reverse()) text = reverseWorkspaceDiff(text, edit.diff!, path, selection.expectedCwd);
          plan.push({ path, text, action: 'create' });
        } else {
          const before = await reader.read(path); if (!before.revision) fail('电脑未提供文件版本');
          let text = before.text;
          for (const edit of history.slice(index + 1).reverse()) text = reverseWorkspaceDiff(text, edit.diff!, path, selection.expectedCwd);
          if (change.kind === 'create') {
            if (index !== 0 || text !== change.text) fail('新增文件已有其他内容，已停止撤销');
            plan.push({ path, before, action: 'delete' });
          } else {
            if (index !== 0 || path !== change.after || groups.has(change.before)) fail('重命名与其他文件变更重叠，请分组撤销');
            await assertMissing(reader, change.before);
            if (change.editDiff) text = reverseWorkspaceDiff(text, change.editDiff, path, selection.expectedCwd);
            plan.push({ path, before, text, action: 'rename', destination: change.before });
          }
        }
        continue;
      }
      const before = await reader.read(path);
      if (!before.revision) fail('电脑未提供文件版本，无法安全撤销');
      let text = before.text;
      for (const edit of [...history].reverse()) text = reverseWorkspaceDiff(text, edit.diff!, edit.path, selection.expectedCwd);
      plan.push({ path, before, text, action: 'write' });
    }
    for (const item of plan) {
      failedPath = item.path;
      if (item.action === 'create') await reader.create!(item.path, item.text!);
      else if (item.action === 'delete') await reader.remove!(item.path, item.before!.revision!);
      else if (item.action === 'rename') {
        // Restore content before moving; failure is reported truthfully and
        // keeps both the original path and all bytes available for inspection.
        const original = item.before!;
        const saved = original.text === item.text ? original : await reader.write!(item.path, item.text!, original.revision!);
        if (original.text !== item.text) partialNotice = `${item.path} 的内容已恢复，但文件名尚未恢复；请先核对该文件`;
        await reader.rename!(item.path, item.destination!, saved.revision!);
        partialNotice = '';
      } else await reader.write!(item.path, item.text!, item.before!.revision!);
      restoredPaths.push(item.path);
    }
    return { complete: true, restoredPaths, message: `已撤销 ${restoredPaths.length} 个文件的修改` };
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : '撤销失败';
    return { complete: false, restoredPaths, ...(failedPath ? { failedPath } : {}), message: partialNotice ? `${partialNotice}。${detail}` : restoredPaths.length ? `已撤销 ${restoredPaths.length} 个文件，其余已停止：${detail}` : `未撤销任何文件：${detail}` };
  } finally { reader?.dispose(); }
}
