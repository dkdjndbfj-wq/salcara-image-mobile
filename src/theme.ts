import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

/**
 * Salcara design system — white-first surfaces with the logo's sky-blue →
 * violet → pink gradient as the accent. Old token names are kept as aliases.
 */
export const palette = {
  white: '#FFFFFF',
  mist: '#F7F8FD',
  cloud: '#F0F2FA',
  haze: '#E6E9F7',
  line: '#E7E9F3',
  ink: '#0E1325',
  ink2: '#2C3350',
  slate: '#5E6583',
  steel: '#666D89',
  silver: '#BEC3D6',
  sky: '#7CC6FF',
  blue: '#3D7BFA',
  deep: '#2A5CE0',
  violet: '#A68BF7',
  pink: '#F4A6CE',
  peach: '#FFD9BD',
  ice: '#EEF1FF',
} as const;

/** Brand gradient taken from the logo: sky → blue → violet → pink. */
export const brandGradient = ['#7CC6FF', '#3D7BFA', '#A68BF7', '#F4A6CE'] as const;
export const brandStops = brandGradient.map((color, index) => ({ color, offset: index / (brandGradient.length - 1) }));

const lightColors = {
  background: palette.white,
  canvas: palette.white,
  card: palette.white,
  surface: palette.mist,
  surfaceStrong: palette.cloud,
  blueSurface: palette.ice,
  tint: palette.haze,
  primary: palette.blue,
  primaryStrong: palette.blue,
  primaryDeep: palette.deep,
  primarySoft: palette.ice,
  glow: '#D3DAFF',
  accent: palette.violet,
  pink: palette.pink,
  peach: palette.peach,
  text: palette.ink,
  textSecondary: palette.ink2,
  textMuted: palette.slate,
  subtle: palette.steel,
  faint: palette.silver,
  ink: palette.ink,
  onPrimary: palette.white,
  border: palette.line,
  divider: '#EEF0F8',
  userBubble: '#EFF1FE',
  scrim: 'rgba(14, 19, 37, 0.36)',
  danger: '#E5484D',
  dangerSurface: '#FFF1F3',
  warningText: '#A15C07',
  warningSurface: '#FFF7E8',
  success: '#12A150',
  mask: 'rgba(61, 123, 250, 0.42)',
  /** Frosted surface over a picture or a glow (translucent white; a faint veil at night). */
  glass: 'rgba(255, 255, 255, 0.8)',
};
export type Palette = { -readonly [K in keyof typeof lightColors]: string };

/** The same roles at night: soft charcoal surfaces, the brand blue lifted for contrast. */
const darkColors: Palette = {
  background: '#0F1116',
  canvas: '#0F1116',
  card: '#171A21',
  surface: '#1C2028',
  surfaceStrong: '#242933',
  blueSurface: '#1A2236',
  tint: '#262C3A',
  primary: '#6F98FF',
  primaryStrong: '#6F98FF',
  primaryDeep: '#9DB6FF',
  primarySoft: '#1A2236',
  glow: '#2A3557',
  accent: '#B7A2FA',
  pink: '#F4A6CE',
  peach: '#FFD9BD',
  text: '#E8EBF2',
  textSecondary: '#C3C9D6',
  textMuted: '#98A0B3',
  subtle: '#8E96A8',
  faint: '#5D6576',
  ink: '#E8EBF2',
  onPrimary: '#FFFFFF',
  border: '#2A2F3A',
  divider: '#232832',
  userBubble: '#232A3B',
  scrim: 'rgba(0, 0, 0, 0.55)',
  danger: '#F06A70',
  dangerSurface: '#3A1E22',
  warningText: '#E8B15C',
  warningSurface: '#33281A',
  success: '#3DC48A',
  mask: 'rgba(111, 152, 255, 0.42)',
  glass: 'rgba(255, 255, 255, 0.08)',
};

/**
 * 编程 space: the desktop app's look (Salcara Bridge) — quiet grey canvas, white
 * cards with hairline borders, a near-black primary button and the blue only
 * as a small accent. Values mirror remote/bridge/internal/console/web (shell.css, dark.css).
 */
