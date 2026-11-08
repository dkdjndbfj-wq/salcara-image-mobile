import { reconcileSkillMentions, type SkillMention, type SkillMentionEdit } from './skill-mentions';
import { skillDisplayName } from './skill-display-metadata';

interface DisplayMention extends SkillMention { sourceStart: number; sourceEnd: number }
export interface SkillComposerPresentation { text: string; mentions: DisplayMention[] }

/** The editor shows a name, while the draft retains its explicit $ invocation.
 * Every offset crosses this boundary; visible text alone never creates a skill. */
export function skillComposerPresentation(value: string, mentions: readonly SkillMention[]): SkillComposerPresentation {
  let text = '', offset = 0;
  const result: DisplayMention[] = [];
  for (const mention of mentions) {
    if (mention.start < offset || value.slice(mention.start, mention.end) !== `$${mention.skill.name}`) continue;
    text += value.slice(offset, mention.start);
    const start = text.length;
    text += skillDisplayName(mention.skill);
    result.push({ start, end: text.length, skill: mention.skill, sourceStart: mention.start, sourceEnd: mention.end });
    offset = mention.end;
  }
  return { text: text + value.slice(offset), mentions: result };
}

export function skillDisplayOffset(presentation: SkillComposerPresentation, source: number): number {
  let delta = 0;
  for (const mention of presentation.mentions) {
    if (source <= mention.sourceStart) break;
    if (source < mention.sourceEnd) return mention.start + Math.max(0, Math.min(mention.end - mention.start - 1,
      Math.round((source - mention.sourceStart) * (mention.end - mention.start) / (mention.sourceEnd - mention.sourceStart))));
    delta += mention.sourceEnd - mention.sourceStart - (mention.end - mention.start);
  }
  return Math.max(0, source - delta);
}

export function skillSourceOffset(presentation: SkillComposerPresentation, display: number): number {
  let delta = 0;
  for (const mention of presentation.mentions) {
    if (display <= mention.start) break;
    if (display < mention.end) return mention.sourceStart + Math.max(1, Math.min(mention.sourceEnd - mention.sourceStart - 1,
      Math.round((display - mention.start) * (mention.sourceEnd - mention.sourceStart) / (mention.end - mention.start))));
    delta += mention.sourceEnd - mention.sourceStart - (mention.end - mention.start);
  }
  return Math.max(0, display + delta);
}

/** An explicit editor selection is stronger evidence than a text diff, in
 * particular when two same-name tokens refer to different paths. */
export function replaceSkillComposerRange(value: string, mentions: readonly SkillMention[], start: number, end: number, inserted: string): SkillMentionEdit {
  const presentation = skillComposerPresentation(value, mentions);
  const from = skillDisplayOffset(presentation, start), to = skillDisplayOffset(presentation, end);
  const next = presentation.text.slice(0, from) + inserted + presentation.text.slice(to), delta = inserted.length - (to - from);
  const retained = presentation.mentions.filter(mention => mention.sourceEnd <= start || mention.sourceStart >= end)
    .map(mention => mention.sourceStart >= end ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention);
  const result = canonicalSkillText(next, retained);
  return { ...result, caret: skillSourceOffset(skillComposerPresentation(result.text, result.mentions), from + inserted.length) };
}

function canonicalSkillText(display: string, candidates: readonly SkillMention[]): SkillMentionEdit {
  let text = '', at = 0;
  const mentions: SkillMention[] = [];
  for (const mention of candidates) {
    if (mention.start < at || display.slice(mention.start, mention.end) !== skillDisplayName(mention.skill)
      || mention.start > 0 && !/\s/u.test(display[mention.start - 1])
      || mention.end < display.length && !/\s/u.test(display[mention.end])) continue;
    text += display.slice(at, mention.start);
    const start = text.length;
    text += `$${mention.skill.name}`;
    mentions.push({ start, end: text.length, skill: mention.skill });
    at = mention.end;
  }
  text += display.slice(at);
  return { text, mentions: reconcileSkillMentions(text, text, mentions).mentions };
}

/** Preserve only untouched references across a native edit, paste or IME commit.
 * A replacement that happens to spell $name remains literal, even when the
 * reconstructed canonical text equals the previous draft. */
export function editSkillPresentation(value: string, presentation: SkillComposerPresentation, next: string): SkillMentionEdit {
  const previous = presentation.text;
  if (previous === next) return { text: value, mentions: presentation.mentions.map(({ sourceStart: start, sourceEnd: end, skill }) => ({ start, end, skill })) };
  let start = 0, suffix = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  while (suffix < previous.length && suffix < next.length && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const ambiguous = start + suffix > Math.min(previous.length, next.length);
  const uncertainStart = Math.min(previous.length, next.length) - suffix;
  let oldEnd = previous.length, newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  const affected = (mention: DisplayMention) => ambiguous
    ? mention.start < start + Math.max(0, previous.length - next.length) && mention.end > uncertainStart
    : mention.start < oldEnd && mention.end > start || oldEnd === start && mention.start < start && mention.end > start;
  let caret: number | undefined;
  if (!ambiguous && newEnd === start && oldEnd > start) {
    const touched = presentation.mentions.filter(affected);
    if (touched.length) {
      start = Math.min(start, touched[0].start); oldEnd = Math.max(oldEnd, touched[touched.length - 1].end);
      next = previous.slice(0, start) + previous.slice(oldEnd); caret = start;
    }
  }
  const delta = next.length - previous.length;
  const retained = presentation.mentions.filter(mention => !affected(mention)).map(mention => mention.start >= oldEnd
    ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention);
  const result = canonicalSkillText(next, retained);
  return { ...result, ...(caret === undefined ? {} : { caret: skillSourceOffset(skillComposerPresentation(result.text, result.mentions), caret) }) };
}
