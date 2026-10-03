import { Linking } from 'react-native';

/**
 * Light-touch pointers to the official Salcara relay. The app stays free and
 * fully usable with any relay: nothing here gates a feature. Forks can set
 * `enabled: false` (or change the URL) in this one place.
 */
export const PROMO = {
  enabled: true,
  name: 'Salcara 中转站',
  host: 'salcara.top',
  url: 'https://salcara.top',
  /** Days a dismissed card stays hidden. */
  snoozeDays: 30,
} as const;

export const promoUrl = (place: string) => `${PROMO.url}/?utm_source=salcara-app&utm_medium=${encodeURIComponent(place)}`;

export async function openPromo(place: string): Promise<void> {
  if (!PROMO.enabled) return;
  try { await Linking.openURL(promoUrl(place)); } catch { /* the link is optional */ }
}

/** True when this looks like someone already on the official relay; they never see the card. */
export function usesOfficialRelay(values: ReadonlyArray<string | null | undefined>): boolean {
  return values.some((value) => typeof value === 'string' && value.toLowerCase().includes(PROMO.host.split('.')[0]));
}

type SettingsStore = { getSetting: (key: string) => Promise<string | null>; setSetting: (key: string, value: string | null) => Promise<void> };
// Loaded lazily so screens and tests that never touch storage do not open the database.
const store = (): SettingsStore | null => { try { return require('./storage/database') as SettingsStore; } catch { return null; } };

export async function promoSnoozed(place: string): Promise<boolean> {
  try {
    const raw = await store()?.getSetting(`promo.dismissed.${place}`);
    const at = raw ? Number(raw) : 0;
    return Number.isFinite(at) && at > 0 && Date.now() - at < PROMO.snoozeDays * 86400000;
  } catch { return false; }
}

export async function snoozePromo(place: string): Promise<void> {
  try { await store()?.setSetting(`promo.dismissed.${place}`, String(Date.now())); } catch { /* best effort */ }
}
