import React from 'react';
import { Text } from 'react-native';
import glyphs from '../../node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/Ionicons.json';
export function Ionicons({ name, size = 20, color, style }) { return <Text aria-hidden style={[{ fontFamily: 'Ionicons', fontSize: size, color, lineHeight: size + 2 }, style]}>{String.fromCodePoint(glyphs[name] ?? glyphs['ellipse-outline'])}</Text>; }
