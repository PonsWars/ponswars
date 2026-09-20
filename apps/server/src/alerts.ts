import type { CanonicalClock, RoundState, UtcTimestamp } from '@ponswars/shared-types';

/**
 * What is worth waking someone for, and how to say it (§59.3).
 *
 * A round opens every ten minutes, around the clock, and the person running
 * PonsWars cannot watch that. The system is built to fail safe on its own — a
 * battle whose data fails the integrity rules is voided and card uses are
 * restored (§4.4, §110.6), claims can be paused without erasing anyone's
 * entitlement — so what it needs is to *tell* somebody, and to tell them only
 * what they would want to be told.
 *
 * Few alerts, each of which means something:
 *
 * - **A round that will not finalize.** Critical, and it says when it clears.
 * - **Battles voided.** A notice per round, naming them: a void is safe, but a
 *   run of them is the feed failing, and that is the owner's to know.
 * - **The Secret vault out of cover.** Secrets stop being dealt until it is
 *   refunded (§8.3) — not an outage, and not something to discover a week later.
 * - **The server starting and stopping.** A restart that nobody asked for, and
 *   a crash loop, are both visible as a run of these.
 *
 * Market data degrading and then recovering is deliberately *not* here. It
 * heals itself, and when it does not, the harm it does is a void — which is.
 * One person paged for every wobble in a feed stops reading pages.
 *
 * Pure: conditions in, messages out. What sends them is `alert-sink.ts`.
 */

export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

/** Something wrong for as long as it lasts, identified by its key. */
export interface Condition {
  readonly key: string;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly detail: string;
  /** Where to start, relative to the repository. */
  readonly runbook: string | null;
}

/**
 * One thing to send.
 *
 * `FIRING` and `RESOLVED` bracket a condition; `NOTICE` is something that
 * happened once and has nothing to clear.
 */
export interface AlertMessage extends Condition {
  readonly status: 'FIRING' | 'RESOLVED' | 'NOTICE';
}

/**
 * The conditions now, against the ones already reported.
 *
 * A condition is sent once when it starts and once when it stops — never again
 * in between, however often it is evaluated. No reminder while it lasts: how
 * often to nag is an alert threshold, which the registry leaves `OPEN`, and a
 * page that repeats every few minutes is one a person learns to swipe away.
 */
export function reconcile(
  active: ReadonlyMap<string, Condition>,
  current: readonly Condition[],
): { readonly active: ReadonlyMap<string, Condition>; readonly messages: readonly AlertMessage[] } {
  const next = new Map<string, Condition>();
  const messages: AlertMessage[] = [];

  for (const condition of current) {
    if (next.has(condition.key)) {
      continue;
    }
    next.set(condition.key, condition);
    if (!active.has(condition.key)) {
      messages.push({ ...condition, status: 'FIRING' });
    }
  }
  for (const [key, condition] of active) {
    if (!next.has(key)) {
      messages.push({ ...condition, status: 'RESOLVED' });
    }
  }
  return { active: next, messages };
}

/** The states a round is finished in. Nothing past them can be stuck. */
const SETTLED: ReadonlySet<RoundState> = new Set<RoundState>(['FINALIZED', 'VOID']);

/**
 * A round past its battle end by more than the deployment allows, and not yet
 * final (§25; `docs/operations/round-stuck.md`).
 *
 * Keyed by round, so the next round being fine does not clear it and a second
 * stuck round is a second alert.
 */
export function stuckRound(
  round: {
    readonly roundId: string;
    readonly state: RoundState;
    readonly clock: Pick<CanonicalClock, 'battleEndAt'>;
  } | null,
  now: UtcTimestamp,
  afterMs: number,
): Condition | null {
  if (round === null || SETTLED.has(round.state)) {
    return null;
  }
  const late = now - round.clock.battleEndAt;
  if (late <= afterMs) {
    return null;
  }
  return {
    key: `round-stuck:${round.roundId}`,
    severity: 'CRITICAL',
    title: `Round ${round.roundId} is not finalizing`,
    detail:
      `It is still ${round.state}, ${minutes(late)} past its battle end. ` +
      'The result is already fixed by the data inside the window (§12.6); what is late is recording it.',
    runbook: 'docs/operations/round-stuck.md',
  };
}

/**
 * The Secret vault unable to cover one more Secret (§8.3).
 *
 * `null` for a vault this deployment does not reserve against — Secrets off by
 * decision are not an alert.
 */
export function uncoveredVault(covered: boolean | null): Condition | null {
  if (covered !== false) {
    return null;
  }
  return {
    key: 'secret-vault-uncovered',
    severity: 'WARNING',
    title: 'Secret vault is out of cover',
    detail:
      'It cannot cover another Secret, so the Secret band is dealing Legendary until it is refunded (§8.3). Nobody already reserved is affected.',
    runbook: 'docs/operations/secret-vault.md',
  };
}

/** Battles a finalized round voided, or `null` when it voided none. */
export function voidedBattles(roundId: string, voided: readonly string[]): AlertMessage | null {
  if (voided.length === 0) {
    return null;
  }
  return {
    status: 'NOTICE',
    key: `voided:${roundId}`,
    severity: 'WARNING',
    title: `${String(voided.length)} battle${voided.length === 1 ? '' : 's'} voided in ${roundId}`,
    detail:
      `${voided.join(', ')}. Card uses were restored (§110.6). ` +
      'One is the rules working; several in a row is the feed failing.',
    runbook: 'docs/operations/feed-degradation.md',
  };
}

/** The server coming up, or going down on an error. */
export function lifecycle(kind: 'STARTED' | 'FAILED', detail: string): AlertMessage {
  return kind === 'STARTED'
    ? {
        status: 'NOTICE',
        key: 'server-started',
        severity: 'INFO',
        title: 'PonsWars server started',
        detail,
        runbook: null,
      }
    : {
        status: 'NOTICE',
        key: 'server-failed',
        severity: 'CRITICAL',
        title: 'PonsWars server stopped on an error',
        detail,
        runbook: 'docs/operations/README.md',
      };
}

function minutes(ms: number): string {
  const whole = Math.floor(ms / 60_000);
  return whole < 1 ? 'under a minute' : `${String(whole)} minute${whole === 1 ? '' : 's'}`;
}
