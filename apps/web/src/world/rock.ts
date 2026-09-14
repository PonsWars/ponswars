/**
 * The rock a floating island is carved from (§38.1).
 *
 * Every delivered world frame hangs its islands over the cloud on masses of
 * broken rock: a wide ragged shelf under the city, strata stepping down, and a
 * long jagged root narrowing into the void. A cone was a spinning top. This is
 * that mass, generated.
 *
 * Pure geometry data, no three: a ring of vertices at each depth, pushed in and
 * out by seeded noise so no two islands share a silhouette, with a few ribs
 * dropped into hanging spurs. Seeded from the island, so it is the same rock
 * on every client and in every round (§38.4).
 */

export interface RockData {
  /** x, y, z per vertex. */
  readonly positions: Float32Array;
  /** r, g, b per vertex, linear 0–1. */
  readonly colors: Float32Array;
  readonly indices: Uint32Array;
}

export interface RockShape {
  /** Radius of the shelf at the top, in world units. */
  readonly radius: number;
  /** How far the root hangs below the shelf. */
  readonly depth: number;
  /** Vertices around each ring. */
  readonly around: number;
  /** Rings from shelf to root. */
  readonly rings: number;
}

/** A small seeded generator, independent of the game's audited PRNG. */
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

/** Smooth periodic noise around the ring, from a handful of seeded harmonics. */
function ringNoise(random: () => number, harmonics: number): (angle: number) => number {
  const terms = Array.from({ length: harmonics }, (_, index) => ({
    frequency: index + 2 + Math.floor(random() * 3),
    phase: random() * Math.PI * 2,
    amplitude: 1 / (index + 1.4),
  }));
  const total = terms.reduce((sum, term) => sum + term.amplitude, 0);
  return (angle) =>
    terms.reduce(
      (sum, term) => sum + Math.sin(angle * term.frequency + term.phase) * term.amplitude,
      0,
    ) / total;
}

/** Colours down the mass: sunlit shelf, strata, near-black root. */
const SHELF = [0.3, 0.27, 0.24] as const;
/** The cliff face under the shelf: the same stone in bands, lighter and darker. */
const CLIFF = [0.2, 0.19, 0.18] as const;
const STRATA = [0.16, 0.15, 0.145] as const;
const ROOT = [0.06, 0.065, 0.075] as const;

/** How much of the mass's depth is cliff before the root starts to taper. */
export const CLIFF_DEPTH = 0.22;

