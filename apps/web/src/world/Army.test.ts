import type { MomentumState } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { postureFor } from './Army.js';

/**
 * What an army shows, and what it must never show (§13, §24, §48.3).
 *
 * The whole of an army's behaviour comes from two values the public stream
 * already carries: a qualitative momentum state and a normalized frontline.
 * There is no third input and there must never be one — §24 keeps the exact
 * score off the wire for the entire live battle, and a posture derived from
 * anything else would be a client inventing a reading of a fight.
 */

const SIDES = [-1, 1] as const;
const DECISIVE: readonly MomentumState[] = ['PUSHING', 'SURGING', 'DOMINATING', 'COMEBACK'];

describe('a contested battle', () => {
  it('has both sides assaulting, wherever the line is', () => {
    // §13.1: contested is a fight neither side is winning. Both are in it.
    for (const frontline of [0.3, 0.5, 0.72]) {
      for (const side of SIDES) {
        expect(postureFor(side, 'CONTESTED', frontline)).toBe('ASSAULTING');
      }
    }
  });
});

describe('a battle somebody is winning', () => {
  it('advances the side the frontline favours and holds the other', () => {
    // `frontline` is the share held by the LEFT faction, which is `side: -1`.
    for (const momentum of DECISIVE) {
      expect(postureFor(-1, momentum, 0.68)).toBe('ADVANCING');
      expect(postureFor(1, momentum, 0.68)).toBe('HOLDING');

      expect(postureFor(1, momentum, 0.32)).toBe('ADVANCING');
      expect(postureFor(-1, momentum, 0.32)).toBe('HOLDING');
    }
  });

  it('never has both sides advancing at once', () => {
    // The property that keeps an army from contradicting the frontline marker
    // standing between the two of them.
    for (const momentum of DECISIVE) {
      for (const frontline of [0.05, 0.25, 0.45, 0.55, 0.75, 0.95]) {
        const both = SIDES.map((side) => postureFor(side, momentum, frontline));
        expect(both.filter((posture) => posture === 'ADVANCING')).toHaveLength(1);
      }
    }
  });

  it('treats a comeback as what the frontline already says', () => {
    // §13 describes `COMEBACK` as a reversal rather than a position, and the
    // frontline is where the reversal has reached. The side it now favours is
    // the side advancing — which is what a comeback looks like — so no special
    // case is needed, and a special case would be a second opinion.
    expect(postureFor(-1, 'COMEBACK', 0.6)).toBe(postureFor(-1, 'SURGING', 0.6));
    expect(postureFor(1, 'COMEBACK', 0.6)).toBe(postureFor(1, 'SURGING', 0.6));
  });
});

describe('an exactly even line', () => {
  it('has nobody advancing', () => {
    // A dead heat that is not `CONTESTED` is unusual but reachable, and an army
    // that advanced on a zero advantage would be showing ground nobody took.
    for (const momentum of DECISIVE) {
      for (const side of SIDES) {
        expect(postureFor(side, momentum, 0.5)).toBe('HOLDING');
      }
    }
  });
});
