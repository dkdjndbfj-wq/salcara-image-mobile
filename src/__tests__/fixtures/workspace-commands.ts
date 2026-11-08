import type { Command } from '../../remote/client';
const scope = { sessionKey: 'codex:workspace', controlSurface: 'cli' as const, expectedCwd: 'C:/workspace' };
export const workspaceCommands: Command[] = [
  { ...scope, type: 'workspace.git.read', action:'review', reviewScope:'branch', reviewRef:'main' },
  { ...scope, type: 'workspace.git.read', action:'review', reviewScope:'last-turn', path:'app.ts', sourceDiff:'@@ -1 +1 @@\n-old\n+new\n' },
  { ...scope, type: 'workspace.git.mutate', action:'review-apply', reviewScope:'unstaged', path:'app.ts', expectedRevision:'a'.repeat(64),patchRevision:'b'.repeat(64),hunk:'c'.repeat(64),operation:'stage' },
  { ...scope, type: 'workspace.files.write', path: 'app.ts', text: 'updated', expectedRevision: 'a'.repeat(64) },
  { ...scope, type: 'workspace.terminal.open', operationId: 'operation-terminal-0001', cols: 80, rows: 24 },
  { ...scope, type: 'workspace.terminal.read', terminalId: 'terminal-0000001', cursor: 0 },
  { ...scope, type: 'workspace.terminal.input', terminalId: 'terminal-0000001', sequence: 1, data: 'pwd\r' },
  { ...scope, type: 'workspace.terminal.resize', terminalId: 'terminal-0000001', cols: 100, rows: 30 },
  { ...scope, type: 'workspace.terminal.close', terminalId: 'terminal-0000001' },
  { ...scope, type: 'workspace.preview.open', operationId: 'operation-preview-0001', url: 'http://localhost:3000/', width: 800, height: 600 },
  { ...scope, type: 'workspace.preview.frame', pageId: 'preview-0000001', capture: true },
  { ...scope, type: 'workspace.preview.input', pageId: 'preview-0000001', sequence: 1, input: { action: 'click', x: 20, y: 30 } },
  { ...scope, type: 'workspace.preview.close', pageId: 'preview-0000001' },
];
