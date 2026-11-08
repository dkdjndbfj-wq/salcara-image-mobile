import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export interface NativeSkillRun { start: number; end: number; name: string; label: string; color: string; iconSmall?: string }
interface NativeSkillInput { setMentions(tag: number, expected: string, entries: NativeSkillRun[]): Promise<{ height: number } | null> }
export const nativeSkillInput = (() => { try { return Platform.OS === 'android' ? requireOptionalNativeModule<NativeSkillInput>('SalcaraSkillInput') : null; } catch { return null; } })();
