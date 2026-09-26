export const colors = {
  background: '#FFFFFF',
  surface: '#F6F7F9',
  blueSurface: '#EFF6FF',
  primary: '#4EA8FF',
  primaryStrong: '#2474CD',
  text: '#18212F',
  textMuted: '#748091',
  border: '#E9EDF2',
  ink: '#202C3C',
  subtle: '#A4ADBA',
  danger: '#EF4444',
  dangerSurface: '#FEF2F2',
  warningText: '#9A6700',
  warningSurface: '#FFF7E6',
  success: '#16A34A',
  mask: 'rgba(239, 68, 68, 0.48)',
} as const;

export const type = {
  title: { fontSize: 22, lineHeight: 29, fontWeight: '600' as const },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 23 },
  caption: { fontSize: 12, lineHeight: 18 },
} as const;
export const motion = { enter: 240, exit: 180, press: 110 } as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 12,
  lg: 16,
  pill: 999,
} as const;
