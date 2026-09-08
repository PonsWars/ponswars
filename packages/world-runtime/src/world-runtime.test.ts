import type { DurationMs, UtcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  advance,
  CAMERA_MODES,
  flyTo,
  focusMyWar,
  initialCamera,
  isMoving,
  progressOf,
  resetView,
  viewDistance,
  zoomLevelForMode,
  type CameraConfig,
  type CameraPose,
} from './camera.js';
import {
  DETAIL_LEVELS,
  hudBudgetFor,
  mayRenderExactScore,
  scaledThresholds,
  selectDetail,
  type LodThresholds,
} from './lod.js';
import { applySoftBoundary, distance, lerp, smoothstep, vec3, type Vec3 } from './vector.js';

const T0 = 1_800_000_000_000 as UtcTimestamp;
const at = (offset: number): UtcTimestamp => (T0 + offset) as UtcTimestamp;
const ms = (value: number): DurationMs => value as DurationMs;

const GLOBAL: CameraPose = { position: vec3(0, 800, 800), target: vec3(0, 0, 0) };
const SECTOR: CameraPose = { position: vec3(200, 180, 260), target: vec3(200, 0, 200) };
const BATTLE: CameraPose = { position: vec3(200, 60, 220), target: vec3(200, 0, 200) };

const CONFIG: CameraConfig = {
  globalAnchor: GLOBAL,
  boundaryRadius: 2_000,
  durations: {
    panelTransition: ms(200),
    spatialTransition: ms(1_200),
    cinematic: ms(2_500),
  },
  reducedMotion: false,
};

const THRESHOLDS: LodThresholds = { full: 300, reduced: 800, silhouette: 2_000 };

/**
 * Steps a transition to completion, frame by frame.
 *
 * The final step lands exactly on `from + duration`. Stepping by 16ms alone
 * stops short of a 1000ms transition at 992, so the flight would never
 * complete - a property of the harness rather than of the camera.
 */
const runToEnd = (
  start: ReturnType<typeof initialCamera>,
  from: number,
  duration: number,
  config = CONFIG,
) => {
  let state = start;
  for (let t = from; t < from + duration; t += 16) {
    state = advance(state, at(t), config);
  }
  return advance(state, at(from + duration), config);
};

describe('vector maths', () => {
  it('eases with zero velocity at both ends', () => {
    // §37.5: believable acceleration and deceleration, no snapping.
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBe(0.5);
    // Motion near the ends is much slower than in the middle.
    expect(smoothstep(0.05)).toBeLessThan(0.05);
    expect(smoothstep(0.95)).toBeGreaterThan(0.95);
  });

  it('clamps easing outside the unit interval', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });

  it('interpolates positions', () => {
    expect(lerp(vec3(0, 0, 0), vec3(10, 20, 30), 0.5)).toEqual(vec3(5, 10, 15));
  });
});

describe('soft world boundary', () => {
  it('leaves an inside position untouched', () => {
    // §38.8: the boundary is felt, not collided with.
    const inside = vec3(100, 0, 0);
    expect(applySoftBoundary(inside, 2_000)).toEqual(inside);
  });

  it('resists rather than blocking', () => {
    // §81.4: damping and resistance rather than an abrupt invisible wall. The
    // camera still moves outward, just far less than asked.
    const outside = vec3(4_000, 0, 0);
    const constrained = applySoftBoundary(outside, 2_000, 0.25);

    expect(distance(constrained, vec3(0, 0, 0))).toBeGreaterThan(2_000);
    expect(distance(constrained, vec3(0, 0, 0))).toBeLessThan(4_000);
  });

  it('keeps pushing outward monotonic', () => {
    // Pushing further must still go further, or the boundary reads as a bug.
    let previous = 0;
    for (const x of [2_500, 3_000, 5_000, 20_000]) {
      const range = distance(applySoftBoundary(vec3(x, 0, 0), 2_000), vec3(0, 0, 0));
      expect(range).toBeGreaterThan(previous);
      previous = range;
    }
  });

  it('rejects a nonsensical boundary', () => {
    expect(() => applySoftBoundary(vec3(0, 0, 0), 0)).toThrow(RangeError);
    expect(() => applySoftBoundary(vec3(0, 0, 0), 100, 0)).toThrow(RangeError);
    expect(() => applySoftBoundary(vec3(0, 0, 0), 100, 2)).toThrow(RangeError);
  });
});

