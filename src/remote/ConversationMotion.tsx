import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle, type ViewProps } from 'react-native';
import { useReducedMotion } from '../components/MotionPressable';

/** Local presence motion. Live child updates do not restart the entrance;
 * only visibility or an explicit transition key does. No layout is animated. */
export function WorkbenchReveal({ children, visible = true, transitionKey, style, testID, pointerEvents='auto' }: {
  children: React.ReactNode; visible?: boolean; transitionKey?: string | number;
  style?: StyleProp<ViewStyle>; testID?: string;pointerEvents?:ViewProps['pointerEvents'];
}) {
  const reduced = useReducedMotion(), progress = useRef(new Animated.Value(visible ? 0 : 1)).current;
  const [present, setPresent] = useState(visible), showing = useRef(visible), revision = useRef(0);
  useEffect(() => {
    const token = ++revision.current;
    if (reduced) { progress.setValue(visible ? 1 : 0); showing.current = visible; setPresent(visible); return; }
    if (!visible && !showing.current) return;
    if (visible) { showing.current = true; setPresent(true); progress.setValue(0); }
    const animation = Animated.timing(progress, { toValue: visible ? 1 : 0, duration: visible ? 150 : 100,
      easing: Easing.out(Easing.cubic), useNativeDriver: true, isInteraction: false });
    animation.start(({ finished }) => {
      if (finished && !visible && revision.current === token) { showing.current = false; setPresent(false); }
    });
    return () => { ++revision.current; animation.stop(); };
  }, [visible, transitionKey, reduced, progress]);
  if (!visible && (reduced || !present)) return null;
  return <Animated.View testID={testID} pointerEvents={visible ? pointerEvents : 'none'} accessibilityElementsHidden={!visible}
    importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'} style={[style, reduced ? undefined : {
      opacity: progress, transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [4, 0] }) }],
    }]}>{children}</Animated.View>;
}
