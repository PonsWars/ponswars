/**
 * The shape of a floating war sector (§38.1, §38.4, §38.9).
 *
 * §38.9 asks for verticality — plateaus, raised structures, a place with a
 * skyline rather than a board with counters on it — and §38.4 asks for the
 * geometry to be *stable enough for orientation across rounds*. Those two pull
 * against each other if the detail is hand-placed: enough of it to read as a
 * built-up territory is more than anyone will write out by hand, and anything
 * sampled fresh each round destroys the landmark a player navigates by.
 *
 * So it is generated, and generated from a seed that is a property of the
 * *place*: sector three is the same sector three in every round, on every
 * client, for every player. Two people describing the island with the tall
 * ridge on its western side are describing the same island.
 *
 * ## What may not reach this file
 *
 * Nothing here takes a battle, a score, a frontline or a momentum reading. §12.5
 * and §24 hide the exact score for the whole live window, and a skyline that
 * grew with a side's score would publish it in the one place a player cannot
 * help but look. The seed is an integer and the shape is an input, which is what
 * makes that a fact about the signature rather than a rule to remember.
 */

/** One structure on a district. Local coordinates, centred on the district. */
export interface Block {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** Yaw, in radians. Small: a district is planned, not scattered. */
  readonly rotation: number;
  /** Whether this one carries a lit crown — the tall ones, so the skyline reads. */
  readonly lit: boolean;
  /**
   * How it is built.
   *
   * A skyline of nothing but boxes reads as blocks rather than as a city, and
   * the difference is entirely in the outline: a taper puts a diagonal in it, a
   * tower puts a round shoulder in it. Which one a structure gets comes from
   * the same stream as its size, so a district's mix is as stable as its
   * layout.
   */
  readonly form: BlockForm;
}

/** The three ways a structure is built. */
export type BlockForm = 'BLOCK' | 'TAPER' | 'TOWER';

/** A rock hanging beneath the plateau, which is what makes an island float. */
export interface Crag {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly length: number;
  readonly tiltX: number;
  readonly tiltZ: number;
}

/** A loose rock in the space around an island (§38.1). */
export interface Debris {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  /** A resting orientation, so no two rocks present the same face. */
  readonly tilt: number;
}

/**
 * The envelope a district is generated into.
 *
 * `OPEN` production tuning (§59.4): these are the proportions of a place, and
 * they belong to the scene that knows how big its platform is, not to a default
 * compiled in here.
 */
export interface DistrictShape {
  /** Half-extent across, along the axis that separates the two sides. */
  readonly halfWidth: number;
  /** Half-extent along the frontline axis. */
  readonly halfDepth: number;
  /** Tallest a structure may be at the middle of the district. */
  readonly peakHeight: number;
  /** Tallest a structure may be at its rim, so the skyline domes rather than sprawls. */
  readonly edgeHeight: number;
  /** Smallest and largest footprint of a single structure. */
  readonly minFootprint: number;
  readonly maxFootprint: number;
  /** Clear ground kept between two structures. */
  readonly spacing: number;
}

/**
 * A deterministic stream of numbers in [0, 1).
 *
 * A 32-bit LCG with the Numerical Recipes constants. Small, exactly reproducible
 * across engines, and — unlike `Math.random` — answerable to a test. The world
 * being the same world on two machines is not a nicety here: §38.4 makes the
 * sector geometry the thing a player orients by, and two clients disagreeing
 * about it would be two different worlds.
 */
