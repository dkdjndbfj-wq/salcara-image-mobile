import { buildBlocks, fileEdits, workSummary } from '../remote/blocks';
import type { TimelineItem } from '../remote/store';
import { liveDelay } from '../remote/useLiveSync';

const user = (id: string, text: string): Extract<TimelineItem, { kind: 'message' }> => ({ kind: 'message', id, role: 'user', text, final: true, ts: 1 });
const bot = (id: string, text: string, final = true): Extract<TimelineItem, { kind: 'message' }> => ({ kind: 'message', id, role: 'assistant', text, final, ts: 1 });
const tool = (id: string, kind: 'command' | 'file_change' | 'read' | 'image_view' | 'image_generation', title: string, extra: Record<string, unknown> = {}): Extract<TimelineItem, { kind: 'tool' }> =>
  ({ kind: 'tool', id, tool: kind, title, status: 'done', ts: 1, ...extra }) as Extract<TimelineItem, { kind: 'tool' }>;

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
  expect(last).toMatchObject({ type: 'work', live: true, current: '正在运行 · pnpm build', currentItemId: 't1' });
  const thinking = buildBlocks([user('u1', 'go'), { kind: 'reasoning', id: 'r', text: 'Planning the fix\nmore', final: false, ts: 1 }], true);
  expect(thinking[1]).toMatchObject({ live: true, current: '正在思考 · Planning the fix more', currentItemId: 'r' });
  const updated = buildBlocks([user('u1', 'go'), { kind: 'reasoning', id: 'r', text: 'Running the focused tests', final: false, ts: 2 }], true);
  expect(updated[1]).toMatchObject({ live: true, current: '正在思考 · Running the focused tests', currentItemId: 'r' });
});

