import type { SectorIdentityName } from './sector-identity.js';

/**
 * The one structure that tells a sector apart from across the world (§38.4,
 * §36.7, §37.2).
 *
 * The five islands wear the same ring of low city and the same rock, and from
 * the global view — the level §37.2 calls *the complete world* — that is most
 * of what a sector is. The terrain identities underneath are real but low:
 * they say where you are once you are there, and say nothing at the distance a
 * player picks a battle from. §38.4 asks for sectors that are *spatially
 * memorable*, and memorable at that distance means a silhouette.
 *
 * So each identity raises its own structure, twice, on the far flank: a pair of
 * stacks, of masts, of leaning pylons, of gantries, of watch towers. They are
 * the tallest thing on an island and the shape a player learns it by, the way
 * §36.7 makes a faction's base its silhouette before its colour.
 *
 * ## What they are not
 *
 * Nothing here belongs to anybody. §38.3 keeps a sector neutral and §38.4
 * gives it no advantage: these are structures the market left standing, in the
 * world's own metal and the world's own signal lights, and a player who learns
 * them learns a place rather than a side. They are also not the FOBs: those are
 * landed each round and folded away at the reshuffle (§38.5), and these have
 * always been here.
 *
 * ## Where they stand
 *
 * On the flank away from the battlefield camera, clear of everything the
 * battle stands on. §36.15 puts reading the frontline first, and the tallest
 * thing in a sector is exactly what must never be between a camera and the
 * fight — the far flank is behind the battle from every battlefield pose, so
 * height there costs nothing.
 *
 * Pure data, no three, like `fob-shape.ts`: the silhouettes are what is worth
 * testing, and a test should not need a renderer.
 */

export type LandmarkShapeKind = 'box' | 'cylinder' | 'cone';

export interface LandmarkPart {
  readonly shape: LandmarkShapeKind;
  /** Centre, in the landmark's own space, standing on the deck at `y = 0`. */
  readonly position: readonly [number, number, number];
  /**
   * Sized as `fob-shape.ts` sizes its parts:
   *
   * - `box` — width, height, depth
   * - `cylinder` — top radius, height, bottom radius
   * - `cone` — radius, height, (unused)
   */
  readonly size: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  /**
   * Which surface it is. `signal` is a working light — a lamp on a mast, a
   * warning light on a stack — in the Market's own cold white, never a
   * faction's colour (§38.3, §36.5).
   */
  readonly material: 'hull' | 'dark' | 'signal';
}

export interface Landmark {
  /** What it is, in a player's words. */
  readonly description: string;
  readonly parts: readonly LandmarkPart[];
}

/**
 * How far from its own centre a landmark may reach, and how tall it may stand.
 *
 * The reach is what the placement is checked against, so a structure can never
 * grow into the ground the battle is read on. The height is the one §36.9
 * limit that matters here: five sectors, and no sector with a spire twice
 * anybody else's.
 */
export const LANDMARK_RADIUS = 13;
export const LANDMARK_MAX_HEIGHT = 64;

/**
 * Where the pair stands: out near the rim, on the far flank, to either side of
 * the terrain that gathers about the flank's own axis.
 */
export const LANDMARK_ANGLES = [Math.PI - 0.82, Math.PI + 0.82] as const;
export const LANDMARK_DISTANCE = 102;

/**
 * The deck's surface, which a landmark stands on.
 *
 * Its own copy rather than an import, so this module owes nothing to the
 * terrain: the terrain reads *this* one, to keep its blocks off the ground a
 * landmark stands on, and a cycle between the two would be the wrong way round.
 * `wreckage.ts` keeps the same number for the same reason.
 */
const DECK_Y = 11;

/** A stack: the industrial ridge's own chimney, banded, with a warning light. */
function stacks(): LandmarkPart[] {
  return [
    {
      shape: 'cylinder',
      position: [0, 25, 0],
      size: [3.4, 50, 5.2],
      rotation: [0, 0, 0],
      material: 'hull',
    },
    {
      shape: 'cylinder',
      position: [0, 38, 0],
      size: [4.2, 3, 4.2],
      rotation: [0, 0, 0],
      material: 'dark',
    },
    {
      shape: 'box',
      position: [6, 9, 0],
      size: [5, 18, 5],
      rotation: [0, 0.4, 0],
      material: 'dark',
    },
    {
      shape: 'box',
      position: [0, 51.4, 0],
      size: [1.4, 1.4, 1.4],
      rotation: [0, 0, 0],
      material: 'signal',
    },
  ];
}

/** A mast: the data canyon's relay, cross-armed, with a lit dish. */
function mast(): LandmarkPart[] {
  return [
    {
      shape: 'box',
      position: [0, 28, 0],
      size: [2.6, 56, 2.6],
      rotation: [0, 0.3, 0],
      material: 'hull',
    },
    {
      shape: 'box',
      position: [0, 40, 0],
      size: [16, 1.2, 1.6],
      rotation: [0, 0.3, 0],
      material: 'hull',
    },
    {
      shape: 'box',
      position: [0, 33, 0],
      size: [11, 1.2, 1.6],
      rotation: [0, 0.3, 0],
      material: 'hull',
    },
    {
      shape: 'cone',
      position: [0, 58.5, 0],
      size: [3.2, 5, 0],
      rotation: [0, 0, 0],
      material: 'signal',
    },
    {
      shape: 'box',
      position: [0, 2, 0],
      size: [8, 4, 8],
      rotation: [0, 0.3, 0],
      material: 'dark',
    },
  ];
}

