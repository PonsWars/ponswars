import { apiErrorSchema, type ApiError } from '@ponswars/schemas';

/**
 * Every error this API returns (§110.5, §47).
 *
 * §110.5 requires an error to say three things: what happened, whether the
 * player's funds and state are safe, and what they can do next. The schema
 * makes all three required, so the way to satisfy it is to actually answer
 * them — which is why each error below states plainly whether anything was
 * lost, even when the answer is obviously nothing.
 *
 * That second field is the one worth the effort. A player whose pick was
 * rejected at the lock boundary does not need reassurance in general; they need
 * to know their card was not spent.
 */

export interface ErrorResponse {
  readonly status: number;
  readonly body: ApiError;
}

function error(
  status: number,
  code: string,
  message: string,
  stateIsSafe: boolean,
  nextStep: string,
  correlationId: string,
): ErrorResponse {
  // Parsed, not cast. An error response that failed its own schema would be the
  // least useful possible thing to discover in production.
  return {
    status,
    body: apiErrorSchema.parse({ code, message, stateIsSafe, nextStep, correlationId }),
  };
}

/** The body did not match the schema (§66.2). */
export function invalidRequest(detail: string, correlationId: string): ErrorResponse {
  return error(
    400,
    'INVALID_REQUEST',
    `The request did not match the expected shape: ${detail}`,
    true,
    'Correct the request and send it again. Nothing was recorded.',
    correlationId,
  );
}

/** No round is loaded yet, or the id names a different one. */
export function roundNotFound(roundId: string, correlationId: string): ErrorResponse {
  return error(
    404,
    'ROUND_NOT_FOUND',
    `Round ${roundId} is not the round currently in play.`,
    true,
    'Fetch GET /v1/rounds/current and pick in the round it names.',
    correlationId,
  );
}

/**
 * The pick arrived after the lock (§3.2, §72.4).
 *
 * The server decides this, never the client's countdown — a device whose clock
 * runs slow would otherwise argue its way past the boundary. Saying the card
 * was not spent matters more here than anywhere else in the API: a player who
 * misses the lock will assume they lost a charge.
 */
export function picksClosed(correlationId: string): ErrorResponse {
  return error(
    409,
    'PICKS_CLOSED',
    'Picks for this round closed when it locked.',
    true,
    'Nothing was recorded and no card charge was spent. The next round opens shortly.',
    correlationId,
  );
}

/** The battle id is not one of the five in this round. */
export function battleNotInRound(battleId: string, correlationId: string): ErrorResponse {
  return error(
    422,
    'BATTLE_NOT_IN_ROUND',
    `Battle ${battleId} is not part of this round.`,
    true,
    'Fetch the current round and back one of the battles it lists.',
    correlationId,
  );
}

/**
 * The backed ticker is not one of the two fighting.
 *
 * Separate from the battle check so the message can say which mistake was made.
 * "Invalid request" for a player who backed the right battle and mistyped the
 * ticker is a worse answer than naming it.
 */
export function tickerNotInBattle(ticker: string, correlationId: string): ErrorResponse {
  return error(
    422,
    'TICKER_NOT_IN_BATTLE',
    `${ticker} is not one of the two stocks in that battle.`,
    true,
    'Back one of the two stocks the battle lists.',
    correlationId,
  );
}

/** One pick per wallet per round (§4.2). */
export function alreadyPicked(correlationId: string): ErrorResponse {
  return error(
    409,
    'ALREADY_PICKED',
    'This wallet has already backed a battle in this round.',
    true,
    'Change the existing pick instead; it can be changed until the round locks.',
    correlationId,
  );
}

/**
 * No result for that battle (§47.1, §12.6).
 *
 * One code for two situations on purpose: a battle that does not exist and a
 * battle still running both have no result to give, and distinguishing them
 * would let anyone enumerate battle ids. §12.6 hides the live score, and a
 * "still running" answer is a small piece of the same information.
 */
export function resultNotFound(battleId: string, correlationId: string): ErrorResponse {
  return error(
    404,
    'RESULT_NOT_FOUND',
    `No finalized result for battle ${battleId}.`,
    true,
    'A result appears when the battle finalizes, at the end of its round.',
    correlationId,
  );
}

/**
 * A card decision arrived for a round this wallet has not picked in (§47.6).
 *
 * §40.7 puts the card after the side, so there is nothing to arm. Naming that
 * is more useful than recording a decision no round will ever read — and the
 * remedy is one step the player can take.
 */
export function noPickToDecide(correlationId: string): ErrorResponse {
  return error(
    409,
    'NO_PICK_TO_DECIDE',
    'There is no pick in this round for a card to support.',
    true,
    'Back a stock first; the card decision comes after.',
    correlationId,
  );
}

/**
 * A card was asked for that this wallet cannot deploy (§6, §40.7, §40.9).
 *
 * No card on record, or one with no charge left. The pick itself is untouched —
 * saying so is the point, because a player told only "refused" will assume
 * their whole pick went with it.
 */
export function noCardToUse(correlationId: string): ErrorResponse {
  return error(
    409,
    'NO_CARD_TO_USE',
    'This wallet holds no Genesis Card with a charge left to use.',
    true,
    'Keep the card saved. Your pick stands without it, and nothing was spent.',
    correlationId,
  );
}

/**
 * The request needs a wallet and none was proven (§48.2).
 *
 * Spectating needs no wallet at all (§5), so this only ever applies to writes.
 */
export function unauthenticated(correlationId: string): ErrorResponse {
  return error(
    401,
    'UNAUTHENTICATED',
    'This action needs a connected wallet.',
    true,
    'Connect a wallet and try again. Watching needs no wallet.',
    correlationId,
  );
}

/**
 * The signature did not answer the challenge (§45.2, §69.5).
 *
 * One error for every way a sign-in can fail, and deliberately so. A challenge
 * that expired, one already used, one that never existed and a signature from
 * the wrong wallet are four different facts, and telling them apart is useful
 * to exactly one kind of caller: somebody working through nonces that are not
 * theirs. The player's next step is the same in all four cases.
 */
export function signInRefused(correlationId: string): ErrorResponse {
  return error(
    401,
    'SIGN_IN_REFUSED',
    'That signature did not match a live sign-in request.',
    true,
    'Ask for a new sign-in request and sign it again. Nothing was charged and no funds moved.',
    correlationId,
  );
}

/**
 * The wallet is on a chain this deployment does not accept (§45.2).
 *
 * Answered before a signature is asked for, because the alternative is a
 * player approving a wallet prompt and then being told it was pointless.
 */
export function wrongChain(expected: number, correlationId: string): ErrorResponse {
  return error(
    400,
    'WRONG_CHAIN',
    `This deployment accepts signatures from chain ${String(expected)} only.`,
    true,
    `Switch your wallet to chain ${String(expected)} and connect again.`,
    correlationId,
  );
}
