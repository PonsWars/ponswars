import { battleResultSchema, currentRoundSchema } from '@ponswars/schemas';
import {
  battleId as toBattleId,
  roundId as toRoundId,
  utcTimestamp,
  type FinalizedBattleResult,
} from '@ponswars/shared-types';
import type { ClientBattle, ClientRound } from '../state/session.js';
import type { LiveEndpoints } from './endpoints.js';

/**
 * Fetching the authoritative round (§47.1, §70.7 step 2).
 *
 * Two jobs, and no third. It parses what arrived — the same schema the server
 * parsed on the way out, so a payload that drifted fails here rather than
 * halfway through a render — and it maps that into the shapes the store holds.
 *
 * The mapping is the interesting half. `ClientBattle` has no score field and
 * the response has no score to put in one (§24, §48.3); the momentum and
 * frontline a battle starts at are stated here rather than read from a payload
 * that does not carry them, and every later value comes from the realtime
 * stream. Nothing in this file computes anything a server decides.
 */

/** How a fetch failed, in terms the caller can act on. */
export type RoundFetchFailure =
  /** The request never completed: offline, DNS, CORS, a closed laptop lid. */
  | { readonly kind: 'UNREACHABLE'; readonly detail: string }
  /** The server answered, but not with a round. */
  | { readonly kind: 'REJECTED'; readonly status: number }
  /** The body is not the shape §47.1 publishes. Never partially applied. */
  | { readonly kind: 'MALFORMED'; readonly detail: string };

export interface RoundSnapshot {
  readonly round: ClientRound;
  readonly battles: readonly ClientBattle[];
  /**
   * Server time when the response was produced, from the canonical clock
   * (§23.5).
   *
   * Carried out separately so the caller can compare it with the local clock
   * and keep the offset every countdown is projected through. The device clock
   * is never authority.
   */
  readonly serverTime: number;
}

export type RoundFetchResult =
  | { readonly ok: true; readonly snapshot: RoundSnapshot }
  | { readonly ok: false; readonly failure: RoundFetchFailure };

/**
 * The momentum and frontline a battle is shown at before the stream speaks.
 *
 * A battle the client has just learned about has no momentum history, and §13
 * derives momentum from movement over time — so the honest starting point is
 * the neutral one, replaced by the first `BATTLE_STATE_UPDATE`. Guessing from
 * anything in the snapshot would be inventing a reading the server did not
 * publish.
 */
const NEUTRAL_MOMENTUM = 'CONTESTED' as const;
const CENTRE_FRONTLINE = 0.5;

/**
 * Reads the current round.
 *
 * `signal` is threaded through so a component that unmounts, or a poll that is
 * superseded, stops rather than resolving into a store that has moved on.
 */
export async function fetchCurrentRound(
  endpoints: LiveEndpoints,
  signal?: AbortSignal,
  // Injected so a test can answer without a network. Not a seam for anything
  // else: nothing in this app should be fetching through a substitute.
  fetchImpl: typeof fetch = fetch,
): Promise<RoundFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoints.api}/v1/rounds/current`, {
      signal: signal ?? null,
      headers: { accept: 'application/json' },
    });
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'UNREACHABLE', detail: String(error) } };
  }

  if (!response.ok) {
    return { ok: false, failure: { kind: 'REJECTED', status: response.status } };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'MALFORMED', detail: String(error) } };
  }

  const parsed = currentRoundSchema.safeParse(body);
  if (!parsed.success) {
    // Not partially applied. A round missing a field is a round this client
    // cannot render truthfully, and rendering four of five battles would look
    // like a round with four battles.
    return {
      ok: false,
      failure: { kind: 'MALFORMED', detail: parsed.error.issues[0]?.message ?? 'unknown' },
    };
  }

  return { ok: true, snapshot: toSnapshot(parsed.data) };
}

/** Maps a parsed response onto the shapes the store holds. */
export function toSnapshot(body: ReturnType<typeof currentRoundSchema.parse>): RoundSnapshot {
  return {
    round: {
      roundId: body.roundId,
      state: body.state,
      // Through the checked constructors rather than cast. The schema proves
      // the fields are numbers; `utcTimestamp` proves they are timestamps, and
      // that is the difference between a clock and five numbers.
      clock: {
        serverTime: utcTimestamp(body.clock.serverTime),
        pickOpenAt: utcTimestamp(body.clock.pickOpenAt),
        lockAt: utcTimestamp(body.clock.lockAt),
        battleStartAt: utcTimestamp(body.clock.battleStartAt),
        battleEndAt: utcTimestamp(body.clock.battleEndAt),
      },
      // §23.6 gives the client two words. The API does not publish it yet, and
      // a client that assumed `DEGRADED` would put a warning on a healthy feed
      // while one that assumed `HEALTHY` would hide a real one — so this states
      // the assumption in one place, to be replaced when the field lands.
      feedHealth: 'HEALTHY',
    },
    battles: body.battles.map((battle, slot) => ({
      battleId: battle.battleId,
      sectorIndex: slot,
      left: battle.left,
      right: battle.right,
      leftIntel: battle.leftIntel,
      rightIntel: battle.rightIntel,
      momentum: NEUTRAL_MOMENTUM,
      frontline: CENTRE_FRONTLINE,
      // What this wallet backs is a different request (§47.5). `null` is "not
      // known yet", and the pick view fills it in — not a claim that the player
      // has not picked.
      backing: null,
    })),
    serverTime: body.clock.serverTime,
  };
}

/**
 * A finalized battle result (§47.1, §27.8).
 *
 * The same fact the `ROUND_FINALIZED` event carries — §25 makes a result
 * immutable once it exists, so the two cannot disagree. This is how a client
 * that was not connected when the battle ended can still show it, which is the
 * common case: the result screen is reached *after* the round it describes.
 *
 * `null` means no result yet, which the server answers identically for a battle
 * that is still running and one that does not exist (§12.6).
 */
export async function fetchBattleResult(
  endpoints: LiveEndpoints,
  battleId: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<FinalizedBattleResult | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoints.api}/v1/battles/${battleId}/result`, {
      signal: signal ?? null,
      headers: { accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  const parsed = battleResultSchema.safeParse(body);
  if (!parsed.success) {
    return null;
  }

  const { battleId: id, roundId, finalizedAt, tiebreakStep, ...rest } = parsed.data;
  return {
    ...rest,
    battleId: toBattleId(id),
    roundId: toRoundId(roundId),
    finalizedAt: utcTimestamp(finalizedAt),
    ...(tiebreakStep === undefined ? {} : { tiebreakStep }),
  };
}