export function islandRock(seed: number, shape: RockShape): RockData {
  const random = generator(seed);
  const { radius, depth, around, rings } = shape;
  const outline = ringNoise(random, 5);
  const ledges = ringNoise(random, 3);

  // Spurs: a few directions where the rock hangs lower, as broken columns.
  const spurs = Array.from({ length: 4 + Math.floor(random() * 3) }, () => ({
    angle: random() * Math.PI * 2,
    width: 0.18 + random() * 0.22,
    drop: 0.25 + random() * 0.45,
  }));
  const spurAt = (angle: number): number =>
    spurs.reduce((most, spur) => {
      const gap = Math.abs(Math.atan2(Math.sin(angle - spur.angle), Math.cos(angle - spur.angle)));
      return Math.max(most, spur.drop * Math.max(0, 1 - gap / spur.width));
    }, 0);

  const vertexCount = (rings + 1) * around + 1;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  // A share of the rings spent on the cliff, so its face stands straight
  // rather than being one long slope from the first ring to the second.
  const cliffRings = Math.max(2, Math.round(rings * 0.3));

  for (let ring = 0; ring <= rings; ring += 1) {
    const t =
      ring <= cliffRings
        ? (ring / cliffRings) * CLIFF_DEPTH
        : CLIFF_DEPTH + ((ring - cliffRings) / (rings - cliffRings)) * (1 - CLIFF_DEPTH);
    for (let step = 0; step < around; step += 1) {
      const angle = (step / around) * Math.PI * 2;
      const spur = spurAt(angle);
      // A cliff under the shelf that barely steps in, then the root tapering
      // hard below it — but a spur keeps its width for longer, which is what
      // makes it hang as a column. Every delivered world frame gives an
      // island a wall of rock under its city; a cone from the rim down read
      // as a spinning top.
      const below = Math.max(0, (t - CLIFF_DEPTH) / (1 - CLIFF_DEPTH));
      const taper =
        t <= CLIFF_DEPTH
          ? 1 - (t / CLIFF_DEPTH) * 0.1
          : 0.9 * Math.pow(1 - below, 1.25 + (1 - spur) * 0.9) * (1 - below * 0.15);
      // Ragged outward only down the cliff, so the wall is never narrower than
      // the plateau standing on it; ragged both ways below.
      const wobble = outline(angle + t * 1.7);
      const edge =
        t <= CLIFF_DEPTH ? 1 + (wobble * 0.5 + 0.5) * 0.14 : 1 + wobble * 0.16 * (1 - t * 0.4);
      // Strata: the wall steps in at a few depths rather than sloping evenly.
      const strata = 1 - 0.06 * Math.round(Math.sin(t * 9 + ledges(angle) * 2) * 1.2) * (1 - t);
      const r = radius * taper * edge * strata + (t > 0.98 ? 0 : 0.6);
      const y = -t * depth * (1 + spur * 0.9) - (ring === 0 ? 0 : random() * 2.5);
      const index = ring * around + step;
      positions[index * 3] = Math.cos(angle) * r;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = Math.sin(angle) * r;

      const shade = t < 0.04 ? SHELF : t <= CLIFF_DEPTH ? CLIFF : t < 0.6 ? STRATA : ROOT;
      const next = t < 0.04 ? CLIFF : t <= CLIFF_DEPTH ? CLIFF : t < 0.6 ? ROOT : ROOT;
      const blend = t < 0.04 ? t / 0.04 : t <= CLIFF_DEPTH ? 0 : t < 0.6 ? below / 0.5 : 1;
      // Bands down the cliff, alternating, so the face reads as layered stone.
      const band = t > 0.02 && t <= CLIFF_DEPTH ? (ring % 2 === 0 ? 1.12 : 0.84) : 1;
      const grain = (0.82 + random() * 0.36) * band;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = (shade[channel] ?? 0) * (1 - blend) + (next[channel] ?? 0) * blend;
        colors[index * 3 + channel] = value * grain;
      }
    }
  }

  // The root's tip, one vertex below the last ring.
  const tip = vertexCount - 1;
  positions[tip * 3] = 0;
  positions[tip * 3 + 1] = -depth * 1.15;
  positions[tip * 3 + 2] = 0;
  colors.set(ROOT, tip * 3);

  const indices: number[] = [];
  for (let ring = 0; ring < rings; ring += 1) {
    for (let step = 0; step < around; step += 1) {
      const a = ring * around + step;
      const b = ring * around + ((step + 1) % around);
      const c = (ring + 1) * around + step;
      const d = (ring + 1) * around + ((step + 1) % around);
      // Wound to face outward.
      indices.push(a, b, c, b, d, c);
    }
  }
  for (let step = 0; step < around; step += 1) {
    const a = rings * around + step;
    const b = rings * around + ((step + 1) % around);
    indices.push(a, b, tip);
  }

  return { positions, colors, indices: Uint32Array.from(indices) };
}

/** The weathered top of a rock: dark stone with a little growth on it. */
export const CAP = [0.055, 0.062, 0.052] as const;

/**
 * A rock with its top closed over.
 *
 * `islandRock` is open at the shelf — on an island the plateau used to cover
 * it — and an open top is a hole: the sky through the rim wherever the rock's
 * outline reaches past the plateau, and the whole inside of an islet from above.
 *
 * One centre vertex and a fan to the shelf ring, with the ring taking the cap's
 * colour: it carries the sunlit shelf tone, which on a cap read as a pale plate.
 */
