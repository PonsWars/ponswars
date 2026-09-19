import type { Placement } from './InstancedField.js';
import {
  clearOfBattle,
  DECK_RADIUS,
  sectorIdentity,
  type TerrainBlock,
} from './sector-identity.js';

/**
 * What the market left broken on the deck (§36.4).
 *
 * §36.4 describes the battlefield as a digital financial warzone — *damaged
 * market infrastructure, ruined and active financial-tech machinery* — and the
 * deck had none of the damage. Everything on it was standing, intact and
 * square, which is a trading floor rather than a place that has been fought
 * over every ten minutes for as long as the world has existed.
 *
 * Two kinds of wreck, both from a market rather than from a war:
 *
 * - **A toppled ticker pylon.** The tall display boards an exchange hangs its
 *   symbols on, fallen over and lying tilted on the deck with a few segments of
 *   its face still lit.
 * - **A snapped gantry.** A frame that carried cable or signage, one leg broken
 *   short and its crossbar hanging off it at an angle.
 *
 * Neutral, like the rest of the sector (§38.3): nobody's colours, and a wreck
 * is where it is because of the place, not the matchup — seeded from the sector
 * index and from nothing else. And kept off everybody's ground by the same rule
 * the sector's terrain is (`clearOfBattle`), because a pylon lying across the
 * contested strip would be the one thing on the deck a player cannot read past.
 *
 * Pure placement, no three. The rotation maths is here rather than in the
 * scene so the lit segments land on the face of the board they belong to, and
 * so a test can check where they land.
 */

export interface Wreck {
  readonly kind: 'PYLON' | 'GANTRY';
  /** Its solid parts. */
  readonly hull: readonly Placement[];
  /** What still has power: segments of a display face, a live cable end. */
  readonly lit: readonly Placement[];
  /** Where it stands and how far it reaches, for the keep-out. */
  readonly centre: readonly [number, number];
  readonly reach: number;
}

/** The deck's surface. */
const DECK_Y = 11;

/**
 * Where wreckage lies: the four corners of the deck at the battle's two ends.
 *
 * Behind each district, either side of where its forward base lands. The
 * flanks carry the sector's own terrain and the ends carry the bases, which
 * leaves these — and they are the corners a sector camera looks across.
 */
