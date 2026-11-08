import { AgentFeatureCache, AGENT_FEATURE_CACHE_TTL, type AgentFeatureScope } from '../remote/agent-feature-cache';
import { MAX_AGENT_FEATURE_SKILLS, parseAgentFeatures } from '../remote/agent-features';

const scope: AgentFeatureScope = { pairing: 'pair', device: 'pc', agent: 'codex', source: 'native', account: 'account', cwd: '/project', session: '' };
const oldRevision = 'a'.repeat(64), newRevision = 'b'.repeat(64);
const cursor = (offset: number) => `${'c'.repeat(32)}:${offset}`;
const skill = (name: string, description = name) => ({ name, description });
const baseline = () => ({ revision: oldRevision, collaborationModes: ['default', 'plan'], skillsSupported: true,
  skills: [skill('unchanged'), skill('changed', 'old'), skill('removed')] });
const page = (override: Record<string, unknown> = {}) => ({ syncVersion: 1, kind: 'delta', revision: newRevision, baseRevision: oldRevision,
  collaborationModes: ['default', 'plan'], skillsSupported: true, skills: [], removedSkills: [], totalSkills: 3, totalChanges: 0, offset: 0, ...override });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('delta pages merge additions edits and deletions atomically and retain unchanged rows', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  const last = deferred<unknown>(), started = deferred<void>();
  const fetch = jest.fn().mockResolvedValueOnce(page({ skills: [skill('added'), skill('changed', 'new')], totalChanges: 3, nextCursor: cursor(2) }))
    .mockImplementationOnce(() => { started.resolve(); return last.promise; });
  const reading = cache.read(scope, fetch); await started.promise;
  expect(cache.peek(scope)?.skills).toEqual(baseline().skills);
  last.resolve(page({ removedSkills: [{ name: 'removed' }], totalChanges: 3, offset: 2 }));
  expect((await reading).skills).toEqual([skill('added'), skill('changed', 'new'), skill('unchanged')]);
  expect(fetch.mock.calls).toEqual([[{ syncVersion: 1, ifRevision: oldRevision }], [{ syncVersion: 1, cursor: cursor(2) }]]);
});

test('full initial sync follows all pages beyond the old 1000 row limit', async () => {
  const cache = new AgentFeatureCache(), all = Array.from({ length: 1205 }, (_, i) => skill(`skill-${String(i).padStart(4, '0')}`));
  let offset = 0;
  const fetch = jest.fn(async () => {
    const start = offset; offset = Math.min(offset + 200, all.length);
    return page({ kind: 'full', baseRevision: undefined, skills: all.slice(start, offset), totalSkills: all.length, totalChanges: all.length,
      offset: start, ...(offset < all.length ? { nextCursor: cursor(offset) } : {}) });
  });
  expect((await cache.read(scope, fetch)).skills).toEqual(all); expect(fetch).toHaveBeenCalledTimes(7);
});

test('deleting every skill also updates availability and collaboration modes', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  const value = await cache.read(scope, async () => page({ skillsSupported: false, collaborationModes: ['plan'], totalSkills: 0,
    totalChanges: 3, removedSkills: baseline().skills.map(({ name }) => ({ name })) }));
  expect(value).toEqual({ skills: [], skillsSupported: false, collaborationModes: ['plan'] });
});

test('metadata-only changes do not need to retransmit unchanged skills', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  const value = await cache.read(scope, async () => page({ collaborationModes: ['default'] }));
  expect(value.collaborationModes).toEqual(['default']); expect(value.skills).toHaveLength(3);
});

test('additive Bridge metadata and unknown collaboration modes do not break a feature page', async () => {
  const cache = new AgentFeatureCache();
  const value = await cache.read(scope, async () => page({
    kind: 'full', baseRevision: undefined,
    collaborationModes: ['default', 'plan', 'future-mode'],
    skills: [{ ...skill('new'), category: 'review', updatedAt: 123 }],
    totalChanges: 1, totalSkills: 1,
  }));
  expect(value.collaborationModes).toEqual(['default', 'plan']);
  expect(value.skills).toEqual([skill('new')]);
});

