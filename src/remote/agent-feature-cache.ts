import { type AgentFeatures } from './agent-features';
import { readAgentFeatureSnapshot, type AgentFeatureReadOptions } from './agent-feature-sync';
export type { AgentFeatureReadOptions } from './agent-feature-sync';

export const AGENT_FEATURE_CACHE_TTL = 30_000;
const MAX_ENTRIES = 64;
const MAX_CACHE_SIZE = 32 * 1024 * 1024;
export interface AgentFeatureScope {
  pairing: string; device: string; agent: string; source: string;
  account: string; cwd: string; session: string;
}
interface Entry {
  scope: AgentFeatureScope; value?: AgentFeatures; revision?: string; expiresAt: number;
  size?: number;
  flight?: Promise<AgentFeatures>;
}
const keyOf = (scope: AgentFeatureScope) => JSON.stringify([scope.pairing, scope.device, scope.agent, scope.source, scope.account, scope.cwd, scope.session]);
const copy = (value: AgentFeatures): AgentFeatures => ({ ...value, collaborationModes: [...value.collaborationModes], skills: value.skills.map(skill => ({ ...skill })) });
const stale = () => new Error('API 或连接已切换，请重新读取技能');

/** Picker hints only. Native turn submission validates skills independently. */
export class AgentFeatureCache {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = () => Date.now()) {}
  clear(): void { this.entries.clear(); }
  discard(scope: AgentFeatureScope): void { this.entries.delete(keyOf(scope)); }
  invalidate(device: string, agents?: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) if (entry.scope.device === device && (!agents || agents.has(entry.scope.agent))) this.entries.delete(key);
  }
  /** Native metadata changed; retain the last complete baseline for a delta. */
  expire(device: string, agents?: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) if (entry.scope.device === device && (!agents || agents.has(entry.scope.agent))) {
      if (entry.value) this.entries.set(key, { scope: entry.scope, value: entry.value, revision: entry.revision, size: entry.size, expiresAt: 0 });
      else this.entries.delete(key);
    }
  }
  peek(scope: AgentFeatureScope): AgentFeatures | undefined {
    const value = this.entries.get(keyOf(scope))?.value;
    return value ? copy(value) : undefined;
  }
  async read(scope: AgentFeatureScope, fetch: (options: AgentFeatureReadOptions) => Promise<unknown>, force = false): Promise<AgentFeatures> {
    const key = keyOf(scope), previous = this.entries.get(key);
    if (!force && previous?.flight) {
      const value = await previous.flight;
      if (this.entries.get(key) !== previous) throw stale();
      return copy(value);
    }
    if (!force && previous?.value && previous.expiresAt > this.now()) return copy(previous.value);
    // Replacing the entry fences late responses, including a refresh which
    // overtakes an ordinary read. Forced reads never reuse an in-flight read.
    const entry: Entry = { scope: { ...scope }, expiresAt: 0, value: previous?.value, revision: previous?.revision, size: previous?.size };
    this.entries.delete(key); this.entries.set(key, entry);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    const request = Promise.resolve().then(async () => {
      const { value, revision } = await readAgentFeatureSnapshot(fetch, previous, () => { if (this.entries.get(key) !== entry) throw stale(); }, force);
      entry.value = copy(value); entry.revision = revision; entry.expiresAt = this.now() + AGENT_FEATURE_CACHE_TTL;
      entry.size = JSON.stringify(entry.value).length;
      let totalSize = [...this.entries.values()].reduce((sum, item) => sum + (item.size ?? 0), 0);
      for (const [oldKey, old] of this.entries) {
        if (totalSize <= MAX_CACHE_SIZE) break;
        if (oldKey !== key) { this.entries.delete(oldKey); totalSize -= old.size ?? 0; }
      }
      return entry.value;
    });
    entry.flight = request;
    try {
      const value = await request;
      if (this.entries.get(key) !== entry) throw stale();
      return copy(value);
    }
    catch (error) {
      if (this.entries.get(key) === entry) {
        if (previous?.value) this.entries.set(key, { scope: entry.scope, value: previous.value, revision: previous.revision, size: previous.size, expiresAt: 0 });
        else this.entries.delete(key);
      }
      throw error;
    }
    finally { if (entry.flight === request) entry.flight = undefined; }
  }
}
