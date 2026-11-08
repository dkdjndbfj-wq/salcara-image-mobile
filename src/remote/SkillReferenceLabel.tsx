import React from 'react';
import { Image, Text } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { SkillReference } from './agent-features';
import { SKILL_ICON_PATH, useSkillMentionColor } from './skill-appearance';
import { skillDisplayName } from './skill-display-metadata';

export function SkillReferenceLabel({ skill }: { skill: SkillReference }) {
  const color = useSkillMentionColor(skill.brandColor);
  return <Text testID="remote-message-skill" accessibilityLabel={`技能 ${skill.name}${skill.path ? `，${skill.path}` : ''}`}
    style={{ color, fontWeight: '500' }}>
    {skill.iconSmall ? <Image source={{ uri: skill.iconSmall }} style={{ width: 16, height: 16 }} accessibilityIgnoresInvertColors /> : <Svg width={16} height={16} viewBox="0 0 20 20" aria-hidden>
      <Path d={SKILL_ICON_PATH} fill="none" stroke={color} strokeWidth={1.35} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>}{'\u2009'}{skillDisplayName(skill)}
  </Text>;
}
