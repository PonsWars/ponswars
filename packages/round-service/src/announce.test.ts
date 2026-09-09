import { createRound, type RoundEngineState } from '@ponswars/battle-engine';
import { RATIO_SCALE, clockForRound, roundIdFor } from '@ponswars/battle-math';
import { WORLD_CHANNEL } from '@ponswars/realtime';
import { parseEventFrame } from '@ponswars/schemas';
import { ACTIVE_TICKERS, roundId as toRoundId, utcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { announceRoundOpened } from './announce.js';
import { MemoryPublisher } from './memory.js';

/**
 * `ROUND_OPENED` (§48.3).
 *
 * The event a client learns a round from. It was in the contract and in the
 * schemas and was published by nothing, so a client that connected between two
 * rounds had no way to hear about the new one until it fetched.
 */

const EPOCH = utcTimestamp(1_800_000_000_000);

const CONFIDENCE = {
  lookback: Object.fromEntries(
    ACTIVE_TICKERS.map((ticker) => [
      ticker,
      {
        windowReturn: 0n,
        volatility: RATIO_SCALE,
        relativeVolume: RATIO_SCALE,
        qualifiedPonsActivity: 20n,
        subWindowReturns: [10n, 10n, 10n],
      },
    ]),
  ),
  calibration: {
    priceTrend: { strong: RATIO_SCALE / 2n, weak: -RATIO_SCALE / 2n },
    volumePulse: { rising: (RATIO_SCALE * 13n) / 10n, weak: (RATIO_SCALE * 7n) / 10n },
    ponsActivity: { high: 40n, medium: 15n },
    momentumStability: { stable: 2, mixed: 5 },
    matchup: { favored: 20, strongFavorite: 60, dominant: 120 },
  },
};

function openRound(): RoundEngineState {
  return createRound({
    roundId: toRoundId(roundIdFor(0)),
    roundIndex: 0,
    clock: clockForRound(EPOCH, 0, EPOCH),
    baseSeedHex: `0x${'5c'.repeat(32)}`,
    recentRounds: [],
    confidence: CONFIDENCE,
  });
}

describe('announcing an open round', () => {
  it('emits one frame that parses against the published contract', async () => {
    const publisher = new MemoryPublisher();
    const round = openRound();

    await announceRoundOpened(round, publisher);

    expect(publisher.published).toHaveLength(1);
    const [envelope] = publisher.published;
    const parsed = parseEventFrame(JSON.parse(JSON.stringify(envelope)));
    expect(parsed.ok ? null : parsed.reason).toBeNull();
    expect(envelope?.event).toBe('ROUND_OPENED');
    // The world channel, not the round's own. Nobody can subscribe to a round
    // they have not heard of, and this event is the hearing of it — announcing
    // it on the round's channel would reach only clients who already knew.
    expect(envelope?.channel).toBe(WORLD_CHANNEL);
  });

  it('carries all five matchups with their sectors and intel', async () => {
    // §4.3 fixes the count at five and the schema enforces it; §38.4 makes the
    // sector positional, so it is derived here exactly as the API derives it.
    const publisher = new MemoryPublisher();
    const round = openRound();

    await announceRoundOpened(round, publisher);
    const payload = publisher.published[0]?.payload as {
      matchups: { sectorId: string; leftIntel: { label: string } }[];
    };

    expect(payload.matchups).toHaveLength(5);
    expect(payload.matchups.map((matchup) => matchup.sectorId)).toEqual([
      'sector-01',
      'sector-02',
      'sector-03',
      'sector-04',
      'sector-05',
    ]);
    // The whole snapshot, not just a label: §27.5 draws four sub-signals, and a
    // client that had to fetch to see them would draw an empty panel first.
    expect(Object.keys(payload.matchups[0]?.leftIntel ?? {}).sort()).toEqual([
      'label',
      'momentumStability',
      'ponsActivity',
      'priceTrend',
      'volumePulse',
    ]);
  });

  it('stamps the announcement at the instant the round opened', async () => {
    // Not at "now". §23.5 makes the round's own clock authoritative, and an
    // announcement stamped late would describe a pick phase that started later
    // than it did.
    const publisher = new MemoryPublisher();
    const round = openRound();

    await announceRoundOpened(round, publisher);

    expect(publisher.published[0]?.emittedAt).toBe(round.clock.pickOpenAt);
  });
});
