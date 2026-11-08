import React from 'react';
import { ScrollView, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

export interface MessageCodeViewportProps { children: React.ReactNode; bounded: boolean; contentStyle: StyleProp<ViewStyle>; contentHeight: number }
export const MESSAGE_CODE_MAX_HEIGHT = 240;

/** The workbench owns two bounded axes. Other chat surfaces keep their layout. */
export function MessageCodeViewport({ children, bounded, contentStyle, contentHeight }: MessageCodeViewportProps) {
  const horizontal = <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={bounded} persistentScrollbar={bounded}
    keyboardShouldPersistTaps="handled" style={bounded ? styles.horizontal : undefined} contentContainerStyle={contentStyle}>{children}</ScrollView>;
  if (!bounded) return horizontal;
  return <ScrollView testID="message-code-scroll" accessibilityLabel="代码，支持上下左右滚动" nestedScrollEnabled showsVerticalScrollIndicator persistentScrollbar
    keyboardShouldPersistTaps="handled" style={{ height: Math.min(MESSAGE_CODE_MAX_HEIGHT, contentHeight), flexGrow: 0 }} contentContainerStyle={styles.content}>
    {horizontal}
  </ScrollView>;
}
const styles = StyleSheet.create({ horizontal: { flexGrow: 0, flexShrink: 0 }, content: { flexGrow: 0 } });
