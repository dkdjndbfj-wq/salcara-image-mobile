import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, LayoutAnimation, Platform, StyleSheet, View, useWindowDimensions, type KeyboardEvent, type StyleProp, type ViewStyle } from 'react-native';
import { keyboardOcclusion, type KeyboardFrame } from './keyboard-geometry';

const KeyboardViewportHeight = createContext<number | undefined>(undefined);
export function useKeyboardViewportHeight(): number {
  const height = useContext(KeyboardViewportHeight), window = useWindowDimensions();
  return height ?? window.height;
}

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
export function KeyboardSafeView({ style, children, pointerEvents, extraGap = 0, onOcclusionChange, testID }: {
  style?: StyleProp<ViewStyle>; children: ReactNode; pointerEvents?: 'box-none' | 'auto' | 'none' | 'box-only'; extraGap?: number;
  onOcclusionChange?: (coversBottom: boolean) => void; testID?: string;
}) {
  const ref = useRef<View>(null);
  const dimensions = useWindowDimensions();
  const [inset, setInset] = useState(0);
  const [height, setHeight] = useState<number>();
  const refresh = useRef<() => void>(() => {}), callback = useRef(onOcclusionChange); callback.current = onOcclusionChange;
  useEffect(() => {
    let alive = true, generation = 0, covered: boolean | undefined, keyboard: KeyboardFrame | undefined;
    const apply = (next: number, nextCovered: boolean, event?: KeyboardEvent) => {
      if (!alive) return;
      if (Platform.OS === 'ios' && event?.duration) {
        LayoutAnimation.configureNext({ duration: event.duration, update: { type: LayoutAnimation.Types.keyboard } });
      }
      setInset((current) => (Math.abs(current - next) < 1 ? current : next));
      if (covered !== nextCovered) { covered = nextCovered; callback.current?.(nextCovered); }
    };
    const measure = (event?: KeyboardEvent) => {
      const request = ++generation, frame = keyboard;
      if (!frame) { apply(0, false, event); return; }
      ref.current?.measureInWindow((x, y, width, height) => {
        if (!alive || request !== generation) return;
        const result = keyboardOcclusion({ x, y, width, height }, frame, extraGap);
        apply(result.inset, result.coversBottom, event);
      });
    };
    refresh.current = () => measure();
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      const viewport = window.visualViewport;
      const updateViewport = () => {
        const active = document.activeElement;
        const editable = active instanceof HTMLElement && (active.isContentEditable || active.tagName === 'TEXTAREA' || active.tagName === 'INPUT');
        const top = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
        // Pinch zoom and browser chrome without an editor are not software keyboards.
        keyboard = viewport && Math.abs(viewport.scale - 1) < .01 && (editable || keyboard) && window.innerHeight - top > 1
          ? { screenX: viewport.offsetLeft, screenY: top, width: viewport.width, height: window.innerHeight - top } : undefined;
        measure();
      };
      viewport?.addEventListener('resize', updateViewport); viewport?.addEventListener('scroll', updateViewport);
      window.addEventListener('resize', updateViewport); document.addEventListener('focusin', updateViewport);
      refresh.current = updateViewport; updateViewport();
      return () => { alive = false; ++generation; refresh.current = () => {};
        viewport?.removeEventListener('resize', updateViewport); viewport?.removeEventListener('scroll', updateViewport);
        window.removeEventListener('resize', updateViewport); document.removeEventListener('focusin', updateViewport);
      };
    }
    const onShow = (event: KeyboardEvent) => { keyboard = event.endCoordinates; measure(event); };
    const onHide = (event: KeyboardEvent) => { keyboard = undefined; measure(event); };
    const subscriptions = Platform.OS === 'ios'
      ? [Keyboard.addListener('keyboardWillShow', onShow), Keyboard.addListener('keyboardWillChangeFrame', onShow), Keyboard.addListener('keyboardWillHide', onHide)]
      : [Keyboard.addListener('keyboardDidShow', onShow), Keyboard.addListener('keyboardDidChangeFrame', onShow), Keyboard.addListener('keyboardDidHide', onHide)];
    keyboard = Keyboard.metrics?.(); measure();
    return () => { alive = false; ++generation; refresh.current = () => {}; subscriptions.forEach((subscription) => subscription.remove()); };
  }, [extraGap]);
  useEffect(() => { refresh.current(); }, [dimensions.width, dimensions.height]);
  const base = StyleSheet.flatten(style), padding = base?.paddingBottom ?? base?.paddingVertical ?? base?.padding ?? 0;
  return <View ref={ref} testID={testID} collapsable={false} onLayout={event => { setHeight(event.nativeEvent.layout.height); refresh.current(); }} pointerEvents={pointerEvents}
    style={[style, inset ? { paddingBottom: Math.max(typeof padding === 'number' ? padding : 0, inset) } : null]}>
    <KeyboardViewportHeight.Provider value={height === undefined ? undefined : Math.max(0, height - inset)}>{children}</KeyboardViewportHeight.Provider>
  </View>;
}
