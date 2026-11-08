import { editSkillPresentation, replaceSkillComposerRange, skillComposerPresentation, skillDisplayOffset, skillSourceOffset } from '../remote/skill-composer-presentation';
import { restoreSkillMentions } from '../remote/skill-mentions';

const review = { name: 'review', path: '/a/SKILL.md' };
const make = (body = '继续') => { const state = restoreSkillMentions(body, [review]); return { ...state, view: skillComposerPresentation(state.text, state.mentions) }; };

test('only selected references become names; literal lookalikes and UTF-16 selections survive', () => {
  const { text, mentions, view } = make('你好🙂 $review');
  expect(view.text).toBe('review 你好🙂 $review');
  for (const offset of [0, 7, 8, text.length]) expect(skillSourceOffset(view, skillDisplayOffset(view, offset))).toBe(offset);
  expect(editSkillPresentation(text, view, view.text)).toEqual({ text, mentions });
});

test('ordinary insertion, Chinese IME and changes before a token retain the exact selected path', () => {
  const { text, view } = make();
  expect(editSkillPresentation(text, view, view.text + '检查')).toMatchObject({ text: text + '检查', mentions: [{ skill: review }] });
  expect(editSkillPresentation(text, view, '请 ' + view.text)).toMatchObject({ text: '请 ' + text, mentions: [{ start: 2, end: 9, skill: review }] });
});

test('native Backspace inside a selected name removes it atomically and replacement becomes ordinary text', () => {
  const { text, view } = make();
  expect(editSkillPresentation(text, view, 'revie 继续')).toEqual({ text: ' 继续', mentions: [], caret: 0 });
  expect(editSkillPresentation(text, view, 'reXview 继续')).toEqual({ text: 'reXview 继续', mentions: [] });
});

test('deleting an ambiguous repeated name never selects a different same-name path', () => {
  const state = restoreSkillMentions('继续', [review, { ...review, path: '/b/SKILL.md' }]);
  const view = skillComposerPresentation(state.text, state.mentions);
  const result = editSkillPresentation(state.text, view, 'review 继续');
  expect(result).toEqual({ text: 'review 继续', mentions: [] });
});

test('separators still determine authority after a projected edit', () => {
  const { text, view } = make();
  for (const next of ['x' + view.text, '$' + view.text, 'reviewX 继续']) {
    expect(editSkillPresentation(text, view, next)).toEqual({ text: next, mentions: [] });
  }
});

test('native deletion maps its caret once across earlier tokens without counting later tokens', () => {
  const state = restoreSkillMentions('task', ['a', 'b', 'c', 'd'].map(name => ({ name, path: `/${name}/SKILL.md` })));
  const view = skillComposerPresentation(state.text, state.mentions);
  const result = editSkillPresentation(state.text, view, 'a b  d task');
  expect(result.text).toBe('$a $b  $d task'); expect(result.caret).toBe(6);
  expect(skillDisplayOffset(skillComposerPresentation(result.text, result.mentions), result.caret!)).toBe(4);
});

test.each([[0, 'x', 'xreview 继续', 1], [7, 'X', 'reviewX 继续', 7], [0, '$', '$review 继续', 1]] as const)('explicit paste at %s never reveals a hidden invocation prefix', (at, inserted, expected, caret) => {
  const { text, mentions } = make();
  expect(replaceSkillComposerRange(text, mentions, at, at, inserted)).toEqual({ text: expected, mentions: [], caret });
});
