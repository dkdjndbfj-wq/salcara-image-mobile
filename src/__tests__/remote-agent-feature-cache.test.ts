import { AgentFeatureCache, AGENT_FEATURE_CACHE_TTL, type AgentFeatureScope } from '../remote/agent-feature-cache';

const scope: AgentFeatureScope = { pairing: 'pair-a', device: 'pc-a', agent: 'codex', source: 'native-codex', account: 'account-a', cwd: '/project-a', session: 'codex:a' };
const revision = 'a'.repeat(64);
const catalog = (name = 'review', rev = revision) => ({ revision: rev, collaborationModes: ['default', 'plan'], skillsSupported: true, skills: [{ name, path: '/skill', description: name }] });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('full catalog is reused until TTL then verified conditionally without losing fields', async () => {
  let now = 0; const cache = new AgentFeatureCache(() => now), fetch = jest.fn().mockResolvedValueOnce(catalog()).mockResolvedValueOnce({ notModified: true, revision });
  const original = await cache.read(scope, fetch); original.skills[0].name = 'caller mutation';
  expect((await cache.read(scope, fetch)).skills[0].name).toBe('review');
  expect(fetch).toHaveBeenCalledTimes(1);
  now = AGENT_FEATURE_CACHE_TTL;
  expect(cache.peek(scope)?.skills[0].name).toBe('review');
  expect((await cache.read(scope, fetch)).skills[0].name).toBe('review');
  expect(fetch.mock.calls).toEqual([[{ syncVersion: 1 }], [{ syncVersion: 1, ifRevision: revision }]]);
});

test.each(Object.keys(scope) as Array<keyof AgentFeatureScope>)('catalog isolation includes %s', async field => {
  const cache = new AgentFeatureCache(), fetch = jest.fn().mockResolvedValue(catalog());
  await cache.read(scope, fetch);
  const changed = { ...scope, [field]: `${scope[field]}-other` };
  expect(cache.peek(changed)).toBeUndefined();
  await cache.read(changed, fetch); expect(fetch).toHaveBeenCalledTimes(2);
});

test('concurrent reads share one discovery; force supersedes it and late reads cannot overwrite', async () => {
  const cache = new AgentFeatureCache(), first = deferred<unknown>(), fetch = jest.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(catalog('updated', 'b'.repeat(64)));
  const old = cache.read(scope, fetch), shared = cache.read(scope, fetch);
  const failures = Promise.all([expect(old).rejects.toThrow('已切换'), expect(shared).rejects.toThrow('已切换')]);
  await Promise.resolve();
  expect((await cache.read(scope, fetch, true)).skills[0].name).toBe('updated');
  first.resolve(catalog()); await failures;
  expect(fetch.mock.calls).toEqual([[{ syncVersion: 1 }], [{ syncVersion: 1, force: true }]]);
  expect(cache.peek(scope)?.skills[0].name).toBe('updated');
});

test.each(['clear', 'invalidate'] as const)('%s retires in-flight work and cannot republish after account changes', async operation => {
  const cache = new AgentFeatureCache(), pending = deferred<unknown>(), read = cache.read(scope, () => pending.promise);
  const failed = expect(read).rejects.toThrow('已切换'); await Promise.resolve();
  if (operation === 'clear') cache.clear(); else cache.invalidate(scope.device, new Set([scope.agent]));
  pending.resolve(catalog()); await failed; expect(cache.peek(scope)).toBeUndefined();
});

test('a refresh reconciles additions, removals and modifications using the complete native result', async () => {
  let now = 0; const cache = new AgentFeatureCache(() => now);
  await cache.read(scope, async () => ({ ...catalog(), skills: [{ name: 'removed', description: '' }, { name: 'changed', description: 'old' }] }));
  now += AGENT_FEATURE_CACHE_TTL;
  const updated = await cache.read(scope, async () => ({ ...catalog(), revision: 'b'.repeat(64), skills: [{ name: 'changed', description: 'new' }, { name: 'added', description: '' }] }));
  expect(updated.skills.map(skill => [skill.name, skill.description])).toEqual([['changed', 'new'], ['added', '']]);
});

test('legacy full responses work; failed refreshes retain only the last complete expired directory', async () => {
  const cache = new AgentFeatureCache();
  await cache.read(scope, async () => ({ ...catalog(), revision: undefined }));
  const fetch = jest.fn().mockResolvedValue({ notModified: true, revision });
  await expect(cache.read(scope, fetch, true)).rejects.toThrow('不匹配');
  expect(cache.peek(scope)?.skills[0].name).toBe('review');
  await expect(cache.read(scope, async () => { throw new Error('account deleted'); })).rejects.toThrow('account deleted');
  expect(cache.peek(scope)?.skills[0].name).toBe('review');
  cache.invalidate(scope.device); expect(cache.peek(scope)).toBeUndefined();
});

test('conditional responses must match the exact saved revision', async () => {
  let now = 0; const cache = new AgentFeatureCache(() => now);
  await cache.read(scope, async () => catalog()); now += AGENT_FEATURE_CACHE_TTL;
  await expect(cache.read(scope, async () => ({ notModified: true, revision: 'b'.repeat(64) }))).rejects.toThrow('不匹配');
  expect(cache.peek(scope)?.skills[0].name).toBe('review');
});

test('catalog memory is bounded across many projects', async () => {
  const cache = new AgentFeatureCache();
  for (let i = 0; i < 65; i++) await cache.read({ ...scope, cwd: `/project-${i}` }, async () => catalog());
  expect(cache.peek({ ...scope, cwd: '/project-0' })).toBeUndefined();
  expect(cache.peek({ ...scope, cwd: '/project-64' })).toBeDefined();
});
