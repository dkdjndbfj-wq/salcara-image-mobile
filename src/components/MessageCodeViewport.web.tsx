import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import type { MessageCodeViewportProps } from './MessageCodeViewport';
export const MESSAGE_CODE_MAX_HEIGHT = 240;

/** A single web scrollport keeps both scrollbars reachable at the frame edges. */
export function MessageCodeViewport({ children, bounded, contentStyle }: MessageCodeViewportProps) {
  if (!bounded) return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={contentStyle}>{children}</ScrollView>;
  return <div data-testid="message-code-scroll" role="region" aria-label="代码，支持上下左右滚动" tabIndex={0}
    style={{ maxHeight: MESSAGE_CODE_MAX_HEIGHT, minWidth: 0, overflow: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'thin', outlineOffset: -2 }}>
    <div style={{ ...StyleSheet.flatten(contentStyle) as React.CSSProperties, width: 'max-content', minWidth: '100%', boxSizing: 'border-box' }}>{children}</div>
  </div>;
}
