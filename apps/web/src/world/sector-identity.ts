/**
 * What makes one sector a different place from the next (§38.4, §38.9).
 *
 * §38.4 names five identities — an elevated industrial ridge, a data canyon,
 * fractured platforms, a machinery field, an open tactical basin — and asks
 * them to be *spatially memorable* and stable across rounds, so a player who
 * has been to a sector recognises it when the camera comes back. Five discs
 * with the same ring road on them are not that: without this, every sector in
 * the world was the same plate, and the only thing telling them apart was the
 * label floating over it.
 *
 * None of it means anything. §38.3 keeps sectors neutral and §38.4 gives them
 * no gameplay advantage, so this is geometry a player learns the shape of and
 * nothing more — a landmark, not a modifier. It is also why an identity belongs
 * to the *sector index* and not to the battle in it: any pair can occupy any
 * sector, and terrain that changed with the matchup would be a second, worse
 * readout of something §13 already says.
 *
 * Pure placement data, no three. The keep-out below is the part worth testing,
 * and a test should not need a renderer to check it.
 */

export const SECTOR_IDENTITY_NAMES = [
  'INDUSTRIAL_RIDGE',
  'DATA_CANYON',
  'FRACTURED_PLATFORMS',
  'MACHINERY_FIELD',
  'TACTICAL_BASIN',
] as const;

export type SectorIdentityName = (typeof SECTOR_IDENTITY_NAMES)[number];

export interface TerrainBlock {
  /** Centre, in the sector's own space. */
  readonly position: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  /** Turn about the deck's up axis, in radians. */
  readonly rotation: number;
  /** Across the neutral stone range: variation, never faction colour (§38.3). */
  readonly tone: number;
  /** Whether it carries a data channel's light (§38.11). */
  readonly lit: boolean;
}

export interface SectorIdentity {
  readonly name: SectorIdentityName;
  /** What it is, in a player's words. */
  readonly label: string;
  readonly blocks: readonly TerrainBlock[];
}

/**
 * The ground the battle is read on, which nothing here may stand in (§36.15).
 *
 * The contested strip is 76 across and the two districts reach out to 86, so
 * everything an identity places starts beyond that and stops short of the rim.
 * §38.9 is explicit that core battle surfaces stay flat enough to read the
 * frontline — the verticality goes round the edges, where it is scenery a
 * camera passes over rather than terrain an army disappears behind.
 */
export const KEEP_OUT_RADIUS = 92;

/** The rim of the deck. Nothing stands past it, or it hangs over the void. */
export const DECK_RADIUS = 118;

/**
 * The ground the frontline crosses, as a half-extent in each direction.
 *
 * The contested strip is 76 across and 150 deep, and the two districts stand
 * either side of it. Nothing an identity places may reach into this rectangle:
 * §36.15 asks a viewer to read where the frontline is at a glance, and terrain
 * standing in front of it is the one thing that takes that away.
 */
export const BATTLE_GROUND = { halfWidth: 44, halfDepth: 80 } as const;

/** The deck's surface, which blocks stand on or are cut into. */
const DECK_Y = 11;

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
 * Places round the deck's edge, gathered along the two flanks.
 *
 * The ends are where the districts and their armies stand. These spread from
 * about 35° to 145° off the battle's axis on each side — which is also where
 * they read, since the global camera looks across a sector rather than down it.
 */
function flankAngles(count: number, random: () => number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const half = index % 2 === 0 ? 1 : -1;
    const along = (Math.floor(index / 2) + 0.5) / Math.ceil(count / 2);
    const spread = 0.62 + along * 1.9 + (random() - 0.5) * 0.18;
    return half * spread;
  });
}

/** Where a block stands, pushed out from the keep-out toward the rim. */
function onRing(angle: number, out: number, y: number): readonly [number, number, number] {
  const radius = KEEP_OUT_RADIUS + out * (DECK_RADIUS - KEEP_OUT_RADIUS);
  return [Math.sin(angle) * radius, y, Math.cos(angle) * radius];
}

/**
 * An elevated industrial ridge.
 *
 * One raised spine of plant stepping down as it runs. The tallest identity: from
 * across the world this is the sector with something standing on it.
 */
function ridge(random: () => number): TerrainBlock[] {
  return flankAngles(10, random).map((angle, index) => {
    const height = 26 - Math.abs(index - 4) * 3.2 + random() * 5;
    return {
      position: onRing(angle, 0.34 + random() * 0.28, DECK_Y + height / 2),
      size: [10 + random() * 6, height, 16 + random() * 10] as const,
      rotation: angle,
      tone: 0.35 + random() * 0.3,
      lit: index % 4 === 0,
    };
  });
}