describe('camera modes and zoom', () => {
  it('maps each mode to its spatial level', () => {
    // §37.2's four states.
    expect(zoomLevelForMode('GLOBAL_FREE')).toBe(1);
    expect(zoomLevelForMode('GLOBAL_FOCUS')).toBe(1);
    expect(zoomLevelForMode('SECTOR_FOCUS')).toBe(2);
    expect(zoomLevelForMode('BATTLE_TACTICAL')).toBe(3);
    expect(zoomLevelForMode('CINEMATIC_TEMP')).toBe(4);
  });

  it('gives every declared mode a level', () => {
    for (const mode of CAMERA_MODES) {
      expect([1, 2, 3, 4]).toContain(zoomLevelForMode(mode));
    }
  });

  it('starts at the global anchor', () => {
    const state = initialCamera(CONFIG);
    expect(state.pose).toEqual(GLOBAL);
    expect(state.mode).toBe('GLOBAL_FREE');
    expect(isMoving(state)).toBe(false);
  });
});

describe('fly-to', () => {
  it('travels the whole way and adopts the destination mode', () => {
    const start = flyTo(
      initialCamera(CONFIG),
      { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(0), duration: ms(1_000) },
      CONFIG,
    );
    expect(isMoving(start)).toBe(true);

    const finished = runToEnd(start, 0, 1_000);
    expect(finished.pose).toEqual(SECTOR);
    expect(finished.mode).toBe('SECTOR_FOCUS');
    expect(isMoving(finished)).toBe(false);
  });

  it('moves monotonically toward the destination', () => {
    // §114.3: predictable behaviour. A camera that overshoots or backtracks
    // mid-flight would break orientation, which §37.5 lists as the thing a
    // transition must preserve.
    let state = flyTo(
      initialCamera(CONFIG),
      { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(0), duration: ms(1_000) },
      CONFIG,
    );

    let previous = Number.POSITIVE_INFINITY;
    for (let t = 0; t <= 1_000; t += 50) {
      state = advance(state, at(t), CONFIG);
      const remaining = distance(state.pose.position, SECTOR.position);
      expect(remaining).toBeLessThanOrEqual(previous + 1e-9);
      previous = remaining;
    }
  });

  it('lands identically whatever the frame rate', () => {
    // Absolute time, not deltas: a dropped frame jumps further along the same
    // curve rather than leaving the camera short.
    const start = flyTo(
      initialCamera(CONFIG),
      { to: BATTLE, mode: 'BATTLE_TACTICAL', at: at(0), duration: ms(1_000) },
      CONFIG,
    );

    const smooth = runToEnd(start, 0, 1_000);
    const stuttering = advance(advance(start, at(700), CONFIG), at(1_000), CONFIG);

    expect(stuttering.pose).toEqual(smooth.pose);
    expect(stuttering.mode).toBe(smooth.mode);
  });

  it('reports progress across the flight', () => {
    const state = flyTo(
      initialCamera(CONFIG),
      { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(0), duration: ms(1_000) },
      CONFIG,
    );
    expect(progressOf(state, at(0))).toBe(0);
    expect(progressOf(state, at(500))).toBeCloseTo(0.5, 6);
    expect(progressOf(state, at(2_000))).toBe(1);
  });

  it('rejects a non-positive duration', () => {
    expect(() =>
      flyTo(
        initialCamera(CONFIG),
        { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(0), duration: ms(0) },
        CONFIG,
      ),
    ).toThrow(RangeError);
  });
});

