import { useEffect, useMemo, type JSX } from 'react';
import { AdditiveBlending, DataTexture } from 'three';
import { InstancedField, type Placement } from './InstancedField.js';

/**
 * Scorch on the contested ground (§36.10, §38.3).
 *
 * The fighting leaves marks: every delivered battle frame has the ground
 * between the armies burned and cratered, and a clean grid between two armies
 * firing at each other reads as a board they have not touched.
 *
 * Flat, and only that. §36.15 keeps the contested strip clear so the frontline
 * reads instantly, so nothing here stands up off the ground: dark burns, and a
 * few with embers still glowing in them.
 *
 * Neutral by construction (§38.3) — burned ground is no side's colour — and a
 * property of the sector rather than of the battle, so it is the same ground
 * every round (§38.4).
 */

/** The contested strip the marks stay inside, as half-extents. */
const HALF_WIDTH = 32;
const HALF_LENGTH = 70;
/** Just over the paving, so a burn lies on the lit lines rather than under them. */
const GROUND = 11.8;

function generator(seed: number): () => number {
  let state = (seed * 2_654_435_761) >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

/** A cheap hash to break a texture's shape up, so no mark is a clean circle. */
function hash(x: number, y: number, salt: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43_758.545_3;
  return value - Math.floor(value);
}

/** Smoothed value noise over a coarse grid, in [0, 1]. */
function noise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, salt);
  const b = hash(ix + 1, iy, salt);
  const c = hash(ix, iy + 1, salt);
  const d = hash(ix + 1, iy + 1, salt);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * A ragged radial falloff, as alpha.
 *
 * `embers` keeps only broken patches of it — a scatter of glowing spots across
 * the burn rather than a ring, which read as a target painted on the floor.
 */
function radialTexture(embers: boolean): DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const ragged = noise(x / 9, y / 9, 1) * 0.5 + noise(x / 4, y / 4, 2) * 0.25;
      const r = Math.hypot(dx, dy) * 2 + (ragged - 0.37) * 0.7;
      const body = Math.max(0, 1 - r) ** 1.2;
      const value = embers
        ? body * Math.max(0, (noise(x / 5, y / 5, 3) - 0.62) / 0.38) ** 1.5
        : body;
      const at = (y * size + x) * 4;
      data.fill(Math.round(value * 255), at, at + 4);
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.needsUpdate = true;
  return texture;
}

export function Scorch({ seed }: { readonly seed: number }): JSX.Element {
  const { burns, embers } = useMemo(() => {
    const random = generator(seed);
    const burnPlacements: Placement[] = [];
    const emberPlacements: Placement[] = [];
    for (let index = 0; index < 16; index += 1) {
      const size = 8 + random() * 12;
      const x = (random() * 2 - 1) * (HALF_WIDTH - size * 0.3);
      const z = (random() * 2 - 1) * (HALF_LENGTH - size * 0.3);
      const turn = random() * Math.PI;
      burnPlacements.push({
        position: [x, GROUND, z],
        scale: [size, size * (0.8 + random() * 0.4), 1],
        rotation: [-Math.PI / 2, 0, turn],
      });
      // A third of them still smouldering.
      if (random() < 0.34) {
        emberPlacements.push({
          position: [x, GROUND + 0.05, z],
          scale: [size * 0.8, size * 0.8, 1],
          rotation: [-Math.PI / 2, 0, turn],
        });
      }
    }
    return { burns: burnPlacements, embers: emberPlacements };
  }, [seed]);

  const burnFade = useMemo(() => radialTexture(false), []);
  const emberRing = useMemo(() => radialTexture(true), []);
  useEffect(
    () => () => {
      burnFade.dispose();
      emberRing.dispose();
    },
    [burnFade, emberRing],
  );

  return (
    <group>
      <InstancedField placements={burns} renderOrder={2}>
        <planeGeometry key="burn" args={[1, 1]} />
        <meshBasicMaterial
          key="burn-material"
          color="#030405"
          alphaMap={burnFade}
          transparent
          opacity={0.9}
          depthWrite={false}
        />
      </InstancedField>
      <InstancedField placements={embers} renderOrder={3}>
        <planeGeometry key="ember" args={[1, 1]} />
        <meshBasicMaterial
          key="ember-material"
          color="#ff7a2e"
          alphaMap={emberRing}
          transparent
          opacity={0.9}
          blending={AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </InstancedField>
    </group>
  );
}
