import { ACTIVE_TICKERS, type ActiveTicker } from '@ponswars/shared-types';

/**
 * What each faction lands when it takes a sector (§38.5, §36.7, §36.8).
 *
 * Every faction deployed the same object: a hex footing, a mast, a lit
 * octahedron on top, and one colour swapped. §36.7 is explicit that colour
 * alone is never identity — *every faction stays identifiable with faction
 * colours removed* — and one shape in ten colours fails that completely. A
 * player looking at a grey screenshot, or a player who cannot tell green from
 * red, was being shown the same base for all ten.
 *
 * So each faction lands its own structure, built from the directions §39 gives
 * it: racks for the AI Mech Legion, a launch gantry for the Mars Vanguard, a
 * portal ring for the Reality Legion, scaffold and a banner for the Retail
 * Rebellion. They differ in silhouette first and in colour second, which is the
 * order §36.7 puts them in.
 *
 * ## What it must not become
 *
 * A fortress. §38.5 makes the base *temporary* — landed for the round and
 * folded away at the reshuffle — and §38.3 keeps the sector neutral, so nothing
 * here may read as a faction having settled. They stay light, and §36.9 keeps
 * them within a hand's breadth of each other in height: no god-base for one
 * faction and a tent for another.
 *
 * Pure data, no three. The silhouette rule is the thing worth testing, and a
 * test should not need a renderer to check it.
 */

export type FobShapeKind = 'box' | 'cylinder' | 'cone' | 'octahedron' | 'torus';

export interface FobPart {
  readonly shape: FobShapeKind;
  /** Centre, in the base's own space, standing on the deck at `y = 0`. */
  readonly position: readonly [number, number, number];
  /**
   * What the shape is sized by, in world units:
   *
   * - `box` — width, height, depth
   * - `cylinder` — top radius, height, bottom radius
   * - `cone` — radius, height, (unused)
   * - `octahedron` — radius, (unused), (unused)
   * - `torus` — radius, tube, (unused)
   */
  readonly size: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  /**
   * Which of the three surfaces it is.
   *
   * `accent` is the faction's colour and is used sparingly — §36.5 makes those
   * accents, never washes, and a base painted in one is a lamp.
   */
  readonly material: 'hull' | 'dark' | 'accent';
}

export interface FobShape {
  /** What the structure is, for anyone reading the code or a label. */
  readonly description: string;
  readonly parts: readonly FobPart[];
}

/**
 * How far from the base's own centre anything may stand.
 *
 * The base sits at the outer edge of its staging ground, and the ranks form
 * inward of it. Anything reaching past this is standing in a formation.
 */
export const FOB_RADIUS = 22;

/** The range every faction's structure tops out in (§36.9). */
export const FOB_MIN_HEIGHT = 24;
export const FOB_MAX_HEIGHT = 40;

/** A footing every base stands on, so they all read as landed on the deck. */
const FOOTING: FobPart = {
  shape: 'cylinder',
  position: [0, 3, 0],
  size: [10, 6, 13],
  rotation: [0, 0, 0],
  material: 'dark',
};

