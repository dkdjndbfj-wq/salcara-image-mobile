import React, { useRef } from 'react';
import Svg, { ClipPath, Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';

/**
 * The Salcara ribbon logo as vector artwork (same geometry as
 * assets/brand-logo.svg, 1024×1024 box). Two ribbon shapes, each repeated
 * with a half-turn, so the mark looks identical after rotating 180°.
 */
const A_SHAPE = 'M385 542 C325 542 250 505 224 430 C192 345 208 235 278 160 C345 88 450 54 545 56 C660 58 770 128 808 290 L760 300 C700 245 600 215 520 225 C455 240 415 300 400 370 C390 430 392 500 385 542 Z';
const A_FOLD = 'M390 560 C395 300 430 215 490 150 C550 95 620 78 700 70 L900 60 L900 420 Z';
const A_RIM = 'M385 542 C325 542 250 505 224 430 C192 345 208 235 278 160 C345 88 450 54 545 56 C660 58 770 128 808 290';
const B_SHAPE = 'M455 262 C520 215 640 212 760 250 C895 295 992 400 994 515 C996 628 915 718 808 757 C845 690 868 610 838 525 C805 440 720 405 625 385 C545 368 490 320 455 262 Z';
const B_SHEEN = 'M470 258 C540 222 650 225 760 262 C880 305 965 400 968 515 C970 615 905 700 815 750';
const B_RIM = 'M455 262 C520 215 640 212 760 250 C895 295 992 400 994 515 C996 628 915 718 808 757';
/** Half-turn about the mark's centre (with the slight scale the artwork has). */
const HALF_TURN = 'matrix(-0.98 0 0 -0.98 1005.84 1029.6)';

export type RibbonPart = 'a' | 'b' | 'a2' | 'b2';
export const RIBBON_ORDER: RibbonPart[] = ['a', 'a2', 'b', 'b2'];
/** Unit direction pointing from the centre towards each ribbon, used by the launch animation. */
export const RIBBON_DIRECTION: Record<RibbonPart, { x: number; y: number }> = {
  a: { x: -0.38, y: -0.92 }, a2: { x: 0.38, y: 0.92 }, b: { x: 0.98, y: -0.2 }, b2: { x: -0.98, y: 0.2 },
};

let seed = 0;
function useUid(): string {
  const ref = useRef('');
  if (!ref.current) { seed += 1; ref.current = `lg${seed}`; }
  return ref.current;
}

function Gradients({ uid, parts }: { uid: string; parts: RibbonPart[] }) {
  const needsA = parts.some((part) => part.startsWith('a'));
  const needsB = parts.some((part) => part.startsWith('b'));
  return <Defs>
    {needsA && <>
      <LinearGradient id={`${uid}af`} gradientUnits="userSpaceOnUse" x1="380" y1="540" x2="640" y2="60">
        <Stop offset="0" stopColor="#FFE7BD" /><Stop offset="0.16" stopColor="#FFC6D4" /><Stop offset="0.34" stopColor="#F6A9DC" />
        <Stop offset="0.64" stopColor="#A98BF8" /><Stop offset="1" stopColor="#D9D2FF" />
      </LinearGradient>
      <LinearGradient id={`${uid}ad`} gradientUnits="userSpaceOnUse" x1="410" y1="330" x2="800" y2="160">
        <Stop offset="0" stopColor="#2F6BF6" /><Stop offset="0.5" stopColor="#5A9CFC" /><Stop offset="1" stopColor="#A9D4FF" />
      </LinearGradient>
      <ClipPath id={`${uid}ac`}><Path d={A_SHAPE} /></ClipPath>
    </>}
    {needsB && <LinearGradient id={`${uid}bf`} gradientUnits="userSpaceOnUse" x1="460" y1="262" x2="820" y2="760">
      <Stop offset="0" stopColor="#B9E2FF" /><Stop offset="0.38" stopColor="#4D96FB" /><Stop offset="0.66" stopColor="#3E80F8" /><Stop offset="1" stopColor="#BBD7FF" />
    </LinearGradient>}
  </Defs>;
}

function Ribbon({ uid, part }: { uid: string; part: RibbonPart }) {
  const flipped = part.endsWith('2');
  if (part.startsWith('a')) {
    return <G transform={flipped ? HALF_TURN : undefined}>
      <Path d={A_SHAPE} fill={`url(#${uid}af)`} />
      <Path d={A_FOLD} fill={`url(#${uid}ad)`} clipPath={`url(#${uid}ac)`} />
      <Path d={A_RIM} fill="none" stroke="#FFFFFF" strokeOpacity={0.45} strokeWidth={3} />
    </G>;
  }
  return <G transform={flipped ? HALF_TURN : undefined}>
    <Path d={B_SHAPE} fill={`url(#${uid}bf)`} />
    <Path d={B_SHEEN} fill="none" stroke="#FFFFFF" strokeOpacity={0.22} strokeWidth={16} strokeLinecap="round" />
    <Path d={B_RIM} fill="none" stroke="#FFFFFF" strokeOpacity={0.5} strokeWidth={3} />
  </G>;
}

/** The full mark, or selected ribbons of it (the launch animation moves each ribbon on its own layer). */
export function LogoArt({ size, parts = RIBBON_ORDER }: { size: number; parts?: RibbonPart[] }) {
  const uid = useUid();
  return <Svg width={size} height={size} viewBox="0 0 1024 1024">
    <Gradients uid={uid} parts={parts} />
    {RIBBON_ORDER.filter((part) => parts.includes(part)).map((part) => <Ribbon key={part} uid={uid} part={part} />)}
  </Svg>;
}
