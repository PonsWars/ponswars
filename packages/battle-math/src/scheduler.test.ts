import { milliseconds, ROUND_DURATION, type UtcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  acceptsPickAt,
  battleIdFor,
  clockForRound,
  decideFinalization,
  roundIdFor,
  roundIndexAt,
  sectorIdFor,
  type FinalizationPolicy,
} from './scheduler.js';

const EPOCH = 1_800_000_000_000 as UtcTimestamp;
const at = (offset: number): UtcTimestamp => (EPOCH + offset) as UtcTimestamp;

const POLICY: FinalizationPolicy = { maxWait: milliseconds(5_000) };

describe('clockForRound', () => {
  it('places round zero at the epoch', () => {
    const clock = clockForRound(EPOCH, 0, EPOCH);
    expect(clock.pickOpenAt).toBe(EPOCH);
    expect(clock.lockAt).toBe(EPOCH + 60_000);
    expect(clock.battleEndAt).toBe(EPOCH + 600_000);
  });

  it('runs rounds back to back with no gap', () => {
    // §3: rounds are continuous. A gap would leave the world in no round at
    // all, and an overlap would mean two live rounds.
    for (let index = 0; index < 100; index += 1) {
      const current = clockForRound(EPOCH, index, EPOCH);
      const next = clockForRound(EPOCH, index + 1, EPOCH);
      expect(next.pickOpenAt).toBe(current.battleEndAt);
    }
  });

  it('is a pure function of epoch and index', () => {
    expect(clockForRound(EPOCH, 7, at(1))).toEqual(clockForRound(EPOCH, 7, at(1)));
  });

  it('carries the server time it was built with', () => {
    expect(clockForRound(EPOCH, 3, at(999)).serverTime).toBe(at(999));
  });

  it.each([-1, 1.5, Number.NaN])('rejects index %s', (index) => {
    expect(() => clockForRound(EPOCH, index, EPOCH)).toThrow(RangeError);
  });
});

describe('roundIndexAt', () => {
  it('maps an instant to its round', () => {
    expect(roundIndexAt(EPOCH, EPOCH)).toBe(0);
    expect(roundIndexAt(EPOCH, at(599_999))).toBe(0);
    expect(roundIndexAt(EPOCH, at(600_000))).toBe(1);
    expect(roundIndexAt(EPOCH, at(ROUND_DURATION * 42))).toBe(42);
  });

  it('returns null before the epoch', () => {
    // There is no round -1, and returning 0 would quietly place a pre-launch
    // timestamp inside the first round.
    expect(roundIndexAt(EPOCH, at(-1))).toBeNull();
  });

  it('round-trips against clockForRound', () => {
    for (const index of [0, 1, 5, 144, 1_000]) {
      const clock = clockForRound(EPOCH, index, EPOCH);
      expect(roundIndexAt(EPOCH, clock.pickOpenAt)).toBe(index);
      expect(roundIndexAt(EPOCH, (clock.battleEndAt - 1) as UtcTimestamp)).toBe(index);
    }
  });
});

describe('acceptsPickAt', () => {
  const clock = clockForRound(EPOCH, 0, EPOCH);

  it('accepts throughout the pick phase', () => {
    expect(acceptsPickAt(clock, clock.pickOpenAt)).toBe(true);
    expect(acceptsPickAt(clock, at(30_000))).toBe(true);
    expect(acceptsPickAt(clock, at(59_999))).toBe(true);
  });

  it('rejects at the lock instant exactly', () => {
    // §72.4: a request received after lock_at is rejected even if the user's
    // screen still shows milliseconds remaining. §3.2 locks *at* one minute, so
    // that instant already belongs to the battle.
    expect(acceptsPickAt(clock, clock.lockAt)).toBe(false);
    expect(acceptsPickAt(clock, at(60_001))).toBe(false);
  });

  it('rejects before the round opens', () => {
    expect(acceptsPickAt(clock, at(-1))).toBe(false);
  });
});

describe('decideFinalization', () => {
  const clock = clockForRound(EPOCH, 0, EPOCH);

  it('finalizes immediately when data is complete', () => {
    expect(decideFinalization(clock, clock.battleEndAt, true, POLICY)).toBe('FINALIZE');
  });

  it('waits briefly for late but still valid data', () => {
    // §72.5: a brief FINALIZING pause rather than fabricating a result.
    expect(decideFinalization(clock, clock.battleEndAt, false, POLICY)).toBe('WAIT');
    expect(decideFinalization(clock, at(600_000 + 4_999), false, POLICY)).toBe('WAIT');
  });

  it('voids rather than waiting indefinitely', () => {
    // §72.5 requires a configured maximum. Crossing it is a data-integrity
    // decision, not a longer wait.
    expect(decideFinalization(clock, at(600_000 + 5_000), false, POLICY)).toBe('VOID');
    expect(decideFinalization(clock, at(600_000 + 60_000), false, POLICY)).toBe('VOID');
  });

  it('finalizes on complete data even past the maximum wait', () => {
    // Data that arrives late is still real data. VOID is for absent data.
    expect(decideFinalization(clock, at(600_000 + 60_000), true, POLICY)).toBe('FINALIZE');
  });

  it('never decides before the cutoff', () => {
    // §12.6 makes the cutoff hard. Deciding early would mean scoring a window
    // that is still open.
    expect(() => decideFinalization(clock, at(599_999), true, POLICY)).toThrow(RangeError);
  });

  it('offers no fourth outcome', () => {
    // Brief §6: never synthesize a result to keep the UI moving. There is no
    // path here that finalizes on incomplete data.
    for (const offset of [0, 1_000, 4_999, 5_000, 100_000]) {
      for (const complete of [true, false]) {
        const decision = decideFinalization(clock, at(600_000 + offset), complete, POLICY);
        expect(['WAIT', 'FINALIZE', 'VOID']).toContain(decision);
        if (!complete) {
          expect(decision).not.toBe('FINALIZE');
        }
      }
    }
  });
});

describe('identifiers', () => {
  it('are deterministic and sort as strings', () => {
    expect(roundIdFor(0)).toBe('round-0000000000');
    expect(roundIdFor(42)).toBe('round-0000000042');
    const ids = [roundIdFor(2), roundIdFor(10), roundIdFor(1)];
    expect([...ids].sort()).toEqual([roundIdFor(1), roundIdFor(2), roundIdFor(10)]);
  });

  it('scope battles to their round', () => {
    expect(battleIdFor(7, 0)).toBe('round-0000000007-b0');
    expect(battleIdFor(7, 4)).toBe('round-0000000007-b4');
    expect(battleIdFor(7, 0)).not.toBe(battleIdFor(8, 0));
  });

  it('number sectors from one', () => {
    // Sectors are neutral and reused every round (§38.3), so their ids carry no
    // round or faction.
    expect(sectorIdFor(0)).toBe('sector-01');
    expect(sectorIdFor(4)).toBe('sector-05');
  });

  it.each([-1, 1.5])('reject invalid inputs: %s', (value) => {
    expect(() => roundIdFor(value)).toThrow(RangeError);
    expect(() => battleIdFor(0, value)).toThrow(RangeError);
    expect(() => sectorIdFor(value)).toThrow(RangeError);
  });
});