const deskLight = {
  bg: '#F3F5F9', surface: '#FFFFFF', surface2: '#F5F7FB', surface3: '#EDF0F6',
  text: '#141A26', text2: '#3A4356', muted: '#6E7789', faint: '#A3ABBB',
  line: '#E4E8EF', lineStrong: '#D9DEE7',
  ink: '#141A26', onInk: '#FFFFFF',
  accent: '#2F6BFF', accentSoft: 'rgba(47, 107, 255, 0.09)', accentText: '#1F56E0',
  ok: '#12A06A', okSoft: 'rgba(18, 160, 106, 0.10)',
  warn: '#B86E0A', warnSoft: 'rgba(232, 160, 50, 0.14)',
  bad: '#E0444B', badSoft: 'rgba(224, 68, 75, 0.09)',
  press: 'rgba(20, 30, 60, 0.05)', dot: 'rgba(20, 30, 60, 0.07)', glow: '#FFFFFF',
  scrim: 'rgba(20, 26, 38, 0.32)', scrimLight: 'rgba(20, 26, 38, 0.12)',
  shadow: '#1E2846', code: '#151922', codeText: '#D5DAE6', codeMuted: '#8A93A8',
  userBubble: 'rgba(47, 107, 255, 0.08)',
};
export type Desk = { -readonly [K in keyof typeof deskLight]: string };
const deskDark: Desk = {
  bg: '#121419', surface: '#1A1D24', surface2: '#20242C', surface3: '#282D37',
  text: '#E8EBF2', text2: '#B9C0CF', muted: '#8E96A8', faint: '#5D6576',
  line: '#2A2F3A', lineStrong: '#343A46',
  ink: '#E8EBF2', onInk: '#11141A',
  accent: '#6F98FF', accentSoft: 'rgba(111, 152, 255, 0.14)', accentText: '#9DB6FF',
  ok: '#3DC48A', okSoft: 'rgba(61, 196, 138, 0.14)',
  warn: '#E8A23C', warnSoft: 'rgba(232, 162, 60, 0.16)',
  bad: '#F06A70', badSoft: 'rgba(240, 106, 112, 0.14)',
  press: 'rgba(255, 255, 255, 0.06)', dot: 'rgba(255, 255, 255, 0.06)', glow: 'rgba(255, 255, 255, 0.06)',
  scrim: 'rgba(0, 0, 0, 0.55)', scrimLight: 'rgba(0, 0, 0, 0.3)',
  shadow: '#000000', code: '#0D0F13', codeText: '#D5DAE6', codeMuted: '#7A8396',
  userBubble: 'rgba(111, 152, 255, 0.16)',
};

/* ---------- light / dark ---------- */
export type Scheme = 'light' | 'dark';
export type AppearancePreference = 'system' | 'light' | 'dark';
/**
 * Dark mode is switched on only once every screen reads its colours through
 * themed()/useColors(); until then the app stays light so nothing is half dark.
 */
export const DARK_MODE_READY = true;
let preference: AppearancePreference = 'system';
function systemScheme(): Scheme { try { return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } }
function resolveScheme(): Scheme { return !DARK_MODE_READY ? 'light' : preference === 'system' ? systemScheme() : preference; }
let scheme: Scheme = resolveScheme();
const schemeListeners = new Set<() => void>();

/** Live palette. Styles made with themed() follow the scheme; reading colors.* in render does too. */
export const colors: Palette = { ...(scheme === 'dark' ? darkColors : lightColors) };
export const desk: Desk = { ...(scheme === 'dark' ? deskDark : deskLight) };

/** Other palettes (e.g. the chat space's `warm`) switch in place together with `colors`. */
const palettes: Array<{ target: Record<string, unknown>; light: Record<string, unknown>; dark: Record<string, unknown> }> = [];
export function registerPalette<T extends Record<string, unknown>>(target: T, light: T, dark: T): T {
  palettes.push({ target, light, dark });
  Object.assign(target, scheme === 'dark' ? dark : light);
  return target;
}