function stream(seed: number): () => number {
  // Forced positive and into 32 bits, so a caller passing a negative or
  // fractional seed gets a stable sequence rather than a NaN cascade.
  let state = Math.floor(Math.abs(seed)) % 4_294_967_296;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** A value in [low, high), from a stream. */
function between(next: () => number, low: number, high: number): number {
  return low + next() * (high - low);
}

/**
 * How tall a structure may stand at a given distance from the district centre.
 *
 * Exported because it is the property the tests hold the generator to: every
 * block obeys this, so the skyline domes toward the middle no matter what the
 * stream produces. A city that is uniformly tall reads as a wall from the
 * sector camera and hides everything behind it.
 */
export function heightCap(shape: DistrictShape, normalizedDistance: number): number {
  const clamped = normalizedDistance <= 0 ? 0 : normalizedDistance >= 1 ? 1 : normalizedDistance;
  return shape.peakHeight + (shape.edgeHeight - shape.peakHeight) * clamped;
}

/**
 * The structures on one district, packed without overlapping.
 *
 * Rejection sampling against a fixed attempt budget rather than a solver: a
 * district that comes back one building short is a district, and a generator
 * that can loop forever on a shape it cannot fill is a hang on someone's
 * machine. `count` is therefore an upper bound, which the tests assert.
 */
export function districtBlocks(
  seed: number,
  shape: DistrictShape,
  count: number,
): readonly Block[] {
  const next = stream(seed);
  const blocks: Block[] = [];
  const attempts = Math.max(count, 0) * 40;

  for (let attempt = 0; attempt < attempts && blocks.length < count; attempt += 1) {
    const width = between(next, shape.minFootprint, shape.maxFootprint);
    const depth = between(next, shape.minFootprint, shape.maxFootprint);
    // The circle that contains the structure whatever its yaw, so containment
    // and spacing are both decided before the rotation is chosen.
    const radius = Math.hypot(width, depth) / 2;

    const spanX = shape.halfWidth - radius;
    const spanZ = shape.halfDepth - radius;
    if (spanX <= 0 || spanZ <= 0) {
      // No structure of this size fits at all. Nothing later in this attempt
      // can change that, so try another size rather than dividing by zero.
      continue;
    }

    const x = between(next, -spanX, spanX);
    const z = between(next, -spanZ, spanZ);
    const rotation = between(next, -0.32, 0.32);

    // Inside the ellipse, not merely inside the bounding box: the corners of a
    // rectangular district hang off a round plateau.
    if (Math.hypot(x / spanX, z / spanZ) > 1) {
      continue;
    }

    const clash = blocks.some((placed) => {
      const clearance = radius + Math.hypot(placed.width, placed.depth) / 2 + shape.spacing;
      return Math.hypot(placed.x - x, placed.z - z) < clearance;
    });
    if (clash) {
      continue;
    }

    const cap = heightCap(shape, Math.hypot(x / shape.halfWidth, z / shape.halfDepth));
    // Never far below its cap. A district whose structures range from a tenth
    // of the cap to all of it is not a varied skyline, it is a few towers in a
    // car park: the first pass floored this at 0.42 and most of the district
    // came out shorter than the platform it stood on.
    const height = cap * between(next, 0.58, 1);

    // Mostly blocks, because most of a city is. The tapers and towers are what
    // stop the rest reading as a bar chart.
    const roll = next();
    const form: BlockForm = roll < 0.62 ? 'BLOCK' : roll < 0.84 ? 'TAPER' : 'TOWER';

    blocks.push({
      x,
      z,
      width,
      depth,
      height,
      rotation,
      // The tall ones only. A crown on every roof is a lit grid, and §36.5 keeps
      // faction colour an accent rather than a wash.
      lit: height > shape.peakHeight * 0.52,
      form,
    });
  }

  return blocks;
}

/**
 * The rocks hanging under a plateau.
 *
 * Spread around a ring rather than clustered at the centre, because the
 * silhouette that says *floating island* is the one where the underside is
 * ragged at its edges and the point is at its middle — a cone alone reads as a
 * spinning top.
 */
export function islandCrags(seed: number, radius: number, count: number): readonly Crag[] {
  const next = stream(seed);
  return Array.from({ length: Math.max(count, 0) }, (_, index) => {
    // Evenly spaced around the ring with a jitter, so no two islands read as
    // the same object and none of them reads as a gear.
    const angle = ((index + between(next, 0.2, 0.8)) / Math.max(count, 1)) * Math.PI * 2;
    // The rock's own thickness comes out of the ring it may sit on, or a crag
    // placed at the rim reaches past it — from above that reads as rock growing
    // out of the void beside the island rather than out of its underside.
    const thickness = between(next, radius * 0.08, radius * 0.2);
    const distance = between(next, radius * 0.4, radius - thickness);
    return {
      x: Math.cos(angle) * distance,
      z: Math.sin(angle) * distance,
      radius: thickness,
      length: between(next, radius * 0.35, radius * 0.95),
      // Leaning outward from the axis, which is how rock breaks away from a mass.
      tiltX: Math.sin(angle) * between(next, 0.1, 0.34),
      tiltZ: -Math.cos(angle) * between(next, 0.1, 0.34),
    };
  });
}

/**
 * Loose rock in the space around an island (§38.1).
 *
 * §36.14 asks for a world kept subtly alive rather than one full of particles.
 * A handful of slowly turning rocks at varying heights gives the void a depth
 * that a starfield alone cannot: stars are infinitely far away, so they never
 * move against the camera, and a world with nothing between it and the stars
 * reads as a model on a black table.
 */
export function debrisField(
  seed: number,
  inner: number,
  outer: number,
  count: number,
): readonly Debris[] {
  const next = stream(seed);
  return Array.from({ length: Math.max(count, 0) }, () => {
    const angle = between(next, 0, Math.PI * 2);
    const distance = between(next, inner, outer);
    return {
      x: Math.cos(angle) * distance,
      y: between(next, -outer * 0.42, outer * 0.3),
      z: Math.sin(angle) * distance,
      radius: between(next, outer * 0.012, outer * 0.045),
      tilt: between(next, 0, Math.PI),
    };
  });
}
