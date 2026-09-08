import { PUBLIC_EVENT_PAYLOADS } from '@ponswars/schemas';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../state/session.js';
import { liveEndpoints, type LiveEndpoints } from './endpoints.js';
import { fetchCurrentRound, type RoundFetchFailure } from './round-client.js';
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

  const setRound = useSession((state) => state.setRound);
  const setBattles = useSession((state) => state.setBattles);
  const setConnection = useSession((state) => state.setConnection);
  const setClockOffset = useSession((state) => state.setClockOffset);

  // The socket outlives any single render and must not be re-created by one.
  const socketRef = useRef<LiveSocket | null>(null);

  useEffect(() => {
    if (endpoints === null) {
      return;
    }

    const controller = new AbortController();
    let disposed = false;

    const resync = async (): Promise<void> => {
      const result = await fetchCurrentRound(endpoints, controller.signal);
      if (disposed) {
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

    return () => {
      disposed = true;
      controller.abort();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [endpoints, setRound, setBattles, setConnection, setClockOffset]);

  return endpoints === null ? { live: false } : { live: true, lastFailure };
}

/**
 * Applies one event to the store.
 *
 * Only `BATTLE_STATE_UPDATE` is applied incrementally. A round that locked or
 * finalized has changed more than any one payload describes — the phase, the
 * picks, five results — so those re-fetch the authoritative snapshot rather
 * than patching a state machine from the outside (§22, §70.7).
 */
function applyEvent(event: string, payload: unknown, resync: () => void): void {
  if (event !== 'BATTLE_STATE_UPDATE') {
    if (event === 'PICKS_LOCKED' || event === 'ROUND_FINALIZED') {
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
