import { skillKey, validSkillReferences, type SkillReference } from './agent-features';
import { copySkillReference as copySkill } from './skill-display-metadata';

export interface SkillMention { start: number; end: number; skill: SkillReference }
export interface SkillMentionEdit { text: string; mentions: SkillMention[]; caret?: number }
export interface SkillMentionInsertion extends SkillMentionEdit { caret: number }

const tokenFor = (skill: SkillReference) => `$${skill.name}`;
const validSkill = (skill: SkillReference) => validSkillReferences([skill]) && !/\s/u.test(skill.name);
const boundary = (text: string, position: number) => position < 0 || position >= text.length || /\s/u.test(text[position]);
const tokenAt = (text: string, start: number, end: number, skill: SkillReference) =>
  Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length
  && text.slice(start, end) === tokenFor(skill) && boundary(text, start - 1) && boundary(text, end);

/** Only recorded, exact tokens retain authority; literal text cannot create a reference. */
function validMentions(text: string, mentions: readonly SkillMention[]): SkillMention[] {
  const result: SkillMention[] = [], seen = new Set<string>();
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    if (!validSkill(mention.skill) || !tokenAt(text, mention.start, mention.end, mention.skill)) continue;
    const key = skillKey(mention.skill);
    if (seen.has(key) || result.length >= 8 || result.length > 0 && mention.start < result[result.length - 1].end) continue;
    result.push({ start: mention.start, end: mention.end, skill: copySkill(mention.skill) });
    seen.add(key);
  }
  return result;
}

export function insertSkillMention(text: string, rangeStart: number, rangeEnd: number, skill: SkillReference, existingMentions: readonly SkillMention[] = []): SkillMentionInsertion {
  const original = validMentions(text, existingMentions);
  const noChange = (caret = Math.max(0, Math.min(text.length, Number.isFinite(rangeEnd) ? rangeEnd : text.length))) => ({ text, mentions: original, caret });
  if (!validSkill(skill) || !Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) || rangeStart < 0 || rangeEnd < rangeStart || rangeEnd > text.length) return noChange();
  const remaining = original.filter(mention => mention.end <= rangeStart || mention.start >= rangeEnd);
  const duplicate = remaining.find(mention => skillKey(mention.skill) === skillKey(skill));
  if (duplicate) return noChange(duplicate.end);
  if (remaining.length >= 8) return noChange();
  // A mid-word insertion needs a separator, while all original outside-range
  // characters remain intact. The token's trailing space supports continued typing.
  const separator = rangeStart > 0 && !boundary(text, rangeStart - 1) ? ' ' : '';
  const insertion = `${separator}${tokenFor(skill)} `;
  const nextText = text.slice(0, rangeStart) + insertion + text.slice(rangeEnd);
  const delta = insertion.length - (rangeEnd - rangeStart);
  const shifted = remaining.map(mention => mention.start >= rangeEnd
    ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention);
  const start = rangeStart + separator.length;
  shifted.push({ start, end: start + tokenFor(skill).length, skill: copySkill(skill) });
  return { text: nextText, mentions: validMentions(nextText, shifted), caret: rangeStart + insertion.length };
}

/** Track one native text edit using the unchanged prefix and suffix. */
export function reconcileSkillMentions(oldText: string, newText: string, mentions: readonly SkillMention[]): SkillMentionEdit {
  const original = validMentions(oldText, mentions);
  if (oldText === newText) return { text: newText, mentions: original };
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
  let suffix = 0;
  while (suffix < oldText.length && suffix < newText.length && oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]) suffix++;
  const shortest = Math.min(oldText.length, newText.length);
  if (start + suffix > shortest) {
    // Identical visible names can represent different paths. Without the
    // native edit selection, removing one of "$review $review" has multiple
    // equally valid alignments. Never choose a surviving path by position.
    const uncertainStart = shortest - suffix;
    const removed = Math.max(0, oldText.length - newText.length);
    const uncertainEnd = start + removed;
    const affected = original.filter(mention => mention.start < uncertainEnd && mention.end > uncertainStart);
    const touchedAt = (at: number) => original.filter(mention => removed > 0
      ? mention.start < at + removed && mention.end > at : mention.start < at && mention.end > at);
    const earliest = touchedAt(uncertainStart), latest = touchedAt(start);
    const sameTouchedTokens = earliest.length > 0 && earliest.length === latest.length && earliest.every((mention, index) => mention === latest[index]);
    if (affected.length > 0 && !sameTouchedTokens) {
      const delta = newText.length - oldText.length;
      const retained = original.filter(mention => !affected.includes(mention)).map(mention => mention.start >= uncertainEnd
        ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention);
      return { text: newText, mentions: validMentions(newText, retained) };
    }
  }
  let oldEnd = oldText.length, newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) { oldEnd--; newEnd--; }
  let nextText = newText, caret: number | undefined;
  // Backspace, Delete and range deletion treat a recorded token as one chip.
  // Replacement/paste edits retain exactly the new text and drop intersected
  // references instead; edited visible text is never guessed back into a skill.
  if (newEnd === start && oldEnd > start) {
    const touched = original.filter(mention => mention.start < oldEnd && mention.end > start);
    if (touched.length) {
      start = Math.min(start, touched[0].start);
      oldEnd = Math.max(oldEnd, touched[touched.length - 1].end);
      nextText = oldText.slice(0, start) + oldText.slice(oldEnd);
      newEnd = start;
      caret = start;
    }
  }
  const delta = nextText.length - oldText.length;
  const shifted: SkillMention[] = [];
  for (const mention of original) {
    if (mention.end <= start) shifted.push(mention);
    else if (mention.start >= oldEnd) shifted.push({ ...mention, start: mention.start + delta, end: mention.end + delta });
    // Insertion strictly inside a token or any intersecting replacement drops it.
  }
  return { text: nextText, mentions: validMentions(nextText, shifted), ...(caret === undefined ? {} : { caret }) };
}

/** Remove only authoritative tokens. Manually typed lookalikes remain user text. */
export function stripSkillMentions(text: string, mentions: readonly SkillMention[]): string {
  let result = text;
  for (const mention of validMentions(text, mentions).reverse()) result = result.slice(0, mention.start) + result.slice(mention.end);
  return result;
}

/** Restore a stripped wire/queue body. Every existing lookalike is user text;
 * never claim an existing token and silently remove it on the next send. */
export function restoreSkillMentions(text: string, skills: readonly SkillReference[]): SkillMentionInsertion {
  const seen = new Set<string>(), mentions: SkillMention[] = [];
  let prefix = '';
  for (const skill of skills) {
    if (!validSkill(skill) || seen.has(skillKey(skill)) || mentions.length >= 8) continue;
    seen.add(skillKey(skill));
    const start = prefix.length;
    prefix += tokenFor(skill) + ' ';
    mentions.push({ start, end: prefix.length - 1, skill: copySkill(skill) });
  }
  return { text: prefix + text, caret: prefix.length + text.length, mentions };
}
