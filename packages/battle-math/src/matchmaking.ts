import { ACTIVE_TICKERS, BATTLES_PER_ROUND, MATCHUP_COOLDOWN_ROUNDS } from '@ponswars/shared-types';
import type { ActiveTicker } from '@ponswars/shared-types';
import { DeterministicPrng, deriveRoundSeed } from './prng.js';

/**
 * Deterministic matchmaking (§4.3).
 *
 * Ten active stocks produce exactly five simultaneous battles, each stock
 * appearing once, no self-match, and the same unordered matchup barred for two
 * rounds. The result must be reproducible from a chain-derived seed and the
 * round context alone — §26 requires a third party to be able to check that the
 * pairings were not chosen to favour anyone.
 */

/** Domain separator so matchmaking never shares a byte stream with another use. */
const MATCHMAKING_DOMAIN = 'PONSWARS_MATCHMAKING_V1';

/** A scheduled pairing. `left` and `right` are staging positions, not advantages. */
export interface Pairing {
  readonly left: ActiveTicker;
  readonly right: ActiveTicker;
}

/** Canonical key for an unordered matchup, so `A vs B` and `B vs A` collide. */
export function matchupKey(a: ActiveTicker, b: ActiveTicker): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Builds the forbidden set from recent history.
 *
 * Accepts the most recent rounds newest-first and considers only
 * {@link MATCHUP_COOLDOWN_ROUNDS} of them — twenty minutes at the locked round
 * length. Older rounds are ignored rather than rejected, so a caller may pass a
 * longer history without changing the outcome.
 */
export function cooldownSet(recentRounds: readonly (readonly Pairing[])[]): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const round of recentRounds.slice(0, MATCHUP_COOLDOWN_ROUNDS)) {
    for (const pairing of round) {
      blocked.add(matchupKey(pairing.left, pairing.right));
    }
  }
  return blocked;
}

/**
 * Pairs an ordered roster, skipping matchups on cooldown.
 *
 * Depth-first over the shuffled order: take the first unpaired ticker, try each
 * remaining ticker as its partner in order, recurse, and backtrack when a branch
 * dead-ends. The shuffle supplies the randomness; the search only guarantees the
 * cooldown constraint is met.
 *
 * A solution always exists. The forbidden set is at most two perfect matchings
 * over ten vertices, so every ticker still has seven eligible partners — well
 * above the `n/2` threshold that guarantees a perfect matching. The search
 * therefore returns `null` only if the caller supplied a history that could not
 * have been produced by this scheduler.
 */
function pairInOrder(
  order: readonly ActiveTicker[],
  blocked: ReadonlySet<string>,
): Pairing[] | null {
  if (order.length === 0) {
    return [];
  }

  const [head, ...rest] = order;
  /* c8 ignore next 3 -- unreachable: length was checked above. */
  if (head === undefined) {
    return null;
  }

  for (let i = 0; i < rest.length; i += 1) {
    const partner = rest[i];
    if (partner === undefined) continue;
    if (blocked.has(matchupKey(head, partner))) continue;

    const remaining = [...rest.slice(0, i), ...rest.slice(i + 1)];
    const tail = pairInOrder(remaining, blocked);
    if (tail !== null) {
      return [{ left: head, right: partner }, ...tail];
    }
  }
  return null;
}

export interface MatchmakingInput {
  /** Chain-derived base seed, hex. */
  readonly baseSeedHex: string;
  /** Round this schedule is for. Mixed into the seed so rounds cannot collide. */
  readonly roundId: string;
  /**
   * Tickers eligible this round.
   *
   * Defaults to the active roster. A caller substitutes a reserve ticker here
   * when an active asset's data is unhealthy *before* the round (§4.2, §4.4).
   */
  readonly roster?: readonly ActiveTicker[];
  /** Previous rounds, newest first, for the cooldown rule (§4.3). */
  readonly recentRounds?: readonly (readonly Pairing[])[];
}

/**
 * Produces the five pairings for a round.
 *
 * Pure and deterministic: the same input always yields the same schedule, which
 * is what makes it auditable.
 *
 * @throws RangeError if the roster is not an even, duplicate-free set of the
 *   expected size.
 * @throws Error if no schedule satisfies the cooldown constraint, which can only
 *   happen for a history this scheduler could not have produced.
 */
export function scheduleRound(input: MatchmakingInput): readonly Pairing[] {
  const roster = input.roster ?? ACTIVE_TICKERS;

  if (roster.length !== BATTLES_PER_ROUND * 2) {
    throw new RangeError(
      `Roster must hold exactly ${String(BATTLES_PER_ROUND * 2)} tickers, received ${String(roster.length)}`,
    );
  }
  if (new Set(roster).size !== roster.length) {
    throw new RangeError('Roster must not contain duplicate tickers');
  }

  const seed = deriveRoundSeed(input.baseSeedHex, input.roundId);
  const prng = new DeterministicPrng(seed, MATCHMAKING_DOMAIN);
  const order = prng.shuffle(roster);
  const blocked = cooldownSet(input.recentRounds ?? []);

  const pairings = pairInOrder(order, blocked);
  if (pairings === null) {
    throw new Error(
      `No schedule satisfies the ${String(MATCHUP_COOLDOWN_ROUNDS)}-round matchup cooldown for round ${input.roundId}`,
    );
  }
  return pairings;
}
