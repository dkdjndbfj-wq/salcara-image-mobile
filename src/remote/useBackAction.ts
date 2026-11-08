import { useCallback, useEffect, useRef } from 'react';
import { BackHandler, Keyboard } from 'react-native';

export type BackAction = () => boolean;
export type RegisterBackAction = (action: BackAction | null) => void;

export function dismissKeyboardOnBack(): boolean {
  if (!Keyboard.isVisible()) return false;
  Keyboard.dismiss();
  return true;
}

/** Parents call the visible child's action before navigating themselves. */
export function useChildBackAction() {
  const child = useRef<BackAction | null>(null);
  const register = useCallback<RegisterBackAction>(action => { child.current = action; }, []);
  const handle = useCallback(() => child.current?.() ?? false, []);
  return { register, handle };
}

/** Explicit delegation avoids depending on parent/child effect registration order. */
export function useBackAction(action: BackAction, register?: RegisterBackAction, enabled = true) {
  const latest = useRef(action);
  latest.current = action;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const handle = () => active && (dismissKeyboardOnBack() || latest.current());
    if (register) {
      register(handle);
      return () => { active = false; register(null); };
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', handle);
    return () => { active = false; subscription.remove(); };
  }, [register, enabled]);
}
