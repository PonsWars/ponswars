import { DISTRIBUTION_WINDOW, utcTimestamp } from '@ponswars/shared-types';
import type { DistributionWindow } from '@ponswars/store-postgres';
import { describe, expect, it } from 'vitest';
import { nextWindowStep } from './rewards-window.js';

const START = utcTimestamp(Date.parse('2026-09-16T00:00:00Z'));
const END = utcTimestamp(START + DISTRIBUTION_WINDOW);

const window = (state: DistributionWindow['state'], id = 7n): DistributionWindow => ({
  distributionId: id,
  state,
  windowStart: START,
  windowEnd: END,
});

describe('nextWindowStep', () => {
  it('opens the first window at the instant it is asked', () => {
    expect(nextWindowStep(START, null)).toEqual({
      kind: 'OPEN',
      distributionId: 1n,
      windowStart: START,
    });
  });

  it('waits out an open window rather than snapshotting it early (§16.3)', () => {
    expect(nextWindowStep(utcTimestamp(END - 1), window('OPEN'))).toEqual({
      kind: 'WAIT',
      until: END,
      reason: 'distribution 7 closes',
    });
  });

  it('snapshots at the close, and after it', () => {
    expect(nextWindowStep(END, window('OPEN'))).toEqual({ kind: 'SNAPSHOT', distributionId: 7n });
    expect(nextWindowStep(utcTimestamp(END + 5 * 3_600_000), window('OPEN'))).toEqual({
      kind: 'SNAPSHOT',
      distributionId: 7n,
    });
  });

  it('opens the next window where the last one ended, however late it is opened', () => {
    // §16.2 makes windows contiguous. A scheduler that slept through a close
    // owes a late window, never a short one or a gap nobody earned points in.
    const late = utcTimestamp(END + 9 * 3_600_000);

    expect(nextWindowStep(late, window('SNAPSHOT'))).toEqual({
      kind: 'OPEN',
      distributionId: 8n,
      windowStart: END,
    });
  });

  it('opens the next window whatever became of the last one', () => {
    for (const state of ['SNAPSHOT', 'CALCULATED', 'PUBLISHED', 'CLOSED'] as const) {
      expect(nextWindowStep(END, window(state))).toMatchObject({
        kind: 'OPEN',
        distributionId: 8n,
      });
    }
  });
});
