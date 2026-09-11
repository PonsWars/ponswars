import type { MomentumState } from '@ponswars/shared-types';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLIPS,
  LEAN,
  leanFor,
  MARCH_START,
  MARCH_STOP,
  marching,
  MODELS,
  pickClip,
  postureFor,
  stanceFor,
  type Stance,
  type UnitKind,
} from './army-rules.js';

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
const STANCES: readonly Stance[] = ['HOLDING', 'MARCHING', 'ASSAULTING'];

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
    // frontline is where the reversal has reached. No special case is needed,
    // and a special case would be a second opinion.
    expect(postureFor(-1, 'COMEBACK', 0.6)).toBe(postureFor(-1, 'SURGING', 0.6));
    expect(postureFor(1, 'COMEBACK', 0.6)).toBe(postureFor(1, 'SURGING', 0.6));
  });

  it('has nobody advancing on an exactly even line', () => {
    // A dead heat that is not `CONTESTED` is unusual but reachable, and an army
    // that advanced on a zero advantage would be showing ground nobody took.
    for (const momentum of DECISIVE) {
      for (const side of SIDES) {
        expect(postureFor(side, momentum, 0.5)).toBe('HOLDING');
      }
    }
  });
});

describe('the lean', () => {
  it('never exceeds its stated reach, wherever the line is', () => {
    for (let step = 0; step <= 100; step += 1) {
      for (const side of SIDES) {
        expect(Math.abs(leanFor(side, step / 100))).toBeLessThanOrEqual(LEAN + 1e-9);
      }
    }
  });

  it('carries a winning army toward the centre and a losing one back', () => {
    // Left stands at negative x, so toward the centre is positive for it.
    expect(leanFor(-1, 0.7)).toBeGreaterThan(0);
    expect(leanFor(-1, 0.3)).toBeLessThan(0);
    // And the mirror for the right.
    expect(leanFor(1, 0.3)).toBeLessThan(0);
    expect(leanFor(1, 0.7)).toBeGreaterThan(0);
  });

  it('keeps the front rank on its own side of the contested strip', () => {
    // The first rank stands at 40 and the strip reaches 38 either way. Leaning
    // the full distance must still leave the army off the ground the frontline
    // marker moves across.
    for (const side of SIDES) {
      for (const frontline of [0, 0.5, 1]) {
        const front = side * 40 + leanFor(side, frontline);
        expect(Math.abs(front)).toBeGreaterThan(38 - LEAN - 1e-9);
        expect(Math.sign(front)).toBe(side);
      }
    }
  });
});

describe('marching', () => {
  it('walks while advancing and moving, and holds once it has arrived', () => {
    // An advancing army that kept walking after the formation stopped would be
    // on a treadmill: legs cycling, feet going nowhere.
    expect(stanceFor('ADVANCING', true)).toBe('MARCHING');
    expect(stanceFor('ADVANCING', false)).toBe('HOLDING');
  });

  it('never marches while holding or assaulting, whatever the formation does', () => {
    for (const moving of [true, false]) {
      expect(stanceFor('HOLDING', moving)).toBe('HOLDING');
      expect(stanceFor('ASSAULTING', moving)).toBe('ASSAULTING');
    }
  });

  it('starts and stops at different speeds, so a slowing army does not flicker', () => {
    const between = (MARCH_START + MARCH_STOP) / 2;
    expect(marching(false, between)).toBe(false);
    expect(marching(true, between)).toBe(true);
    expect(marching(false, MARCH_START + 0.01)).toBe(true);
    expect(marching(true, MARCH_STOP - 0.01)).toBe(false);
    // Moving back counts as moving.
    expect(marching(false, -(MARCH_START + 0.01))).toBe(true);
  });
});

describe('choosing a clip', () => {
  it('takes the first preference the rig has', () => {
    expect(pickClip(['Idle', 'Walk'], ['Shoot_Big', 'Walk', 'Idle'])).toBe('Walk');
  });

  it('never chooses Death, even when it is the only thing asked for', () => {
    expect(pickClip(['Death', 'Idle'], ['Death'])).toBeUndefined();
    expect(pickClip(['Death'], ['Idle'])).toBeUndefined();
  });
});

/**
 * The clips in the files that actually ship.
 *
 * Read from the GLB's own JSON chunk rather than from a list kept beside it,
 * because the bug this exists to prevent was exactly a list that disagreed with
 * a file: the walker was asked for `Shoot_Big`, which its rig does not have, and
 * fell back to the first clip in the file. That was `Death`, and in every
 * contested battle the walker died on a loop.
 */
function clipsIn(url: string): readonly string[] {
  const path = fileURLToPath(new URL(`../../public${url}`, import.meta.url));
  const bytes = readFileSync(path);
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as {
    animations?: readonly { readonly name?: string }[];
  };
  return (json.animations ?? []).map((animation) => animation.name ?? '');
}

describe('every unit in every file', () => {
  const kinds = Object.keys(MODELS) as UnitKind[];

  for (const kind of kinds) {
    for (const url of MODELS[kind]) {
      it(`${url} has a clip for every stance, and none of them is Death`, () => {
        const available = clipsIn(url);
        for (const stance of STANCES) {
          const chosen = pickClip(available, CLIPS[kind][stance]);
          expect(chosen, `${kind} ${stance}`).toBeDefined();
          expect(chosen).not.toBe('Death');
        }
      });
    }
  }
});