/**
 * A data canyon.
 *
 * Cut into the deck rather than built on it: shallow walls set below the
 * surface and lit along their length, with a lip on the outside. §38.11 asks
 * for market data as environment — routing and energy, never charts on ground.
 */
function canyon(random: () => number): TerrainBlock[] {
  return flankAngles(12, random).flatMap((angle, index) => {
    const depth = 5 + random() * 3;
    return [
      {
        position: onRing(angle, 0.12 + random() * 0.18, DECK_Y - depth / 2),
        size: [7 + random() * 4, depth, 22 + random() * 12] as const,
        rotation: angle,
        tone: 0.12 + random() * 0.12,
        lit: index % 2 === 0,
      },
      {
        position: onRing(angle, 0.62 + random() * 0.22, DECK_Y + 1.6),
        size: [9 + random() * 5, 3.2, 14 + random() * 8] as const,
        rotation: angle,
        tone: 0.3 + random() * 0.2,
        lit: false,
      },
    ];
  });
}

/**
 * Fractured platforms.
 *
 * The deck broken into slabs that no longer line up: each tilted off the ring
 * and standing at its own height, with gaps between them.
 */
function fractured(random: () => number): TerrainBlock[] {
  return flankAngles(11, random).map((angle) => {
    const lift = (random() - 0.35) * 11;
    return {
      position: onRing(angle, random(), DECK_Y + lift / 2),
      size: [16 + random() * 12, Math.abs(lift) + 3, 18 + random() * 14] as const,
      rotation: angle + (random() - 0.5) * 0.7,
      tone: 0.2 + random() * 0.35,
      lit: false,
    };
  });
}

/**
 * A machinery field.
 *
 * Clusters of heavy plant, several boxes to a group and close together, so it
 * reads as machinery rather than as crates somebody scattered.
 */
function machinery(random: () => number): TerrainBlock[] {
  return flankAngles(6, random).flatMap((angle) => {
    const out = 0.24 + random() * 0.3;
    return Array.from({ length: 3 }, (_, part) => {
      const height = 7 + random() * 13;
      // Scattered along the ring and outward from it, never inward: a cluster
      // that wandered toward the middle would put plant on the ground the
      // frontline crosses. The keep-out is a rule, not a starting point.
      const along = (random() - 0.5) * 0.24;
      const push = out + random() * 0.3;
      return {
        position: onRing(angle + along, push > 1 ? 1 : push, DECK_Y + height / 2),
        size: [6 + random() * 7, height, 6 + random() * 7] as const,
        rotation: angle + (random() - 0.5) * 0.5,
        tone: 0.25 + random() * 0.3,
        lit: part === 1 && random() > 0.5,
      };
    });
  });
}

/**
 * An open tactical basin.
 *
 * Nearly bare, and that is the identity: a low rim all the way round an open
 * floor. The sector a player recognises by how far they can see across it.
 */
function basin(random: () => number): TerrainBlock[] {
  return flankAngles(14, random).map((angle) => ({
    position: onRing(angle, 0.84 + random() * 0.1, DECK_Y + 2.4),
    size: [6 + random() * 3, 5 + random() * 2.5, 20 + random() * 10] as const,
    rotation: angle,
    tone: 0.22 + random() * 0.16,
    lit: false,
  }));
}

const SHAPES: Readonly<
  Record<
    SectorIdentityName,
    { readonly label: string; readonly build: (random: () => number) => TerrainBlock[] }
  >
> = {
  INDUSTRIAL_RIDGE: { label: 'Industrial ridge', build: ridge },
  DATA_CANYON: { label: 'Data canyon', build: canyon },
  FRACTURED_PLATFORMS: { label: 'Fractured platforms', build: fractured },
  MACHINERY_FIELD: { label: 'Machinery field', build: machinery },
  TACTICAL_BASIN: { label: 'Open tactical basin', build: basin },
};

/**
 * The identity of one sector, by its index.
 *
 * Deterministic, which is the whole point of §38.4's "geometry stays stable for
 * orientation": the same sector is the same place on every client, in every
 * round, however the matchups fall.
 */
export function sectorIdentity(index: number): SectorIdentity {
  const name = SECTOR_IDENTITY_NAMES[index % SECTOR_IDENTITY_NAMES.length] ?? 'TACTICAL_BASIN';
  const shape = SHAPES[name];
  return { name, label: shape.label, blocks: shape.build(generator(index * 977 + 31)) };
}
