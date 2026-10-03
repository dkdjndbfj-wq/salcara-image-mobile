export type OrbitNode = {
  index: number;
  /** Center of the horizontal, single-line label. */
  x: number;
  y: number;
  width: number;
  opacity: number;
  interactive: boolean;
};

const NODE_HEIGHT = 44;
const NODE_MIN_WIDTH = 44;
const LABEL_GAP = 8;
const VISIBLE_DELTA = 1.4;
const INTERACTIVE_DELTA = 1.06;

function itemCount(count: number): number {
  return Number.isFinite(count) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(count))) : 0;
}

export function clampOrbitCenter(center: number, count: number): number {
  const last = Math.max(0, itemCount(count) - 1);
  return Math.min(last, Math.max(0, Number.isNaN(center) ? 0 : center));
}

export function orbitCenterAfterSwipe(start: number, dx: number, width: number, count: number): number {
  const origin = clampOrbitCenter(start, count);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(dx)) return origin;
  return clampOrbitCenter(origin - dx / (width * 0.2), count);
}

export function snapOrbitCenter(center: number, count: number): number {
  return Math.round(clampOrbitCenter(center, count));
}

/**
 * Only the visible arc is materialized, even for a very large model catalog.
 * Text is never rotated: these points are centers of ordinary 44px-high labels.
 */
export function orbitNodes({ width, height, center, count }: {
  width: number;
  height: number;
  center: number;
  count: number;
}): OrbitNode[] {
  const size = itemCount(count);
  if (!size || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height < NODE_HEIGHT) return [];

  const position = clampOrbitCenter(center, size);
  const radius = width * (width < 360 ? 0.36 : 0.4);
  const margin = Math.min(56, width / 2);
  const horizontalInset = width >= 72 ? 14 : 0;
  const nodes: OrbitNode[] = [];
  const first = Math.max(0, Math.ceil(position - VISIBLE_DELTA));
  const last = Math.min(size - 1, Math.floor(position + VISIBLE_DELTA));

  for (let index = first; index <= last; index++) {
    const delta = index - position;
    const distance = Math.abs(delta);
    const angle = (-90 + delta * 58) * Math.PI / 180;
    const x = Math.min(width - margin, Math.max(margin, width / 2 + Math.cos(angle) * radius));
    const y = Math.min(height - NODE_HEIGHT / 2, Math.max(NODE_HEIGHT / 2, height - 74 + Math.sin(angle) * radius));
    const availableWidth = Math.max(0, Math.min(2 * (x - horizontalInset), 2 * (width - x - horizontalInset)));
    const preferredWidth = Math.min(width * 0.46, availableWidth);
    nodes.push({
      index,
      x,
      y,
      width: Math.min(availableWidth, Math.max(NODE_MIN_WIDTH, preferredWidth)),
      opacity: Math.min(1, Math.max(0, (VISIBLE_DELTA - distance) / (VISIBLE_DELTA - 1))),
      interactive: distance <= INTERACTIVE_DELTA,
    });
  }

  // Halfway through a swipe, adjacent labels can share a baseline. Narrow them
  // together, retaining the normal integer-center layout whenever it fits.
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const left = nodes[a];
      const right = nodes[b];
      if (Math.abs(left.y - right.y) >= NODE_HEIGHT) continue;
      const maxCombinedWidth = 2 * (Math.abs(left.x - right.x) - LABEL_GAP);
      if (left.width + right.width <= maxCombinedWidth) continue;
      const minLeft = Math.min(NODE_MIN_WIDTH, left.width);
      const minRight = Math.min(NODE_MIN_WIDTH, right.width);
      if (maxCombinedWidth < minLeft + minRight) {
        // An exceptionally narrow viewport cannot fit both touch targets.
        // Keep the closer node instead of overlapping or shrinking unreadably.
        const removeIndex = Math.abs(left.index - position) <= Math.abs(right.index - position) ? b : a;
        nodes.splice(removeIndex, 1);
        a = -1;
        break;
      }
      const reduction = left.width + right.width - maxCombinedWidth;
      const leftRoom = left.width - minLeft;
      const rightRoom = right.width - minRight;
      const room = leftRoom + rightRoom;
      if (room > 0) {
        left.width -= reduction * leftRoom / room;
        right.width -= reduction * rightRoom / room;
      }
    }
  }
  return nodes;
}