test('live file changes expose an editing label and the exact edited file', () => {
  const blocks = buildBlocks([user('u', '修复'), tool('edit', 'file_change', '修改 src/app.ts', {
    status: 'running', diff: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new',
  })], true);
  expect(blocks[1]).toMatchObject({ type: 'work', live: true, current: '正在编辑 · src/app.ts', currentItemId: 'edit', files: [{ id: 'edit', path: 'src/app.ts', status: 'running' }] });
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

test('native context compaction progress stays visible while routine information remains folded', () => {
  const notice: Extract<TimelineItem, { kind: 'notice' }> = { kind: 'notice', id: 'compact', level: 'info',
    noticeKind: 'context_compaction', progress: true, text: '正在压缩上下文', ts: 2 };
  const progressBlocks = buildBlocks([user('u', '检查'), notice], true);
  expect(progressBlocks.map(block => block.type)).toEqual(['user', 'notice']);
  const completed = buildBlocks([user('u', '检查'), { ...notice, progress: false, text: '上下文已压缩' }], false);
  expect(completed.map(block => block.type)).toEqual(['user', 'notice']);
  expect(buildBlocks([user('u', '检查'), { ...notice, noticeKind: undefined, progress: false, text: '连接已恢复' }], false)
    .map(block => block.type)).toEqual(['user', 'work']);
});

test('warnings stay visible while routine info remains folded into activity', () => {
  const blocks = buildBlocks([
    user('u', '继续'),
    { kind: 'notice', id: 'info', level: 'info', text: '连接已恢复', ts: 1 },
    { kind: 'notice', id: 'warn', level: 'warn', text: '停止请求待核对', ts: 2 },
    tool('t', 'command', '检查状态'),
  ], true);
  expect(blocks.some(block => block.type === 'notice' && block.item.id === 'warn')).toBe(true);
  expect(blocks.some(block => block.type === 'notice' && block.item.id === 'info')).toBe(false);
  expect(blocks.some(block => block.type === 'work' && block.items.some(item => item.kind === 'notice' && item.id === 'info'))).toBe(true);
});

test('a historical interruption folds into work only after another host turn begins', () => {
  const interrupted: TimelineItem = { kind: 'turn', id: 'old:end', turnId: 'old', status: 'interrupted', ts: 2 };
  const working: TimelineItem = { ...tool('new:tool', 'command', '继续检查', { status: 'running' }), turnId: 'new' };
  const items = [tool('old:tool', 'command', '检查'), interrupted, working];
  const blocks = buildBlocks(items, true);
  expect(blocks.some(block => block.type === 'turn')).toBe(false);
  expect(blocks[0]).toMatchObject({ type: 'work', live: false, items: [expect.objectContaining({ id: 'old:tool' }), interrupted] });
  expect(blocks[1]).toMatchObject({ type: 'work', live: true, current: '正在运行 · 继续检查' });
  expect(items[1]).toBe(interrupted); // Rendering never alters stop/continue or queue state.
});

test('late same-turn work, child work, an optimistic prompt and a running flag cannot hide an interruption', () => {
  const interrupted: TimelineItem = { kind: 'turn', id: 'old:end', turnId: 'old', status: 'interrupted', ts: 2 };
  const candidates: TimelineItem[] = [
    { ...tool('late', 'command', '迟到结果'), turnId: 'old' },
    { ...tool('child', 'command', '子任务'), turnId: 'child-turn', parentId: 'parent' },
    { ...user('pending', '继续'), local: true, turnId: 'optimistic' },
    { kind: 'notice', id: 'notice', level: 'info', text: '连接已恢复', ts: 3 },
    { kind: 'turn', id: 'old:started', turnId: 'old', status: 'started', ts: 3 },
  ];
  for (const candidate of candidates) {
    expect(buildBlocks([interrupted, candidate], true).find(block => block.type === 'turn')).toMatchObject({ item: interrupted });
  }
});

test('legacy explicit next-turn boundaries fold old interruptions but preserve the current interruption and failures', () => {
  const blocks = buildBlocks([
    { kind: 'turn', id: 'old', status: 'interrupted', ts: 1 },
    { kind: 'turn', id: 'next', status: 'started', ts: 2 },
    { kind: 'turn', id: 'failed', status: 'failed', error: 'capacity', ts: 3 },
    { kind: 'turn', id: 'current', status: 'interrupted', ts: 4 },
  ], false);
  expect(blocks[0]).toMatchObject({ type: 'work', summary: '中断记录' });
  expect(blocks.filter(block => block.type === 'turn').map(block => block.item.id)).toEqual(['failed', 'current']);
});

test('a late new item from a previously observed older turn cannot fold the current interruption', () => {
  const current: TimelineItem = { kind: 'turn', id: 'current:end', turnId: 'current', status: 'interrupted', ts: 3 };
  const blocks = buildBlocks([
    { kind: 'turn', id: 'older:end', turnId: 'older', status: 'completed', ts: 1 },
    { kind: 'turn', id: 'current:start', turnId: 'current', status: 'started', ts: 2 },
    current,
    { ...tool('late-older-result', 'command', '旧轮结果'), turnId: 'older', ts: 4 },
  ], false);
  expect(blocks.find(block => block.type === 'turn' && block.item.id === current.id)).toMatchObject({ item: current });
});

test('a native in-progress boundary after its items preserves the current work indicator only', () => {
  const items: TimelineItem[] = [
    { ...tool('old-tool', 'command', '旧轮检查', { status: 'running' }), turnId: 'old' },
    { kind: 'turn', id: 'old:end', turnId: 'old', status: 'interrupted', ts: 2 },
    { ...tool('new-tool', 'command', '继续检查', { status: 'running' }), turnId: 'new' },
    { kind: 'turn', id: 'new:start', turnId: 'new', status: 'started', ts: 3 },
  ];
  expect(buildBlocks(items, true).filter(block => block.type === 'work').map(block => block.live)).toEqual([false, true]);
  expect(buildBlocks(items, false).filter(block => block.type === 'work').every(block => !block.live)).toBe(true);
  expect(buildBlocks([...items, { kind: 'turn', id: 'new:end', turnId: 'new', status: 'interrupted', ts: 4 }], true)
    .filter(block => block.type === 'work').every(block => !block.live)).toBe(true);
});

test('a delayed old terminal folds even when the next turn started before it arrived', () => {
  const oldEnd: TimelineItem = { kind: 'turn', id: 'old:end', turnId: 'old', status: 'interrupted', ts: 3 };
  const items: TimelineItem[] = [
    { kind: 'turn', id: 'old:start', turnId: 'old', status: 'started', ts: 1 },
    { kind: 'turn', id: 'new:start', turnId: 'new', status: 'started', ts: 2 },
    oldEnd,
  ];
  for (const timeline of [items, [...items, { ...tool('new-tool', 'command', '继续检查', { status: 'running' }), turnId: 'new', ts: 4 }]]) {
    const blocks = buildBlocks(timeline, true);
    expect(blocks.some(block => block.type === 'turn' && block.item.id === oldEnd.id)).toBe(false);
    expect(blocks.some(block => block.type === 'work' && block.items.includes(oldEnd))).toBe(true);
  }
});

test('a tool-only completed turn keeps a compact completion boundary', () => {
  const blocks = buildBlocks([
    user('u', '运行一下'),
    tool('t', 'command', '运行测试'),
    { kind: 'turn', id: 'done', status: 'completed', durationMs: 1200, usage: { outputTokens: 50 }, ts: 2 },
  ], false);
  expect(blocks.map((block) => block.type)).toEqual(['user', 'work', 'turn']);
  expect(blocks[2]).toMatchObject({ type: 'turn', item: { status: 'completed', durationMs: 1200 } });
});

test('completed commentary is not a final answer and keeps the turn boundary', () => {
  const commentary = { ...bot('progress', '正在检查'), messagePhase: 'commentary' as const };
  const done: TimelineItem = { kind: 'turn', id: 'done', status: 'completed', durationMs: 1200, ts: 2 };
  expect(buildBlocks([user('u', '检查'), commentary, done], false).map(block => block.type)).toEqual(['user', 'assistant', 'turn']);
  expect(buildBlocks([user('u', '检查'), commentary, { ...bot('answer', '结果'), messagePhase: 'final_answer' as const }, done], false).map(block => block.type)).toEqual(['user', 'assistant', 'assistant']);
});

test('a single-file change without a diff header falls back to the tool detail', () => {
  const [edit] = fileEdits({ kind: 'tool', id: 'x', tool: 'file_change', title: '修改 app.ts', detail: 'src/app.ts', status: 'done', ts: 1 });
  expect(edit).toMatchObject({ path: 'src/app.ts', add: 0, del: 0 });
});

test('live sync holds one request at a time with long-poll, otherwise polls briefly, and backs off on errors', () => {
  // Even an empty long-poll response gets a small floor so a proxy that
  // immediately closes the request cannot create a tight request loop.
  expect(liveDelay(0, 0, true)).toBe(250);
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

test('image view and generation events stay visible as image work in the activity summary', () => {
  const blocks = buildBlocks([
    user('u-image', '看看这两张图'),
    tool('view-image', 'image_view', '查看图片'),
    tool('generate-image', 'image_generation', '生成图片'),
  ], false);
  const work = blocks.find((block) => block.type === 'work');
  expect(work && work.type === 'work' ? work.summary : '').toBe('处理了 2 张图片');
});
