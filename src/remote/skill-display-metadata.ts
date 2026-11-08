/** Display snapshots never participate in skill identity or command execution. */
export interface SkillDisplayMetadata { displayName?: string; brandColor?: string; iconSmall?: string }
export const skillDisplayName = (skill: { name: string; displayName?: string }) => skill.displayName || skill.name;
export const validSkillDisplayName = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 200 && [...value].reduce((n, c) => n + (c.length === 2 ? 4 : c.charCodeAt(0) < 128 ? 1 : c.charCodeAt(0) < 2048 ? 2 : 3), 0) <= 200
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
export const validSkillBrandColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
/** Only Bridge-normalized tiny PNGs. URLs, SVG and remote paths are never loaded. */
export function validSkillIcon(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 5486 || !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const encoded = value.slice(22); if (encoded.length % 4 !== 0) return false;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes: number[] = []; let bits = 0, count = 0;
  for (const char of encoded.slice(0, 44)) { const digit = alphabet.indexOf(char); if (digit < 0) break; bits = (bits << 6) | digit; count += 6; if (count >= 8) { count -= 8; bytes.push((bits >> count) & 255); } }
  const uint = (at: number) => (bytes[at] * 0x1000000 + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]);
  return bytes.length >= 24 && uint(8) === 13 && bytes.slice(12, 16).join(',') === '73,72,68,82' && uint(16) > 0 && uint(16) <= 32 && uint(20) > 0 && uint(20) <= 32;
}
export function validSkillDisplay(value: Record<string, unknown>): boolean {
  return (value.displayName === undefined || validSkillDisplayName(value.displayName))
    && (value.brandColor === undefined || validSkillBrandColor(value.brandColor)) && (value.iconSmall === undefined || validSkillIcon(value.iconSmall));
}
export function skillDisplayMetadata(value: SkillDisplayMetadata): SkillDisplayMetadata {
  return { ...(validSkillDisplayName(value.displayName) ? { displayName: value.displayName } : {}),
    ...(validSkillBrandColor(value.brandColor) ? { brandColor: value.brandColor } : {}), ...(validSkillIcon(value.iconSmall) ? { iconSmall: value.iconSmall } : {}) };
}
export function copySkillReference<T extends { name: string; path?: string } & SkillDisplayMetadata>(skill: T) {
  return { name: skill.name, ...(skill.path !== undefined ? { path: skill.path } : {}), ...skillDisplayMetadata(skill) };
}
