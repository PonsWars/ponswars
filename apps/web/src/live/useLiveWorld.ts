import { PUBLIC_EVENT_PAYLOADS, type RoundFinalizedPayload } from '@ponswars/schemas';
import {
  battleId as toBattleId,
  roundId as toRoundId,
  utcTimestamp,
  type FinalizedBattleResult,
} from '@ponswars/shared-types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession, type PickAttempt } from '../state/session.js';
import { liveEndpoints, type LiveEndpoints } from './endpoints.js';
import {
  decideCard,
  fetchMyPick,
  submitPick,
  withdrawPick,
  type PickFailure,
  type PickResult,
} from './pick-client.js';
import { fetchCurrentRound, type RoundFetchFailure } from './round-client.js';
import { sessionAuthorization } from './session-token.js';
import { openLiveSocket, type LiveSocket } from './socket-client.js';

/**
 * Connects the world to the server, or says plainly that it is not connected.
 *
 * One hook, because the two halves are one thing: the socket says when to
 * re-fetch (§70.7 step 2) and the fetch says which battles to follow. Splitting
 * them would mean a component holding half a connection.
 *
 * `live: false` is a first-class answer, not an error. A build with no
 * endpoints configured is a preview of the world, and the caller is expected to
 * label it — placeholder battles presented as a running round would be the
 * worst thing this client could do.
 */

export type LiveStatus =
  /** No endpoints configured. Whatever is on screen is a preview. */
  | { readonly live: false }
  /** Configured, and this is how it is going. */
  | { readonly live: true; readonly lastFailure: RoundFetchFailure | null };

export function useLiveWorld(): LiveStatus {
  const endpoints = useMemo<LiveEndpoints | null>(() => liveEndpoints(import.meta.env), []);
  const [lastFailure, setLastFailure] = useState<RoundFetchFailure | null>(null);

  const authorization = useMemo(() => sessionAuthorization(import.meta.env), []);

  const setRound = useSession((state) => state.setRound);
  const setBattles = useSession((state) => state.setBattles);
  const setConnection = useSession((state) => state.setConnection);
  const setClockOffset = useSession((state) => state.setClockOffset);
  const setPickGateway = useSession((state) => state.setPickGateway);
  const setPickError = useSession((state) => state.setPickError);
  const applyMyBacking = useSession((state) => state.applyMyBacking);

  // The socket outlives any single render and must not be re-created by one.
  const socketRef = useRef<LiveSocket | null>(null);

  useEffect(() => {
    if (endpoints === null) {
      return;
    }

    const controller = new AbortController();
    const lifecycle = { disposed: false };
    /**
     * Read through a call so the check is not narrowed away.
     *
     * TypeScript narrows this to `false` after the first guard and keeps that
     * narrowing across an `await`, so a second check compiles as provably dead
     * code — while at runtime it is the one that matters, because teardown
     * happens during exactly those awaits. A call is re-evaluated every time,
     * which is what the code means.
     */
    const disposed = (): boolean => lifecycle.disposed;

    const resync = async (): Promise<void> => {
      const result = await fetchCurrentRound(endpoints, controller.signal);
      if (disposed()) {
        return;
      }
      if (!result.ok) {
        // Kept and surfaced rather than swallowed. §42.14 asks for a useful
        // sync state, and a client that silently retries forever leaves a
        // player watching a world that stopped without saying so.
        setLastFailure(result.failure);
        return;
      }

      setLastFailure(null);
      const { snapshot } = result;
      setRound(snapshot.round);
      setBattles(snapshot.battles);
      // §23.5: every countdown is projected through this, so a device clock
      // that is minutes out still shows the same lock time as everyone else.
      setClockOffset(snapshot.serverTime - Date.now());
      socketRef.current?.follow(
        snapshot.round.roundId,
        snapshot.battles.map((battle) => battle.battleId),
      );

      // What this wallet backs is a separate, private request (§47.5), and it
      // is asked after the round because it is about the round that just
      // arrived. A spectator never asks.
      if (authorization === null) {
        return;
      }
      const mine = await fetchMyPick(endpoints, authorization, snapshot.round.roundId);
      if (disposed()) {
        return;
      }
      if (mine.ok) {
        applyMyBacking(
          mine.value?.battleId ?? null,
          mine.value === null
            ? null
            : {
                // The side the server recorded, never inferred from the
                // battle. Reading `left` here would show the wrong faction to
                // half the players and look right to the other half.
                ticker: mine.value.backedTicker,
                cardDeployed: mine.value.cardDecision === 'USE',
              },
        );
      }
    };

    socketRef.current = openLiveSocket({
      endpoints,
      handlers: {
        onConnectionChange: setConnection,
        onResync: () => {
          void resync();
        },
        onEvent: (event, _channel, payload) => {
          applyEvent(event, payload, () => {
            void resync();
          });
        },
      },
    });

    // The write side, given to the store so the controls read one place.
    // `null` for a spectator, which is what makes §5's normal case ordinary
    // rather than a disabled version of the real thing.
    if (authorization !== null) {
      const roundId = (): string | null => useSession.getState().round?.roundId ?? null;
      const report = <T>(result: PickResult<T>): PickAttempt =>
        result.ok ? { ok: true } : { ok: false, ...describe(result.failure) };

      setPickGateway({
        back: async (battleId, ticker) => {
          const id = roundId();
          if (id === null) {
            return {
              ok: false,
              message: 'No round is loaded yet.',
              nextStep: 'Wait a moment and try again.',
            };
          }
          const attempt = report(
            await submitPick(endpoints, authorization, {
              roundId: id,
              battleId,
              backedTicker: ticker,
              // §40.7 puts the card after the side. A first submission saves it,
              // and arming is the separate decision that follows — so backing a
              // stock can never spend a use the player has not offered.
              cardDecision: 'SAVE',
              clientRequestId: requestId(),
            }),
          );
          await resync();
          return attempt;
        },
        withdraw: async () => {
          const id = roundId();
          if (id === null) {
            return { ok: true };
          }
          const attempt = report(await withdrawPick(endpoints, authorization, id));
          await resync();
          return attempt;
        },
        decide: async (decision) => {
          const id = roundId();
          if (id === null) {
            return {
              ok: false,
              message: 'No round is loaded yet.',
              nextStep: 'Wait a moment and try again.',
            };
          }
          const attempt = report(
            await decideCard(endpoints, authorization, id, decision, requestId()),
          );
          await resync();
          return attempt;
        },
      });
    }

    return () => {
      lifecycle.disposed = true;
      controller.abort();
      socketRef.current?.close();
      socketRef.current = null;
      setPickGateway(null);
      setPickError(null);
    };
  }, [
    endpoints,
    authorization,
    setRound,
    setBattles,
    setConnection,
    setClockOffset,
    setPickGateway,
    setPickError,
    applyMyBacking,
  ]);

  return endpoints === null ? { live: false } : { live: true, lastFailure };
}