export function capped(
  rock: RockData,
  around: number,
  cap: readonly [number, number, number],
): RockData {
  const vertices = rock.positions.length / 3;
  const centre = vertices;

  const positions = new Float32Array(rock.positions.length + 3);
  positions.set(rock.positions);
  // At the shelf ring's height: ring 0 carries no jitter, so the cap is flat.
  positions.set([0, rock.positions[1] ?? 0, 0], centre * 3);

  const colors = new Float32Array(rock.colors.length + 3);
  colors.set(rock.colors);
  colors.set(cap, centre * 3);
  for (let step = 0; step < around; step += 1) {
    colors.set(cap, step * 3);
  }

  const indices = Array.from(rock.indices);
  for (let step = 0; step < around; step += 1) {
    // Wound to face up: (centre, a, b) faces down on a ring laid out this way.
    indices.push(centre, (step + 1) % around, step);
  }

  return { positions, colors, indices: Uint32Array.from(indices) };
}

/**
 * A small floating islet: the same broken rock as an island, a unit wide, with
 * its top closed over (§38.1).
 *
 * The void between the islands was scattered with black icosahedra, and a black
 * low-poly ball in the sky reads as a hole rather than a rock. Every delivered
 * world frame fills that middle distance with islets instead — the same stone
 * as the islands, broken off them — so that is what these are.
 *
 * A unit wide so one shape can be instanced at any size.
 */
export function islet(seed: number): RockData {
  const around = 12;
  // Built at ten units and scaled down: the generator pads every ring by a
  // fixed amount that is nothing on an island and most of a unit-wide rock.
  const built = 10;
  const rock = islandRock(seed, { radius: built, depth: built * 1.3, around, rings: 5 });
  const scaled = { ...rock, positions: rock.positions.map((value) => value / built) };
  return capped(scaled, around, CAP);
}

/** One small building on an island's rim. */
export interface RimBuilding {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly turn: number;
}

/**
 * The city around an island's rim (§38.9).
 *
 * The two districts stand either side of the contested ground, and the rest of
 * the plateau was empty paving — which from the global view is most of what a
 * sector looked like: a grey disc. Every delivered frame packs the whole island
 * edge with low structures instead, lit, so the island reads as a city with a
 * battlefield in it rather than a battlefield on a plate.
 *
 * Kept low, off both district decks and off the contested ground, so nothing
 * here stands in the army's ranks or the frontline's path, or rises into a
 * camera pose.
 */
export function rimCity(
  seed: number,
  options: {
    readonly count: number;
    readonly inner: number;
    readonly outer: number;
    readonly maxHeight: number;
    /** Rectangles that must stay clear, as [centreX, halfX, halfZ] about the z axis. */
    readonly clear: readonly (readonly [number, number, number])[];
  },
): RimBuilding[] {
  const random = generator(seed ^ 0x5bd1e995);
  const out: RimBuilding[] = [];
  for (let attempt = 0; attempt < options.count * 3 && out.length < options.count; attempt += 1) {
    const angle = random() * Math.PI * 2;
    const distance = options.inner + random() * (options.outer - options.inner);
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const width = 3.5 + random() * 5.5;
    const depth = 3.5 + random() * 5.5;
    const margin = Math.max(width, depth) / 2 + 1;
    const blocked = options.clear.some(
      ([centreX, halfX, halfZ]) =>
        Math.abs(x - centreX) < halfX + margin && Math.abs(z) < halfZ + margin,
    );
    if (blocked) {
      continue;
    }
    // Taller toward the outside of the band, so the rim steps up like a wall.
    const outward = (distance - options.inner) / Math.max(options.outer - options.inner, 1);
    const height = 4 + random() * (options.maxHeight - 4) * (0.45 + outward * 0.55);
    out.push({ x, z, width, depth, height, turn: random() * Math.PI });
  }
  return out;
}
