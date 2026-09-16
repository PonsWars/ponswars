import { FACTION_ACCENT } from '@ponswars/ui-tokens';
import type { MomentumState } from '@ponswars/shared-types';

/**
 * What each sector throws down into the weather (§38.10, §36.14, §36.15).
 *
 * The cloud under this world was lit by one thing: the Market Core, from the
 * middle. Everything else in the deck was the same flat blue at every point,
 * which is why the middle distance read as a painted backdrop rather than as
 * weather five battles are being fought above.
 *
 * A battle is the brightest thing in its sector, and cloud under a battle
 * should carry its light. That is §36.14's "market pulses" and §38.10's
 * atmosphere shifting with the phase — and it is not only decoration: §36.15
 * puts *which side is pushing* among the things a viewer must be able to read
 * at a glance, and light in the deck says it from any distance and any angle,
 * before a label is legible.
 *
 * Pure, and no three: the colours come back as the tokens they are, and the
 * scene turns them into light. That keeps the rule — which faction, how much —
 * testable without a renderer, which is the only way it is testable at all.
 */

export interface SectorGlow {
  /** Where the sector stands, in world units. */
  readonly x: number;
  readonly z: number;
  /** The accent of the faction on each side (§36.5: accents, never washes). */
  readonly left: string;
  readonly right: string;
  /**
   * The share of the field the left faction holds, `0`–`1`.
   *
   * The frontline, passed through rather than derived: §24 keeps the score
   * hidden for the whole live battle, and the frontline is what the client is
   * given instead (§13.2). Light mixed by it says who is pushing without ever
   * having held a number that could say by how much.
   */
  readonly hold: number;
  /** How much light this sector throws, `0`–`1`. */
  readonly strength: number;
}

/**
 * How bright each momentum state burns.
 *
 * `CALIBRATE` (§59.4). Ordered rather than exact: a contested battle glows, a
 * dominated one glows hardest, and a comeback burns nearly as bright because
 * §13 makes it the moment worth looking up for.
 */
/**
 * The accent table, read by ticker rather than by faction.
 *
 * Widened on purpose: a battle arrives over the wire, so the ticker in it is a
 * string until something checks it. Looking it up through the narrow type would
 * make TypeScript certain of an answer the network never promised.
 */
const ACCENTS: Readonly<Record<string, string | undefined>> = FACTION_ACCENT;

const STRENGTH: Readonly<Record<MomentumState, number>> = {
  CONTESTED: 0.45,
  PUSHING: 0.62,
  SURGING: 0.82,
  DOMINATING: 1,
  COMEBACK: 0.94,
};

export interface GlowingBattle {
  readonly sectorIndex: number;
  readonly left: string;
  readonly right: string;
  readonly momentum: MomentumState;
  readonly frontline: number;
}

/**
 * One glow per sector that has a battle in it.
 *
 * Sectors are matched by index rather than by order: §38.3 lets any pair occupy
 * any sector, and a battle list that arrived in another order would otherwise
 * light the wrong rock.
 */
export function sectorGlows(
  battles: readonly GlowingBattle[],
  positions: readonly { readonly x: number; readonly z: number }[],
): readonly SectorGlow[] {
  return battles.flatMap((battle) => {
    const at = positions[battle.sectorIndex];
    if (at === undefined) {
      return [];
    }
    const left = ACCENTS[battle.left];
    const right = ACCENTS[battle.right];
    if (left === undefined || right === undefined) {
      // A ticker this build has no accent for lights nothing, rather than
      // lighting the weather in a colour nobody chose (§36.5).
      return [];
    }
    return [
      {
        x: at.x,
        z: at.z,
        left,
        right,
        hold: clamp(battle.frontline),
        strength: STRENGTH[battle.momentum],
      },
    ];
  });
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
