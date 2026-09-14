/**
 * Where the cloud banks stand (§38.1, §38.10).
 *
 * The cloud sea is a floor. Every delivered world frame also has weather at the
 * islands' own height — banks gathered under each rock, drifting through the
 * gaps between sectors, curling round the Market Core — and that is most of
 * what gives those frames their depth: something in front of the far islands
 * and behind the near ones.
 *
 * Pure placement data, no three, seeded, so it is the same weather on every
 * client and in every round (§38.4).
 */

export interface CloudIsland {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Radius of the island's shelf. */
  readonly radius: number;
}

export interface CloudPuff {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Half the width of the puff, in world units. */
  readonly size: number;
  /** A per-puff value in [0, 1) the shader varies its shape by. */
  readonly seed: number;
}

export interface CloudOptions {
  /** Puffs gathered round and under each island. */
  readonly perIsland: number;
  /** Puffs drifting in the open, between and beyond the islands. */
  readonly open: number;
  /** How far out the open weather reaches, from the centre. */
  readonly reach: number;
}

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

/**
 * How far below an island's shelf the top of each of its banks sits.
 *
 * Under the shelf and never over it: a puff standing on the plateau would be
 * fog in the army's ranks and would hide the frontline §36.15 asks a player to
 * read instantly.
 */
const BELOW_SHELF = { min: 40, max: 170 } as const;

export function cloudBanks(
  seed: number,
  islands: readonly CloudIsland[],
  options: CloudOptions,
): CloudPuff[] {
  const random = generator(seed);
  const puffs: CloudPuff[] = [];

  for (const island of islands) {
    for (let index = 0; index < options.perIsland; index += 1) {
      const angle = random() * Math.PI * 2;
      // Mostly round the rim, some tucked in under the root.
      const spread = 0.35 + random() * 0.95;
      const distance = island.radius * spread;
      const size = island.radius * (0.28 + random() * 0.38);
      // Measured from the puff's top edge, so a big puff sinks further.
      const drop = size * 0.5 + BELOW_SHELF.min + random() * (BELOW_SHELF.max - BELOW_SHELF.min);
      puffs.push({
        x: island.x + Math.cos(angle) * distance,
        y: island.y - drop,
        z: island.z + Math.sin(angle) * distance,
        size,
        seed: random(),
      });
    }
  }

  for (let index = 0; index < options.open; index += 1) {
    const angle = random() * Math.PI * 2;
    const distance = options.reach * (0.25 + random() * 0.75);
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const y = -230 + random() * 170;
    // Kept out from under the plateaus, where the island's own banks already
    // are: two layers of puff over one rock read as a smear.
    const crowded = islands.some(
      (island) => Math.hypot(x - island.x, z - island.z) < island.radius * 1.1,
    );
    if (crowded) {
      continue;
    }
    puffs.push({ x, y, z, size: 70 + random() * 120, seed: random() });
  }

  return puffs;
}
