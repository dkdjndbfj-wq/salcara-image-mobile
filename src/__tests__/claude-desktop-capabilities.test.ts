import { agentSupports, parseAgentStatus, resolveAgentExecution } from '../remote/projection';

const execution = { tool: 'claude', controlSurface: 'cli', entrypoint: 'claude-desktop' };
const advancedControls = [
  'features', 'contextReferences', 'contextAnnotations', 'contextDiffAnnotations',
  'sideQuestion', 'context', 'compact', 'sessionActions',
] as const;
const workerCapabilities = {
  list: true, read: true, send: true, imageOutput: true,
  ...Object.fromEntries(advancedControls.map(capability => [capability, true])),
  approvalModes: ['ask', 'auto_edits', 'auto_all'],
};
const desktopHistory = { available: true, readOnly: true, identity: 'a'.repeat(64), scopes: ['desktop-chat', 'desktop-cowork'] };

function desktopProfile(fields: Record<string, unknown> = {}) {
  return parseAgentStatus({ agents: [{
    id: 'claude-desktop', available: true, remoteSendSupported: true,
    execution, capabilities: workerCapabilities, desktopHistory, ...fields,
  }] }).agents.find(profile => profile.id === 'claude-desktop')!;
}

test('Claude Desktop Code retains the worker controls used by the composer and context menus', () => {
  const profile = desktopProfile();
  expect(resolveAgentExecution(profile)).toEqual(execution);
  expect(profile).toMatchObject({ available: true, remoteSendSupported: true, sessionScope: 'code' });
  for (const capability of advancedControls) {
    expect(profile.capabilities?.[capability]).toBe(true);
    expect(agentSupports(profile, profile.id, capability)).toBe(true);
  }
  expect(profile.capabilities?.approvalModes).toEqual(['ask', 'auto_edits', 'auto_all']);
  expect(profile.desktopHistory).toMatchObject({ readOnly: true, scopes: ['desktop-chat', 'desktop-cowork'] });
});

test('history-only Claude Desktop exposes viewing without Code actions', () => {
  const profile = desktopProfile({ remoteSendSupported: false, capabilities: { list: true, read: true, imageOutput: true } });
  expect(profile.available).toBe(true);
  for (const capability of ['list', 'read', 'imageOutput'] as const) {
    expect(agentSupports(profile, profile.id, capability)).toBe(true);
  }
  for (const capability of ['send', ...advancedControls] as const) {
    expect(agentSupports(profile, profile.id, capability)).toBe(false);
  }
});

test('an invalid Code executor cannot upgrade native Chat/Cowork history to writable capabilities', () => {
  const profile = desktopProfile({ execution: { ...execution, controlSurface: 'desktop' } });
  expect(profile).toMatchObject({ available: true, execution: null, remoteSendSupported: false });
  for (const capability of ['send', ...advancedControls] as const) {
    expect(agentSupports(profile, profile.id, capability)).toBe(false);
  }
  expect(profile.desktopHistory?.readOnly).toBe(true);
});
