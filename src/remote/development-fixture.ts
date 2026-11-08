/**
 * Local-only fixture for reviewing the remote programming UI while the Hub
 * and desktop pairing flow are still under development. It deliberately does
 * not enter the remote store or persist a credential.
 */
export const SIMULATED_REMOTE_COMPUTER_ENABLED = true;
export const SIMULATED_REMOTE_DEVICE_ID = 'development-preview-pc';
import type { AgentCapabilities, AgentProfile, DeviceStatus, SessionInfo } from './client';

const extensionCapabilities: AgentCapabilities = {
  list: true, read: true, send: true, interrupt: true, preciseInterrupt: true, approval: true,
  questions: false, subagents: false, attachments: false, imageInput: false, imageOutput: false, modelOverride: false,
};

export const SIMULATED_REMOTE_DEVICE_NAME = 'Salcara 开发电脑';
export const SIMULATED_REMOTE_DEVICE: DeviceStatus = {
  deviceId: SIMULATED_REMOTE_DEVICE_ID,
  name: SIMULATED_REMOTE_DEVICE_NAME,
  os: 'windows',
  online: true,
  lastSeen: Date.now(),
  tools: [
    { id: 'codex', name: 'Codex', available: true },
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'deepseek-harness', name: 'DeepSeek Harness', available: true },
    { id: 'hermes', name: 'Hermes Agent', available: true },
  ],
  projects: [
    { name: 'salcara-web', path: 'D:\\Projects\\salcara-web' },
    { name: 'remote-bridge', path: 'D:\\Projects\\remote-bridge' },
    { name: 'product-planning', path: 'D:\\Work\\product-planning' },
    { name: 'release-operations', path: 'D:\\Work\\release-operations' },
  ],
};
export const SIMULATED_REMOTE_AGENTS: AgentProfile[] = [
  { id: 'codex', name: 'Codex', tool: 'codex', available: true, remoteSendSupported: true, api: { name: 'Codex 开发 API', model: 'gpt-5.2', protocol: 'responses', configured: true, pending: false, source: 'computer' } },
  { id: 'claude', name: 'Claude Code', tool: 'claude', available: true, remoteSendSupported: true, api: { name: 'Claude Code 开发 API', model: 'Claude Sonnet 4.5', protocol: 'messages', configured: true, pending: false, source: 'computer' } },
  { id: 'claude-desktop', name: 'Claude Desktop', tool: 'claude', available: true, remoteSendSupported: true, api: { name: 'Claude Desktop 开发 API', model: 'Claude Sonnet 4.5', protocol: 'messages', configured: true, pending: false, source: 'computer' } },
  { id: 'deepseek-harness', name: 'DeepSeek Harness', tool: 'deepseek-harness', available: true, remoteSendSupported: true,
    execution: { tool: 'deepseek-harness', controlSurface: 'cli' }, capabilities: { ...extensionCapabilities, modelOverride: true },
    api: { name: 'DeepSeek 开发 API', model: 'deepseek-chat', protocol: 'chat', configured: true, pending: false, source: 'computer' } },
  { id: 'hermes', name: 'Hermes Agent', tool: 'hermes', available: true, remoteSendSupported: true,
    execution: { tool: 'hermes', controlSurface: 'cli' }, capabilities: { ...extensionCapabilities, startModelOverride: true },
    api: { name: 'Hermes 开发 API', model: '示例模型', protocol: 'chat', configured: true, pending: false, source: 'computer' } },
];

