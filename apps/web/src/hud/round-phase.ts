import type { CanonicalClock, RoundState, UtcTimestamp } from '@ponswars/shared-types';

/**
 * What the HUD says about the round, derived from the round state machine (§22).
 *
 * A pure function over the authoritative state and the canonical clock, so the
 * copy for every phase is decided in one place and can be tested. Scattering
 * `state === 'PICK_OPEN' ? … : …` through components is how a UI ends up
 * offering pick controls during finalization.
 *
 * There is no branch here that invents a phase. §22 gives seven states and this
 * answers for all seven, `VOID` included — the README rule that missing or
 * failed data *"degrades explicitly or voids the battle, never becomes a fresh,
 * empty, safe or complete state"* has to hold in the HUD as much as in the
 * engine.
 */
export interface RoundView {
  /** The phase, in the player's words. */
  readonly label: string;
  /** What the countdown counts towards, or `null` when nothing is pending. */
  readonly countdownCaption: string | null;
  readonly countdownTarget: UtcTimestamp | null;
  /** Whether a pick may be made right now (§3.2 — picks close at lock). */
  readonly picksAllowed: boolean;
  /** Whether this round was voided (§22, §4.4). */
  readonly voided: boolean;
}

export function roundView(state: RoundState, clock: CanonicalClock): RoundView {
  switch (state) {
    case 'PREPARING':
      return {
        label: 'PREPARING ROUND',
        countdownCaption: 'PICKS OPEN IN',
        countdownTarget: clock.pickOpenAt,
        picksAllowed: false,
        voided: false,
      };
    case 'PICK_OPEN':
      return {
        label: 'PICK PHASE',
        countdownCaption: 'LOCKS IN',
        countdownTarget: clock.lockAt,
        picksAllowed: true,
        voided: false,
      };
    case 'LOCKING':
      // A brief mechanical step, not a phase a player waits through. No
      // countdown, because a timer implies something they could still do.
      return {
        label: 'LOCKING PICKS',
        countdownCaption: null,
        countdownTarget: null,
        picksAllowed: false,
        voided: false,
      };
    case 'BATTLE_LIVE':
      return {
        label: 'BATTLE LIVE',
        countdownCaption: 'BATTLE ENDS',
        countdownTarget: clock.battleEndAt,
        picksAllowed: false,
        voided: false,
      };
    case 'FINALIZING':
      // §25 finalization is exactly-once and takes as long as it takes. A
      // countdown here would be a guess presented as a deadline.
      return {
        label: 'FINALIZING',
        countdownCaption: null,
        countdownTarget: null,
        picksAllowed: false,
        voided: false,
      };
    case 'FINALIZED':
      return {
        label: 'ROUND COMPLETE',
        countdownCaption: null,
        countdownTarget: null,
        picksAllowed: false,
        voided: false,
      };
    case 'VOID':
      // Named, not softened. §4.4 does not revive a voided round and §12 awards
      // nothing for one, so a HUD that phrased this as a pause would be
      // promising a result that is never coming.
      return {
        label: 'ROUND VOID',
        countdownCaption: null,
        countdownTarget: null,
        picksAllowed: false,
        voided: true,
      };
  }
}

/**
 * Formats a remaining duration as `mm:ss`.
 *
 * Clamped at zero. A countdown that runs negative is showing a deadline that
 * has already passed as though it were still ahead, and past a lock the
 * honest reading is `00:00` until the next state arrives.
 *
 * Minutes are not clamped: a round is ten minutes (§3.1) but a client that
 * reconnects to a longer window should show what it was told rather than a
 * capped number that quietly disagrees with the server.
 */
export function formatCountdown(remainingMs: number): string {
  const clamped = remainingMs > 0 ? remainingMs : 0;
  const totalSeconds = Math.floor(clamped / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * How the client is currently connected (§49, §42.14).
 *
 * `RECONNECTING` is its own state rather than being hidden behind the last known
 * values. §23.6 and §42.14 both want the interface to say when it is out of
 * date, and a frozen HUD that still looks live is worse than one that admits it.
 */
export const CONNECTION_STATES = ['CONNECTED', 'RECONNECTING', 'OFFLINE'] as const;

export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * The banner to show for a connection state, or `null` when all is well.
 *
 * `RECONNECTING` says the world is paused rather than broken, because §49
 * resubscribes and replays a snapshot; `OFFLINE` says the display is stale,
 * which is the one thing a player must not be left guessing about while a
 * battle they backed is running.
 */
export function connectionBanner(state: ConnectionState): string | null {
  switch (state) {
    case 'CONNECTED':
      return null;
    case 'RECONNECTING':
      return 'RECONNECTING — WORLD PAUSED';
    case 'OFFLINE':
      return 'OFFLINE — DISPLAY MAY BE OUT OF DATE';
  }
}
