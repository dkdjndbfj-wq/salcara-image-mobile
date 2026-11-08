import { useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';

/** Animate the panel, never the Modal portal: Escape is active from the first frame. */
export function useSessionMenuMotion(visible: boolean, scopeKey: string, reduced: boolean) {
  const progress = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const owner = useRef({ visible, scopeKey, epoch: 0, closing: false, complete: undefined as (() => void) | undefined });
  if (owner.current.visible !== visible || owner.current.scopeKey !== scopeKey) {
    owner.current = { visible, scopeKey, epoch: owner.current.epoch + 1, closing: false, complete: undefined };
  }
  const epoch = owner.current.epoch, mounted = useRef(true), sequence = useRef(0), animation = useRef<Animated.CompositeAnimation | undefined>(undefined);
  const reducedRef = useRef(reduced); reducedRef.current = reduced;
  const lastOpening = useRef(-1), [, redraw] = useState(0);
  const current = () => mounted.current && owner.current.epoch === epoch && owner.current.visible;
  const stop = () => { ++sequence.current; animation.current?.stop(); animation.current = undefined; };
  const animate = (closing: boolean) => {
    stop();
    const token = sequence.current;
    const finish = () => {
      if (!current() || sequence.current !== token || !closing) return;
      const callback = owner.current.complete; owner.current.complete = undefined;
      callback?.();
    };
    if (reducedRef.current) { progress.setValue(closing ? 0 : 1); finish(); return; }
    animation.current = Animated.timing(progress, { toValue: closing ? 0 : 1, duration: closing ? 110 : 150,
      easing: closing ? Easing.in(Easing.cubic) : Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' });
    animation.current.start(({ finished }) => { if (finished) finish(); });
  };
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, []);
  useLayoutEffect(() => {
    if (!visible) { stop(); progress.setValue(0); return; }
    if (lastOpening.current !== epoch) { lastOpening.current = epoch; progress.setValue(reduced ? 1 : 0); }
    animate(owner.current.closing);
    return stop;
  }, [epoch, visible, reduced]);
  const close = (complete: () => void) => {
    if (!current() || owner.current.closing) return false;
    owner.current.closing = true; owner.current.complete = complete; redraw(value => value + 1);
    animate(true); return true;
  };
  return { close, closing: owner.current.closing, style: { opacity: progress,
    transform: reduced ? [] : [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
      { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [.97, 1] }) }] } };
}
