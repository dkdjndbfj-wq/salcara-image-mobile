import { sessionAgentDisplayName } from '../remote/agent-catalog';

test.each([
  ['codex', '', 'Codex'],
  ['claude', '', 'Claude Code'],
  ['claude', 'Claude Desktop Code', 'Claude Desktop'],
  ['deepseek-harness', '', 'DeepSeek Harness'],
  ['hermes', '', 'Hermes Agent'],
  ['hermes', 'Claude Desktop', 'Hermes Agent'],
  ['deepseek-harness', 'Claude Desktop', 'DeepSeek Harness'],
  ['future-agent', '', 'future-agent'],
])('session tool %s with client %s has the correct display name', (tool, client, expected) => {
  expect(sessionAgentDisplayName({ tool, client })).toBe(expected);
});

test.each([
  ['codex', 'Codex'], ['claude', 'Claude Code'],
  ['deepseek-harness', 'DeepSeek Harness'], ['hermes', 'Hermes Agent'],
])('an event supplies the name before the session directory arrives: %s', (tool, expected) => {
  expect(sessionAgentDisplayName(undefined, tool)).toBe(expected);
});

test.each([undefined, null, '', 'bad\nagent', 'bad\u202Eagent', 'https://example.test', 'x'.repeat(65)])(
  'missing or invalid tool %s stays neutral', tool => {
    expect(sessionAgentDisplayName(undefined, tool)).toBe('Agent');
  },
);
