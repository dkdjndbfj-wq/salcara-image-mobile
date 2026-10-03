import { useSyncExternalStore } from 'react';

import { setAppearancePreference, type AppearancePreference } from './theme';

/** 设置 → 外观: follow the system, or always light / dark. Kept on this phone only. */
const SETTING = 'appearance';
let current: AppearancePreference = 'system';
const listeners = new Set<() => void>();
const settings = () => { try { return require('./storage/database') as typeof import('./storage/database'); } catch { return null; } };

export const APPEARANCE_LABEL: Record<AppearancePreference, string> = { system: '跟随系统', light: '浅色', dark: '深色' };

function apply(next: AppearancePreference) {
  current = next;
  setAppearancePreference(next);
  listeners.forEach((listener) => listener());
}

/** Called once at start-up, before the first screen is shown. */
export async function loadAppearance(): Promise<void> {
  try {
    const saved = await settings()?.getSetting(SETTING);
    if (saved === 'light' || saved === 'dark' || saved === 'system') apply(saved);
  } catch { /* first start: follow the system */ }
}

export async function setAppearance(next: AppearancePreference): Promise<void> {
  apply(next);
  try { await settings()?.setSetting(SETTING, next); } catch { /* still applied for this run */ }
}

export function useAppearance(): AppearancePreference {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current, () => current);
}
