import React, { useRef } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

import type { Character } from '../memorybox/types';

let ringSeed = 0;

/**
 * Round avatar: the character's picture, or its emoji / initial on a soft tint of its colour.
 * `ring` draws a thin gradient halo in the character's colour (used where the avatar is the focus).
 */
export function CharacterAvatar({ character, size = 40, ring = false, online = false }: {
  character: Pick<Character, 'icon' | 'color' | 'name'> & { avatarUri?: string | null }; size?: number; ring?: boolean; online?: boolean;
}) {
  const id = useRef(`avatarRing${(ringSeed += 1)}`).current;
  const icon = character.icon.trim() || [...character.name][0] || '·';
  const inset = ring ? Math.max(2.5, size * 0.07) : 0;
  const inner = size - inset * 2;
  return <View style={{ width: size, height: size }}>
    {ring ? <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#7CC6FF" />
          <Stop offset="0.5" stopColor={character.color} />
          <Stop offset="1" stopColor="#A68BF7" />
        </LinearGradient>
      </Defs>
      <Circle cx={size / 2} cy={size / 2} r={size / 2 - 1} stroke={`url(#${id})`} strokeWidth={Math.max(1.5, size * 0.035)} fill="none" />
    </Svg> : null}
    <View style={[styles.avatar, { left: inset, top: inset, width: inner, height: inner, borderRadius: inner / 2, backgroundColor: `${character.color}22` }]}>
      {character.avatarUri
        ? <Image source={{ uri: character.avatarUri }} style={{ width: inner, height: inner }} resizeMode="cover" fadeDuration={120} />
        : <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.text, { color: character.color, fontSize: inner * 0.5, lineHeight: inner * 0.64 }]}>{icon}</Text>}
    </View>
    {online ? <View style={[styles.online, { width: size * 0.26, height: size * 0.26, borderRadius: size * 0.13, borderWidth: Math.max(1.5, size * 0.05) }]} /> : null}
  </View>;
}

const styles = StyleSheet.create({
  avatar: { position: 'absolute', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  text: { fontWeight: '700', textAlign: 'center' },
  online: { position: 'absolute', right: 0, bottom: 0, backgroundColor: '#35C77B', borderColor: '#FFFFFF' },
});
