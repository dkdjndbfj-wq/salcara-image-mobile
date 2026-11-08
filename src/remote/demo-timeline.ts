import { diffStats, type FileEdit } from './blocks';
import type { ToolId } from './client';
import type { TimelineItem } from './store';

export type DemoMessage = { id: number; role: 'user' | 'assistant'; text: string; code?: string; file?: string };

const CODE_DIFFS = [
  { id: 'demo-css', path: 'src/auth/login.css', diff: '--- a/src/auth/login.css\n+++ b/src/auth/login.css\n@@ -1,4 +1,4 @@\n .auth-layout {\n   display: grid;\n-  grid-template-columns: minmax(0, 1fr) 420px;\n+  grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);\n }\n' },
  { id: 'demo-tsx', path: 'src/auth/LoginPage.tsx', diff: '--- a/src/auth/LoginPage.tsx\n+++ b/src/auth/LoginPage.tsx\n@@ -4,1 +4,1 @@\n-      <section className="auth-form">\n+      <section className="auth-form" aria-label="登录表单">\n' },
];
const WORK_DIFFS = [
  { id: 'demo-checklist', path: 'release/checklist.md', diff: '--- a/release/checklist.md\n+++ b/release/checklist.md\n@@ -1,3 +1,3 @@\n-- [ ] 平板布局回归测试\n-- [ ] 远程会话检查\n+- [x] 平板布局回归测试\n+- [x] 远程会话检查\n - [ ] 发布说明与交接\n' },
];

export function demoFileChanges(mode: 'code' | 'work'): FileEdit[] {
  return (mode === 'work' ? WORK_DIFFS : CODE_DIFFS).map(file => ({ ...file, status: 'done', ...diffStats(file.diff) }));
}

/** Synthetic host events feed the same renderer as a connected conversation.
 * Only the seeded assistant message carries `code`; later replies are plain text. */
export function demoConversationTimeline(messages: DemoMessage[], mode: 'code' | 'work', tool: ToolId, scope: string): TimelineItem[] {
  const items: TimelineItem[] = [];
  let sequence = 0;
  const append = (item: TimelineItem) => { const seq = ++sequence; items.push({ ...item, ts: seq * 1000, seq }); };
  for (const message of messages) {
    const id = `demo:${scope}:${message.id}`;
    if (message.role !== 'assistant' || !message.code) {
      append({ kind: 'message', id, role: message.role, text: message.text, final: true, ts: 0 });
      continue;
    }
    const work = mode === 'work';
    const files = demoFileChanges(mode);
    const turnId = `${id}:turn`;
    const childId = `${id}:review`;
    const childKey = `${tool}:demo-${scope}-review`;
    append({ kind: 'turn', id: `${turnId}:start`, turnId, status: 'started', ts: 0 });
    const text = (suffix: string, value: string, phase: 'commentary' | 'final_answer') => append({
      kind: 'message', id: `${id}:${suffix}`, role: 'assistant', text: value, final: true, messagePhase: phase, turnId, ts: 0,
    });
    text('intro', message.text, 'commentary');
    append({ kind: 'tool', id: `${id}:read`, tool: 'read', title: work ? 'release/checklist.md' : 'src/auth/LoginPage.tsx',
      status: 'done', output: work ? '示例数据：已核对发布清单中的回归、连接与交接事项。' : '示例数据：已读取登录表单组件和布局断点。', turnId, ts: 0 });
    append({ kind: 'tool', id: `${id}:edit`, tool: 'file_change', title: work ? '更新发布检查清单' : '调整登录布局',
      status: 'done', diff: files.map(file => file.diff).join('\n'), turnId, ts: 0 });
    text('progress', work ? '清单已按回归检查和交接事项整理。接下来核对文档格式，并请子智能体检查遗漏项。'
      : '布局调整已记录。接下来运行登录页测试，并请子智能体核对平板断点和表单可访问性。', 'commentary');
    append({ kind: 'tool', id: `${id}:command`, tool: 'command', title: work ? 'npm run check:release' : 'npm run test -- Login',
      detail: work ? 'npm run check:release' : 'npm run test -- Login', status: 'done', exitCode: 0, durationMs: 9000,
      output: work ? '示例命令输出\n✓ 发布清单格式检查通过\n✓ 2 项已完成，1 项待交接\nDuration 9.00s'
        : '示例命令输出\n✓ Login layout test passed\n✓ Tablet breakpoint test passed\n2 tests passed\nDuration 9.00s', turnId, ts: 0 });
    append({ kind: 'tool', id: childId, tool: 'subagent', title: work ? '交付检查' : '界面检查', status: 'done',
      detail: work ? '示例任务：检查发布清单中的遗漏项。' : '示例任务：检查平板断点与表单可访问性。',
      childSessionKeys: [childKey], turnId, ts: 0 });
    // A successful launch alone cannot establish completion for Codex children.
    append({ kind: 'tool', id: `${childId}:result`, tool: 'subagent', title: '示例子任务结果', status: 'done',
      output: work ? '示例检查完成：发布说明与交接仍需处理。' : '示例检查完成：平板断点与表单标签符合预期。',
      childSessionKeys: [childKey], parentId: childId, turnId, ts: 0 });
    append({ kind: 'tool', id: `${id}:image`, tool: 'image_view', title: work ? '查看发布检查清单截图' : '查看平板登录页截图',
      status: 'done', output: '示例图片查看记录；未读取电脑上的实际截图。', turnId, ts: 0 });
    append({ kind: 'tool', id: `${id}:browser`, tool: 'web', title: '打开示例网页', status: 'done',
      browser: { action: 'open', url: 'https://example.com/', pageId: `${scope}:demo-preview` }, turnId, ts: 0 });
    text('result', work ? '发布检查清单已整理完成。平板回归和远程会话检查标记为完成，发布说明与交接仍待处理。你可以查看 `release/checklist.md` 的示例变更。\n\n以上是示例数据，未修改电脑文件。'
      : '登录页布局示例已调整，测试与子任务检查均已完成。你可以查看 `src/auth/login.css` 的变更，或打开网页预览继续检查。\n\n登录流程：\n\n```mermaid\nflowchart LR\n  A[输入账号] --> B{验证通过}\n  B -->|是| C[进入工作区]\n  B -->|否| A\n```\n\n表单宽度按可用空间计算：\n\n$$\nW = \\min(420, W_{available})\n$$\n\n以上是示例数据，未修改电脑文件。', 'final_answer');
    append({ kind: 'turn', id: `${turnId}:end`, turnId, status: 'completed', durationMs: 16_000, ts: 0 });
  }
  return items;
}
