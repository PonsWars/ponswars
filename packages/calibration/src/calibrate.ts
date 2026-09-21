import {
  applyTick,
  beginBattle,
  finalizeBattle,
  openBattle,
  type BattleEngineState,
} from '@ponswars/battle-engine';
import {
  advantageFromBattleScore,
  directionChanges,
  divScaled,
  matchupConfidence,
  ponsStrength,
  RATIO_SCALE,
  volatilityAdjustedReturn,
  type ConfidenceLookback,
  type SideInputs,
} from '@ponswars/battle-math';
import {
  comparableSpans,
  nextOpenWindow,
  OnchainMarket,
  onchainMarketPolicy,
  TapeSource,
  type TapeClock,
  type TapeEntry,
} from '@ponswars/market-data';
import {
  ACTIVE_TICKERS,
  battleId,
  buildCanonicalClock,
  CONFIDENCE_LABELS,
  CONFIDENCE_LOOKBACK,
  FEED_HEALTH,
  MOMENTUM_STABILITY_SIGNALS,
  MOMENTUM_STATES,
  PONS_ACTIVITY_SIGNALS,
  PRICE_TREND_SIGNALS,
  requiresVoid,
  ROUND_DURATION,
  roundId,
  utcTimestamp,
  VICTORY_LABELS,
  VOLUME_PULSE_SIGNALS,
  type ActiveTicker,
  type FeedHealth,
} from '@ponswars/shared-types';
import type { CalibrationCandidate } from './candidate.js';
import { Sample, tally, type Distribution } from './distribution.js';

/**
 * Plays a recorded market through the real market adapter and the real engine.
 *
 * Every ten-minute slot the tape covers, while the market was open, becomes a
 * round — covers meaning the recorder was running through it and through the
 * history its first readings look back over (`TapeSource.records`), and every pair of tickers a battle in it — forty-five a round rather
 * than the five matchmaking would pick, because the point is how the market
 * behaves under the bounds, not which five happened to be drawn. Each battle is
 * ticked at the service's cadence from what the tape shows had been read by
 * that instant, and finalized the way the service finalizes it.
 *
 * What comes out is measurement, not a decision: how often each ticker would
 * have voided a battle, how its inputs are spread, how wide the margins run.
 * `suggest` turns some of that into starting values; a person still chooses.
 */

export interface CalibrationOptions {
  /**
   * `chain` to measure the market alone, `wall` to measure it as the recorder's
   * endpoint delivered it (see `TapeClock`).
   */
  readonly clock: TapeClock;
  /** The engine's tick interval (§12.5). */
  readonly tickMs: number;
  /** Pons trading never counted as a player's, as the server excludes it. */
  readonly excludedAddresses: readonly string[];
  /** Every how many ticks the inputs are sampled into distributions. */
  readonly sampleEveryTicks: number;
  /** Called after each round, for progress on a long tape. */
  readonly onRound?: (done: number, total: number) => void;
}

export interface TickerReport {
  /** Every tick observed, by the health the adapter gave it. */
  readonly ticks: Readonly<Record<FeedHealth, number>>;
  /**
   * Every tick that was not `HEALTHY`, by the reason the adapter gave: which
   * bound, or the source's lag, or the market being shut. The first thing to
   * read when a ticker voids too often.
   */
  readonly unhealthyReasons: Readonly<Record<string, number>>;
  /** Battles this ticker fought that finalized or voided. */
  readonly battles: { readonly finalized: number; readonly voided: number };
  /** Battles voided at a tick where this ticker's own reading required it. */
  readonly voidsCaused: number;
  /** Inputs during battles, sampled. */
  readonly inputs: {
    /** Volatility-adjusted return over the battle so far, in sigmas. */
    readonly adjustedReturn: Distribution;
    /** Return over the battle so far, in basis points. */
    readonly returnBps: Distribution;
    /** Volatility over the battle horizon, in basis points. */
    readonly volatilityBps: Distribution;
    /** Relative volume, as a multiple of the expected. */
    readonly relativeVolume: Distribution;
    readonly qualifiedPonsActivity: Distribution;
    readonly uniqueActiveWallets: Distribution;
  };
  /** The confidence lookback at each round's open (§10.1). */
  readonly lookback: {
    readonly adjustedReturn: Distribution;
    readonly relativeVolume: Distribution;
    readonly qualifiedPonsActivity: Distribution;
    readonly directionChanges: Distribution;
  };
}

