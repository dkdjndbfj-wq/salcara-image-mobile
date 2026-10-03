import React, { type RefObject } from 'react';
import { Animated, Image, Platform, StyleSheet, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { themed } from '../theme';
/** Progress 1 = intact surface, 0 = fully dissolved. The reverse run reassembles it. */
export const COMPOSER_DISSOLVE_MS = 640;
export interface SurfaceTexture { uri: string; width: number; height: number }

// Deterministic pseudo-noise so every run (and every test) is identical.
const noise = (seed: number) => { const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

const COLUMNS = 12;
const ROWS = 3;
/**
 * The real surface is cut into small tiles. A soft front sweeps from right to
 * left; each tile lifts up-left, shrinks, turns slightly and fades — dust in a
 * breeze rather than an explosion. `start`/`span` are in dissolve time (1 − progress).
 */
export const DISSOLVE_TILES = Array.from({ length: COLUMNS * ROWS }, (_, id) => {
  const column = id % COLUMNS, row = Math.floor(id / COLUMNS);
  const sweep = 1 - column / (COLUMNS - 1);
  return {
    id, column, row,
    start: Math.min(0.62, 0.02 + sweep * 0.5 + noise(id) * 0.1),
    span: 0.3 + noise(id + 40) * 0.08,
    dx: -(16 + noise(id + 80) * 22), dy: -(4 + noise(id + 120) * 14) + (row - 1) * 3,
    turn: (noise(id + 160) - 0.5) * 14,
  };
});

/** Fine dust shed by the tiles; muted ink with a faint brand tint, never confetti. */
export const DISSOLVE_FRAGMENTS = Array.from({ length: 36 }, (_, id) => {
  const x = 4 + noise(id + 200) * 92;
  return {
    id, x, y: 12 + noise(id + 240) * 76,
    phase: Math.min(0.92, 0.08 + (1 - x / 100) * 0.55 + noise(id + 280) * 0.12),
    size: 1 + noise(id + 320) * 1.6, distance: 18 + noise(id + 360) * 24, drift: -(2 + noise(id + 400) * 10),
    color: ['#8E98B8', '#A7B6E8', '#B9A9EE', '#9AA4C2'][id % 4], peak: 0.35 + noise(id + 440) * 0.35,
  };
});

/** An ephemeral local render texture: no files, uploads, pixel logging or retained screenshots. */
export async function captureDissolveTexture(ref: RefObject<View | null>, size: { width: number; height: number }): Promise<SurfaceTexture | undefined> {
  if (Platform.OS === 'web' || !ref.current || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      captureRef(ref, { format: 'png', result: 'base64', width: Math.ceil(size.width), height: Math.ceil(size.height) }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 100); }),
    ]);
    return typeof result === 'string' && result ? { uri: `data:image/png;base64,${result}`, ...size } : undefined;
  } catch { return undefined; } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Maps dissolve time t∈[a,b] (ease-out) onto progress, which runs 1 → 0. */
function along(progress: Animated.Value, a: number, b: number, from: number, to: number) {
  const p0 = Math.max(0, Math.min(1, 1 - b)), p1 = Math.max(p0 + 0.0001, Math.min(1, 1 - a));
  const mid = p0 + (p1 - p0) * 0.45; // ~70 % of the motion happens in the first half (ease-out)
  const value = from + (to - from) * 0.72;
  return progress.interpolate({ inputRange: [0, p0, mid, p1, 1], outputRange: [to, to, value, from, from], extrapolate: 'clamp' });
}

export function ComposerDissolve({ progress, texture, testId = 'remote-composer' }: { progress: Animated.Value; texture?: SurfaceTexture; testId?: string }) {
  const styles = useStyles();
  const tileWidth = texture ? texture.width / COLUMNS : 0, tileHeight = texture ? texture.height / ROWS : 0;
  return <View testID={`${testId}-dissolve`} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
    {texture ? DISSOLVE_TILES.map((tile) => {
      const left = tile.column * tileWidth, top = tile.row * tileHeight, end = tile.start + tile.span;
      return <Animated.View key={`tile:${tile.id}`} testID={`${testId}-sample-${tile.id}`} style={[styles.tile, {
        left, top, width: tileWidth + 0.5, height: tileHeight + 0.5,
        opacity: along(progress, tile.start + tile.span * 0.15, end, 1, 0),
        transform: [
          { translateX: along(progress, tile.start, end, 0, tile.dx) },
          { translateY: along(progress, tile.start, end, 0, tile.dy) },
          { rotate: along(progress, tile.start, end, 0, tile.turn).interpolate({ inputRange: [-360, 360], outputRange: ['-360deg', '360deg'] }) },
          { scale: along(progress, tile.start, end, 1, 0.35) },
        ],
      }]}><Image accessible={false} source={{ uri: texture.uri }} resizeMode="stretch" style={{ position: 'absolute', left: -left, top: -top, width: texture.width, height: texture.height }} /></Animated.View>;
    }) : null}
    {DISSOLVE_FRAGMENTS.map((particle) => {
      const end = Math.min(1, particle.phase + 0.34);
      return <Animated.View key={`particle:${particle.id}`} testID={`${testId}-particle-${particle.id}`} style={[styles.particle, {
        left: `${particle.x}%`, top: `${particle.y}%`, width: particle.size, height: particle.size, borderRadius: particle.size / 2, backgroundColor: particle.color,
        opacity: progress.interpolate({ inputRange: [0, Math.max(0, 1 - end), Math.max(0, 1 - particle.phase - 0.08), Math.max(0.0001, 1 - particle.phase), 1], outputRange: [0, 0, particle.peak, 0, 0], extrapolate: 'clamp' }),
        transform: [
          { translateX: along(progress, particle.phase, end, 0, -particle.distance) },
          { translateY: along(progress, particle.phase, end, 0, particle.drift) },
        ],
      }]} />;
    })}
  </View>;
}
const useStyles = themed((c, d) => StyleSheet.create({
  tile: { position: 'absolute', overflow: 'hidden' },
  particle: { position: 'absolute' },
}));