test('additive tombstone metadata does not prevent removal', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  const value = await cache.read(scope, async () => page({
    removedSkills: [{ name: 'removed', path: undefined, reason: 'disabled', removedAt: 123 }],
    totalChanges: 1, totalSkills: 2,
  }));
  expect(value.skills.map(item => item.name)).toEqual(['changed', 'unchanged']);
});

test('missing delta baseline restarts once as a full sync instead of guessing', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  const fetch = jest.fn().mockResolvedValueOnce(page({ baseRevision: 'd'.repeat(64) }))
    .mockResolvedValueOnce(page({ kind: 'full', baseRevision: undefined, skills: [skill('fresh')], totalSkills: 1, totalChanges: 1 }));
  expect((await cache.read(scope, fetch)).skills).toEqual([skill('fresh')]);
  expect(fetch.mock.calls).toEqual([[{ syncVersion: 1, ifRevision: oldRevision }], [{ syncVersion: 1 }]]);
});

test('expired transfer retries with a full snapshot once and never commits its partial delta', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  const fetch = jest.fn().mockResolvedValueOnce(page({ skills: [skill('added')], totalSkills: 4, totalChanges: 2, nextCursor: cursor(1) }))
    .mockRejectedValueOnce(new Error('feature_cursor_expired: restart'))
    .mockResolvedValueOnce(page({ kind: 'full', baseRevision: undefined, skills: [skill('fresh')], totalSkills: 1, totalChanges: 1 }));
  expect((await cache.read(scope, fetch)).skills).toEqual([skill('fresh')]);
  expect(fetch.mock.calls[2]).toEqual([{ syncVersion: 1 }]);
});

test.each([
  { totalChanges: 1 }, { totalSkills: 2 }, { offset: 1 }, { totalSkills: MAX_AGENT_FEATURE_SKILLS + 1 },
  { skills: [skill('same'), skill('same')], totalChanges: 2 },
  { removedSkills: [{ name: 'missing' }], totalChanges: 1 },
  { removedSkills: [{ name: 'removed', description: 'not an identity' }], totalChanges: 1 },
  { skills: [skill('bad name')], totalChanges: 1 }, { nextCursor: cursor(1) },
  { syncVersion: 2 }, { syncVersion: undefined }, { revision: 'bad' }, { revision: oldRevision }, { kind: 'full', baseRevision: undefined, totalChanges: 0 },
])('malformed or incomplete sync rejects without changing the last good directory: %j', async invalid => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  await expect(cache.read(scope, async () => page(invalid))).rejects.toThrow();
  expect(cache.peek(scope)?.skills).toEqual(baseline().skills);
});

test('mixed revisions and duplicate operations across pages never publish', async () => {
  for (const final of [page({ revision: 'e'.repeat(64), totalChanges: 2, offset: 1, skills: [skill('changed', 'new')] }),
    page({ totalChanges: 2, offset: 1, skills: [skill('changed', 'again')] })]) {
    const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
    const fetch = jest.fn().mockResolvedValueOnce(page({ totalChanges: 2, skills: [skill('changed', 'new')], nextCursor: cursor(1) })).mockResolvedValueOnce(final);
    await expect(cache.read(scope, fetch)).rejects.toThrow(); expect(cache.peek(scope)?.skills).toEqual(baseline().skills);
  }
});

test('connection invalidation during a page fences all late state and does not resurrect the baseline', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  const pending = deferred<unknown>(), started = deferred<void>();
  const fetch = jest.fn().mockResolvedValueOnce(page({ totalChanges: 2, skills: [skill('changed', 'new')], nextCursor: cursor(1) }))
    .mockImplementationOnce(() => { started.resolve(); return pending.promise; });
  const reading = cache.read(scope, fetch); const rejected = expect(reading).rejects.toThrow('已切换'); await started.promise;
  cache.invalidate(scope.device); pending.resolve(page({ totalChanges: 2, offset: 1, skills: [skill('unchanged', 'now changed')] }));
  await rejected; expect(cache.peek(scope)).toBeUndefined();
});

