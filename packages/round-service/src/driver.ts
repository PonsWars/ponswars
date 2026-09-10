import {
  createRound,
  nextRoundOpensAt,
  pollDelay,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import {
  clockForRound,
  roundIdFor,
  roundIndexOf,
  type ConfidenceCalibration,
} from '@ponswars/battle-math';
import {
  ACTIVE_TICKERS,
  milliseconds,
  roundId as toRoundId,
  type CanonicalClock,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import { announceRoundOpened } from './announce.js';
import { stepRound } from './loop.js';
import type { MarketDataPort, RoundPorts } from './ports.js';

/**
 * The round driver: rounds opening, running and finalizing, forever (§3, §22).
 *
 * `stepRound` beside this decides what one round is due for at one instant.
 * This is the thing that keeps asking — it opens a round, steps it until it
 * finalizes, opens the next where the last ended, and does not stop.
 *
 * It lives here rather than in a service because there is more than one service
 * that needs it and there must not be more than one copy of it. The local stack
 * runs it against a synthetic market and an in-memory store; the deployable
 * server runs it against whatever the environment names. A second copy of a
 * loop that decides when a round finalizes is a second answer to when a round
 * finalizes.
 *
 * Nothing here reads a clock, opens a socket or writes to a log. Time arrives
 * as `now`, the world arrives as ports, and anything worth saying is handed to
 * `onEvent` — which is what lets the whole loop be driven a step at a time in a
 * test.
 */

/** Something that happened, for whoever is watching the loop. */
export type DriverEvent =
  | { readonly kind: 'RESUMED'; readonly round: RoundEngineState }
  | { readonly kind: 'OPENED'; readonly round: RoundEngineState }
  | {
      readonly kind: 'STATE';
      readonly round: RoundEngineState;
      readonly from: RoundEngineState['state'];
    }
  | {
      readonly kind: 'FINALIZED';
      readonly round: RoundEngineState;
      readonly finalization: NonNullable<Awaited<ReturnType<typeof stepRound>>['finalization']>;
    };

export interface DriverOptions {
  readonly ports: RoundPorts;
  readonly config: EngineConfig;
  readonly calibration: ConfidenceCalibration;
  readonly now: () => UtcTimestamp;
  /**
   * Scoring tick interval (§12.5, §23.1).
   *
   * An input rather than a constant. §23.1 names approximately one
   * authoritative tick per second, and *approximately* is a calibration that
   * belongs to a deployment.
   */
  readonly tickMs: number;
  /**
   * The seed every round's evidence chain is derived from (§26).
   *
   * Per-deployment, and never generated here: a driver that invented one would
   * make two deployments of the same code produce different evidence for the
   * same inputs.
   */
  readonly baseSeedHex: string;
  /** Where the current round can be read from, for anything serving it. */
  readonly onRound: (round: RoundEngineState) => void;
  readonly onEvent?: (event: DriverEvent) => void;
  /**
   * Stops the loop between steps.
   *
   * Between rather than during: a round part-way through finalizing has writes to finish
   * (§25), and abandoning it there is what checkpoints exist to avoid.
   */
  readonly signal?: AbortSignal;
}

/**
 * Opens a round, snapshotting confidence from the window behind it.
 *
 * Async because §10.1 makes confidence an observation rather than a setting.
 * Read once, here, so the snapshot belongs to the round — a later read would be
 * a different window, and §10.3 freezes it at open.
 */
async function openRound(
  index: number,
  clock: CanonicalClock,
  market: MarketDataPort,
  at: UtcTimestamp,
  options: DriverOptions,
): Promise<RoundEngineState> {
  const lookback = Object.fromEntries(
    await Promise.all(
      ACTIVE_TICKERS.map(async (ticker) => [ticker, await market.lookback(ticker, at)] as const),
    ),
  );

  const round = createRound({
    roundId: toRoundId(roundIdFor(index)),
    roundIndex: index,
    clock,
    baseSeedHex: options.baseSeedHex,
    recentRounds: [],
    confidence: { lookback, calibration: options.calibration },
  });

  // §22 makes opening the phase an explicit transition rather than something
  // the clock implies, which is why the driver refuses to infer it.
  return { ...round, state: 'PICK_OPEN' };
}

/**
 * Runs rounds until the signal aborts.
 *
 * Resolves when it stops, so a caller can shut the rest of a process down after
 * it rather than while it is still writing.
 */
export async function runRounds(options: DriverOptions): Promise<void> {
  const { ports, config, now, onEvent, signal } = options;
  const say = onEvent ?? ((): undefined => undefined);

  // §25: ask the store what it was doing before opening anything new.
  //
  // The composition root asks even against a store that cannot answer, so that
  // swapping in a durable one makes a restart resume a live round rather than
  // abandoning one and starting another on top of it. Wiring this only when a
  // durable store arrives would mean discovering then that nothing called it.
  const stored = await ports.store.loadLatest();
  // A finalized round is history, not something to resume into: the next thing
  // to do after one is to open the round after it.
  const resumed = stored !== null && stored.state !== 'FINALIZED' ? stored : null;
  if (resumed !== null) {
    say({ kind: 'RESUMED', round: resumed });
  }

  // Rounds are contiguous (§3.1): each opens where the last ended, so the
  // schedule never drifts even if a finalization runs late. An identifier this
  // codebase did not produce resumes at zero *and says so*, because the
  // alternative is opening round zero on top of a live sequence unnoticed.
  let index = resumed === null ? 0 : (roundIndexOf(resumed.roundId) ?? 0);
  let clock = resumed?.clock ?? clockForRound(now(), 0, now());
  let round = resumed ?? (await openRound(index, clock, ports.marketData, now(), options));

  // Announced only when it is new. A resumed round was announced when it
  // opened, and §48.3's `ROUND_OPENED` means a round has opened rather than
  // that a server has restarted.
  if (resumed === null) {
    await announceRoundOpened(round, ports.publisher);
    say({ kind: 'OPENED', round });
  }
  options.onRound(round);

  let previousState = round.state;

  while (signal?.aborted !== true) {
    const result = await stepRound(round, now(), ports, config);
    round = result.state;
    options.onRound(round);

    if (round.state !== previousState) {
      say({ kind: 'STATE', round, from: previousState });
      previousState = round.state;
    }

    if (result.finalization !== undefined) {
      say({ kind: 'FINALIZED', round, finalization: result.finalization });

      // §3.1: the next round opens where this one ended.
      index += 1;
      clock = clockForRound(nextRoundOpensAt(clock), 0, now());
      round = await openRound(index, clock, ports.marketData, now(), options);
      options.onRound(round);
      await announceRoundOpened(round, ports.publisher);
      previousState = round.state;
      say({ kind: 'OPENED', round });
      continue;
    }

    // A live battle sleeps the tick cadence; anything else sleeps until the
    // boundary the driver named, capped so the loop never overshoots one it was
    // told about.
    const delay =
      result.action.kind === 'TICK'
        ? options.tickMs
        : Math.max(pollDelay(result.action, now(), milliseconds(1_000)), 100);
    await sleep(delay, signal);
  }
}

/** A sleep that gives up when the signal does. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