function applyScheme() {
  const next = resolveScheme();
  if (next === scheme) return;
  scheme = next;
  Object.assign(colors, next === 'dark' ? darkColors : lightColors);
  Object.assign(desk, next === 'dark' ? deskDark : deskLight);
  for (const item of palettes) Object.assign(item.target, next === 'dark' ? item.dark : item.light);
  // Styles are built per scheme on the next render, after every palette above has switched.
  schemeListeners.forEach((listener) => listener());
}
try { Appearance.addChangeListener?.(() => applyScheme()); } catch { /* test hosts */ }

export function setAppearancePreference(next: AppearancePreference) {
  preference = next;
  if (DARK_MODE_READY) {
    // Native pieces (keyboard, system dialogs) follow the same choice.
    try { Appearance.setColorScheme?.((next === 'system' ? 'unspecified' : next) as never); } catch { /* older hosts */ }
  }
  applyScheme();
}
export function currentScheme(): Scheme { return scheme; }
function subscribeScheme(listener: () => void) { schemeListeners.add(listener); return () => { schemeListeners.delete(listener); }; }
export function useScheme(): Scheme { return useSyncExternalStore(subscribeScheme, () => scheme, () => scheme); }
export function useColors(): Palette { return useScheme() === 'dark' ? darkColors : lightColors; }
export function useDesk(): Desk { return useScheme() === 'dark' ? deskDark : deskLight; }

/**
 * Styles that follow light / dark (any palette read inside the factory, `colors.x` included, is
 * already switched when it runs): `const useStyles = themed((c, d) => StyleSheet.create({...}))`
 * and `const styles = useStyles()` inside the component. Built once per scheme.
 */
export function themed<T>(factory: (c: Palette, d: Desk, s: Scheme) => T): (() => T) & { current: () => T } {
  const cache: Partial<Record<Scheme, T>> = {};
  const build = (s: Scheme) => (cache[s] ??= factory(s === 'dark' ? darkColors : lightColors, s === 'dark' ? deskDark : deskLight, s));
  function useThemedStyles() { return build(useScheme()); }
  /** For plain helpers called while a component renders (not a hook). */
  useThemedStyles.current = () => build(scheme);
  return useThemedStyles;
}

export const type = {
  display: { fontSize: 30, lineHeight: 38, fontWeight: '600' as const, letterSpacing: -0.8 },
  title: { fontSize: 20, lineHeight: 28, fontWeight: '600' as const, letterSpacing: -0.3 },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 26 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const },
  caption: { fontSize: 12, lineHeight: 17 },
} as const;

export const motion = { enter: 280, exit: 200, press: 120, stagger: 60 } as const;
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;

export const shadow = {
  soft: { shadowColor: '#1B2150', shadowOpacity: 0.06, shadowRadius: 16, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
  float: { shadowColor: '#1B2150', shadowOpacity: 0.1, shadowRadius: 28, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
  glow: { shadowColor: '#5A6CF6', shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
} as const;

/** Friendly display name for raw model IDs, e.g. “claude-sonnet-4-5” → “Claude Sonnet 4.5”. */
export function prettyModel(id?: string | null): string {
  if (!id) return '';
  const base = id.split('/').pop() ?? id;
  const words = base.replace(/[-_](\d{8}|latest|preview)$/i, '').split(/[-_\s]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const next = words[i + 1];
    if (/^\d+$/.test(word) && next && /^\d$/.test(next)) { out.push(`${word}.${next}`); i += 1; continue; }
    if (/^gpt$/i.test(word)) { out.push('GPT'); continue; }
    if (/^o\d/i.test(word) || /^\d/.test(word)) { out.push(word); continue; }
    out.push(word.length <= 3 && /^[a-z]+$/i.test(word) && !/^(pro|max|mini|air|lite|fast|turbo|flash|nano)$/i.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1));
  }
  return out.join(' ').replace(/GPT (\d)/, 'GPT-$1').replace(/GPT Image/, 'GPT Image');
}
