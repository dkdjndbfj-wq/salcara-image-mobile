import { parseNativeSessionActions, parseNativeSessionActionResult, validSessionName } from '../remote/session-actions';
import { agentSupports, agentSessions } from '../remote/projection';
import type { SessionInfo } from '../remote/client';

const key = 'codex:s', op = '11111111-2222-4333-8444-555555555555';
const catalog = { sessionKey: key, title: '原名称', revision: 'r1', archived: false, actions: ['rename', 'archive', 'fork'] };
const session = { sessionKey: 'codex:new', tool: 'codex', title: '分支', client: 'Codex', cwd: 'C:/work', updatedAt: 1, status: 'idle', controllable: false };
test('native actions require explicit capability and retain a real archive distinction', () => {
  expect(agentSupports(undefined, 'codex', 'sessionActions')).toBe(false);
  expect(agentSupports(undefined, 'codex', 'archivedSessions')).toBe(false);
  expect(parseNativeSessionActions(catalog, key)).toEqual(catalog);
  expect(parseNativeSessionActions({ ...catalog, archived: true, actions: ['unarchive'] }, key)?.archived).toBe(true);
  expect(agentSessions([{ ...session, archived: true }, { ...session, sessionKey: key }] as SessionInfo[], { tool: 'codex' })).toHaveLength(1);
});
test.each([
  { sessionKey: 'claude:s' }, { revision: '' }, { revision: 'a b' }, { actions: ['rename', 'rename'] },
  { actions: ['review'] }, { actions: ['unarchive'] }, { archived: true }, { archived: 'false' }, { title: '\u202e' },
])('rejects a malformed or foreign native catalog %j', change => {
  expect(parseNativeSessionActions({ ...catalog, ...change }, key)).toBeUndefined();
});
test('unknown/old runtime has no invented actions', () => {
  expect(parseNativeSessionActions({ ...catalog, revision: '', actions: [], unavailableReason: '当前版本不支持' }, key)?.actions).toEqual([]);
});
test.each(['', ' title', 'title ', 'line\nnext', '\u202e名称', '中'.repeat(81)])('rejects invalid native title %j', value => expect(validSessionName(value)).toBe(false));
test('uses Unicode code points for the native title limit', () => { expect(validSessionName('中'.repeat(80))).toBe(true); expect(validSessionName('😀'.repeat(80))).toBe(true); });
const result = { sessionKey: key, action: 'fork', operationId: op, state: 'completed', session };
test('fork success must identify a new native session in the same tool', () => {
  expect(parseNativeSessionActionResult(result, key, 'fork', op)?.session?.sessionKey).toBe('codex:new');
  for (const change of [{ session: undefined }, { session: { ...session, sessionKey: key } }, { session: { ...session, sessionKey: 'claude:new' } }, { session: { ...session, controlSurface: 'desktop' } }, { operationId: 'other' }]) {
    expect(parseNativeSessionActionResult({ ...result, ...change }, key, 'fork', op)).toBeUndefined();
  }
  expect(parseNativeSessionActionResult({ ...result, state: 'unconfirmed', session: undefined }, key, 'fork', op)?.state).toBe('unconfirmed');
});
test('archive and restore acknowledgements cannot reverse the observed state', () => {
  expect(parseNativeSessionActionResult({ ...result, action: 'archive', session: { ...session, sessionKey: key } }, key, 'archive', op)).toBeUndefined();
  expect(parseNativeSessionActionResult({ ...result, action: 'unarchive', session: { ...session, sessionKey: key, archived: true } }, key, 'unarchive', op)).toBeUndefined();
});
