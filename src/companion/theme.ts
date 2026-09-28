/**
 * Starlight palette of the chat space: the same white-and-blue family as the assistant,
 * leaning towards indigo and violet so the two spaces are told apart at a glance.
 * (The token object keeps the name `warm` so every chat component reads from one place.)
 */
export const warm = {
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
  gradient: ['#7CC6FF', '#6B7CFF', '#A68BF7'] as const,
} as const;

/** Gradients used by the space transition. */
export const SPACE_GRADIENTS = {
  assistant: ['#7CC6FF', '#3D7BFA', '#A68BF7'] as const,
  companion: ['#C9BCFF', '#7B6CF6', '#5B8CFF'] as const,
};
