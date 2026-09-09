import { milliseconds } from '@ponswars/shared-types';
import type { NavigationConfig, ReshuffleTiming } from '@ponswars/world-runtime';
import { SECTOR_ORBIT_RADIUS, WORLD_BOUNDARY_RADIUS } from './layout.js';

/**
 * Feel tuning for direct camera navigation (§37.3, §37.4).
 *
 * `OPEN` production tuning, not a locked rule — §59.4 leaves the numbers that
 * only affect feel to be calibrated against the real world once art is in.
 * Every value here is derived from the layout rather than typed as a taste
 * judgement, so the world can be rescaled without the camera going wrong.
 */
export const NAVIGATION: NavigationConfig = {
  /**
   * Slightly inside the cinematic pose, which sits about 31 units from its
   * target. Zooming further than the closest scripted shot would put the camera
   * inside the geometry.
   */
  minViewDistance: 26,

  /**
   * Comfortably outside the sector ring but well within the soft boundary of
   * §38.8, so pulling all the way back still frames the whole world rather than
   * the empty void beyond it.
   */
  maxViewDistance: Math.min(SECTOR_ORBIT_RADIUS * 5, WORLD_BOUNDARY_RADIUS * 0.9),

  /** One wheel notch covers 18% of the remaining distance. */
  zoomStep: 0.18,

  /**
   * Drift halves every 220 ms, so a flick glides for roughly a second before it
   * falls under the floor. §37.5 asks for believable deceleration; a glide that
   * outlasts the gesture that caused it reads as the camera having a mind of its
   * own.
   */
  inertiaHalfLife: milliseconds(220),

  /**
   * Two world units per second. Below that the movement is invisible, and
   * leaving it running would keep the scene re-rendering forever.
   */
  minDriftSpeed: 0.002,
};

/**
 * How long each phase of a reshuffle takes (§15, §59.4).
 *
 * `CALIBRATE`: §15 fixes the order and names no durations. Roughly three and a
 * half seconds in total, which is short enough to sit inside the gap between a
 * round finalizing and the next opening, and long enough that a player watching
 * sees the world come apart rather than blink.
 *
 * Reduced motion gets its own set rather than a branch in the reducer (§83.3).
 * The sequence is the same sequence; it simply takes a fraction of the time,
 * which is what "reduced" means here — not "absent", because a world that
 * rearranged itself instantly would be a page reload with extra steps.
 */
export const RESHUFFLE: ReshuffleTiming = {
  teardownMs: 1_200,
  holdMs: 600,
  connectMs: 900,
  deployMs: 700,
};

export const RESHUFFLE_REDUCED: ReshuffleTiming = {
  teardownMs: 160,
  holdMs: 80,
  connectMs: 120,
  deployMs: 100,
};

/**
 * How wide the lens has to be for the world to fit the window (§37.4, §83).
 *
 * A perspective camera's field of view is vertical, so a fixed one narrows
 * *horizontally* as the window gets taller than it is wide. At 45° on a
 * 375×812 phone the horizontal field is under 22°, and the ring of five
 * sectors — over 1 000 units across — did not come close to fitting: the
 * global view on a phone was the Market Core and two of the five islands.
 *
 * `HORIZONTAL_FOV` is what the lens tries to keep across the frame whatever
 * the shape of the window. The bounds are the honest part of it: a portrait
 * phone cannot have both a comfortable lens and the whole ring, and past about
 * 78° the distortion at the edges costs more than the sectors it recovers.
 *
 * `CALIBRATE` (§59.4).
 */
export const VIEWPORT_FIT = {
  horizontalFov: 58,
  minFov: 45,
  maxFov: 78,
} as const;
