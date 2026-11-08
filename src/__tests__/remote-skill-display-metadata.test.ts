import { copyTurnFeatures, parseAgentFeatures, skillKey, validSkillReferences } from '../remote/agent-features';
import { messageSkills } from '../remote/conversation-metadata';
import { restoreSkillMentions, stripSkillMentions } from '../remote/skill-mentions';
import { editSkillPresentation, replaceSkillComposerRange, skillComposerPresentation, skillDisplayOffset, skillSourceOffset } from '../remote/skill-composer-presentation';
import { validSkillIcon } from '../remote/skill-display-metadata';

const iconSmall = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=';
const skill = { name: 'review', path: '/a/SKILL.md', displayName: '代码检查🙂', brandColor: '#8A42EF', iconSmall };

test('verified display snapshots survive catalog, draft and message copies while identity remains name/path', () => {
  const features = parseAgentFeatures({ collaborationModes: [], skillsSupported: true, skills: [{ ...skill, description: 'check' }] });
  expect(features.skills[0]).toMatchObject(skill);
  const selected = copyTurnFeatures({ skills: [skill] });
  const restored = restoreSkillMentions('普通 $review', selected.skills!);
  expect(messageSkills(restored.mentions.map(mention => mention.skill))).toEqual([skill]);
  expect(stripSkillMentions(restored.text, restored.mentions)).toBe(' 普通 $review');
  expect(skillKey(skill)).toBe(skillKey({ name: 'review', path: '/a/SKILL.md' }));
  expect(validSkillReferences([skill, { ...skill, displayName: 'other' }])).toBe(false);
});

test('remote URLs, SVG, invalid color and control characters never become display resources', () => {
  for (const icon of ['https://example.com/icon.png', 'file:///secret.png', 'data:image/svg+xml,<svg/>', 'data:image/png;base64,AAAA']) {
    expect(validSkillIcon(icon)).toBe(false); expect(validSkillReferences([{ ...skill, iconSmall: icon }])).toBe(false);
  }
  for (const extra of [{ brandColor: 'red' }, { displayName: 'name\nother' }]) expect(validSkillReferences([{ ...skill, ...extra }])).toBe(false);
  expect(parseAgentFeatures({ collaborationModes: [], skillsSupported: true, skills: [{ name: 'review', displayName: 'valid', iconSmall: 'https://example.com/icon.png' }] }).skills)
    .toEqual([{ name: 'review', description: '', displayName: 'valid' }]);
});

test.each(['R', '代码检查🙂 with a much longer visible label'])('label %s keeps boundary offsets and identity across edits', displayName => {
  const state = restoreSkillMentions('继续🙂', [{ ...skill, displayName }]);
  const view = skillComposerPresentation(state.text, state.mentions);
  expect(view.text).toBe(displayName + ' 继续🙂');
  for (const offset of [0, 7, 8, state.text.length]) expect(skillSourceOffset(view, skillDisplayOffset(view, offset))).toBe(offset);
  expect(editSkillPresentation(state.text, view, view.text + '检查').mentions[0].skill).toEqual({ ...skill, displayName });
  expect(replaceSkillComposerRange(state.text, state.mentions, 0, 7, '')).toEqual({ text: ' 继续🙂', mentions: [], caret: 0 });
  expect(replaceSkillComposerRange(state.text, state.mentions, 0, 0, 'x').text).toBe('x' + view.text);
});
