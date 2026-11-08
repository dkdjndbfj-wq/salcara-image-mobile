const CODE_FONT_SIZE = 12;
const MONOSPACE_ASCII_ADVANCE = CODE_FONT_SIZE * 0.61;
const MONOSPACE_WIDE_ADVANCE = CODE_FONT_SIZE;
const CODE_HORIZONTAL_PADDING = 22;

function isWideCodePoint(point: number): boolean {
  return (point >= 0x1100 && point <= 0x11ff)
    || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
    || (point >= 0xac00 && point <= 0xd7a3)
    || (point >= 0xf900 && point <= 0xfaff)
    || (point >= 0xfe10 && point <= 0xfe6f)
    || (point >= 0xff00 && point <= 0xffe6)
    || (point >= 0x1f300 && point <= 0x1faff);
}

/**
 * Approximate the unwrapped monospace content width for the bounded command
 * canvas. The horizontal viewport stays screen-sized; its content ends just
 * after the longest source line so a long command can be panned to its edge.
 */
export function toolCodeCanvasWidth(text: string, viewportWidth: number): number {
  let longestLine = 0;
  for (const line of text.split(/\r?\n/)) {
    let width = 0;
    for (const glyph of line) {
      if (glyph === '\t') width += MONOSPACE_ASCII_ADVANCE * 4;
      else width += isWideCodePoint(glyph.codePointAt(0) ?? 0) ? MONOSPACE_WIDE_ADVANCE : MONOSPACE_ASCII_ADVANCE;
    }
    longestLine = Math.max(longestLine, width);
  }
  const minimum = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  return Math.max(minimum, Math.ceil(longestLine + CODE_HORIZONTAL_PADDING));
}
