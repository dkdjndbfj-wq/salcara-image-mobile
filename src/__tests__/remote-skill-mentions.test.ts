import { insertSkillMention, reconcileSkillMentions, restoreSkillMentions, stripSkillMentions, type SkillMention } from '../remote/skill-mentions';
import type { SkillReference } from '../remote/agent-features';

const review = { name: 'review', path: '/workspace/a/SKILL.md' };
const otherReview = { name: 'review', path: '/workspace/b/SKILL.md' };
const testSkill = { name: 'plugin:test' };
const token = (skill: SkillReference, start = 0): SkillMention => ({ start, end: start + skill.name.length + 1, skill });

it('inserts inside the composer and preserves body, path identity, caret and immutable input', () => {
  const before = 'Review this /re carefully\nkeep indentation';
  const result = insertSkillMention(before, 12, 15, review, []);
  expect(result.text).toBe('Review this $review  carefully\nkeep indentation');
  expect(result.caret).toBe(20);
  expect(result.mentions).toEqual([token(review, 12)]);
  expect(result.mentions[0].skill).not.toBe(review);
  const middle = insertSkillMention('ab', 1, 1, review, []);
  expect(middle.text).toBe('a $review b');
  expect(middle.mentions).toEqual([token(review, 2)]);
});

it('keeps same-name paths separate, deduplicates exact references and enforces the eight-skill limit', () => {
  const first = insertSkillMention('', 0, 0, review, []);
  const second = insertSkillMention(first.text, first.caret, first.caret, otherReview, first.mentions);
  expect(second.text).toBe('$review $review ');
  expect(second.mentions.map(item => item.skill.path)).toEqual([review.path, otherReview.path]);
  expect(insertSkillMention(second.text, second.caret, second.caret, review, second.mentions).text).toBe(second.text);
  const full = restoreSkillMentions('', Array.from({ length: 8 }, (_, i) => ({ name: `skill${i}` })));
  expect(insertSkillMention(full.text, full.caret, full.caret, review, full.mentions)).toMatchObject({ text: full.text, mentions: full.mentions });
});

it('moves mention offsets with edits outside tokens without creating references from typed text', () => {
  const old = '$review task';
  expect(reconcileSkillMentions(old, 'please $review task', [token(review)]).mentions).toEqual([token(review, 7)]);
  expect(reconcileSkillMentions(old, '$review task and $plugin:test', [token(review)]).mentions).toEqual([token(review)]);
  expect(reconcileSkillMentions('', '$review ', []).mentions).toEqual([]);
  expect(reconcileSkillMentions(old, '$reviewSuffix task', [token(review)]).mentions).toEqual([]);
});

it('deletes the entire token on Backspace or Delete of one token character', () => {
  for (const next of ['$revie task', 'review task', '$reiew task']) {
    const result = reconcileSkillMentions('$review task', next, [token(review)]);
    expect(result).toEqual({ text: ' task', mentions: [], caret: 0 });
  }
  const next = reconcileSkillMentions('intro $review task', 'intro $revie task', [token(review, 6)]);
  expect(next).toEqual({ text: 'intro  task', mentions: [], caret: 6 });
});

it('removes intersected chips across a selection while retaining unrelated references and offsets', () => {
  const old = '$review alpha $plugin:test omega $review tail';
  const mentions = [token(review), token(testSkill, 14), token(otherReview, 33)];
  const end = old.indexOf('test') + 2;
  const next = old.slice(0, 3) + old.slice(end);
  const result = reconcileSkillMentions(old, next, mentions);
  expect(result.text).toBe(' omega $review tail');
  expect(result.mentions).toEqual([token(otherReview, 7)]);
});

it('preserves replacement and pasted text but cancels any intersecting reference', () => {
  const old = '$review task';
  expect(reconcileSkillMentions(old, '$revXiew task', [token(review)])).toEqual({ text: '$revXiew task', mentions: [] });
  expect(reconcileSkillMentions(old, '$other task', [token(review)])).toEqual({ text: '$other task', mentions: [] });
  const pasted = '$review $review task';
  const result = reconcileSkillMentions(old, pasted, [token(review)]);
  // No selection range accompanies onChangeText, so identical pasted tokens
  // cannot be assigned the prior path by guessing which occurrence moved.
  expect(result.mentions).toHaveLength(0);
  expect(result.text).toBe(pasted);
});

it('fails closed when deleting identical visible tokens could retain either of two paths', () => {
  const old = '$review $review task';
  const result = reconcileSkillMentions(old, '$review task', [token(review), token(otherReview, 8)]);
  expect(result).toEqual({ text: '$review task', mentions: [] });
  const repeatedName = { name: 'aaaa' };
  expect(reconcileSkillMentions('$aaaa task', '$aaa task', [token(repeatedName)])).toEqual({ text: ' task', mentions: [], caret: 0 });
});

it('strips only exact valid recorded tokens and preserves ordinary text including untracked lookalikes', () => {
  expect(stripSkillMentions('$review task $review', [token(review)])).toBe(' task $review');
  expect(stripSkillMentions('$reviewSuffix', [token(review)])).toBe('$reviewSuffix');
  expect(stripSkillMentions('ordinary text', [token(review)])).toBe('ordinary text');
  expect(stripSkillMentions('', [])).toBe('');
  expect(stripSkillMentions('$review ', [token(review)]).trim()).toBe('');
});

it('restores stripped message bodies without claiming literal same-name tokens', () => {
  expect(restoreSkillMentions('Use $review carefully', [review])).toMatchObject({ text: '$review Use $review carefully', mentions: [token(review)] });
  expect(restoreSkillMentions('$reviewSuffix task', [review])).toMatchObject({ text: '$review $reviewSuffix task', mentions: [token(review)] });
  const restored = restoreSkillMentions('$review task', [review, otherReview]);
  expect(restored.text).toBe('$review $review $review task');
  expect(restored.mentions).toEqual([token(review), token(otherReview, 8)]);
  expect(stripSkillMentions(restored.text, restored.mentions)).toBe('  $review task');
  expect(restoreSkillMentions('', [review, review])).toMatchObject({ text: '$review ', mentions: [token(review)] });
});

it('rejects invalid ranges and skill references, and loses authority when visible token text changes', () => {
  expect(insertSkillMention('task', -1, 1, review, []).text).toBe('task');
  expect(insertSkillMention('task', 0, 10, review, []).text).toBe('task');
  expect(insertSkillMention('task', 0, 0, { name: 'bad name' }, []).text).toBe('task');
  expect(insertSkillMention('task', 0, 0, { name: 'valid', path: '\nunsafe' }, []).text).toBe('task');
  expect(reconcileSkillMentions('$review task', '$Review task', [token(review)]).mentions).toEqual([]);
  expect(restoreSkillMentions('', []).text).toBe('');
});
