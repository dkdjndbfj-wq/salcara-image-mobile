import { useCallback, useEffect, useState } from 'react';
import { Keyboard } from 'react-native';

/** Focus and keyboard geometry only affect presentation, never stored drafts or
 * the panel's expanded state. A source change cannot carry focus to another chat. */
export function useSideQuestionComposerLayout(scope: string, availableHeight?: number) {
  const [editingScope, setEditingScope] = useState<string>();
  const setEditing = useCallback((editing: boolean) => setEditingScope(editing ? scope : undefined), [scope]);
  useEffect(() => { setEditingScope(undefined); }, [scope]);
  useEffect(() => { const listener = Keyboard.addListener('keyboardDidHide', () => setEditingScope(undefined)); return () => listener.remove(); }, []);
  return { compact: editingScope === scope && availableHeight !== undefined && availableHeight < 420, setEditing };
}
