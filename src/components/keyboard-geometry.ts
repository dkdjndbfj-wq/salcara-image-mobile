export type WindowFrame = { x: number; y: number; width: number; height: number };
export type KeyboardFrame = { screenX: number; screenY: number; width: number; height: number };

/** Only a keyboard covering this container's bottom edge needs a bottom inset. */
export function keyboardOcclusion(frame: WindowFrame, keyboard?: KeyboardFrame, gap = 0): { inset: number; coversBottom: boolean } {
  const empty = { inset: 0, coversBottom: false };
  if (!keyboard || ![frame.x, frame.y, frame.width, frame.height, keyboard.screenX, keyboard.screenY, keyboard.width, keyboard.height].every(Number.isFinite)
    || frame.width <= 0 || frame.height <= 0 || keyboard.width <= 0 || keyboard.height <= 0) return empty;
  const bottom = frame.y + frame.height;
  if (keyboard.screenX >= frame.x + frame.width || keyboard.screenX + keyboard.width <= frame.x
    || keyboard.screenY > bottom + 1 || keyboard.screenY + keyboard.height < bottom - 1) return empty;
  const overlap = Math.max(0, bottom - keyboard.screenY);
  return { inset: Math.min(frame.height, overlap + (overlap > 0 && Number.isFinite(gap) ? Math.max(0, gap) : 0)), coversBottom: true };
}
