/**
 * Starlight palette of the chat space: the same white-and-blue family as the assistant,
 * leaning towards indigo and violet so the two spaces are told apart at a glance.
 * (The token object keeps the name `warm` so every chat component reads from one place.)
 */
import { registerPalette } from '../theme';

const warmLight = {
  background: '#F5F7FF',
  surface: '#EEF1FF',
  surfaceStrong: '#E4E8FB',
  card: '#FFFFFF',
  border: '#DCE2F6',
  text: '#1B2150',
  textSecondary: '#3A4270',
  muted: '#7A82A6',
  faint: '#B3B9D3',
  accent: '#5B5BF7',
  accentDeep: '#4340D6',
  accentSoft: '#E9E8FF',
  userBubble: '#5B6CFF',
  gradient: ['#7CC6FF', '#6B7CFF', '#A68BF7'] as readonly string[],
};
type Warm = typeof warmLight;
/** The same starlight family at night: deep indigo surfaces, softened violet accents. */
const warmDark: Warm = {
  background: '#10111C',
  surface: '#181A2A',
  surfaceStrong: '#21243A',
  card: '#1A1C2C',
  border: '#2A2D45',
  text: '#E6E8F7',
  textSecondary: '#C2C6E2',
  muted: '#9096B8',
  faint: '#5C6185',
  accent: '#8C8CFF',
  accentDeep: '#ABABFF',
  accentSoft: '#25264A',
  userBubble: '#5B6CFF',
  gradient: ['#7CC6FF', '#6B7CFF', '#A68BF7'],
};
/** Live palette: switches with light / dark (see registerPalette in theme.ts). */
export const warm: Warm = registerPalette({ ...warmLight }, warmLight, warmDark);

/** Gradients used by the space transition. */
export const SPACE_GRADIENTS = {
  assistant: ['#7CC6FF', '#3D7BFA', '#A68BF7'] as const,
  companion: ['#C9BCFF', '#7B6CF6', '#5B8CFF'] as const,
  remote: ['#7CE0C8', '#2E7BF6', '#1B2A6B'] as const,
};