export function simulatedAgentsWithApi(assignments: Record<string, string>): AgentProfile[] {
  return SIMULATED_REMOTE_AGENTS.map(agent => {
    const target = SIMULATED_REMOTE_AGENTS.find(item => `preview-${item.id}` === assignments[agent.id]);
    return target ? { ...agent, api: { ...agent.api, name: target.api.name, model: target.api.model,
      accountId: `preview-${target.id}`, source: 'phone' } }
      : { ...agent, api: { ...agent.api, accountId: `preview-${agent.id}` } };
  });
}
export const SIMULATED_REMOTE_SESSIONS: SessionInfo[] = [
  { sessionKey: 'codex:simulated-login', tool: 'codex', client: 'Codex App', title: '修复登录页平板布局', cwd: 'D:\\Projects\\salcara-web', workspaceMode: 'code', updatedAt: Date.now(), status: 'idle', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'codex:simulated-tabs', tool: 'codex', client: 'Codex App', title: '整理工作区工具标签', cwd: 'D:\\Projects\\salcara-web', workspaceMode: 'code', updatedAt: Date.now() - 60_000, status: 'running', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'codex:simulated-reconnect', tool: 'codex', client: 'Codex App', title: '检查设备重连流程', cwd: 'D:\\Projects\\remote-bridge', workspaceMode: 'code', updatedAt: Date.now() - 120_000, status: 'waiting_approval', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'codex:simulated-events', tool: 'codex', client: 'Codex App', title: '补齐会话事件同步', cwd: 'D:\\Projects\\remote-bridge', workspaceMode: 'code', updatedAt: Date.now() - 180_000, status: 'idle', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'codex:simulated-work', tool: 'codex', client: 'Codex App', title: '准备平板发布检查清单', cwd: 'D:\\Work\\release-operations', workspaceMode: 'work', updatedAt: Date.now() - 1_800_000, status: 'idle', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'codex:simulated-qa', tool: 'codex', client: 'Codex App', title: '跟进测试反馈', cwd: 'D:\\Work\\release-operations', workspaceMode: 'work', updatedAt: Date.now() - 1_860_000, status: 'running', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'codex:simulated-plan', tool: 'codex', client: 'Codex App', title: '整理下一版产品计划', cwd: 'D:\\Work\\product-planning', workspaceMode: 'work', updatedAt: Date.now() - 1_920_000, status: 'waiting_approval', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'codex:simulated-handoff', tool: 'codex', client: 'Codex App', title: '整理本周交接事项', cwd: 'D:\\Work\\product-planning', workspaceMode: 'work', updatedAt: Date.now() - 1_980_000, status: 'idle', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'claude:simulated-api', tool: 'claude', client: 'Claude Code', title: '整理 API 错误处理', cwd: 'D:\\Projects\\salcara-web', workspaceMode: 'code', updatedAt: Date.now() - 3_600_000, status: 'idle', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'claude:simulated-work', tool: 'claude', client: 'Claude Code', title: '准备发布检查清单', cwd: 'D:\\Work\\release-operations', workspaceMode: 'work', updatedAt: Date.now() - 7_200_000, status: 'idle', controllable: true, controlSurface: 'cli' },
  { sessionKey: 'claude-desktop:simulated-history', tool: 'claude', client: 'Claude Desktop', title: '整理桌面端设计反馈', cwd: 'D:\\Work\\product-planning', workspaceMode: 'work', updatedAt: Date.now() - 5_400_000, status: 'idle', controllable: true, controlSurface: 'read-only', sessionScope: 'desktop-chat' },
];

// Each installed Agent has its own projects and sessions in both entry modes.
// These statuses are intentionally local examples, never copied into the remote store.
for (const agent of SIMULATED_REMOTE_AGENTS.filter(item => item.id !== 'codex')) {
  const client = agent.name;
  const controlSurface = agent.id === 'claude-desktop' ? 'read-only' : 'cli';
  for (const mode of ['code', 'work'] as const) {
    const projects = mode === 'code' ? SIMULATED_REMOTE_DEVICE.projects.slice(0, 2) : SIMULATED_REMOTE_DEVICE.projects.slice(2);
    for (const [projectIndex, project] of projects.entries()) {
      const existing = SIMULATED_REMOTE_SESSIONS.filter(session => session.client === client && session.workspaceMode === mode && session.cwd === project.path).length;
      for (let index = existing; index < 2; index++) SIMULATED_REMOTE_SESSIONS.push({
        sessionKey: `${agent.id}:simulated-${mode}-${projectIndex}-${index}`, tool: agent.tool, client,
        title: mode === 'code' ? `${index ? '检查' : '整理'}${projectIndex ? '连接与同步' : '界面与交互'}` : `${index ? '跟进' : '准备'}${projectIndex ? '产品计划' : '发布事项'}`,
        cwd: project.path, workspaceMode: mode, updatedAt: Date.now() - (projectIndex + index + 1) * 3_600_000,
        status: index === 0 ? 'running' : 'idle', controllable: true, controlSurface,
        ...(agent.id === 'claude-desktop' && mode === 'work' ? { sessionScope: 'desktop-chat' as const } : {}),
      });
    }
  }
}

export function isSimulatedRemoteDevice(deviceId: string | null | undefined): boolean {
  return deviceId === SIMULATED_REMOTE_DEVICE_ID;
}