export interface CalibrationReport {
  /** The clock the tape was replayed on. */
  readonly clock: TapeClock;
  readonly rounds: {
    /** Slots played as rounds. */
    readonly played: number;
    /** Slots skipped because no whole round fit in the session (§23.8). */
    readonly marketClosed: number;
    /**
     * Slots skipped because the recorder was not running through them, or
     * through the history they look back over. Replayed, they would be a
     * market in which nothing traded.
     */
    readonly unrecorded: number;
    /**
     * Rounds whose comparable earlier sessions start before the tape does.
     * Their relative volume leans on the expected-volume floor rather than on
     * history, so until the tape is days long it measures the floor.
     */
    readonly withoutVolumeHistory: number;
  };
  readonly tickers: Readonly<Record<ActiveTicker, TickerReport>>;
  readonly battles: {
    readonly finalized: number;
    readonly voided: number;
    /** Winning margin, in points of the 100. */
    readonly margin: Distribution;
    readonly victoryLabels: Readonly<Record<(typeof VICTORY_LABELS)[number], number>>;
    /** Every scored tick, by the momentum state it showed. */
    readonly momentum: Readonly<Record<(typeof MOMENTUM_STATES)[number], number>>;
    /** How far from even the frontline sat, sampled, as a fraction of a full lead. */
    readonly advantage: Distribution;
    /** Differences between the two sides at battle end, per component. */
    readonly gaps: {
      readonly adjustedReturn: Distribution;
      readonly relativeVolume: Distribution;
      readonly ponsStrength: Distribution;
    };
  };
  readonly confidence: {
    readonly labels: Readonly<Record<(typeof CONFIDENCE_LABELS)[number], number>>;
    readonly priceTrend: Readonly<Record<(typeof PRICE_TREND_SIGNALS)[number], number>>;
    readonly volumePulse: Readonly<Record<(typeof VOLUME_PULSE_SIGNALS)[number], number>>;
    readonly ponsActivity: Readonly<Record<(typeof PONS_ACTIVITY_SIGNALS)[number], number>>;
    readonly momentumStability: Readonly<
      Record<(typeof MOMENTUM_STABILITY_SIGNALS)[number], number>
    >;
  };
}

/** Stand-in for the finalized block a dead heat is broken with; only the margin is measured. */
const TIEBREAK_BLOCK = `0x${'ca'.repeat(32)}`;

interface TickerSamples {
  readonly ticks: Record<FeedHealth, number>;
  readonly reasons: Map<string, number>;
  finalized: number;
  voided: number;
  voidsCaused: number;
  readonly adjustedReturn: Sample;
  readonly returnBps: Sample;
  readonly volatilityBps: Sample;
  readonly relativeVolume: Sample;
  readonly qualifiedPonsActivity: Sample;
  readonly uniqueActiveWallets: Sample;
  readonly lookbackReturn: Sample;
  readonly lookbackVolume: Sample;
  readonly lookbackPons: Sample;
  readonly lookbackChanges: Sample;
}