describe('interruptibility', () => {
  it('lets a routine flight be redirected', () => {
    // §114.4: routine fly-to is interruptible by another battle selection.
    let state = flyTo(
      initialCamera(CONFIG),
      { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(0), duration: ms(2_000) },
      CONFIG,
    );
    state = advance(state, at(500), CONFIG);
    state = flyTo(
      state,
      { to: BATTLE, mode: 'BATTLE_TACTICAL', at: at(500), duration: ms(1_000) },
      CONFIG,
    );

    const finished = runToEnd(state, 500, 1_000);
    expect(finished.pose).toEqual(BATTLE);
    expect(finished.mode).toBe('BATTLE_TACTICAL');
  });

  it('refuses to let a stray click cut a cinematic short', () => {
    // §81.3 allows a cinematic to reduce control briefly. If any click could
    // end one, the moment it exists for would be unreliable.
    let state = flyTo(
      initialCamera(CONFIG),
      {
        to: BATTLE,
        mode: 'CINEMATIC_TEMP',
        at: at(0),
        duration: ms(2_000),
        interruptible: false,
      },
      CONFIG,
    );
    const before = state;
    state = flyTo(
      state,
      { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(100), duration: ms(500) },
      CONFIG,
    );
    expect(state).toBe(before);
  });

  it('returns control automatically when a cinematic ends', () => {
    // §37.2: level four is temporary and must return to a readable tactical
    // view. Queuing the return here rather than leaving it to a caller is what
    // stops a player being stranded in a close-up.
    let state = flyTo(
      initialCamera(CONFIG),
      {
        to: BATTLE,
        mode: 'CINEMATIC_TEMP',
        at: at(0),
        duration: ms(500),
        interruptible: false,
        restoreTo: SECTOR,
        restoreMode: 'SECTOR_FOCUS',
      },
      CONFIG,
    );

    state = advance(state, at(500), CONFIG);
    expect(state.transition?.interruptible).toBe(true);

    const restored = runToEnd(state, 500, CONFIG.durations.spatialTransition);
    expect(restored.pose).toEqual(SECTOR);
    expect(restored.mode).toBe('SECTOR_FOCUS');
  });

  it('always releases for Reset View', () => {
    // §37.7: RESET VIEW always returns to a known global anchor. Always - it is
    // the control a lost player reaches for, and a rail that refuses to release
    // them is the failure the section exists to prevent.
    let state = flyTo(
      initialCamera(CONFIG),
      {
        to: BATTLE,
        mode: 'CINEMATIC_TEMP',
        at: at(0),
        duration: ms(5_000),
        interruptible: false,
        battleId: 'b1',
      },
      CONFIG,
    );
    state = resetView(state, at(100), CONFIG);

    const finished = runToEnd(state, 100, CONFIG.durations.spatialTransition);
    expect(finished.pose).toEqual(GLOBAL);
    expect(finished.mode).toBe('GLOBAL_FREE');
    expect(finished.focusedBattleId).toBeNull();
  });

  it('always releases for Focus My War', () => {
    let state = flyTo(
      initialCamera(CONFIG),
      { to: GLOBAL, mode: 'CINEMATIC_TEMP', at: at(0), duration: ms(5_000), interruptible: false },
      CONFIG,
    );
    state = focusMyWar(state, 'round-1-b2', SECTOR, at(100), CONFIG);

    const finished = runToEnd(state, 100, CONFIG.durations.spatialTransition);
    expect(finished.pose).toEqual(SECTOR);
    expect(finished.focusedBattleId).toBe('round-1-b2');
  });
});

describe('reduced motion', () => {
  const reduced: CameraConfig = { ...CONFIG, reducedMotion: true };

  it('arrives immediately but still arrives', () => {
    // §83.3: Reduced Motion shortens or disables long fly-throughs, and
    // gameplay information must remain complete. The camera reaches the same
    // place; it simply does not travel there.
    const state = flyTo(
      initialCamera(reduced),
      { to: BATTLE, mode: 'BATTLE_TACTICAL', at: at(0), duration: ms(2_000), battleId: 'b1' },
      reduced,
    );

    expect(state.pose).toEqual(BATTLE);
    expect(state.mode).toBe('BATTLE_TACTICAL');
    expect(state.focusedBattleId).toBe('b1');
    expect(isMoving(state)).toBe(false);
  });

  it('still honours Reset View', () => {
    const state = resetView(initialCamera(reduced), at(0), reduced);
    expect(state.pose).toEqual(GLOBAL);
  });
});

