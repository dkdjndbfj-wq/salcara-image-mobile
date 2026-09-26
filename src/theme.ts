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
  steel: '#8F95AE',
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

export const colors = {
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
} as const;

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
