import { MAX_AGENT_FEATURE_BYTES, MAX_AGENT_FEATURE_SKILLS, parseAgentFeatures, skillKey, validSkillReferences, type AgentFeatures, type AgentSkill } from './agent-features';

export interface AgentFeatureReadOptions { force?: boolean; ifRevision?: string; syncVersion?: 1; cursor?: string; pageSize?: number }
export interface FeatureSnapshot { value?: AgentFeatures; revision?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validRevision = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validCursor = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}:[1-9][0-9]{0,4}$/.test(value);
const bounded = (value: unknown, limit: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= limit;
const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const invalid = () => new Error('电脑返回的技能目录分页不完整或版本不匹配');
const needsRestart = (error: unknown) => record(error) && error.code === 'feature_cursor_expired'
  || error instanceof Error && error.message.startsWith('feature_cursor_expired:');

/** Read one immutable transfer. Publish only the completed, validated snapshot. */
export async function readAgentFeatureSnapshot(fetch: (options: AgentFeatureReadOptions) => Promise<unknown>, previous: FeatureSnapshot | undefined,
  assertCurrent: () => void, force: boolean): Promise<Required<Pick<FeatureSnapshot, 'value'>> & Pick<FeatureSnapshot, 'revision'>> {
  let reset = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let options: AgentFeatureReadOptions = { syncVersion: 1, ...(!reset && previous?.revision ? { ifRevision: previous.revision } : {}), ...(force ? { force: true } : {}) };
      let header: string | undefined, revision: string | undefined, kind: 'full' | 'delta' | undefined, offset = 0, bytes = 0;
      let value: AgentFeatures | undefined, skills: Map<string, AgentSkill> | undefined;
      const seen = new Set<string>(), cursors = new Set<string>();
      for (let pages = 0; pages <= 2 * MAX_AGENT_FEATURE_SKILLS; pages++) {
        assertCurrent(); const result = await fetch(options); assertCurrent();
        if (!record(result)) throw invalid();
        const pageBytes = encodedBytes(result);
        if (result.notModified === true) {
          if (header || reset || !previous?.value || !previous.revision || result.revision !== previous.revision) throw invalid();
          return { value: previous.value, revision: previous.revision };
        }
        if (result.syncVersion === undefined) {
          if (header || pageBytes > MAX_AGENT_FEATURE_BYTES || ['nextCursor', 'kind', 'baseRevision', 'offset', 'removedSkills'].some(key => key in result)) throw invalid();
          return { value: parseAgentFeatures(result), revision: validRevision(result.revision) ? result.revision : undefined };
        }
        if (result.syncVersion !== 1 || !validRevision(result.revision) || result.kind !== 'full' && result.kind !== 'delta'
          || !bounded(result.totalSkills, MAX_AGENT_FEATURE_SKILLS) || !bounded(result.totalChanges, 2 * MAX_AGENT_FEATURE_SKILLS)
          || !bounded(result.offset, 2 * MAX_AGENT_FEATURE_SKILLS) || result.offset !== offset || !Array.isArray(result.removedSkills)
          || !Array.isArray(result.skills) || result.skills.length + result.removedSkills.length > 200 || pageBytes > 256 * 1024
          || result.nextCursor !== undefined && !validCursor(result.nextCursor)) throw invalid();
        const parsed = parseAgentFeatures(result, true);
        if (result.kind === 'full' && (result.baseRevision !== undefined || result.removedSkills.length || result.totalChanges !== result.totalSkills)) throw invalid();
        if (result.kind === 'delta' && result.baseRevision === result.revision) throw invalid();
        if (result.kind === 'delta' && (!validRevision(result.baseRevision) || !previous?.value || result.baseRevision !== previous.revision)) {
          if (!header && !reset) { reset = true; break; }
          throw invalid();
        }
        const identity = JSON.stringify([result.kind, result.revision, result.baseRevision, result.totalSkills, result.totalChanges, parsed.skillsSupported, parsed.collaborationModes]);
        if (header && header !== identity) throw invalid();
        if (!header) {
          header = identity; revision = result.revision; kind = result.kind;
          value = { collaborationModes: parsed.collaborationModes, skillsSupported: parsed.skillsSupported, skills: [] };
          skills = new Map((kind === 'delta' ? previous!.value!.skills : []).map(skill => [skillKey(skill), { ...skill }]));
        }
        for (const skill of parsed.skills) {
          const key = skillKey(skill); if (seen.has(key)) throw invalid(); seen.add(key); skills!.set(key, skill);
        }
        for (const raw of result.removedSkills) {
          // Removal identity is only name + path. A newer Bridge may attach
          // display or audit metadata to the tombstone; ignore it after
          // bounding the object instead of invalidating the whole transfer.
          if (!record(raw) || Object.keys(raw).length > 64 || typeof raw.name !== 'string'
            || raw.path !== undefined && typeof raw.path !== 'string' || !validSkillReferences([{ name: raw.name, ...(raw.path !== undefined ? { path: raw.path } : {}) }])) throw invalid();
          const identity: AgentSkill = { name: raw.name, description: '', ...(raw.path !== undefined ? { path: raw.path as string } : {}) };
          const key = skillKey(identity); if (seen.has(key) || !skills!.has(key)) throw invalid(); seen.add(key); skills!.delete(key);
        }
        offset += parsed.skills.length + result.removedSkills.length; bytes += pageBytes;
        // Upserts precede removals; replacing a full catalog can temporarily
        // contain both generations. Enforce the final count at commit time.
        if (offset > result.totalChanges || bytes > 2 * MAX_AGENT_FEATURE_BYTES || skills!.size > 2 * MAX_AGENT_FEATURE_SKILLS) throw invalid();
        if (result.nextCursor === undefined) {
          if (offset !== result.totalChanges || skills!.size !== result.totalSkills || !value!.skillsSupported && skills!.size) throw invalid();
          value!.skills = [...skills!.values()].sort((a, b) => { const left = skillKey(a), right = skillKey(b); return left < right ? -1 : left > right ? 1 : 0; });
          if (encodedBytes(value) > MAX_AGENT_FEATURE_BYTES) throw invalid();
          return { value: value!, revision };
        }
        if (offset >= result.totalChanges || parsed.skills.length + result.removedSkills.length === 0 || cursors.has(result.nextCursor)) throw invalid();
        cursors.add(result.nextCursor); options = { syncVersion: 1, cursor: result.nextCursor };
      }
      if (!reset || attempt > 0) throw invalid();
    } catch (error) {
      assertCurrent();
      if (attempt === 0 && needsRestart(error)) { reset = true; continue; }
      throw error;
    }
  }
  throw invalid();
}