export async function calibrate(
  entries: readonly TapeEntry[],
  candidate: CalibrationCandidate,
  options: CalibrationOptions,
): Promise<CalibrationReport> {
  if (options.tickMs <= 0 || options.sampleEveryTicks <= 0) {
    throw new RangeError('Tick interval and sampling must be positive');
  }
  const units = entries.find((entry) => entry.kind === 'UNITS');
  if (units === undefined) {
    throw new Error('The tape records no units; it was not written by a recorder');
  }
  const policy = onchainMarketPolicy(candidate.market, {
    quoteDecimals: units.quoteDecimals,
    excludedAddresses: options.excludedAddresses,
  });
  const source = new TapeSource(entries, policy.price.minTradeQuote, options.clock);
  const market = new OnchainMarket(source, policy);
  const span = source.span;
  if (span === null) {
    throw new Error('The tape has no coverage marks: nothing was ever read');
  }

  // A round needs the history its first readings look back over.
  const warmup = Math.max(
    policy.volatilityLookbackMs + policy.price.priceWindowMs,
    CONFIDENCE_LOOKBACK,
  );
  const firstSlot = Math.ceil((span.from + warmup) / ROUND_DURATION) * ROUND_DURATION;
  const slots: number[] = [];
  for (let slot = firstSlot; slot + ROUND_DURATION <= span.to; slot += ROUND_DURATION) {
    slots.push(slot);
  }

  const samples = new Map<ActiveTicker, TickerSamples>(
    ACTIVE_TICKERS.map((ticker) => [ticker, emptyTickerSamples()]),
  );
  const sampleOf = (ticker: ActiveTicker): TickerSamples => {
    const found = samples.get(ticker);
    if (found === undefined) {
      throw new Error(`No samples for ${ticker}`);
    }
    return found;
  };
  const battles = {
    finalized: 0,
    voided: 0,
    margin: new Sample(),
    victoryLabels: tally(VICTORY_LABELS),
    momentum: tally(MOMENTUM_STATES),
    advantage: new Sample(),
    gapReturn: new Sample(),
    gapVolume: new Sample(),
    gapPons: new Sample(),
  };
  const confidence = {
    labels: tally(CONFIDENCE_LABELS),
    priceTrend: tally(PRICE_TREND_SIGNALS),
    volumePulse: tally(VOLUME_PULSE_SIGNALS),
    ponsActivity: tally(PONS_ACTIVITY_SIGNALS),
    momentumStability: tally(MOMENTUM_STABILITY_SIGNALS),
  };
  let played = 0;
  let marketClosed = 0;
  let unrecorded = 0;
  let withoutVolumeHistory = 0;

  const pairs: [ActiveTicker, ActiveTicker][] = [];
  ACTIVE_TICKERS.forEach((left, index) => {
    for (const right of ACTIVE_TICKERS.slice(index + 1)) {
      pairs.push([left, right]);
    }
  });

  for (const [slotIndex, slot] of slots.entries()) {
    const pickOpenAt = utcTimestamp(slot);
    if (!source.records(slot - warmup, slot + ROUND_DURATION)) {
      unrecorded += 1;
      options.onRound?.(slotIndex + 1, slots.length);
      continue;
    }
    if (nextOpenWindow(pickOpenAt, ROUND_DURATION, policy.calendar) !== pickOpenAt) {
      marketClosed += 1;
      options.onRound?.(slotIndex + 1, slots.length);
      continue;
    }
    played += 1;
    const clock = buildCanonicalClock(pickOpenAt, pickOpenAt);
    const earliest = comparableSpans(
      { from: clock.battleStartAt, to: clock.battleEndAt },
      policy.comparableSessions,
      policy.calendar,
    ).reduce((least, comparable) => Math.min(least, comparable.from), Infinity);
    if (earliest < span.from) {
      withoutVolumeHistory += 1;
    }

    source.seeUntil(pickOpenAt);
    const lookbacks = new Map<ActiveTicker, ConfidenceLookback>();
    for (const ticker of ACTIVE_TICKERS) {
      const lookback = await market.lookback(ticker, pickOpenAt);
      lookbacks.set(ticker, lookback);
      const into = sampleOf(ticker);
      into.lookbackReturn.add(ratio(divScaled(lookback.windowReturn, lookback.volatility)));
      into.lookbackVolume.add(ratio(lookback.relativeVolume));
      into.lookbackPons.add(Number(lookback.qualifiedPonsActivity));
      into.lookbackChanges.add(directionChanges(lookback.subWindowReturns));
    }

    const roundKey = `calibration-${String(slot)}`;
    let states: BattleEngineState[] = pairs.map(([left, right]) => {
      const leftLookback = lookbacks.get(left);
      const rightLookback = lookbacks.get(right);
      if (leftLookback === undefined || rightLookback === undefined) {
        throw new Error('A lookback is missing');
      }
      const intel = matchupConfidence(leftLookback, rightLookback, candidate.confidence);
      for (const snapshot of [intel.left, intel.right]) {
        confidence.labels[snapshot.label] += 1;
        confidence.priceTrend[snapshot.priceTrend] += 1;
        confidence.volumePulse[snapshot.volumePulse] += 1;
        confidence.ponsActivity[snapshot.ponsActivity] += 1;
        confidence.momentumStability[snapshot.momentumStability] += 1;
      }
      return openBattle(
        beginBattle({
          battleId: battleId(`${roundKey}-${left}-${right}`),
          roundId: roundId(roundKey),
          left,
          right,
          clock,
          leftIntel: intel.left,
          rightIntel: intel.right,
        }),
        clock.battleStartAt,
      );
    });

    let tick = 0;
    for (
      let at = clock.battleStartAt;
      at < clock.battleEndAt;
      at = utcTimestamp(at + options.tickMs)
    ) {
      source.seeUntil(at);
      const readings = new Map<ActiveTicker, { inputs: SideInputs; health: FeedHealth }>();
      for (const ticker of ACTIVE_TICKERS) {
        const observation = await market.observe(ticker, { opensAt: clock.battleStartAt, at });
        readings.set(ticker, observation);
        const into = sampleOf(ticker);
        into.ticks[observation.health] += 1;
        if (observation.health !== 'HEALTHY') {
          const reason = observation.reason ?? 'UNSPECIFIED';
          into.reasons.set(reason, (into.reasons.get(reason) ?? 0) + 1);
        }
        if (tick % options.sampleEveryTicks === 0 && !requiresVoid(observation.health)) {
          const { inputs } = observation;
          into.adjustedReturn.add(ratio(volatilityAdjustedReturn(inputs)));
          into.returnBps.add(Number(inputs.windowReturn) / 100);
          into.volatilityBps.add(Number(inputs.volatility) / 100);
          into.relativeVolume.add(ratio(inputs.relativeVolume));
          into.qualifiedPonsActivity.add(Number(inputs.qualifiedPonsActivity));
          into.uniqueActiveWallets.add(Number(inputs.uniqueActiveWallets));
        }
      }

      states = states.map((state) => {
        if (state.state !== 'LIVE') {
          return state;
        }
        const left = readings.get(state.setup.left);
        const right = readings.get(state.setup.right);
        if (left === undefined || right === undefined) {
          throw new Error('A reading is missing');
        }
        const outcome = applyTick(
          state,
          {
            at,
            left: left.inputs,
            right: right.inputs,
            leftHealth: left.health,
            rightHealth: right.health,
          },
          candidate.engine,
        );
        if (outcome.kind === 'VOIDED') {
          if (requiresVoid(left.health)) {
            sampleOf(state.setup.left).voidsCaused += 1;
          }
          if (requiresVoid(right.health)) {
            sampleOf(state.setup.right).voidsCaused += 1;
          }
        } else if (outcome.kind === 'UPDATED') {
          battles.momentum[outcome.update.momentum] += 1;
          if (tick % options.sampleEveryTicks === 0) {
            battles.advantage.add(
              Math.abs(ratio(advantageFromBattleScore(outcome.state.leftScoreScaled))),
            );
          }
        }
        return outcome.state;
      });
      tick += 1;
    }

    for (const state of states) {
      const left = sampleOf(state.setup.left);
      const right = sampleOf(state.setup.right);
      if (state.state !== 'LIVE') {
        battles.voided += 1;
        left.voided += 1;
        right.voided += 1;
        continue;
      }
      const outcome = finalizeBattle(state, clock.battleEndAt, TIEBREAK_BLOCK, candidate.engine);
      if (outcome.kind !== 'FINALIZED') {
        battles.voided += 1;
        left.voided += 1;
        right.voided += 1;
        continue;
      }
      battles.finalized += 1;
      left.finalized += 1;
      right.finalized += 1;
      battles.margin.add(
        Math.abs(Number(state.leftScoreScaled - state.rightScoreScaled)) / Number(RATIO_SCALE),
      );
      battles.victoryLabels[outcome.result.victoryLabel] += 1;
      if (state.lastLeft !== null && state.lastRight !== null) {
        battles.gapReturn.add(
          Math.abs(
            ratio(
              volatilityAdjustedReturn(state.lastLeft) - volatilityAdjustedReturn(state.lastRight),
            ),
          ),
        );
        battles.gapVolume.add(
          Math.abs(ratio(state.lastLeft.relativeVolume - state.lastRight.relativeVolume)),
        );
        battles.gapPons.add(
          Math.abs(ratio(ponsStrength(state.lastLeft) - ponsStrength(state.lastRight))),
        );
      }
    }
    options.onRound?.(slotIndex + 1, slots.length);
  }

  return {
    clock: options.clock,
    rounds: { played, marketClosed, unrecorded, withoutVolumeHistory },
    tickers: Object.fromEntries(
      ACTIVE_TICKERS.map((ticker) => [ticker, tickerReport(sampleOf(ticker))]),
    ) as Record<ActiveTicker, TickerReport>,
    battles: {
      finalized: battles.finalized,
      voided: battles.voided,
      margin: battles.margin.summary(),
      victoryLabels: battles.victoryLabels,
      momentum: battles.momentum,
      advantage: battles.advantage.summary(),
      gaps: {
        adjustedReturn: battles.gapReturn.summary(),
        relativeVolume: battles.gapVolume.summary(),
        ponsStrength: battles.gapPons.summary(),
      },
    },
    confidence,
  };
}

