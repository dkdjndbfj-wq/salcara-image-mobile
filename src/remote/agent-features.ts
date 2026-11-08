import { copyContextReferences, validContextReferences, type ContextReference } from './context-references';
import { skillDisplayMetadata, validSkillDisplay, type SkillDisplayMetadata } from './skill-display-metadata';
export type CollaborationMode = 'default' | 'plan';
export interface SkillReference extends SkillDisplayMetadata { name: string; path?: string }
export interface AgentSkill extends SkillReference { description: string; displayName?: string }
export interface TurnFeatures { collaborationMode?: CollaborationMode; skills?: SkillReference[]; contextReferences?: ContextReference[] }
export interface AgentFeatures { collaborationModes: CollaborationMode[]; skills: AgentSkill[]; skillsSupported: boolean }
export const MAX_AGENT_FEATURE_SKILLS = 10_000;
export const MAX_AGENT_FEATURE_BYTES = 16 * 1024 * 1024;

export const isCollaborationMode = (value: unknown): value is CollaborationMode => value === 'default' || value === 'plan';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const utf8Size = (value: string) => [...value].reduce((size, char) => size + (char.length === 2 ? 4 : char.charCodeAt(0) < 0x80 ? 1 : char.charCodeAt(0) < 0x800 ? 2 : 3), 0);
const safe = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && utf8Size(value) <= max && value.trim() === value && !/[\r\n\x00]/.test(value);
const skillName = (value: unknown): value is string => safe(value, 160) && !/[\t $<>]/.test(value);
export function validSkillReferences(value: unknown): value is SkillReference[] {
  return Array.isArray(value) && value.length <= 8 && value.every(item => record(item)
    && Object.keys(item).every(key => ['name', 'path', 'displayName', 'brandColor', 'iconSmall'].includes(key)) && skillName(item.name) && validSkillDisplay(item)
    && (item.path === undefined || safe(item.path, 4096)))
    && new Set(value.map(item => JSON.stringify([item.name, item.path]))).size === value.length;
}
export function validTurnFeatures(value: { collaborationMode?: unknown; skills?: unknown; contextReferences?: unknown }, surface = 'cli'): boolean {
  return (value.collaborationMode === undefined || surface === 'cli' && isCollaborationMode(value.collaborationMode))
    && (value.skills === undefined || surface === 'cli' && validSkillReferences(value.skills))
    && (value.contextReferences === undefined || surface === 'cli' && validContextReferences(value.contextReferences));
}
/** Keep intent detached across storage waits, queueing, and receipt retries. */
export function copyTurnFeatures(value: { collaborationMode?: unknown; skills?: unknown; contextReferences?: unknown }): TurnFeatures {
  if (!validTurnFeatures(value)) throw new Error('工作模式或技能选项无效');
  return { ...(value.contextReferences !== undefined ? { contextReferences: copyContextReferences(value.contextReferences) } : {}), ...(isCollaborationMode(value.collaborationMode) ? { collaborationMode: value.collaborationMode } : {}),
    ...(validSkillReferences(value.skills) ? { skills: value.skills.map(skill => ({ ...skill })) } : {}) };
}
export const skillKey = (skill: SkillReference) => JSON.stringify([skill.name, skill.path ?? '']);
export function parseAgentFeatures(value: unknown, strict = false): AgentFeatures {
  if (!record(value) || !Array.isArray(value.collaborationModes) || !Array.isArray(value.skills) || typeof value.skillsSupported !== 'boolean') throw new Error('电脑返回的工作模式和技能目录无效');
  if (value.skills.length > MAX_AGENT_FEATURE_SKILLS) throw new Error('电脑返回的技能目录超过读取上限');
  // Protocol revisions may add display-only collaboration modes. Preserve the
  // modes this client understands, ignore new string values, and still reject
  // malformed or unbounded metadata before committing a paged snapshot.
  if (strict && (value.collaborationModes.length > 64 || value.collaborationModes.some(mode => typeof mode !== 'string' || mode.length > 128)
    || new Set(value.collaborationModes).size !== value.collaborationModes.length || !value.skillsSupported && value.skills.length > 0)) throw new Error('电脑返回的技能目录分页无效');
  const skills: AgentSkill[] = [];
  const seen = new Set<string>();
  for (const raw of value.skills) {
    if (!record(raw) || !skillName(raw.name) || raw.path !== undefined && !safe(raw.path, 4096)) { if (strict) throw new Error('电脑返回的技能目录分页无效'); continue; }
    // Copy only fields with known semantics below. Unknown additive metadata
    // from a newer Bridge is bounded by the page budget and intentionally
    // discarded instead of making the entire skills catalog unavailable.
    if (strict && (Object.keys(raw).length > 64 || typeof raw.description !== 'string' || [...raw.description].length > 4000 || !validSkillDisplay(raw))) throw new Error('电脑返回的技能目录分页无效');
    const skill: AgentSkill = { name: raw.name, ...(raw.path ? { path: raw.path as string } : {}), description: typeof raw.description === 'string' ? (strict ? raw.description : [...raw.description].slice(0, 4000).join('')) : '',
      ...skillDisplayMetadata(raw) };
    const key = skillKey(skill);
    if (strict && seen.has(key)) throw new Error('电脑返回的技能目录分页包含重复项');
    if (!seen.has(key)) { skills.push(skill); seen.add(key); }
  }
  return { collaborationModes: [...new Set(value.collaborationModes.filter(isCollaborationMode))], skills: value.skillsSupported ? skills : [], skillsSupported: value.skillsSupported };
}