const CORNERS: readonly (readonly [number, number])[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

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
 * A point in a piece's own frame, turned by its tilt and then its heading.
 *
 * The same order three applies `[0, yaw, tilt]` in — tilt about the piece's own
 * z, then heading about the world's y — so what is computed here is where the
 * scene draws it.
 */
function turned(
  local: readonly [number, number, number],
  yaw: number,
  tilt: number,
): [number, number, number] {
  const [u, v, w] = local;
  const x1 = u * Math.cos(tilt) - v * Math.sin(tilt);
  const y1 = u * Math.sin(tilt) + v * Math.cos(tilt);
  return [x1 * Math.cos(yaw) + w * Math.sin(yaw), y1, -x1 * Math.sin(yaw) + w * Math.cos(yaw)];
}

function pylon(x: number, z: number, random: () => number): Wreck {
  const length = 18 + random() * 8;
  const width = 4;
  const thickness = 1.4;
  // Lying with one end on the deck and the other propped on its own wreckage.
  const tilt = 0.12 + random() * 0.3;
  const yaw = random() * Math.PI * 2;
  const rise = Math.sin(tilt) * (length / 2) + thickness / 2;

  const board: Placement = {
    position: [x, DECK_Y + rise, z],
    scale: [length, thickness, width],
    rotation: [0, yaw, tilt],
  };
  // What it is propped on: a slumped block under the raised end.
  const [ex, , ez] = turned([length / 2 - 3, 0, 0], yaw, 0);
  const rubble: Placement = {
    position: [x + ex, DECK_Y + rise * 0.9, z + ez],
    scale: [5 + random() * 3, rise * 1.8, 6 + random() * 3],
    rotation: [0, yaw + (random() - 0.5), 0],
  };

  // Its face: a row of display segments along the top, a few still lit. The
  // gaps are the damage — a board with every segment lit is a working board.
  const lit: Placement[] = [];
  const segments = 9;
  for (let index = 0; index < segments; index += 1) {
    if (random() < 0.55) {
      continue;
    }
    const along = -length / 2 + ((index + 0.5) / segments) * length;
    const [sx, sy, sz] = turned([along, thickness / 2 + 0.15, 0], yaw, tilt);
    lit.push({
      position: [x + sx, DECK_Y + rise + sy, z + sz],
      scale: [(length / segments) * 0.8, 0.3, width * 0.7],
      rotation: [0, yaw, tilt],
    });
  }

  return {
    kind: 'PYLON',
    hull: [board, rubble],
    lit,
    centre: [x, z],
    reach: length / 2 + width,
  };
}

function gantry(x: number, z: number, random: () => number): Wreck {
  const span = 14 + random() * 6;
  const tall = 16 + random() * 6;
  const snapped = tall * (0.4 + random() * 0.2);
  const yaw = random() * Math.PI * 2;
  const leg = 1.8;

  const [ax, , az] = turned([-span / 2, 0, 0], yaw, 0);
  const [bx, , bz] = turned([span / 2, 0, 0], yaw, 0);
  const standing: Placement = {
    position: [x + ax, DECK_Y + tall / 2, z + az],
    scale: [leg, tall, leg],
    rotation: [0, yaw, 0],
  };
  const broken: Placement = {
    position: [x + bx, DECK_Y + snapped / 2, z + bz],
    scale: [leg, snapped, leg],
    rotation: [0, yaw, 0],
  };
  // The crossbar, still fixed at the standing leg and dropped onto the broken
  // one: its tilt is the difference in their heights across the span.
  const drop = Math.atan2(snapped - tall, span);
  const barLength = Math.hypot(span, tall - snapped);
  const bar: Placement = {
    position: [x, DECK_Y + (tall + snapped) / 2, z],
    scale: [barLength, 1.4, 1.4],
    rotation: [0, yaw, drop],
  };
  // A live cable end where it snapped.
  const spark: Placement = {
    position: [x + bx, DECK_Y + snapped + 0.8, z + bz],
    scale: [1, 1, 1],
    rotation: [0, 0, 0],
  };

  return {
    kind: 'GANTRY',
    hull: [standing, broken, bar],
    lit: [spark],
    centre: [x, z],
    reach: span / 2 + leg,
  };
}

/** How many places in a corner are tried before it is left empty. */
const ATTEMPTS = 6;

/** Whether a wreck lies wholly on the deck and off everybody's ground. */
export function wreckFits(wreck: Wreck): boolean {
  const [x, z] = wreck.centre;
  const footprint = {
    position: [x, 0, z] as const,
    size: [wreck.reach * 2, 0, 0] as const,
    rotation: 0,
    tone: 0,
    lit: false,
  };
  // The whole of it on the rock, not just its middle: a board hanging past the
  // rim with nothing under it reads as floating, not as fallen.
  return clearOfBattle(footprint) && Math.hypot(x, z) + wreck.reach <= DECK_RADIUS;
}

/**
 * Whether a wreck would lie across one of the sector's own terrain blocks.
 *
 * Two solids occupying the same place read as a rendering fault, not as a
 * pylon that fell against a ridge — so a wreck goes where the terrain is not.
 */
function overlapsTerrain(wreck: Wreck, blocks: readonly TerrainBlock[]): boolean {
  return blocks.some((block) => {
    const reach = Math.hypot(block.size[0], block.size[2]) / 2;
    const [x, , z] = block.position;
    return Math.hypot(x - wreck.centre[0], z - wreck.centre[1]) < reach + wreck.reach;
  });
}

/**
 * The wreckage on one sector, by its index.
 *
 * One wreck in each corner where one fits. A corner that cannot take one
 * without reaching onto somebody's ground, off the rock, or into the sector's
 * own terrain is left empty rather than crowded.
 */
export function sectorWreckage(index: number): readonly Wreck[] {
  const random = generator(index * 1_471 + 7);
  const terrain = sectorIdentity(index).blocks;
  return CORNERS.flatMap(([sx, sz]) => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      // Out past the district and its base, toward the rim.
      const radius = 86 + random() * 16;
      const angle = 0.5 + random() * 0.45;
      const x = sx * Math.sin(angle) * radius;
      const z = sz * Math.cos(angle) * radius;
      const wreck = random() < 0.6 ? pylon(x, z, random) : gantry(x, z, random);
      if (wreckFits(wreck) && !overlapsTerrain(wreck, terrain)) {
        return [wreck];
      }
    }
    return [];
  });
}
