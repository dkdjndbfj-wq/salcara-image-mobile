import { NOTE_TYPES, type MemLink, type MemNote } from './types';

/**
 * Force-directed layout for the memory canvas: linked notes attract, all
 * notes repel their neighbours (a spatial grid keeps it near O(n)), and each
 * type drifts towards its own sector so the map reads as regions. Positions
 * are kept between sessions; new notes start next to what they link to.
 */

export interface Point { x: number; y: number }

const CELL = 160;
const IDEAL = 110;

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) { value ^= text.charCodeAt(index); value = Math.imul(value, 16777619); }
  return (value >>> 0) / 4294967295;
}

function sectorAnchor(type: MemNote['type'], radius: number): Point {
  const index = NOTE_TYPES.indexOf(type);
  const angle = (index / NOTE_TYPES.length) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function layoutGraph(notes: MemNote[], links: MemLink[], iterations = 60, fixed: Set<string> = new Set()): Map<string, Point> {
  const radius = Math.max(260, Math.sqrt(notes.length) * 70);
  const positions = new Map<string, Point>();
  const byId = new Map(notes.map((note) => [note.id, note]));
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    if (!byId.has(link.source) || !byId.has(link.target)) continue;
    adjacency.set(link.source, [...(adjacency.get(link.source) ?? []), link.target]);
    adjacency.set(link.target, [...(adjacency.get(link.target) ?? []), link.source]);
  }
  // Seed: saved position, else beside a placed neighbour, else in the type's sector.
  for (const note of notes) if (note.x !== null && note.y !== null) positions.set(note.id, { x: note.x, y: note.y });
  const fresh = notes.filter((note) => !positions.has(note.id));
  for (const note of fresh) {
    const placed = (adjacency.get(note.id) ?? []).map((id) => positions.get(id)).find(Boolean);
    const jitter = { x: (hash(note.id) - 0.5) * 120, y: (hash(`${note.id}y`) - 0.5) * 120 };
    const anchor = placed ?? sectorAnchor(note.type, radius * 0.7);
    positions.set(note.id, { x: anchor.x + jitter.x, y: anchor.y + jitter.y });
  }
  const moving = new Set(notes.map((note) => note.id).filter((id) => !fixed.has(id)));
  // New notes move freely; settled ones only drift a little, so the map doesn't reshuffle every time.
  const mobility = new Map(notes.map((note) => [note.id, fresh.includes(note) ? 1 : 0.25]));
  for (let step = 0; step < iterations; step += 1) {
    const temperature = 40 * (1 - step / iterations) + 2;
    const grid = new Map<string, string[]>();
    for (const [id, point] of positions) {
      const key = `${Math.floor(point.x / CELL)},${Math.floor(point.y / CELL)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(id);
    }
    const force = new Map<string, Point>();
    for (const [id, point] of positions) {
      let fx = 0; let fy = 0;
      const cx = Math.floor(point.x / CELL); const cy = Math.floor(point.y / CELL);
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (other === id) continue;
          const q = positions.get(other)!;
          let vx = point.x - q.x; let vy = point.y - q.y;
          let distance = Math.hypot(vx, vy);
          if (distance < 0.01) { vx = hash(id + other) - 0.5; vy = hash(other + id) - 0.5; distance = 0.5; }
          const push = (IDEAL * IDEAL) / distance;
          fx += (vx / distance) * push; fy += (vy / distance) * push;
        }
      }
      for (const other of adjacency.get(id) ?? []) {
        const q = positions.get(other);
        if (!q) continue;
        const vx = q.x - point.x; const vy = q.y - point.y;
        const distance = Math.max(1, Math.hypot(vx, vy));
        const pull = (distance * distance) / IDEAL / 1.5;
        fx += (vx / distance) * pull; fy += (vy / distance) * pull;
      }
      const note = byId.get(id)!;
      const anchor = sectorAnchor(note.type, radius * 0.7);
      fx += (anchor.x - point.x) * 0.02; fy += (anchor.y - point.y) * 0.02;
      force.set(id, { x: fx, y: fy });
    }
    for (const [id, f] of force) {
      if (!moving.has(id)) continue;
      const length = Math.hypot(f.x, f.y);
      if (!length) continue;
      const scale = (Math.min(length, temperature) / length) * (mobility.get(id) ?? 1);
      const point = positions.get(id)!;
      positions.set(id, { x: point.x + f.x * scale, y: point.y + f.y * scale });
    }
  }
  return positions;
}