/** Leaning pylons: the fractured platforms, thrown off true and left standing. */
function pylons(): LandmarkPart[] {
  return [
    {
      shape: 'box',
      position: [-3, 20, 1],
      size: [5.5, 42, 5.5],
      rotation: [0, 0.2, 0.22],
      material: 'hull',
    },
    {
      shape: 'box',
      position: [6, 14, -2],
      size: [4.5, 30, 4.5],
      rotation: [0.16, -0.3, -0.14],
      material: 'hull',
    },
    {
      shape: 'box',
      position: [1, 33, 0],
      size: [14, 2.2, 3],
      rotation: [0, 0.1, 0.3],
      material: 'dark',
    },
    {
      shape: 'box',
      position: [-7.6, 41, 2],
      size: [1.3, 1.3, 1.3],
      rotation: [0, 0, 0],
      material: 'signal',
    },
  ];
}

/** A gantry crane: the machinery field's, a portal with a hanging hoist. */
function gantry(): LandmarkPart[] {
  return [
    {
      shape: 'box',
      position: [-7, 17, 0],
      size: [3.4, 34, 3.4],
      rotation: [0, 0, 0],
      material: 'hull',
    },
    {
      shape: 'box',
      position: [7, 17, 0],
      size: [3.4, 34, 3.4],
      rotation: [0, 0, 0],
      material: 'hull',
    },
    {
      shape: 'box',
      position: [0, 35.5, 0],
      size: [22, 4, 5],
      rotation: [0, 0, 0],
      material: 'hull',
    },
    {
      shape: 'box',
      position: [3, 29, 0],
      size: [4, 9, 4],
      rotation: [0, 0, 0],
      material: 'dark',
    },
    {
      shape: 'box',
      position: [0, 38.4, 0],
      size: [1.4, 1.4, 1.4],
      rotation: [0, 0, 0],
      material: 'signal',
    },
  ];
}

/** A watch tower: the open basin's, wide-eyed over ground you can see across. */
function tower(): LandmarkPart[] {
  return [
    {
      shape: 'cylinder',
      position: [0, 14, 0],
      size: [3, 28, 4.4],
      rotation: [0, 0, 0],
      material: 'hull',
    },
    {
      shape: 'cylinder',
      position: [0, 31, 0],
      size: [9, 7, 7],
      rotation: [0, 0, 0],
      material: 'dark',
    },
    {
      shape: 'cylinder',
      position: [0, 35.6, 0],
      size: [9.4, 1.4, 9.4],
      rotation: [0, 0, 0],
      material: 'hull',
    },
    {
      shape: 'box',
      position: [0, 37.4, 0],
      size: [1.6, 1.6, 1.6],
      rotation: [0, 0, 0],
      material: 'signal',
    },
  ];
}

const LANDMARKS: Readonly<
  Record<SectorIdentityName, { readonly description: string; readonly build: () => LandmarkPart[] }>
> = {
  INDUSTRIAL_RIDGE: { description: 'Exhaust stack', build: stacks },
  DATA_CANYON: { description: 'Relay mast', build: mast },
  FRACTURED_PLATFORMS: { description: 'Leaning pylons', build: pylons },
  MACHINERY_FIELD: { description: 'Gantry crane', build: gantry },
  TACTICAL_BASIN: { description: 'Watch tower', build: tower },
};

/**
 * The landmark an identity raises. The same structure every round, for the
 * same place — §38.4's geometry that stays stable for orientation.
 *
 * Takes the identity's name rather than reading it, so the terrain can keep
 * its blocks off this without the two modules importing each other in a ring.
 */
export function landmarkFor(name: SectorIdentityName): Landmark {
  const chosen = LANDMARKS[name];
  return { description: chosen.description, parts: chosen.build() };
}

/** Where a landmark of the pair stands, in the sector's own frame. */
export function landmarkPlacement(angle: number): {
  readonly position: readonly [number, number, number];
  readonly rotation: number;
} {
  return {
    position: [Math.sin(angle) * LANDMARK_DISTANCE, DECK_Y, Math.cos(angle) * LANDMARK_DISTANCE],
    // Turned to face the middle of the sector, so a cross-arm or a gantry beam
    // stands across the view rather than end-on to it.
    rotation: angle,
  };
}

/**
 * Where the pair stands, in the sector's own frame: what the terrain has to
 * keep off, and what the rim city has to build around.
 */
export function landmarkFootprints(): readonly {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}[] {
  return LANDMARK_ANGLES.map((angle) => {
    const { position } = landmarkPlacement(angle);
    return { x: position[0], z: position[2], radius: LANDMARK_RADIUS };
  });
}
