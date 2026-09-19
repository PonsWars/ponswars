import type { CameraMode } from '@ponswars/world-runtime';
import { VIEWPORT_FIT } from './navigation-config.js';

/**
 * The lens the world is seen through: how wide it is for the window, and how
 * much it closes in for the last thirty seconds of a round (§36.2, §37.4).
 *
 * Pure, so the framing rules can be tested without a canvas.
 */

/**
 * The vertical field of view that keeps `VIEWPORT_FIT.horizontalFov` across a
 * window of this shape, inside the comfortable bounds (§37.4).
 */
export function fittedFov(aspect: number): number {
  const safe = Number.isFinite(aspect) ? Math.max(aspect, 0.05) : 1;
  const wanted =
    (2 * Math.atan(Math.tan((VIEWPORT_FIT.horizontalFov * Math.PI) / 360) / safe) * 180) / Math.PI;
  return Math.min(Math.max(wanted, VIEWPORT_FIT.minFov), VIEWPORT_FIT.maxFov);
}

/**
 * How far the lens closes in during the Final Push. `CALIBRATE` (§59.4).
 *
 * §36.2: the camera *may move closer for ... Final Push — never at the cost of
 * readability or comfort.* A tenth off the field of view is a push-in a player
 * feels rather than a cut they notice, and it keeps both districts and the
 * whole contested strip in frame from the battlefield pose — checked on the
 * running world, not assumed.
 *
 * A narrower lens rather than a camera moved along its axis, on purpose: the
 * pose belongs to the camera reducer, which pans, zooms, flies and restores it,
 * and a second hand on the same pose is how a fly-to ends somewhere it was
 * never sent. The lens is only the renderer's, so the tighten can come and go
 * without the reducer ever knowing — Reset View, Focus My War and `ESC` behave
 * exactly as they do the rest of the round.
 */
export const FINAL_PUSH_TIGHTEN = 0.9;

/**
 * How quickly the lens settles on a new framing: half the remaining way every
 * this many milliseconds. Slow enough to read as the camera leaning in, well
 * under the thirty seconds it has to do it in.
 */
export const LENS_HALF_LIFE_MS = 450;

/**
 * The levels at which a player is watching a battle rather than the world
 * (§37.2). Closing in on the global view would crop the ring of sectors, which
 * is the one thing that view exists to show; the cinematic is already as close
 * as the camera goes, and the presentation pose frames a page, not a war.
 */
const WATCHING: ReadonlySet<CameraMode> = new Set<CameraMode>(['SECTOR_FOCUS', 'BATTLE_TACTICAL']);

/**
 * The share of the fitted field of view the lens should be at.
 *
 * `1` except in the Final Push, at a level where a battle is being watched.
 * Never under reduced motion: §83.3 takes out camera moves that exist for
 * drama, and nothing is lost by it — the HUD says `FINAL PUSH` in words and
 * the world says it in light (§38.6).
 */
export function lensTighten(pushing: boolean, mode: CameraMode, reducedMotion: boolean): number {
  return pushing && !reducedMotion && WATCHING.has(mode) ? FINAL_PUSH_TIGHTEN : 1;
}

/**
 * One frame's step of the lens toward where it should be.
 *
 * Exponential, and by elapsed time rather than per frame, so a slow device
 * leans in over the same half-second a fast one does. Snaps the last sliver,
 * so a settled lens stops asking for a new projection every frame.
 */
export function easeLens(current: number, target: number, deltaMs: number): number {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return current;
  }
  const next = target + (current - target) * 0.5 ** (deltaMs / LENS_HALF_LIFE_MS);
  return Math.abs(next - target) < 1e-4 ? target : next;
}
