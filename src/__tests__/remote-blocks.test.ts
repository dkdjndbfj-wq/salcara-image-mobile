import { buildBlocks, fileEdits, workSummary } from '../remote/blocks';
import type { TimelineItem } from '../remote/store';
import { liveDelay } from '../remote/useLiveSync';

const user = (id: string, text: string): TimelineItem => ({ kind: 'message', id, role: 'user', text, final: true, ts: 1 });
const bot = (id: string, text: string, final = true): TimelineItem => ({ kind: 'message', id, role: 'assistant', text, final, ts: 1 });
const tool = (id: string, kind: 'command' | 'file_change' | 'read', title: string, extra: Record<string, unknown> = {}): TimelineItem =>
  ({ kind: 'tool', id, tool: kind, title, status: 'done', ts: 1, ...extra }) as TimelineItem;

const diff = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1,2 @@', '-old', '+new', '+more',
  'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-x', '+y'].join('\n');

test('work between messages folds into one block with a Codex-style summary and visible file edits', () => {
  const blocks = buildBlocks([
    user('u1', 'fix it'),
    { kind: 'reasoning', id: 'r1', text: '**Looking at tests**', final: true, ts: 1 },
    tool('t1', 'command', '运行 npm test'), tool('t2', 'read', '读取 a.ts'), tool('t3', 'file_change', '修改 2 个文件', { diff }),
    bot('a1', 'Done.'),
    { kind: 'turn', id: 'turn1', status: 'completed', ts: 2 },
  ], false);
  expect(blocks.map((block) => block.type)).toEqual(['user', 'work', 'assistant']);
  const work = blocks[1];
  if (work.type !== 'work') throw new Error('work');
  expect(work.summary).toBe('运行了 1 条命令 · 编辑了 2 个文件 · 查看了 1 处');
  expect(work.files.map((file) => [file.path, file.add, file.del])).toEqual([['src/a.ts', 2, 1], ['README.md', 1, 1]]);
  expect(work.live).toBe(false);
});

test('the trailing block is live while running and names the current step', () => {
  const blocks = buildBlocks([user('u1', 'go'), tool('t1', 'command', '运行 pnpm build', { status: 'running' })], true);
  const last = blocks[blocks.length - 1];
  expect(last).toMatchObject({ type: 'work', live: true, current: '运行 pnpm build' });
  const thinking = buildBlocks([user('u1', 'go'), { kind: 'reasoning', id: 'r', text: 'Planning the fix\nmore', final: false, ts: 1 }], true);
  expect(thinking[1]).toMatchObject({ live: true, current: '思考：Planning the fix' });
});

test('failures and errors stay visible; completed turns and pending approvals do not add rows', () => {
  const blocks = buildBlocks([
    user('u', 'x'),
    { kind: 'approval', id: 'p', approval: 'command', title: 'rm', state: 'pending', ts: 1 },
    { kind: 'turn', id: 't', status: 'failed', error: '429', ts: 1 },
    { kind: 'notice', id: 'n', level: 'error', text: 'Codex 没有安装', ts: 1 },
  ], false);
  expect(blocks.map((block) => block.type)).toEqual(['user', 'turn', 'notice']);
  expect(workSummary([])).toBe('过程');
});

test('a single-file change without a diff header falls back to the tool detail', () => {
  const [edit] = fileEdits({ kind: 'tool', id: 'x', tool: 'file_change', title: '修改 app.ts', detail: 'src/app.ts', status: 'done', ts: 1 });
  expect(edit).toMatchObject({ path: 'src/app.ts', add: 0, del: 0 });
});

test('live sync holds one request at a time with long-poll, otherwise polls briefly, and backs off on errors', () => {
  expect(liveDelay(0, 0, true)).toBe(0);
  expect([0, 3, 9].map((attempt) => liveDelay(attempt, 0, false))).toEqual([2000, 4000, 8000]);
  expect([1, 3, 9].map((failures) => liveDelay(0, failures, true))).toEqual([2000, 8000, 300000]);
});

test('Codex plan updates render as one checklist card in the main column', () => {
  const blocks = buildBlocks([
    { kind: 'message', id: 'u', role: 'user', text: '做吧', final: true, ts: 1 },
    { kind: 'tool', id: 'plan:t1', tool: 'plan', title: '计划 · 1/3', status: 'running', output: '✓ 读代码\n▸ 改界面\n○ 跑测试', ts: 2 },
    { kind: 'tool', id: 'c', tool: 'command', title: '运行 npm test', status: 'done', ts: 3 },
  ], true);
  const plan = blocks.find((block) => block.type === 'plan');
  expect(plan && plan.type === 'plan' ? plan.steps.map((step) => step.status) : []).toEqual(['done', 'active', 'pending']);
  expect(blocks.map((block) => block.type)).toEqual(['user', 'plan', 'work']);
});
