import { describe, expect, it } from 'vitest';
import { islandRock, islet, rimCity } from './rock.js';

const SHAPE = { radius: 120, depth: 150, around: 48, rings: 12 };

describe('islandRock', () => {
  it('is the same rock for the same island, and a different rock for another', () => {
    expect(islandRock(7, SHAPE).positions).toEqual(islandRock(7, SHAPE).positions);
    expect(islandRock(8, SHAPE).positions).not.toEqual(islandRock(7, SHAPE).positions);
  });

  it('hangs entirely below the shelf and inside a little past its radius', () => {
    const { positions } = islandRock(3, SHAPE);
    for (let index = 0; index < positions.length; index += 3) {
      const x = positions[index] ?? 0;
      const y = positions[index + 1] ?? 0;
      const z = positions[index + 2] ?? 0;
      expect(y).toBeLessThanOrEqual(0);
      // Never below the cloud sea the islands float over (−170).
      expect(y).toBeGreaterThan(-SHAPE.depth * 2 - 1);
      expect(Math.hypot(x, z)).toBeLessThan(SHAPE.radius * 1.3);
    }
  });

  it('is a closed, indexed surface with a colour per vertex', () => {
    const { positions, colors, indices } = islandRock(3, SHAPE);
    const vertices = positions.length / 3;

    expect(colors.length).toBe(positions.length);
    expect(indices.length % 3).toBe(0);
    expect(Math.max(...indices)).toBe(vertices - 1);
    expect(Array.from(colors).every((value) => value >= 0 && value <= 1)).toBe(true);
  });
});

describe('islet', () => {
  it('is a closed rock a unit wide, capped on top with a face that looks up', () => {
    const { positions, colors, indices } = islet(5);
    const vertices = positions.length / 3;

    expect(colors.length).toBe(positions.length);
    expect(Math.max(...indices)).toBe(vertices - 1);
    for (let index = 0; index < positions.length; index += 3) {
      expect(Math.hypot(positions[index] ?? 0, positions[index + 2] ?? 0)).toBeLessThan(1.3);
    }

    // The last triangle is part of the cap: its normal must point up.
    const at = (vertex: number): [number, number, number] => [
      positions[vertex * 3] ?? 0,
      positions[vertex * 3 + 1] ?? 0,
      positions[vertex * 3 + 2] ?? 0,
    ];
    const [c, b, a] = Array.from(indices.slice(-3), (vertex) => at(vertex)) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    const u = [b[0] - c[0], b[1] - c[1], b[2] - c[2]];
    const v = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
    const normalY = (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0);
    expect(normalY).toBeGreaterThan(0);
  });
});

describe('rimCity', () => {
  const OPTIONS = {
    count: 120,
    inner: 92,
    outer: 116,
    maxHeight: 24,
    clear: [
      [-62, 28, 52],
      [62, 28, 52],
      [0, 40, 78],
    ] as const,
  };

  it('builds inside the band, low, and clear of the decks and the contested ground', () => {
    const buildings = rimCity(11, OPTIONS);

    expect(buildings.length).toBeGreaterThan(60);
    for (const building of buildings) {
      const distance = Math.hypot(building.x, building.z);
      expect(distance).toBeGreaterThanOrEqual(OPTIONS.inner - 0.001);
      expect(distance).toBeLessThanOrEqual(OPTIONS.outer + 0.001);
      expect(building.height).toBeLessThanOrEqual(OPTIONS.maxHeight);
      for (const [centreX, halfX, halfZ] of OPTIONS.clear) {
        expect(Math.abs(building.x - centreX) < halfX && Math.abs(building.z) < halfZ).toBe(false);
      }
    }
  });

  it('is the same city for the same island', () => {
    expect(rimCity(11, OPTIONS)).toEqual(rimCity(11, OPTIONS));
  });
});
