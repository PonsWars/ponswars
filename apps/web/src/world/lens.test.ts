import { CAMERA_MODES } from '@ponswars/world-runtime';
import { describe, expect, it } from 'vitest';
import { easeLens, FINAL_PUSH_TIGHTEN, fittedFov, LENS_HALF_LIFE_MS, lensTighten } from './lens.js';
import { VIEWPORT_FIT } from './navigation-config.js';

/**
 * The lens the world is seen through (§36.2, §37.4).
 */

describe('fitting the lens to the window (§37.4)', () => {
  it('keeps a wide window at the comfortable floor', () => {
    expect(fittedFov(16 / 9)).toBe(VIEWPORT_FIT.minFov);
  });

  it('widens for a window taller than it is wide, up to the ceiling', () => {
    expect(fittedFov(375 / 812)).toBeGreaterThan(VIEWPORT_FIT.minFov);
    expect(fittedFov(0.1)).toBe(VIEWPORT_FIT.maxFov);
  });

  it('survives a window with no size yet', () => {
    expect(Number.isFinite(fittedFov(0))).toBe(true);
    expect(Number.isFinite(fittedFov(Number.NaN))).toBe(true);
  });
});

describe('closing in for the final push (§36.2)', () => {
  it('closes in while a battle is being watched', () => {
    expect(lensTighten(true, 'BATTLE_TACTICAL', false)).toBe(FINAL_PUSH_TIGHTEN);
    expect(lensTighten(true, 'SECTOR_FOCUS', false)).toBe(FINAL_PUSH_TIGHTEN);
  });

  it('leaves the lens alone outside the final push', () => {
    for (const mode of CAMERA_MODES) {
      expect(lensTighten(false, mode, false)).toBe(1);
    }
  });

  it('never crops the global view, the cinematic or a page', () => {
    for (const mode of [
      'GLOBAL_FREE',
      'GLOBAL_FOCUS',
      'RESETTING',
      'CINEMATIC_TEMP',
      'PROFILE_PRESENTATION',
    ] as const) {
      expect(lensTighten(true, mode, false)).toBe(1);
    }
  });

  it('stays still under reduced motion (§83.3)', () => {
    for (const mode of CAMERA_MODES) {
      expect(lensTighten(true, mode, true)).toBe(1);
    }
  });

  it('leans in, never cuts in (§36.2: comfort)', () => {
    expect(FINAL_PUSH_TIGHTEN).toBeGreaterThanOrEqual(0.85);
    expect(FINAL_PUSH_TIGHTEN).toBeLessThan(1);
  });
});

describe('easing the lens', () => {
  it('covers half the way in one half-life', () => {
    expect(easeLens(1, 0.9, LENS_HALF_LIFE_MS)).toBeCloseTo(0.95, 6);
  });

  it('takes the same path however the frames fall', () => {
    let stepped = 1;
    for (let frame = 0; frame < 30; frame += 1) {
      stepped = easeLens(stepped, 0.9, 1000 / 60);
    }
    expect(stepped).toBeCloseTo(easeLens(1, 0.9, 500), 6);
  });

  it('settles exactly, so a still lens stops re-projecting', () => {
    expect(easeLens(0.90005, 0.9, 16)).toBe(0.9);
  });

  it('holds still on a frame with no time in it', () => {
    expect(easeLens(0.95, 0.9, 0)).toBe(0.95);
    expect(easeLens(0.95, 0.9, Number.NaN)).toBe(0.95);
  });
});