const SHAPES: Readonly<Record<ActiveTicker, FobShape>> = {
  // Racks of compute, stacked and stepped, with two upright fins. Reads as a
  // machine that was set down rather than a building (§39: AI Mech Legion).
  NVDA: {
    description: 'Stepped compute racks with cooling fins',
    parts: [
      FOOTING,
      {
        shape: 'box',
        position: [0, 9, 0],
        size: [17, 6, 13],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [0, 15, 0],
        size: [14, 6, 11],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [0, 21, 0],
        size: [11, 6, 9],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [-5, 28, 0],
        size: [2, 12, 8],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'box',
        position: [5, 28, 0],
        size: [2, 12, 8],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'box',
        position: [0, 24.5, 0],
        size: [11.5, 1, 9.5],
        rotation: [0, 0, 0],
        material: 'accent',
      },
    ],
  },
  // One smooth tapered monolith on a clean disc. The quietest silhouette of the
  // ten, which is the Titanium Guard's whole character (§39).
  AAPL: {
    description: 'Tapered monolith on a machined disc',
    parts: [
      FOOTING,
      {
        shape: 'cylinder',
        position: [0, 7.5, 0],
        size: [11, 3, 12],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'cylinder',
        position: [0, 22, 0],
        size: [3.4, 26, 7.5],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'torus',
        position: [0, 31, 0],
        size: [4.2, 0.7, 0],
        rotation: [Math.PI / 2, 0, 0],
        material: 'accent',
      },
    ],
  },
  // A row of standing barrier panes behind a low server block: the Azure Cyber
  // Corps fights from behind holographic cover (§39).
  MSFT: {
    description: 'Barrier panes over a server block',
    parts: [
      FOOTING,
      {
        shape: 'box',
        position: [0, 9.5, 0],
        size: [16, 7, 12],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [0, 22, -5],
        size: [13, 18, 0.9],
        rotation: [0, 0, 0],
        material: 'accent',
      },
      {
        shape: 'box',
        position: [-7.5, 20, 0],
        size: [9, 15, 0.9],
        rotation: [0, Math.PI / 2, 0],
        material: 'accent',
      },
      {
        shape: 'box',
        position: [7.5, 20, 0],
        size: [9, 15, 0.9],
        rotation: [0, Math.PI / 2, 0],
        material: 'accent',
      },
      {
        shape: 'box',
        position: [0, 27, 0],
        size: [3, 6, 3],
        rotation: [0, 0, 0],
        material: 'dark',
      },
    ],
  },
  // A launch gantry: a standing rocket and the lattice tower beside it. Mars
  // Vanguard arrive by landing (§39).
  TSLA: {
    description: 'Launch gantry beside a standing booster',
    parts: [
      FOOTING,
      {
        shape: 'cylinder',
        position: [-4, 20, 0],
        size: [3.6, 26, 4.2],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'cone',
        position: [-4, 36, 0],
        size: [3.6, 6, 0],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [7, 16, 0],
        size: [1.6, 26, 1.6],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'box',
        position: [7, 29, 0],
        size: [1.4, 1.4, 9],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'box',
        position: [1.5, 29, 0],
        size: [9, 1, 1.4],
        rotation: [0, 0, 0],
        material: 'accent',
      },
    ],
  },
  // Scaffold, mismatched crates and a banner. The Retail Rebellion built theirs
  // out of what was lying about (§39), and nothing about it lines up.
  GME: {
    description: 'Improvised scaffold under a banner mast',
    parts: [
      FOOTING,
      {
        shape: 'box',
        position: [-4, 9, 2],
        size: [10, 6, 9],
        rotation: [0, 0.3, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [4, 11, -3],
        size: [8, 10, 7],
        rotation: [0, -0.5, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [-2, 16, -2],
        size: [7, 5, 6],
        rotation: [0, 0.8, 0],
        material: 'dark',
      },
      {
        shape: 'cylinder',
        position: [2, 24, 0],
        size: [0.8, 22, 0.8],
        rotation: [0, 0, 0.12],
        material: 'dark',
      },
      {
        shape: 'box',
        position: [5.5, 31, 0],
        size: [7, 5, 0.4],
        rotation: [0, 0, 0.12],
        material: 'accent',
      },
    ],
  },
  // A portal ring on two footings. The Reality Legion arrive through theirs
  // rather than landing it (§39).
  META: {
    description: 'Portal ring on paired footings',
    parts: [
      FOOTING,
      {
        shape: 'box',
        position: [-8, 10, 0],
        size: [4, 8, 5],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [8, 10, 0],
        size: [4, 8, 5],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'torus',
        position: [0, 22, 0],
        size: [10, 1.6, 0],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'torus',
        position: [0, 22, 0],
        size: [7.4, 0.5, 0],
        rotation: [0, 0, 0],
        material: 'accent',
      },
    ],
  },
  // Cargo pods stacked under a crane arm. The Fulfillment Army's base is a
  // depot, and the arm is what makes it read as one (§39).
  AMZN: {
    description: 'Cargo stack under a crane arm',
    parts: [
      FOOTING,
      {
        shape: 'box',
        position: [-3, 9, 0],
        size: [13, 6, 11],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [-4, 15, 1],
        size: [10, 6, 8],
        rotation: [0, 0.18, 0],
        material: 'hull',
      },
      {
        shape: 'cylinder',
        position: [7, 19, 0],
        size: [1.5, 28, 1.5],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'box',
        position: [0, 31, 0],
        size: [18, 1.4, 1.4],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'box',
        position: [-7, 28.5, 0],
        size: [1, 4, 1],
        rotation: [0, 0, 0],
        material: 'accent',
      },
    ],
  },
  // A scanning dish on a mast over a low array. The Intelligence Division look
  // before they move (§39).
  GOOGL: {
    description: 'Scanning dish over a sensor array',
    parts: [
      FOOTING,
      {
        shape: 'box',
        position: [0, 9, 0],
        size: [15, 6, 11],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'cylinder',
        position: [0, 19, 0],
        size: [1.7, 16, 2.2],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'cone',
        position: [0, 29, 0],
        size: [8.5, 7, 0],
        rotation: [Math.PI, 0, 0.35],
        material: 'hull',
      },
      {
        shape: 'octahedron',
        position: [0, 26.5, 0],
        size: [1.6, 0, 0],
        rotation: [0, 0, 0],
        material: 'accent',
      },
    ],
  },
  // A reactor core held between two angled blades. The Red Core Battalion's
  // base is the engine they run on (§39).
  AMD: {
    description: 'Reactor core between angled blades',
    parts: [
      FOOTING,
      {
        shape: 'box',
        position: [0, 9, 0],
        size: [12, 6, 10],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [-7, 19, 0],
        size: [2.2, 20, 7],
        rotation: [0, 0, -0.3],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [7, 19, 0],
        size: [2.2, 20, 7],
        rotation: [0, 0, 0.3],
        material: 'hull',
      },
      {
        shape: 'octahedron',
        position: [0, 21, 0],
        size: [5.5, 0, 0],
        rotation: [0, 0.4, 0],
        material: 'accent',
      },
      {
        shape: 'cylinder',
        position: [0, 28, 0],
        size: [1.2, 9, 1.8],
        rotation: [0, 0, 0],
        material: 'dark',
      },
    ],
  },
  // A command post with flanking pylons: the widest footprint and the lowest
  // peak of the ten, because the Market Federation bring everything (§39).
  SPY: {
    description: 'Command post between flanking pylons',
    parts: [
      FOOTING,
      {
        shape: 'box',
        position: [0, 10, 0],
        size: [20, 8, 13],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'box',
        position: [-11, 16, 0],
        size: [3, 20, 4],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'box',
        position: [11, 16, 0],
        size: [3, 20, 4],
        rotation: [0, 0, 0],
        material: 'dark',
      },
      {
        shape: 'cylinder',
        position: [0, 20, 0],
        size: [2.6, 12, 3.4],
        rotation: [0, 0, 0],
        material: 'hull',
      },
      {
        shape: 'octahedron',
        position: [0, 27.5, 0],
        size: [3.2, 0, 0],
        rotation: [0, 0, 0],
        material: 'accent',
      },
    ],
  },
};

/** What this faction lands. */
export function fobShape(ticker: ActiveTicker): FobShape {
  return SHAPES[ticker];
}

/** Every faction that has one, which is all ten of §4.1. */
export const FOB_FACTIONS: readonly ActiveTicker[] = ACTIVE_TICKERS;

/**
 * How tall a structure stands, for the scale rule §36.9 asks for.
 *
 * Measured from the deck to the top of the highest part, by the extent that
 * part is drawn with — a torus stands a tube above its radius, an octahedron a
 * radius above its centre.
 */
export function fobHeight(shape: FobShape): number {
  return Math.max(
    ...shape.parts.map((part) => {
      const [x, y] = part.size;
      switch (part.shape) {
        case 'box':
        case 'cylinder':
        case 'cone':
          return part.position[1] + y / 2;
        case 'octahedron':
          return part.position[1] + x;
        case 'torus':
          return part.position[1] + x + y;
      }
    }),
  );
}

/**
 * The shape of a base with its colours taken away (§36.7).
 *
 * What is left when the accent is gone: which solids it is made of and how big
 * they are. Two factions whose bases reduce to the same string are two factions
 * a viewer cannot tell apart in a grey screenshot — which is the failure §36.7
 * names, and the reason this is computed rather than eyeballed.
 */
export function fobSilhouette(shape: FobShape): string {
  return shape.parts
    .map((part) =>
      [
        part.shape,
        ...part.size.map((value) => Math.round(value)),
        ...part.position.map((value) => Math.round(value)),
      ].join(':'),
    )
    .sort()
    .join('|');
}
