import type { MomentumState } from '@ponswars/shared-types';

/**
 * What an army does, as data and pure functions (§13, §36.2, §48.3).
 *
 * Kept apart from `Army.tsx` so it can be tested without a renderer, and so the
 * one rule that matters most here — an army never says anything the frontline
 * marker does not already say — lives somewhere it can be read in one sitting.
 *
 * Every input is something the public stream already carries: a qualitative
 * momentum state and a normalized frontline. There is no score here and there
 * cannot be — `ClientBattle` has no score field, and §24 keeps the exact figure
 * off the wire for the whole live battle.
 */

/** Where each kind of unit is served from. Built by `tools/build-models.mjs`. */
export const MODELS = {
  trooper: [
    '/models/units/trooper-a.glb',
    '/models/units/trooper-b.glb',
    '/models/units/trooper-c.glb',
  ],
  mech: [
    '/models/units/mech-a.glb',
    '/models/units/mech-b.glb',
    '/models/units/mech-c.glb',
    '/models/units/mech-d.glb',
  ],
  walker: ['/models/units/walker-large.glb'],
  drone: ['/models/units/drone-flying.glb'],
} as const;

export type UnitKind = keyof typeof MODELS;

/**
 * What an army is doing, from the two things the public stream carries.
 *
 * - `CONTESTED` is a fight neither side is winning. Both assault.
 * - Any other state has a side with the advantage — the frontline says which —
 *   and that side advances while the other holds under fire.
 *
 * `COMEBACK` needs no special case. §13 describes it as a reversal, and the
 * frontline is already where the reversal has got to; the side it now favours
 * is the side advancing, which is exactly what a comeback looks like.
 */
export type Posture = 'HOLDING' | 'ADVANCING' | 'ASSAULTING';

export function postureFor(side: -1 | 1, momentum: MomentumState, frontline: number): Posture {
  if (momentum === 'CONTESTED') {
    return 'ASSAULTING';
  }
  return advantageOf(side, frontline) > 0 ? 'ADVANCING' : 'HOLDING';
}

/**
 * How much of the field a side holds beyond an even split, in `[-0.5, 0.5]`.
 *
 * `frontline` is the share held by the LEFT faction, which is `side: -1`.
 */
function advantageOf(side: -1 | 1, frontline: number): number {
  return side === -1 ? frontline - 0.5 : 0.5 - frontline;
}

/**
 * How far an army leans into a push, at most, in world units.
 *
 * Small on purpose. The frontline marker is the readout; this is body language,
 * and an army that walked as far as the line would be a second, competing
 * answer to the question §36.15 says a player must be able to settle instantly.
 */
export const LEAN = 9;

/**
 * Where a side's formation stands relative to its home ranks, along x.
 *
 * Toward the centre when the side is winning ground and back when it is giving
 * it up. One function, used by the formation *and* by the fire it throws, so a
 * round can never leave from anywhere but the front of the army that fired it.
 */
export function leanFor(side: -1 | 1, frontline: number): number {
  return -side * advantageOf(side, frontline) * 2 * LEAN;
}

/**
 * What a unit's body is actually doing, which is not the same as its posture.
 *
 * `ADVANCING` is a claim about the battle; walking is a claim about the ground.
 * A formation only moves while the line is moving — once it has leaned as far as
 * the frontline asks, it stops — and a unit that kept walking after that is on a
 * treadmill: legs cycling, feet going nowhere, which reads as a bug at any
 * distance. So an advancing army marches while it is actually moving and holds
 * once it has arrived.
 */
export type Stance = 'HOLDING' | 'MARCHING' | 'ASSAULTING';

export function stanceFor(posture: Posture, moving: boolean): Stance {
  switch (posture) {
    case 'ADVANCING':
      return moving ? 'MARCHING' : 'HOLDING';
    case 'HOLDING':
    case 'ASSAULTING':
      return posture;
  }
}

/**
 * The speeds, in world units per second, at which a formation starts and stops
 * counting as moving.
 *
 * Two thresholds rather than one. The formation eases toward its target, so its
 * speed decays smoothly through any single threshold — and every frame spent
 * hovering across it would flick the whole army between a walk and a stand.
 */
export const MARCH_START = 0.6;
export const MARCH_STOP = 0.25;

export function marching(wasMarching: boolean, speed: number): boolean {
  const magnitude = Math.abs(speed);
  return wasMarching ? magnitude > MARCH_STOP : magnitude > MARCH_START;
}

/**
 * The clips each kind of unit plays for a stance, in order of preference.
 *
 * Lists rather than single names, and each rig is asked only for clips it has:
 * the walker has no firing clip and the drone no walk, and the first version of
 * this table gave the walker the mech's `Shoot_Big` — which it does not have —
 * and fell back to whatever the file listed first. That was `Death`. In every
 * contested battle the walker died on a loop.
 *
 * Nobody is asked to fire in place who cannot: the troopers' rigs have no
 * standing shot, only a running one, and a trooper running on the spot is a
 * treadmill again. They hold with their weapons up while the tracers — which
 * leave from the front of the army — do the firing.
 *
 * `army-rules.test.ts` checks every entry against the clips in the built files.
 */
export const CLIPS: Readonly<Record<UnitKind, Readonly<Record<Stance, readonly string[]>>>> = {
  trooper: {
    HOLDING: ['Idle_Gun', 'Idle'],
    MARCHING: ['Walk_Gun', 'Walk'],
    ASSAULTING: ['Idle_Gun', 'Idle'],
  },
  mech: {
    HOLDING: ['Idle'],
    MARCHING: ['Walk'],
    ASSAULTING: ['Shoot_Big', 'Shoot_Small', 'Idle'],
  },
  walker: {
    HOLDING: ['Idle'],
    MARCHING: ['Walk'],
    ASSAULTING: ['Idle'],
  },
  drone: {
    HOLDING: ['Flying_Idle'],
    MARCHING: ['Fast_Flying', 'Flying_Idle'],
    ASSAULTING: ['Fast_Flying', 'Flying_Idle'],
  },
};

/**
 * The clip a unit should play, from the clips its file actually contains.
 *
 * The first preference present, and never `Death`, whatever is asked. `undefined`
 * when nothing matches, which the caller reads as "keep playing what you are
 * playing" — a unit frozen mid-stride is a smaller failure than a unit dying.
 */
export function pickClip(
  available: readonly string[],
  wanted: readonly string[],
): string | undefined {
  return wanted.find((name) => name !== 'Death' && available.includes(name));
}
