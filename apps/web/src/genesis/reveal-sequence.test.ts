import { RARITIES, type Rarity } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_REVEAL_WORDS,
  grammarFor,
  revealPlan,
  type RevealRequest,
} from './reveal-sequence.js';

function request(rarity: Rarity, overrides: Partial<RevealRequest> = {}): RevealRequest {
  return { rarity, secretReservationSecured: true, reducedMotion: false, ...overrides };
}

describe('motion grammar', () => {
  it('gives Legendary and Secret their own grammars', () => {
    // §40.6: rarity changes the motion grammar, not just the colour.
    expect(grammarFor('LEGENDARY')).toBe('LEGENDARY');
    expect(grammarFor('SECRET')).toBe('SECRET');
  });

  it('shares one grammar across the ordinary rarities', () => {
    for (const rarity of ['COMMON', 'UNCOMMON', 'RARE', 'EPIC'] satisfies Rarity[]) {
      expect(grammarFor(rarity)).toBe('STANDARD');
    }
  });

  it('answers for every rarity in the catalogue', () => {
    for (const rarity of RARITIES) {
      expect(() => grammarFor(rarity)).not.toThrow();
    }
  });
});

describe('the base sequence', () => {
  it('opens the way §40.6 writes it', () => {
    const plan = revealPlan(request('RARE'));
    expect(plan.steps.slice(0, 3).map((step) => step.label)).toEqual([
      'VERIFYING HOLDER',
      'GENESIS ACCESS GRANTED',
      'GENERATING SIGNAL',
    ]);
  });

  it('names the rarity exactly once in a completed script', () => {
    for (const rarity of RARITIES) {
      const plan = revealPlan(request(rarity));
      expect(plan.steps.filter((step) => step.revealsRarity)).toHaveLength(1);
      expect(plan.complete).toBe(true);
    }
  });

  it('gives Legendary a longer sequence than Common', () => {
    const common = revealPlan(request('COMMON'));
    const legendary = revealPlan(request('LEGENDARY'));
    expect(legendary.steps.length).toBeGreaterThan(common.steps.length);
    expect(legendary.totalDuration).toBeGreaterThan(common.totalDuration);
  });
});

describe('the Secret sequence', () => {
  it('performs the system failing to classify what it drew', () => {
    const labels = revealPlan(request('SECRET')).steps.map((step) => step.label);
    expect(labels).toContain('SIGNAL UNSTABLE');
    expect(labels).toContain('CLASSIFICATION FAILED — ???');
  });

  it('never names the Secret before the reward is reserved', () => {
    // §8.4 and §27.3: reserve before reveal. A player told they hold a Secret
    // the vault cannot cover has been told something false about real money.
    const plan = revealPlan(request('SECRET', { secretReservationSecured: false }));
    expect(plan.complete).toBe(false);
    expect(plan.steps.some((step) => step.revealsRarity)).toBe(false);
    expect(plan.steps.map((step) => step.label)).not.toContain('SECRET STOCK DROP');
  });

  it('holds at securing rather than at an error', () => {
    // The reservation is expected to succeed. This is the sequence waiting for
    // it, not a failure state.
    const plan = revealPlan(request('SECRET', { secretReservationSecured: false }));
    expect(plan.steps.at(-1)?.label).toBe('SECURING REWARD');
  });

  it('reveals once the reservation is confirmed', () => {
    const plan = revealPlan(request('SECRET'));
    expect(plan.complete).toBe(true);
    expect(plan.steps.at(-1)?.label).toBe('SECRET STOCK DROP');
  });

  it('does not gate any other rarity on a reservation', () => {
    // Nothing else pays out on reveal, so nothing else waits on the vault.
    for (const rarity of RARITIES.filter((candidate) => candidate !== 'SECRET')) {
      const plan = revealPlan(request(rarity, { secretReservationSecured: false }));
      expect(plan.complete).toBe(true);
    }
  });
});

describe('reduced motion', () => {
  it('shortens every sequence', () => {
    for (const rarity of RARITIES) {
      const full = revealPlan(request(rarity));
      const reduced = revealPlan(request(rarity, { reducedMotion: true }));
      expect(reduced.totalDuration).toBeLessThan(full.totalDuration);
    }
  });

  it('drops no information', () => {
    // §83.3 collapses long sequences but requires gameplay information to stay
    // complete. Each line is a distinct thing the player is being told, so the
    // beats shorten and none of them disappear.
    for (const rarity of RARITIES) {
      const full = revealPlan(request(rarity));
      const reduced = revealPlan(request(rarity, { reducedMotion: true }));
      expect(reduced.steps.map((step) => step.label)).toEqual(full.steps.map((step) => step.label));
      expect(reduced.complete).toBe(true);
    }
  });

  it('still leaves every beat visible rather than instant', () => {
    // *"Never remove functional feedback."* A zero-length step is a step nobody
    // can read.
    for (const rarity of RARITIES) {
      for (const step of revealPlan(request(rarity, { reducedMotion: true })).steps) {
        expect(step.duration).toBeGreaterThan(0);
      }
    }
  });
});

describe('reveal copy', () => {
  it('uses no casino language anywhere', () => {
    // §40.6: no confetti, no slot-machine effects, no casino celebration
    // language. Written as data and checked, because a prohibition that lives
    // only in a comment is one a future label quietly breaks.
    for (const rarity of RARITIES) {
      for (const secured of [true, false]) {
        for (const reducedMotion of [true, false]) {
          const plan = revealPlan({
            rarity,
            secretReservationSecured: secured,
            reducedMotion,
          });
          for (const step of plan.steps) {
            const label = step.label.toLowerCase();
            for (const word of FORBIDDEN_REVEAL_WORDS) {
              expect(label).not.toContain(word);
            }
          }
        }
      }
    }
  });
});