test('newer refresh wins while an older delta is still paging', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline()); cache.expire(scope.device);
  const pending = deferred<unknown>(), started = deferred<void>();
  const oldFetch = jest.fn().mockResolvedValueOnce(page({ totalChanges: 2, skills: [skill('changed', 'new')], nextCursor: cursor(1) }))
    .mockImplementationOnce(() => { started.resolve(); return pending.promise; });
  const old = cache.read(scope, oldFetch), rejected = expect(old).rejects.toThrow('已切换'); await started.promise;
  await cache.read(scope, async () => ({ ...baseline(), revision: 'f'.repeat(64), skills: [skill('newest')] }), true);
  pending.resolve(page({ totalChanges: 2, offset: 1, skills: [skill('unchanged', 'late')] })); await rejected;
  expect(cache.peek(scope)?.skills).toEqual([skill('newest')]);
});

test('force asks native refresh but still transfers only a matching revision result', async () => {
  const cache = new AgentFeatureCache(); await cache.read(scope, async () => baseline());
  const fetch = jest.fn(async () => ({ notModified: true, revision: oldRevision }));
  expect((await cache.read(scope, fetch, true)).skills).toEqual(baseline().skills);
  expect(fetch).toHaveBeenCalledWith({ syncVersion: 1, force: true, ifRevision: oldRevision });
});

test('TTL and native change events retain the revision while credentials still discard it', async () => {
  let now = 0; const cache = new AgentFeatureCache(() => now); await cache.read(scope, async () => baseline());
  now = AGENT_FEATURE_CACHE_TTL; cache.expire(scope.device);
  const fetch = jest.fn(async () => ({ notModified: true, revision: oldRevision })); await cache.read(scope, fetch);
  expect(fetch).toHaveBeenCalledWith({ syncVersion: 1, ifRevision: oldRevision });
  cache.invalidate(scope.device); expect(cache.peek(scope)).toBeUndefined();
});

test('large replacement permits both generations while paging then commits only final skills', async () => {
  const cache = new AgentFeatureCache();
  const before = Array.from({ length: MAX_AGENT_FEATURE_SKILLS }, (_, i) => skill(`old-${i}`));
  const after = Array.from({ length: MAX_AGENT_FEATURE_SKILLS }, (_, i) => skill(`new-${String(i).padStart(5, '0')}`));
  await cache.read(scope, async () => ({ ...baseline(), skills: before })); cache.expire(scope.device);
  let offset = 0;
  const value = await cache.read(scope, async () => {
    const start = offset; offset += 200;
    return page({ offset: start, totalChanges: 2 * MAX_AGENT_FEATURE_SKILLS, totalSkills: MAX_AGENT_FEATURE_SKILLS,
      skills: start < MAX_AGENT_FEATURE_SKILLS ? after.slice(start, offset) : [],
      removedSkills: start >= MAX_AGENT_FEATURE_SKILLS ? before.slice(start - MAX_AGENT_FEATURE_SKILLS, offset - MAX_AGENT_FEATURE_SKILLS).map(({ name }) => ({ name })) : [],
      ...(offset < 2 * MAX_AGENT_FEATURE_SKILLS ? { nextCursor: cursor(offset) } : {}) });
  });
  expect(value.skills).toEqual(after);
});

test('legacy parser preserves rows beyond 1000 and fails explicitly at the resource bound', () => {
  expect(parseAgentFeatures({ ...baseline(), skills: Array.from({ length: 1001 }, (_, i) => skill(`skill-${i}`)) }).skills).toHaveLength(1001);
  expect(() => parseAgentFeatures({ ...baseline(), skills: Array.from({ length: MAX_AGENT_FEATURE_SKILLS + 1 }, (_, i) => skill(`skill-${i}`)) })).toThrow('上限');
});

test('Chinese and emoji descriptions preserve the native 4000 rune budget without splitting surrogate pairs', async () => {
  const cache = new AgentFeatureCache(), description = '中文😀'.repeat(1333) + '😀';
  const value = await cache.read(scope, async () => page({ kind: 'full', baseRevision: undefined, totalChanges: 1, totalSkills: 1, skills: [skill('review', description)] }));
  expect(value.skills[0].description).toBe(description);
  expect(parseAgentFeatures({ ...baseline(), skills: [skill('review', description + 'x')] }).skills[0].description).toBe(description);
});
