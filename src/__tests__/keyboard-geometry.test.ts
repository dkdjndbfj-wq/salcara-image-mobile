import { keyboardOcclusion } from '../components/keyboard-geometry';

const phone = { x: 0, y: 0, width: 390, height: 844 };
const phoneKeyboard = { screenX: 0, screenY: 508, width: 390, height: 336 };
const clear = { inset: 0, coversBottom: false };

test('a phone soft keyboard reserves the exact obscured screen area', () => {
  expect(keyboardOcclusion(phone, phoneKeyboard)).toEqual({ inset: 336, coversBottom: true });
});

test('headers and an ancestor safe area use measured screen coordinates without adding their offsets twice', () => {
  const content = { x: 0, y: 96, width: 390, height: 714 }; // bottom = 810, above the home indicator
  expect(keyboardOcclusion(content, phoneKeyboard)).toEqual({ inset: 302, coversBottom: true });
});

test('a tablet also moves for its full-width software keyboard', () => {
  const tablet = { x: 0, y: 24, width: 1194, height: 1000 };
  const keyboard = { screenX: 0, screenY: 624, width: 1194, height: 400 };
  expect(keyboardOcclusion(tablet, keyboard)).toEqual({ inset: 400, coversBottom: true });
});

test('a keyboard spanning tablet columns covers a side-chat pane as well as the main pane', () => {
  const keyboard = { screenX: 0, screenY: 540, width: 1194, height: 294 };
  expect(keyboardOcclusion({ x: 264, y: 88, width: 436, height: 746 }, keyboard)).toEqual({ inset: 294, coversBottom: true });
  expect(keyboardOcclusion({ x: 712, y: 88, width: 482, height: 746 }, keyboard)).toEqual({ inset: 294, coversBottom: true });
});

test('Android adjustResize already ending at the keyboard adds no duplicate padding or gap', () => {
  const resized = { x: 0, y: 48, width: 390, height: 460 };
  expect(keyboardOcclusion(resized, phoneKeyboard, 8)).toEqual({ inset: 0, coversBottom: true });
});

test('the old portrait keyboard frame cannot create a gap after rotation', () => {
  const landscape = { x: 0, y: 0, width: 844, height: 390 };
  expect(keyboardOcclusion(landscape, phoneKeyboard)).toEqual(clear);
  expect(keyboardOcclusion(landscape, { screenX: 0, screenY: 170, width: 844, height: 220 })).toEqual({ inset: 220, coversBottom: true });
});

test('a floating tablet keyboard above the bottom edge does not lift the whole workspace', () => {
  expect(keyboardOcclusion({ x: 0, y: 24, width: 1194, height: 1000 },
    { screenX: 600, screenY: 520, width: 320, height: 260 })).toEqual(clear);
});

test('a floating keyboard beside a pane does not move that pane even when aligned to its bottom', () => {
  expect(keyboardOcclusion({ x: 0, y: 0, width: 600, height: 844 },
    { screenX: 700, screenY: 584, width: 320, height: 260 })).toEqual(clear);
});

test('touching only a horizontal edge does not count as obscuring the pane', () => {
  expect(keyboardOcclusion({ x: 0, y: 0, width: 300, height: 844 },
    { screenX: 300, screenY: 508, width: 390, height: 336 })).toEqual(clear);
});

test('an external keyboard with no software keyboard leaves no reserved space', () => {
  expect(keyboardOcclusion(phone)).toEqual(clear);
  expect(keyboardOcclusion(phone, { screenX: 0, screenY: 844, width: 390, height: 0 })).toEqual(clear);
});

test('an external-keyboard accessory bar reserves only its actual height', () => {
  expect(keyboardOcclusion(phone, { screenX: 0, screenY: 800, width: 390, height: 44 })).toEqual({ inset: 44, coversBottom: true });
});

test('additional spacing applies only to a real overlap and cannot exceed the measured pane', () => {
  expect(keyboardOcclusion(phone, phoneKeyboard, 8)).toEqual({ inset: 344, coversBottom: true });
  expect(keyboardOcclusion(phone, phoneKeyboard, -8)).toEqual({ inset: 336, coversBottom: true });
  expect(keyboardOcclusion({ x: 0, y: 700, width: 390, height: 100 }, phoneKeyboard, 8)).toEqual({ inset: 100, coversBottom: true });
});

test('a small bottom-edge rounding error still recognizes a docked keyboard', () => {
  expect(keyboardOcclusion(phone, { ...phoneKeyboard, height: 335.5 })).toEqual({ inset: 336, coversBottom: true });
  expect(keyboardOcclusion(phone, { ...phoneKeyboard, height: 334 })).toEqual(clear);
});

test.each([
  { ...phone, width: 0 }, { ...phone, height: -1 }, { ...phone, x: Number.NaN },
  { ...phone, y: Number.POSITIVE_INFINITY }, { ...phone, height: Number.POSITIVE_INFINITY },
])('invalid or unmeasured content geometry stays neutral: %j', frame => {
  expect(keyboardOcclusion(frame, phoneKeyboard)).toEqual(clear);
});

test.each([
  { ...phoneKeyboard, width: 0 }, { ...phoneKeyboard, height: -1 }, { ...phoneKeyboard, screenX: Number.NaN },
  { ...phoneKeyboard, screenY: Number.POSITIVE_INFINITY }, { ...phoneKeyboard, width: Number.POSITIVE_INFINITY },
])('invalid keyboard geometry stays neutral: %j', keyboard => {
  expect(keyboardOcclusion(phone, keyboard)).toEqual(clear);
});
