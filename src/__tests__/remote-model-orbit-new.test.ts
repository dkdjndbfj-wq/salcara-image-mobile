import { clampOrbitCenter, orbitCenterAfterSwipe, orbitNodes, snapOrbitCenter } from '../remote/model-orbit';

const COUNTS = [0, 1, 2, 6, 50];

function expectSafeLayout(width: number, height: number, center: number, count: number) {
  const nodes = orbitNodes({ width, height, center, count });
  for (const node of nodes) {
    expect(Number.isFinite(node.x)).toBe(true);
    expect(Number.isFinite(node.y)).toBe(true);
    expect(Number.isFinite(node.width)).toBe(true);
    expect(node.index).toBeGreaterThanOrEqual(0);
    expect(node.index).toBeLessThan(count);
    expect(node.x - node.width / 2).toBeGreaterThanOrEqual(-0.00001);
    expect(node.x + node.width / 2).toBeLessThanOrEqual(width + 0.00001);
    expect(node.y - 22).toBeGreaterThanOrEqual(0);
    expect(node.y + 22).toBeLessThanOrEqual(height);
    expect(node.opacity).toBeGreaterThanOrEqual(0);
    expect(node.opacity).toBeLessThanOrEqual(1);
    expect(node.interactive).toBe(Math.abs(node.index - clampOrbitCenter(center, count)) <= 1.06);
  }
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (Math.abs(a.y - b.y) < 44) {
        expect(Math.abs(a.x - b.x) - (a.width + b.width) / 2).toBeGreaterThanOrEqual(8 - 0.00001);
      }
    }
  }
  return nodes;
}

describe('model orbit centers', () => {
  test.each(COUNTS)('clamps and snaps a %i-item catalog', count => {
    const last = Math.max(0, count - 1);
    expect(clampOrbitCenter(-10, count)).toBe(0);
    expect(clampOrbitCenter(last + 10, count)).toBe(last);
    expect(clampOrbitCenter(Infinity, count)).toBe(last);
    expect(clampOrbitCenter(-Infinity, count)).toBe(0);
    expect(clampOrbitCenter(NaN, count)).toBe(0);
    expect(snapOrbitCenter(-10, count)).toBe(0);
    expect(snapOrbitCenter(last + 10, count)).toBe(last);
    if (count > 1) {
      expect(clampOrbitCenter(0.49, count)).toBe(0.49);
      expect(snapOrbitCenter(0.49, count)).toBe(0);
      expect(snapOrbitCenter(0.5, count)).toBe(1);
    }
  });

  test.each(COUNTS)('swipes within a %i-item catalog without selecting', count => {
    const last = Math.max(0, count - 1);
    expect(orbitCenterAfterSwipe(0, -78, 390, count)).toBe(Math.min(1, last));
    expect(orbitCenterAfterSwipe(last, 78, 390, count)).toBe(Math.max(0, last - 1));
    expect(orbitCenterAfterSwipe(0, 10000, 390, count)).toBe(0);
    expect(orbitCenterAfterSwipe(0, -10000, 390, count)).toBe(last);
    expect(orbitCenterAfterSwipe(last + 20, 0, 390, count)).toBe(last);
    expect(orbitCenterAfterSwipe(0.5, -32, 320, count)).toBe(Math.min(1, last));
    for (const width of [0, -1, NaN, Infinity]) {
      expect(orbitCenterAfterSwipe(last, 20, width, count)).toBe(last);
    }
    expect(orbitCenterAfterSwipe(last, NaN, 390, count)).toBe(last);
  });

  test('normalizes invalid or fractional counts', () => {
    for (const count of [-2, NaN, Infinity]) {
      expect(clampOrbitCenter(3, count)).toBe(0);
      expect(orbitNodes({ width: 390, height: 340, center: 3, count })).toEqual([]);
    }
    expect(clampOrbitCenter(10, 2.8)).toBe(1);
  });
});

describe('horizontal model labels along a radial arc', () => {
  test.each(COUNTS)('safely positions %i items at integer and fractional centers', count => {
    for (const width of [288, 320, 390]) {
      for (let center = 0; center <= Math.max(0, count - 1); center += 0.1) {
        const nodes = expectSafeLayout(width, 340, center, count);
        expect(nodes.length).toBeLessThanOrEqual(3);
        for (const node of nodes) expect(node.width).toBeGreaterThanOrEqual(44);
      }
      expectSafeLayout(width, 340, -10, count);
      expectSafeLayout(width, 340, count + 10, count);
    }
  });

  test.each([288, 320, 390])('preserves the approved three-node integer layout at %ipx', width => {
    const nodes = orbitNodes({ width, height: 340, center: 2, count: 6 });
    expect(nodes.map(node => node.index)).toEqual([1, 2, 3]);
    const radius = width * (width < 360 ? 0.36 : 0.4);
    for (const node of nodes) {
      const angle = (-90 + (node.index - 2) * 58) * Math.PI / 180;
      expect(node.x).toBeCloseTo(Math.min(width - 56, Math.max(56, width / 2 + Math.cos(angle) * radius)));
      expect(node.y).toBeCloseTo(340 - 74 + Math.sin(angle) * radius);
      expect(node.width).toBeCloseTo(Math.max(44, Math.min(width * 0.46, 2 * (node.x - 14), 2 * (width - node.x - 14))));
      expect(node.opacity).toBe(1);
      expect(node.interactive).toBe(true);
    }
  });

  test.each([288, 320, 390])('narrows adjacent labels sharing a baseline at %ipx', width => {
    const nodes = expectSafeLayout(width, 340, 1.5, 6);
    expect(nodes.map(node => node.index)).toEqual([1, 2]);
    expect(nodes[0].y).toBeCloseTo(nodes[1].y);
    expect(nodes[0].width).toBeCloseTo(nodes[1].width);
    expect(Math.abs(nodes[0].x - nodes[1].x) - nodes[0].width).toBeCloseTo(8);
  });

  test('fades peripheral labels and disables them before leaving the arc', () => {
    const nodes = orbitNodes({ width: 390, height: 340, center: 1.3, count: 6 });
    const outer = nodes.find(node => node.index === 0)!;
    expect(outer.opacity).toBeCloseTo(0.25);
    expect(outer.interactive).toBe(false);
    expect(nodes.find(node => node.index === 1)?.interactive).toBe(true);
  });

  test.each(COUNTS)('handles narrow or resized viewports with %i items', count => {
    for (const width of [24, 44, 72, 96, 112, 180, 250, 288, 320, 390, 600]) {
      for (const height of [44, 120, 200, 340, 600]) {
        for (const center of [0, 0.3, 0.5, 1, 1.5, count - 1]) {
          expectSafeLayout(width, height, center, count);
        }
      }
    }
  });

  test('has a finite, bounded allocation for huge catalogs', () => {
    const nodes = orbitNodes({ width: 390, height: 340, center: 500000, count: 1000000 });
    expect(nodes.map(node => node.index)).toEqual([499999, 500000, 500001]);
    expect(orbitNodes({ width: 390, height: 340, center: Number.MAX_VALUE, count: Number.MAX_VALUE }).length).toBeLessThanOrEqual(3);
  });

  test('does not emit impossible viewports', () => {
    for (const width of [0, -1, NaN, Infinity]) {
      expect(orbitNodes({ width, height: 340, center: 0, count: 6 })).toEqual([]);
    }
    for (const height of [0, 43, -1, NaN, Infinity]) {
      expect(orbitNodes({ width: 390, height, center: 0, count: 6 })).toEqual([]);
    }
  });
});
