import { NO_CARD_SUPPORT, RATIO_SCALE, type SideInputs } from '@ponswars/battle-math';
import {
  buildCanonicalClock,
  type BattleId,
  type RoundId,
  type UtcTimestamp,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { EMPTY_EVIDENCE } from './evidence.js';
import {
  applyTick,
  beginBattle,
  CURRENT_ENGINE_VERSIONS,
  finalizeBattle,
  openBattle,
  versionTag,
  type BattleEngineState,
  type BattleSetup,
  type EngineConfig,
  type TickInput,
} from './engine.js';

const T0 = 1_800_000_000_000 as UtcTimestamp;
const at = (offset: number): UtcTimestamp => (T0 + offset) as UtcTimestamp;
const BLOCK = `0x${'ab'.repeat(32)}`;

const CONFIG: EngineConfig = {
  scoring: {
    priceEdgeDivisor: 2n * RATIO_SCALE,
    volumeEdgeDivisor: 1n * RATIO_SCALE,
    ponsEdgeDivisor: 10n * RATIO_SCALE,
    cardEdgeDivisor: 10n * RATIO_SCALE,
  },
  momentum: {
    push: 100_000n,
    surge: 200_000n,
    dominance: 400_000n,
    comeback: 300_000n,
  },
  victory: { narrowMargin: 4_000_000n, decisiveMargin: 30_000_000n },
  finalization: { maxWait: 5_000 as never },
  versions: CURRENT_ENGINE_VERSIONS,
  cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
};

const SETUP: BattleSetup = {
  battleId: 'round-0000000001-b0' as BattleId,
  roundId: 'round-0000000001' as RoundId,
  left: 'NVDA',
  right: 'AAPL',
  clock: buildCanonicalClock(T0, T0),
  leftConfidence: 'EVEN',
  rightConfidence: 'EVEN',
};

const side = (overrides: Partial<SideInputs> = {}): SideInputs => ({
  windowReturn: 0n,
  volatility: RATIO_SCALE,
  relativeVolume: RATIO_SCALE,
  qualifiedPonsActivity: 0n,
  uniqueActiveWallets: 0n,
  cardSupport: NO_CARD_SUPPORT,
  ...overrides,
});

const tick = (offset: number, overrides: Partial<TickInput> = {}): TickInput => ({
  at: at(offset),
  left: side(),
  right: side(),
  leftHealth: 'HEALTHY',
  rightHealth: 'HEALTHY',
  ...overrides,
});

const live = (): BattleEngineState => openBattle(beginBattle(SETUP), at(60_000));

/** Drives a full battle and returns the final state. */
const drive = (ticks: readonly TickInput[]): BattleEngineState => {
  let state = live();
  for (const input of ticks) {
    const outcome = applyTick(state, input, CONFIG);
    state = outcome.state;
  }
  return state;
};

describe('lifecycle', () => {
  it('starts scheduled with an empty evidence chain', () => {
    const state = beginBattle(SETUP);
    expect(state.state).toBe('SCHEDULED');
    expect(state.tickSequence).toBe(0);
    expect(state.evidenceHash).toBe(EMPTY_EVIDENCE);
  });

  it('opens at the scoring window', () => {
    expect(live().state).toBe('LIVE');
  });

  it('refuses to open before the window', () => {
    // §12.1: the scoring window opens exactly at lock, not before.
    expect(() => openBattle(beginBattle(SETUP), at(59_999))).toThrow(RangeError);
  });

  it('refuses to open twice', () => {
    expect(() => openBattle(live(), at(60_000))).toThrow();
  });
});

describe('tick acceptance', () => {
  it('ignores ticks while scheduled', () => {
    const outcome = applyTick(beginBattle(SETUP), tick(70_000), CONFIG);
    expect(outcome.kind).toBe('IGNORED');
  });

  it('ignores ticks before the scoring window', () => {
    const outcome = applyTick(live(), tick(30_000), CONFIG);
    expect(outcome.kind).toBe('IGNORED');
  });

  it('ignores ticks at or after the hard cutoff', () => {
    // §12.6: stop accepting battle-window data at the cutoff. A sample in
    // flight when the window closed is expected, and simply does not count.
    expect(applyTick(live(), tick(600_000), CONFIG).kind).toBe('IGNORED');
    expect(applyTick(live(), tick(700_000), CONFIG).kind).toBe('IGNORED');
    expect(applyTick(live(), tick(599_999), CONFIG).kind).toBe('UPDATED');
  });

  it('ignores an out-of-order tick', () => {
    // Accepting one would make the evidence chain describe a history that never
    // happened.
    let state = live();
    state = applyTick(state, tick(120_000), CONFIG).state;
    const outcome = applyTick(state, tick(90_000), CONFIG);
    expect(outcome.kind).toBe('IGNORED');
    expect(outcome.state.tickSequence).toBe(1);
  });

  it('leaves state untouched when ignoring', () => {
    const state = live();
    const outcome = applyTick(state, tick(700_000), CONFIG);
    expect(outcome.state).toBe(state);
  });
});

describe('the public update', () => {
  it('carries no score field', () => {
    // §24 and §48.3 forbid publishing the exact score during a live battle.
    const outcome = applyTick(live(), tick(120_000), CONFIG);
    if (outcome.kind !== 'UPDATED') throw new Error('expected an update');
    expect(Object.keys(outcome.update)).not.toContain('leftScore');
    expect(Object.keys(outcome.update)).not.toContain('score');
    expect(JSON.stringify(outcome.update)).not.toContain('ScoreScaled');
  });

  it('reports time remaining, floored at zero', () => {
    const outcome = applyTick(live(), tick(120_000), CONFIG);
    if (outcome.kind !== 'UPDATED') throw new Error('expected an update');
    expect(outcome.update.timeRemaining).toBe(480_000);
  });

  it('summarises card support as a tier, never a count', () => {
    // §15: thousands of deployed cards must not read as thousands of units.
    const heavy = applyTick(
      live(),
      tick(120_000, { left: side({ cardSupport: { ...NO_CARD_SUPPORT, general: 50_000n } }) }),
      CONFIG,
    );
    if (heavy.kind !== 'UPDATED') throw new Error('expected an update');
    expect(heavy.update.cardSupport).toBe('MAX');

    const light = applyTick(live(), tick(120_000), CONFIG);
    if (light.kind !== 'UPDATED') throw new Error('expected an update');
    expect(light.update.cardSupport).toBe('LOW');
  });

  it('reports degraded health without naming a vendor', () => {
    const outcome = applyTick(live(), tick(120_000, { leftHealth: 'DEGRADED' }), CONFIG);
    if (outcome.kind !== 'UPDATED') throw new Error('expected an update');
    expect(outcome.update.feedHealth).toBe('DEGRADED');
  });
});

describe('feed integrity', () => {
  it('scores through degraded data', () => {
    // DEGRADED is late but real. Voiding on every hiccup would make the game
    // unplayable.
    const outcome = applyTick(live(), tick(120_000, { leftHealth: 'DEGRADED' }), CONFIG);
    expect(outcome.kind).toBe('UPDATED');
  });

  it.each(['STALE', 'UNAVAILABLE'] as const)('voids the battle on %s data', (health) => {
    // §4.4 and Brief §6: never synthesize a result to keep the UI moving.
    const outcome = applyTick(live(), tick(120_000, { leftHealth: health }), CONFIG);
    expect(outcome.kind).toBe('VOIDED');
    expect(outcome.state.state).toBe('VOID');
    expect(outcome.state.voidReason).toBe('DATA_INTEGRITY');
  });

  it('voids on either side failing', () => {
    expect(applyTick(live(), tick(120_000, { rightHealth: 'STALE' }), CONFIG).kind).toBe('VOIDED');
  });

  it('ignores further ticks once voided', () => {
    const voided = applyTick(live(), tick(120_000, { leftHealth: 'STALE' }), CONFIG).state;
    expect(applyTick(voided, tick(180_000), CONFIG).kind).toBe('IGNORED');
  });
});

describe('the evidence chain', () => {
  it('advances with every accepted tick', () => {
    let state = live();
    const seen = new Set<string>([state.evidenceHash]);
    for (const offset of [70_000, 80_000, 90_000]) {
      state = applyTick(state, tick(offset), CONFIG).state;
      expect(seen.has(state.evidenceHash)).toBe(false);
      seen.add(state.evidenceHash);
    }
    expect(state.tickSequence).toBe(3);
  });

  it('detects a dropped tick', () => {
    // §26: the digest is folded forward tick by tick, so it proves nothing was
    // dropped as well as nothing was edited.
    const full = drive([tick(70_000), tick(80_000), tick(90_000)]);
    const dropped = drive([tick(70_000), tick(90_000)]);
    expect(dropped.evidenceHash).not.toBe(full.evidenceHash);
  });

  it('detects reordered ticks', () => {
    const a = drive([tick(70_000, { left: side({ windowReturn: 10_000n }) }), tick(80_000)]);
    const b = drive([tick(70_000), tick(80_000, { left: side({ windowReturn: 10_000n }) })]);
    expect(a.evidenceHash).not.toBe(b.evidenceHash);
  });

  it('detects an altered input', () => {
    const original = drive([tick(70_000), tick(80_000)]);
    const altered = drive([
      tick(70_000),
      tick(80_000, { right: side({ relativeVolume: 2n * RATIO_SCALE }) }),
    ]);
    expect(altered.evidenceHash).not.toBe(original.evidenceHash);
  });

  it('is unchanged by an ignored tick', () => {
    let state = drive([tick(70_000)]);
    const before = state.evidenceHash;
    state = applyTick(state, tick(700_000), CONFIG).state;
    expect(state.evidenceHash).toBe(before);
  });
});

describe('finalization', () => {
  const finalize = (state: BattleEngineState, complete = true) =>
    finalizeBattle(state, at(600_000), BLOCK, CONFIG, complete);

  it('produces a result carrying the full component breakdown', () => {
    const state = drive([tick(70_000), tick(300_000, { left: side({ windowReturn: 80_000n }) })]);
    const outcome = finalize(state);
    if (outcome.kind !== 'FINALIZED') throw new Error('expected a result');

    expect(outcome.result.winner).toBe('NVDA');
    expect(outcome.result.battleId).toBe(SETUP.battleId);
    expect(outcome.result.evidenceHash).toBe(state.evidenceHash);
    expect(outcome.state.state).toBe('FINALIZED');
  });

  it('stamps the five algorithm versions', () => {
    // §73.1: five versions so a replay knows which combination produced a
    // result. A single number would force every historical battle to be
    // reinterpreted whenever any one of them moved.
    const outcome = finalize(drive([tick(70_000)]));
    if (outcome.kind !== 'FINALIZED') throw new Error('expected a result');
    expect(outcome.result.scoringEngineVersion).toBe(versionTag(CURRENT_ENGINE_VERSIONS));
    expect(outcome.result.scoringEngineVersion.split('+')).toHaveLength(5);
  });

  it('is exactly-once', () => {
    // §25. A retried finalization must not write a second result, and the
    // state machine is what guarantees it rather than the caller remembering.
    const outcome = finalize(drive([tick(70_000)]));
    if (outcome.kind !== 'FINALIZED') throw new Error('expected a result');
    expect(() => finalize(outcome.state)).toThrow(/exactly-once/);
  });

  it('cannot finalize a voided battle', () => {
    const voided = applyTick(live(), tick(120_000, { leftHealth: 'STALE' }), CONFIG).state;
    expect(() => finalize(voided)).toThrow();
  });

  it('waits briefly for late but valid data', () => {
    // §72.5.
    const state = drive([tick(70_000)]);
    expect(finalize(state, false).kind).toBe('WAIT');
  });

  it('voids rather than waiting indefinitely', () => {
    const state = drive([tick(70_000)]);
    const outcome = finalizeBattle(state, at(600_000 + 5_000), BLOCK, CONFIG, false);
    expect(outcome.kind).toBe('VOIDED');
  });

  it('voids a battle that never received a scorable tick', () => {
    // Zero-zero is not a draw, it is an absence of evidence. §26 requires a
    // result to be explicable from what was observed.
    const outcome = finalize(live());
    expect(outcome.kind).toBe('VOIDED');
  });

  it('labels an upset from the winner’s pre-battle confidence', () => {
    // §11: the label comes from the snapshot taken at round open, not from the
    // margin.
    const underdogSetup: BattleSetup = { ...SETUP, leftConfidence: 'HEAVY_UNDERDOG' };
    let state = openBattle(beginBattle(underdogSetup), at(60_000));
    state = applyTick(
      state,
      tick(120_000, { left: side({ windowReturn: 200_000n }) }),
      CONFIG,
    ).state;

    const outcome = finalizeBattle(state, at(600_000), BLOCK, CONFIG);
    if (outcome.kind !== 'FINALIZED') throw new Error('expected a result');
    expect(outcome.result.winner).toBe('NVDA');
    expect(outcome.result.victoryLabel).toBe('MAJOR_UPSET');
  });

  it('labels a comeback from what the battlefield showed', () => {
    // A saturated price edge is needed to push the advantage past the 0.30
    // comeback threshold: price carries 45 of 100 points, so even total
    // dominance of it only moves the overall advantage to 0.45.
    const state = drive([
      tick(70_000, { right: side({ windowReturn: 2_000_000n }) }),
      tick(200_000, { right: side({ windowReturn: 2_000_000n }) }),
      tick(400_000, { left: side({ windowReturn: 2_000_000n }) }),
    ]);
    const outcome = finalizeBattle(state, at(600_000), BLOCK, CONFIG);
    if (outcome.kind !== 'FINALIZED') throw new Error('expected a result');
    expect(outcome.result.winner).toBe('NVDA');
    expect(outcome.result.victoryLabel).toBe('COMEBACK_VICTORY');
  });

  it('scores the last accepted tick, never a later one', () => {
    // §12.6 excludes post-cutoff data. A sample arriving after the window must
    // not change the result.
    let state = drive([tick(300_000, { left: side({ windowReturn: 100_000n }) })]);
    state = applyTick(
      state,
      tick(650_000, { right: side({ windowReturn: 900_000n }) }),
      CONFIG,
    ).state;

    const outcome = finalizeBattle(state, at(700_000), BLOCK, CONFIG);
    if (outcome.kind !== 'FINALIZED') throw new Error('expected a result');
    expect(outcome.result.winner).toBe('NVDA');
  });
});

describe('determinism', () => {
  const sequence: TickInput[] = [
    tick(70_000, { left: side({ windowReturn: 30_000n, qualifiedPonsActivity: 500n }) }),
    tick(200_000, { right: side({ relativeVolume: 3n * RATIO_SCALE }) }),
    tick(400_000, { left: side({ cardSupport: { ...NO_CARD_SUPPORT, general: 900n } }) }),
    tick(590_000, { left: side({ windowReturn: 55_000n }) }),
  ];

  it('reproduces the same result from the same evidence', () => {
    // Brief §8: the same evidence bundle must reproduce the same result. This
    // is the property the whole engine is shaped around.
    const first = finalizeBattle(drive(sequence), at(600_000), BLOCK, CONFIG);
    const second = finalizeBattle(drive(sequence), at(600_000), BLOCK, CONFIG);
    expect(second).toEqual(first);
  });

  it('resumes from a checkpoint identically', () => {
    // §25: the engine checkpoints often enough to recover from a restart. A
    // resumed battle must not diverge from one that never stopped.
    const whole = drive(sequence);

    let partial = live();
    for (const input of sequence.slice(0, 2)) {
      partial = applyTick(partial, input, CONFIG).state;
    }
    // Round-trip through JSON the way a real checkpoint would, bigints included.
    const checkpoint: BattleEngineState = JSON.parse(
      JSON.stringify(partial, (_key, value: unknown) =>
        typeof value === 'bigint' ? `${value.toString()}n` : value,
      ),
      (_key, value: unknown) =>
        typeof value === 'string' && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value,
    ) as BattleEngineState;

    let resumed = checkpoint;
    for (const input of sequence.slice(2)) {
      resumed = applyTick(resumed, input, CONFIG).state;
    }

    expect(resumed.evidenceHash).toBe(whole.evidenceHash);
    expect(resumed.leftScoreScaled).toBe(whole.leftScoreScaled);
    expect(resumed.momentum).toEqual(whole.momentum);
  });
});
