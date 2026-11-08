import { isCollaborationMode, skillKey, validSkillReferences, type CollaborationMode, type SkillReference } from './agent-features';
import { copyContextReferences, validContextReferences, type ContextReference } from './context-references';
import type { SkillMention } from './skill-mentions';
import { copySkillReference as copySkill } from './skill-display-metadata';

/** Runtime identities are opaque and exact. A Claude Code skill must never be
 * reinterpreted as a Codex or native desktop skill, even at the same path. */
export interface ComposerFeatureSource {
  scope: string;
  deviceId: string;
  tool: 'codex' | 'claude';
  runtimeId: string;
  surface: 'cli' | 'desktop';
  apiIdentity: string;
  cwd: string;
}

export interface ComposerFeatureIntent {
  version: 1;
  source: ComposerFeatureSource;
  collaborationMode?: CollaborationMode;
  skills?: SkillReference[];
  mentions?: SkillMention[];
  contextReferences?: ContextReference[];
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).every(key => fields.includes(key));
const safeIdentity = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0
  && value.length <= limit && value.trim() === value && !/[\r\n\0]/u.test(value);
const boundary = (text: string, position: number) => position < 0 || position >= text.length || /\s/u.test(text[position]);

export function isComposerFeatureSource(value: unknown): value is ComposerFeatureSource {
  return record(value) && exactFields(value, ['scope', 'deviceId', 'tool', 'runtimeId', 'surface', 'apiIdentity', 'cwd'])
    && safeIdentity(value.scope, 4096) && safeIdentity(value.deviceId, 256)
    && (value.tool === 'codex' || value.tool === 'claude') && safeIdentity(value.runtimeId, 4096)
    && (value.surface === 'cli' || value.surface === 'desktop')
    && safeIdentity(value.apiIdentity, 16_384) && safeIdentity(value.cwd, 4096);
}

export function sameComposerFeatureSource(left: ComposerFeatureSource, right: ComposerFeatureSource): boolean {
  return isComposerFeatureSource(left) && isComposerFeatureSource(right)
    && left.scope === right.scope && left.deviceId === right.deviceId && left.tool === right.tool
    && left.runtimeId === right.runtimeId && left.surface === right.surface && left.apiIdentity === right.apiIdentity && left.cwd === right.cwd;
}

/** Invalid metadata is an unreadable draft, never a plain-text downgrade.
 * Ranges identify the selected occurrence, so literal same-name text remains text. */
export function isComposerFeatureIntent(value: unknown, text: string): value is ComposerFeatureIntent {
  if (!record(value) || !exactFields(value, ['version', 'source', 'collaborationMode', 'skills', 'mentions', 'contextReferences'])
    || value.version !== 1 || !isComposerFeatureSource(value.source)
    || value.collaborationMode !== undefined && !isCollaborationMode(value.collaborationMode)
    || value.skills !== undefined && !validSkillReferences(value.skills)
    || value.contextReferences !== undefined && !validContextReferences(value.contextReferences)
    || value.mentions !== undefined && !Array.isArray(value.mentions)) return false;
  const skills = (value.skills ?? []) as SkillReference[], mentions = (value.mentions ?? []) as unknown[];
  if (mentions.length !== skills.length || mentions.length > 8 || skills.some(skill => /\s/u.test(skill.name))
    || value.collaborationMode === undefined && skills.length === 0 && !(value.contextReferences as ContextReference[] | undefined)?.length) return false;
  const remaining = new Set(skills.map(skillKey));
  let end = 0;
  for (const mention of mentions) {
    if (!record(mention) || !exactFields(mention, ['start', 'end', 'skill']) || !validSkillReferences([mention.skill])) return false;
    const skill = mention.skill as SkillReference;
    if (!Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end)
      || Number(mention.start) < end || Number(mention.end) <= Number(mention.start) || Number(mention.end) > text.length
      || text.slice(Number(mention.start), Number(mention.end)) !== `$${skill.name}`
      || !boundary(text, Number(mention.start) - 1) || !boundary(text, Number(mention.end))
      || !remaining.delete(skillKey(skill))) return false;
    end = Number(mention.end);
  }
  return remaining.size === 0;
}

export function copyComposerFeatureIntent(value: ComposerFeatureIntent, text: string): ComposerFeatureIntent;
export function copyComposerFeatureIntent(value: ComposerFeatureIntent | undefined, text: string): ComposerFeatureIntent | undefined;
export function copyComposerFeatureIntent(value: ComposerFeatureIntent | undefined, text: string): ComposerFeatureIntent | undefined {
  if (value === undefined) return undefined;
  if (!isComposerFeatureIntent(value, text)) throw new Error('草稿中的工作模式或技能引用无效，原内容未覆盖');
  return { version: 1, ...(value.contextReferences !== undefined ? { contextReferences: copyContextReferences(value.contextReferences) } : {}), source: { scope: value.source.scope, deviceId: value.source.deviceId, tool: value.source.tool,
    runtimeId: value.source.runtimeId, surface: value.source.surface, apiIdentity: value.source.apiIdentity, cwd: value.source.cwd },
  ...(value.collaborationMode === undefined ? {} : { collaborationMode: value.collaborationMode }),
  ...(value.skills === undefined ? {} : { skills: value.skills.map(copySkill) }),
  ...(value.mentions === undefined ? {} : { mentions: value.mentions.map(mention => ({ start: mention.start, end: mention.end, skill: copySkill(mention.skill) })) }) };
}