/**
 * Applies one event to the store.
 *
 * Only `BATTLE_STATE_UPDATE` is applied incrementally. Everything else marks a
 * change too large for one payload to describe.
 */
function applyEvent(event: string, payload: unknown, resync: () => void): void {
  if (event !== 'BATTLE_STATE_UPDATE') {
    // A round opening, locking or finalizing changes more than any one payload
    // describes — the phase, the matchups, the picks, five results. Each of
    // those fetches the authoritative snapshot instead of patching a state
    // machine from the outside (§22, §70.7).
    if (event === 'ROUND_FINALIZED') {
      // Kept before the resync, because the resync replaces the round with the
      // next one. §12.6 reveals the breakdown at finalization and §27.8 shows
      // it afterwards — a client that only re-fetched would have nothing left
      // to show the player who just watched the battle end.
      const parsed = PUBLIC_EVENT_PAYLOADS.ROUND_FINALIZED.safeParse(payload);
      if (parsed.success) {
        useSession.getState().setLastResults(parsed.data.results.map(toFinalizedResult));
      }
    }
    if (event === 'ROUND_OPENED' || event === 'PICKS_LOCKED' || event === 'ROUND_FINALIZED') {
      resync();
    }
    return;
  }

  const parsed = PUBLIC_EVENT_PAYLOADS.BATTLE_STATE_UPDATE.safeParse(payload);
  if (!parsed.success) {
    // Dropped, not guessed at. A malformed update is one tick of movement; a
    // half-applied one is a frontline in a position the server never published.
    return;
  }
  const update = parsed.data;

  useSession.setState((state) => ({
    battles: state.battles.map((battle) =>
      battle.battleId === update.battleId
        ? { ...battle, momentum: update.momentum, frontline: update.frontline }
        : battle,
    ),
    // The feed health a player is shown comes from the battles they are
    // watching (§23.6). Taken from the update rather than assumed at fetch
    // time, which is the one place the snapshot cannot know it.
    round: state.round === null ? null : { ...state.round, feedHealth: update.feedHealth },
  }));
}

/**
 * A fresh idempotency key (§66.6).
 *
 * One per decision, not one per attempt: a retry of the same decision must
 * carry the same key, and that reuse belongs to whoever retries. Nothing here
 * retries, so every call is a new decision.
 */
function requestId(): string {
  return `pw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Turns a failure into the two sentences §110.5 asks to be shown. */
function describe(failure: PickFailure): { message: string; nextStep: string } {
  switch (failure.kind) {
    case 'REFUSED':
      // The server already wrote both sentences per condition. Deriving our own
      // from the status code would lose the difference between a missed lock
      // and a ticker that is not in the battle.
      return { message: failure.message, nextStep: failure.nextStep };
    case 'UNREACHABLE':
      return {
        message: 'The server could not be reached.',
        nextStep: 'Check the connection and try again before the round locks.',
      };
    case 'MALFORMED':
      return {
        message: 'The server answered with something this client cannot read.',
        nextStep: 'Reload the page; if it keeps happening the client is out of date.',
      };
  }
}

/**
 * Turns a parsed result off the wire into the engine's own type.
 *
 * Through the checked constructors, not a cast. The schema proves the ids are
 * strings of the right shape; `battleId` and `roundId` prove they are ids, and
 * that is the difference between a result and an object that resembles one.
 *
 * `tiebreakStep` is spread conditionally because `exactOptionalPropertyTypes`
 * separates "absent" from "present and undefined" — §12.7 sets it only when the
 * totals actually tied, and a key holding `undefined` would claim a tiebreak
 * happened and then decline to say which.
 */
function toFinalizedResult(
  result: RoundFinalizedPayload['results'][number],
): FinalizedBattleResult {
  const { battleId, roundId, finalizedAt, tiebreakStep, ...rest } = result;
  return {
    ...rest,
    battleId: toBattleId(battleId),
    roundId: toRoundId(roundId),
    finalizedAt: utcTimestamp(finalizedAt),
    // Destructured out above rather than spread over, because spreading leaves
    // the optional key in the type even when the value is absent.
    ...(tiebreakStep === undefined ? {} : { tiebreakStep }),
  };
}
