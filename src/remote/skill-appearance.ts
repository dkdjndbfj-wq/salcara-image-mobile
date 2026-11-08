import { useScheme } from '../theme';
import { validSkillBrandColor } from './skill-display-metadata';

/** Codex's default inline-mention accent: 80% info + 20% foreground.
 * Kept separate from buttons/links so both composer and history stay identical. */
export function skillMentionColor(defaultColor: string, brandColor?: string) { return validSkillBrandColor(brandColor) ? brandColor : defaultColor; }
export function useSkillMentionColor(brandColor?: string) { return skillMentionColor(useScheme() === 'dark' ? '#A7D1F9' : '#2E82D2', brandColor); }

/** Two-level book marker; contains no text and does not affect caret offsets. */
export const SKILL_ICON_PATH = 'M10.8 1.9 4.2 6v8.5L8.8 18l7-4.3V5.1ZM4.2 6l4.6 3.1 7-4M8.8 9.1V18M4.2 10.7l4.6 3.1 7-4.2';
