import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, LayoutAnimation, Platform, View, type KeyboardEvent, type StyleProp, type ViewStyle } from 'react-native';

/**
 * Keeps its bottom edge (the input) above the keyboard on both platforms.
 *
 * React Native's KeyboardAvoidingView measures itself with onLayout, i.e.
 * relative to its parent. Under a header that underestimates the overlap, and
 * with Android edge-to-edge the window no longer resizes, so the composer ended
 * up behind the keyboard. Here the real on-screen frame is measured and only the
 * actual overlap is added as bottom padding. If the OS already resized the
 * window, the overlap is 0 and nothing changes.
 */
export function KeyboardSafeView({ style, children, pointerEvents, extraGap = 0 }: {
  style?: StyleProp<ViewStyle>; children: ReactNode; pointerEvents?: 'box-none' | 'auto' | 'none' | 'box-only'; extraGap?: number;
}) {
  const ref = useRef<View>(null);
  const [inset, setInset] = useState(0);
  useEffect(() => {
    let alive = true;
    const apply = (next: number, event?: KeyboardEvent) => {
      if (!alive) return;
      if (Platform.OS === 'ios' && event?.duration) {
        LayoutAnimation.configureNext({ duration: event.duration, update: { type: LayoutAnimation.Types.keyboard } });
      }
      setInset((current) => (Math.abs(current - next) < 1 ? current : next));
    };
    const onShow = (event: KeyboardEvent) => {
      const keyboardTop = event.endCoordinates.screenY;
      const node = ref.current;
      if (!node || !Number.isFinite(keyboardTop)) return;
      node.measureInWindow((_x, y, _width, height) => {
        apply(Math.max(0, y + height - keyboardTop) + (y + height > keyboardTop ? extraGap : 0), event);
      });
    };
    const onHide = (event: KeyboardEvent) => apply(0, event);
    const subscriptions = Platform.OS === 'ios'
      ? [Keyboard.addListener('keyboardWillShow', onShow), Keyboard.addListener('keyboardWillChangeFrame', onShow), Keyboard.addListener('keyboardWillHide', onHide)]
      : [Keyboard.addListener('keyboardDidShow', onShow), Keyboard.addListener('keyboardDidChangeFrame', onShow), Keyboard.addListener('keyboardDidHide', onHide)];
    return () => { alive = false; subscriptions.forEach((subscription) => subscription.remove()); };
  }, [extraGap]);
  return <View ref={ref} collapsable={false} pointerEvents={pointerEvents} style={[style, inset ? { paddingBottom: inset } : null]}>{children}</View>;
}
