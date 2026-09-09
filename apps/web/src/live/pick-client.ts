import { apiErrorSchema, myPickSchema, pickResponseSchema } from '@ponswars/schemas';
import type { ActiveTicker, CardDecision } from '@ponswars/shared-types';
import type { LiveEndpoints } from './endpoints.js';

/**
 * Submitting, withdrawing and deciding (§47.5, §47.6).
 *
 * Three requests and no state. What a player has committed to is the server's
 * answer, never this client's memory of what it sent — §22 makes the lock
 * authoritative, and a client that showed its own optimistic guess as settled
 * is how a player believes they are in a war they never entered.
 *
 * Every failure comes back named. §110.5 requires an error to say what happened
 * and what can be done about it, and the API already answers that way; throwing
 * the distinction away at the edge would leave the UI with one shrug for a
 * missed lock, a wrong ticker and a dropped connection.
 */

/** Why a write did not take effect. */
export type PickFailure =
  /** The request never completed. */
  | { readonly kind: 'UNREACHABLE'; readonly detail: string }
  /**
   * The server refused, and said why.
   *
   * `code` is the machine name (`PICKS_CLOSED`, `TICKER_NOT_IN_BATTLE`);
   * `message` and `nextStep` are the sentences §110.5 wants shown.
   */
  | {
      readonly kind: 'REFUSED';
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly nextStep: string;
    }
  /** The server answered with something this client cannot read. */
  | { readonly kind: 'MALFORMED'; readonly detail: string };

export type PickResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: PickFailure };

export interface SubmitPickInput {
  readonly roundId: string;
  readonly battleId: string;
  readonly backedTicker: ActiveTicker;
  readonly cardDecision: CardDecision;
  /**
   * §66.6 idempotency key. A retry carries the same one.
   *
   * Supplied by the caller rather than generated here, because that is the
   * whole point: a client that made a fresh key on every attempt would turn a
   * retry into a second pick, which is the exact failure the key prevents.
   */
  readonly clientRequestId: string;
}

/** Backs a stock (§47.5). */
export async function submitPick(
  endpoints: LiveEndpoints,
  authorization: string,
  input: SubmitPickInput,
  fetchImpl: typeof fetch = fetch,
): Promise<PickResult<{ readonly recorded: boolean; readonly replayed: boolean }>> {
  return request(
    endpoints,
    authorization,
    'PUT',
    `/v1/rounds/${input.roundId}/pick`,
    {
      roundId: input.roundId,
      battleId: input.battleId,
      backedTicker: input.backedTicker,
      cardDecision: input.cardDecision,
      clientRequestId: input.clientRequestId,
    },
    (body) => {
      const parsed = pickResponseSchema.safeParse(body);
      return parsed.success
        ? {
            ok: true as const,
            value: { recorded: parsed.data.recorded, replayed: parsed.data.replayed },
          }
        : { ok: false as const, detail: parsed.error.issues[0]?.message ?? 'unknown' };
    },
    fetchImpl,
  );
}

/** Withdraws a pick (§47.5 `DELETE`). */
export async function withdrawPick(
  endpoints: LiveEndpoints,
  authorization: string,
  roundId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PickResult<{ readonly withdrawn: boolean }>> {
  return request(
    endpoints,
    authorization,
    'DELETE',
    `/v1/rounds/${roundId}/pick`,
    null,
    (body) => {
      const withdrawn = (body as { withdrawn?: unknown }).withdrawn;
      return typeof withdrawn === 'boolean'
        ? { ok: true as const, value: { withdrawn } }
        : { ok: false as const, detail: 'withdrawn must be a boolean' };
    },
    fetchImpl,
  );
}

/** Arms or saves the Genesis Card (§47.6, §40.7). */
export async function decideCard(
  endpoints: LiveEndpoints,
  authorization: string,
  roundId: string,
  decision: CardDecision,
  clientRequestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PickResult<{ readonly cardDecision: CardDecision }>> {
  return request(
    endpoints,
    authorization,
    'PUT',
    `/v1/rounds/${roundId}/card-decision`,
    { roundId, decision, clientRequestId },
    (body) => {
      const cardDecision = (body as { cardDecision?: unknown }).cardDecision;
      return cardDecision === 'USE' || cardDecision === 'SAVE'
        ? { ok: true as const, value: { cardDecision } }
        : { ok: false as const, detail: 'cardDecision must be USE or SAVE' };
    },
    fetchImpl,
  );
}

/**
 * One write, with its failures named.
 *
 * The refusal branch parses the error body rather than trusting a status code.
 * §110.5's `message` and `nextStep` are written per condition, and a UI that
 * derived its own sentence from `409` would lose the difference between a
 * missed lock and a card decision with no pick behind it.
 */
async function request<T>(
  endpoints: LiveEndpoints,
  authorization: string,
  method: 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  read: (body: unknown) => { ok: true; value: T } | { ok: false; detail: string },
  fetchImpl: typeof fetch,
): Promise<PickResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoints.api}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        authorization,
        ...(body === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'UNREACHABLE', detail: String(error) } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'MALFORMED', detail: String(error) } };
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    return {
      ok: false,
      failure: parsed.success
        ? {
            kind: 'REFUSED',
            status: response.status,
            code: parsed.data.code,
            message: parsed.data.message,
            nextStep: parsed.data.nextStep,
          }
        : { kind: 'MALFORMED', detail: parsed.error.issues[0]?.message ?? 'unknown' },
    };
  }

  const result = read(payload);
  return result.ok
    ? { ok: true, value: result.value }
    : { ok: false, failure: { kind: 'MALFORMED', detail: result.detail } };
}

/**
 * What this wallet currently backs in a round (§47.5).
 *
 * A separate request from the round itself, because the round is public and
 * this is not: §5 lets anyone watch, and only a session can ask what it
 * committed to. Answering `null` is a fact — the wallet has not picked — rather
 * than a client that has not asked yet.
 */
export async function fetchMyPick(
  endpoints: LiveEndpoints,
  authorization: string,
  roundId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<
  PickResult<{
    readonly battleId: string;
    readonly backedTicker: ActiveTicker;
    readonly cardDecision: CardDecision;
  } | null>
> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoints.api}/v1/rounds/${roundId}/pick`, {
      headers: { accept: 'application/json', authorization },
    });
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'UNREACHABLE', detail: String(error) } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'MALFORMED', detail: String(error) } };
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    return {
      ok: false,
      failure: parsed.success
        ? {
            kind: 'REFUSED',
            status: response.status,
            code: parsed.data.code,
            message: parsed.data.message,
            nextStep: parsed.data.nextStep,
          }
        : { kind: 'MALFORMED', detail: 'unreadable error body' },
    };
  }

  const parsed = myPickSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      failure: { kind: 'MALFORMED', detail: parsed.error.issues[0]?.message ?? 'unknown' },
    };
  }
  return { ok: true, value: parsed.data.pick };
}