/** A value at `RATIO_SCALE` as a plain number, where 1 is 100% or one whole. */
function ratio(scaled: bigint): number {
  return Number(scaled) / Number(RATIO_SCALE);
}

function emptyTickerSamples(): TickerSamples {
  return {
    ticks: tally(FEED_HEALTH),
    reasons: new Map(),
    finalized: 0,
    voided: 0,
    voidsCaused: 0,
    adjustedReturn: new Sample(),
    returnBps: new Sample(),
    volatilityBps: new Sample(),
    relativeVolume: new Sample(),
    qualifiedPonsActivity: new Sample(),
    uniqueActiveWallets: new Sample(),
    lookbackReturn: new Sample(),
    lookbackVolume: new Sample(),
    lookbackPons: new Sample(),
    lookbackChanges: new Sample(),
  };
}

function tickerReport(samples: TickerSamples): TickerReport {
  return {
    ticks: samples.ticks,
    // Most frequent first, so the report reads top-down.
    unhealthyReasons: Object.fromEntries([...samples.reasons].sort((a, b) => b[1] - a[1])),
    battles: { finalized: samples.finalized, voided: samples.voided },
    voidsCaused: samples.voidsCaused,
    inputs: {
      adjustedReturn: samples.adjustedReturn.summary(),
      returnBps: samples.returnBps.summary(),
      volatilityBps: samples.volatilityBps.summary(),
      relativeVolume: samples.relativeVolume.summary(),
      qualifiedPonsActivity: samples.qualifiedPonsActivity.summary(),
      uniqueActiveWallets: samples.uniqueActiveWallets.summary(),
    },
    lookback: {
      adjustedReturn: samples.lookbackReturn.summary(),
      relativeVolume: samples.lookbackVolume.summary(),
      qualifiedPonsActivity: samples.lookbackPons.summary(),
      directionChanges: samples.lookbackChanges.summary(),
    },
  };
}