describe('level of detail', () => {
  const camera = (position: Vec3): CameraPose => ({ position, target: vec3(0, 0, 0) });

  it('grades by distance', () => {
    // §37.10: distant sectors use simplified silhouettes, focused sectors full
    // detail.
    const sector = vec3(0, 0, 0);
    const grade = (range: number) =>
      selectDetail({
        camera: camera(vec3(range, 0, 0)),
        sectorPosition: sector,
        isFocused: false,
        thresholds: THRESHOLDS,
        tier: 'BALANCED',
      });

    expect(grade(100)).toBe('FULL');
    expect(grade(500)).toBe('REDUCED');
    expect(grade(1_500)).toBe('SILHOUETTE');
    expect(grade(5_000)).toBe('CULLED');
  });

  it('keeps the focused sector at full detail regardless of distance', () => {
    // §36.15 puts the player's chosen war among the things that must stay
    // readable at any moment. It must not degrade because they flew out a
    // little.
    expect(
      selectDetail({
        camera: camera(vec3(50_000, 0, 0)),
        sectorPosition: vec3(0, 0, 0),
        isFocused: true,
        thresholds: THRESHOLDS,
        tier: 'PERFORMANCE',
      }),
    ).toBe('FULL');
  });

  it('pulls thresholds inward on a weaker tier', () => {
    // §82.1: a lower tier draws less rather than drawing the same thing badly.
    const performance = scaledThresholds(THRESHOLDS, 'PERFORMANCE');
    const ultra = scaledThresholds(THRESHOLDS, 'ULTRA');

    expect(performance.full).toBeLessThan(THRESHOLDS.full);
    expect(ultra.full).toBeGreaterThan(THRESHOLDS.full);
  });

  it('does not reduce draw distance for reduced motion', () => {
    // Reduced Motion is about movement, not fidelity. §83.3 requires gameplay
    // information to stay complete, and hiding sectors would remove it.
    expect(scaledThresholds(THRESHOLDS, 'REDUCED_MOTION')).toEqual(
      scaledThresholds(THRESHOLDS, 'BALANCED'),
    );
  });

  it('returns only declared levels', () => {
    for (const range of [0, 10, 400, 900, 3_000, 100_000]) {
      expect(DETAIL_LEVELS).toContain(
        selectDetail({
          camera: camera(vec3(range, 0, 0)),
          sectorPosition: vec3(0, 0, 0),
          isFocused: false,
          thresholds: THRESHOLDS,
          tier: 'BALANCED',
        }),
      );
    }
  });

  it('rejects disordered thresholds', () => {
    expect(() =>
      selectDetail({
        camera: camera(vec3(0, 0, 0)),
        sectorPosition: vec3(0, 0, 0),
        isFocused: false,
        thresholds: { full: 800, reduced: 300, silhouette: 2_000 },
        tier: 'BALANCED',
      }),
    ).toThrow(RangeError);
  });
});

describe('HUD budget by zoom', () => {
  it('keeps the global view minimal', () => {
    // §42.2: round state, countdown, wallet summary, compact switcher. No
    // permanent large sidebars.
    const budget = hudBudgetFor(1);
    expect(budget.roundState).toBe(true);
    expect(budget.countdown).toBe(true);
    expect(budget.pickControls).toBe(false);
    expect(budget.warMomentum).toBe(false);
  });

  it('offers pick controls only at the sector', () => {
    // §37.6: information density follows zoom.
    expect(hudBudgetFor(2).pickControls).toBe(true);
    expect(hudBudgetFor(1).pickControls).toBe(false);
    expect(hudBudgetFor(3).pickControls).toBe(false);
  });

  it('shows momentum only on the battlefield', () => {
    expect(hudBudgetFor(3).warMomentum).toBe(true);
    expect(hudBudgetFor(2).warMomentum).toBe(false);
  });

  it('fades everything for a cinematic', () => {
    // §37.6 and §42.7: most HUD fades to prioritise the event.
    const budget = hudBudgetFor(4);
    expect(Object.values(budget).every((shown) => !shown)).toBe(true);
  });

  it('never permits the exact score at any zoom', () => {
    // The answer does not depend on zoom. §24 and §48.3 hide it for the whole
    // live battle; it is revealed on the result screen, not by flying closer.
    expect(mayRenderExactScore()).toBe(false);
  });
});

describe('view distance', () => {
  it('measures camera to target', () => {
    expect(viewDistance({ position: vec3(0, 3, 4), target: vec3(0, 0, 0) })).toBe(5);
  });
});
