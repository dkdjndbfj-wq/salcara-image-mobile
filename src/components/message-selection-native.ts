import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { SelectionSnapshot } from './message-text-selection';

export interface NativeSelectionEvent extends SelectionSnapshot { token: string }
interface NativeMessageSelection {
  attach(tag: number, token: string, allowAsk: boolean): Promise<boolean>;
  detach(token: string): Promise<void>;
  highlight(token: string, blockIndex: number, start: number, end: number, expected: string): Promise<boolean>;
  addListener(name: 'onSelectionAction', listener: (event: NativeSelectionEvent) => void): { remove(): void };
}
export const nativeMessageSelection = (() => {
  try { return Platform.OS === 'android' ? requireOptionalNativeModule<NativeMessageSelection>('SalcaraMessageSelection') : null; } catch { return null; }
})();
