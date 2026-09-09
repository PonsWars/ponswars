import { milliseconds, utcTimestamp, type UtcTimestamp } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_MODES,
  flyTo,
  initialCamera,
  type CameraConfig,
  type CameraMode,
  type CameraPose,
  type CameraState,
} from './camera.js';
import {
  applyDrift,
  beginPan,
  currentViewDistance,
  endPan,
  IDLE_NAVIGATION,
  outwardMode,
  panTo,
  pinchTo,
  screenBasis,
  intendedMode,
  stepOutward,
  worldUnitsPerPixel,
  zoomBy,
  zoomByNotches,
  type NavigationConfig,
} from './navigation.js';
import { distance, length, subtract, vec3 } from './vector.js';

const T0 = utcTimestamp(1_800_000_000_000);
const at = (offset: number): UtcTimestamp => utcTimestamp(T0 + offset);

const GLOBAL: CameraPose = { position: vec3(0, 800, 800), target: vec3(0, 0, 0) };
const SECTOR: CameraPose = { position: vec3(200, 180, 260), target: vec3(200, 0, 200) };
const BATTLE: CameraPose = { position: vec3(200, 60, 220), target: vec3(200, 0, 200) };

const CAMERA: CameraConfig = {
  globalAnchor: GLOBAL,
  boundaryRadius: 2_000,
  durations: {
    panelTransition: milliseconds(200),
    spatialTransition: milliseconds(1_200),
    cinematic: milliseconds(2_400),
  },
  reducedMotion: false,
};

const REDUCED: CameraConfig = { ...CAMERA, reducedMotion: true };

const NAV: NavigationConfig = {
  minViewDistance: 40,
  maxViewDistance: 4_000,
  zoomStep: 0.15,
  inertiaHalfLife: milliseconds(180),
  minDriftSpeed: 0.001,
};

const POSES: Readonly<Record<CameraMode, CameraPose>> = {
  GLOBAL_FREE: GLOBAL,
  GLOBAL_FOCUS: GLOBAL,
  SECTOR_FOCUS: SECTOR,
  BATTLE_TACTICAL: BATTLE,
  CINEMATIC_TEMP: BATTLE,
  PROFILE_PRESENTATION: GLOBAL,
  RESETTING: GLOBAL,
};

const poseFor = (mode: CameraMode): CameraPose => POSES[mode];

function still(pose: CameraPose, mode: CameraMode = 'GLOBAL_FREE'): CameraState {
  return { pose, mode, transition: null, focusedBattleId: null };
}

describe('worldUnitsPerPixel', () => {
  it('scales with view distance so a drag tracks the pointer at any zoom', () => {
    const near = worldUnitsPerPixel(100, Math.PI / 4, 800);
    const far = worldUnitsPerPixel(400, Math.PI / 4, 800);
    expect(far / near).toBeCloseTo(4, 12);
  });

  it('shrinks as the viewport grows, because a pixel covers less of the frustum', () => {
    expect(worldUnitsPerPixel(100, Math.PI / 4, 1_600)).toBeCloseTo(
      worldUnitsPerPixel(100, Math.PI / 4, 800) / 2,
      12,
    );
  });

  it('refuses a viewport or field of view that cannot describe a projection', () => {
    expect(() => worldUnitsPerPixel(100, Math.PI / 4, 0)).toThrow(RangeError);
    expect(() => worldUnitsPerPixel(100, 0, 800)).toThrow(RangeError);
    expect(() => worldUnitsPerPixel(100, Math.PI, 800)).toThrow(RangeError);
  });
});

describe('screenBasis', () => {
  it('gives an orthonormal right and up pair', () => {
    const { right, up } = screenBasis(vec3(0, 400, 400), vec3(0, 0, 0));
    expect(length(right)).toBeCloseTo(1, 12);
    expect(length(up)).toBeCloseTo(1, 12);
    expect(right.x * up.x + right.y * up.y + right.z * up.z).toBeCloseTo(0, 12);
  });

  it('stays defined when the camera looks straight down', () => {
    // The global view of §37.2 is very nearly a top-down shot. `forward` is then
    // parallel to world up and their cross product collapses to zero, which
    // would freeze dragging at exactly the angle players start from.
    const { right, up } = screenBasis(vec3(0, 900, 0), vec3(0, 0, 0));
    expect(length(right)).toBeCloseTo(1, 12);
    expect(length(up)).toBeCloseTo(1, 12);
  });
});

describe('pan', () => {
  it('moves position and target together, so the camera slides without re-aiming', () => {
    const start = still(GLOBAL);
    const begun = beginPan(start, IDLE_NAVIGATION, { x: 100, y: 100, at: at(0) });
    const moved = panTo(begun.camera, begun.navigation, { x: 140, y: 100, at: at(16) }, 1, CAMERA);

    const positionDelta = subtract(moved.camera.pose.position, GLOBAL.position);
    const targetDelta = subtract(moved.camera.pose.target, GLOBAL.target);
    expect(positionDelta).toEqual(targetDelta);
    expect(length(positionDelta)).toBeCloseTo(40, 9);
  });

  it('drags the world with the pointer rather than against it', () => {
    // Looking down the −z axis from +z, screen right is −x. Dragging right must
    // move the camera the other way so the grabbed point stays under the finger.
    const start = still({ position: vec3(0, 0, 500), target: vec3(0, 0, 0) });
    const begun = beginPan(start, IDLE_NAVIGATION, { x: 0, y: 0, at: at(0) });
    const moved = panTo(begun.camera, begun.navigation, { x: 10, y: 0, at: at(16) }, 1, CAMERA);
    expect(moved.camera.pose.position.x).toBeLessThan(0);
  });

  it('ignores a sample when no drag is active', () => {
    const start = still(GLOBAL);
    const result = panTo(start, IDLE_NAVIGATION, { x: 10, y: 10, at: at(16) }, 1, CAMERA);
    expect(result.camera).toBe(start);
    expect(result.navigation).toBe(IDLE_NAVIGATION);
  });

  it('cancels an interruptible fly-to, because direct input takes over (§114.4)', () => {
    const flying = flyTo(
      still(GLOBAL),
      { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(0), duration: CAMERA.durations.spatialTransition },
      CAMERA,
    );
    expect(flying.transition).not.toBeNull();

    const begun = beginPan(flying, IDLE_NAVIGATION, { x: 0, y: 0, at: at(100) });
    expect(begun.camera.transition).toBeNull();
    expect(begun.navigation.drag).not.toBeNull();
  });

  it('refuses to interrupt a cinematic, which briefly owns control (§81.3)', () => {
    const cinematic = flyTo(
      still(BATTLE, 'BATTLE_TACTICAL'),
      {
        to: BATTLE,
        mode: 'CINEMATIC_TEMP',
        at: at(0),
        duration: CAMERA.durations.cinematic,
        interruptible: false,
      },
      CAMERA,
    );

    const begun = beginPan(cinematic, IDLE_NAVIGATION, { x: 0, y: 0, at: at(100) });
    expect(begun.camera).toBe(cinematic);
    expect(begun.navigation).toBe(IDLE_NAVIGATION);
  });
});

describe('inertia', () => {
  it('glides on after release and decays by half every half-life', () => {
    const begun = beginPan(still(GLOBAL), IDLE_NAVIGATION, { x: 0, y: 0, at: at(0) });
    // 180 px over 90 ms is 2 world units per millisecond at a 1:1 pixel scale.
    const dragged = panTo(begun.camera, begun.navigation, { x: 180, y: 0, at: at(90) }, 1, CAMERA);
    const released = endPan(dragged.navigation, at(90), CAMERA);
    expect(length(released.drift)).toBeCloseTo(2, 9);

    const after = applyDrift(dragged.camera, released, at(90 + 180), CAMERA, NAV);
    expect(length(after.navigation.drift)).toBeCloseTo(1, 9);

    // Displacement over one half-life is v₀·H·(1 − ½)/ln 2.
    const travelled = distance(after.camera.pose.position, dragged.camera.pose.position);
    expect(travelled).toBeCloseTo((2 * 180 * 0.5) / Math.LN2, 6);
  });

  it('lands in the same place whether stepped once or many times', () => {
    // §114.3: predictable behaviour whatever the frame rate. A per-frame damping
    // factor would fail this — the same flick would travel further on a faster
    // screen.
    const begun = beginPan(still(GLOBAL), IDLE_NAVIGATION, { x: 0, y: 0, at: at(0) });
    const dragged = panTo(begun.camera, begun.navigation, { x: 180, y: 0, at: at(90) }, 1, CAMERA);
    const released = endPan(dragged.navigation, at(90), CAMERA);

    const oneStep = applyDrift(dragged.camera, released, at(90 + 240), CAMERA, NAV);

    let camera = dragged.camera;
    let navigation = released;
    for (let elapsed = 16; elapsed <= 240; elapsed += 16) {
      const stepped = applyDrift(camera, navigation, at(90 + elapsed), CAMERA, NAV);
      camera = stepped.camera;
      navigation = stepped.navigation;
    }

    expect(camera.pose.position.x).toBeCloseTo(oneStep.camera.pose.position.x, 9);
    expect(camera.pose.position.z).toBeCloseTo(oneStep.camera.pose.position.z, 9);
  });

  it('stops once the drift falls below the floor', () => {
    const drifting = {
      drag: null,
      drift: vec3(NAV.minDriftSpeed / 2, 0, 0),
      driftAt: at(0),
    };
    const result = applyDrift(still(GLOBAL), drifting, at(16), CAMERA, NAV);
    expect(result.navigation).toBe(IDLE_NAVIGATION);
    expect(result.camera.pose).toEqual(GLOBAL);
  });

  it('does not drift under reduced motion (§83.3)', () => {
    const begun = beginPan(still(GLOBAL), IDLE_NAVIGATION, { x: 0, y: 0, at: at(0) });
    const dragged = panTo(begun.camera, begun.navigation, { x: 180, y: 0, at: at(90) }, 1, REDUCED);
    // The pan itself still happens: reduced motion removes momentum the user did
    // not ask for, not the movement they did.
    expect(dragged.camera.pose.position).not.toEqual(GLOBAL.position);
    expect(endPan(dragged.navigation, at(90), REDUCED)).toBe(IDLE_NAVIGATION);
  });

  it('leaves the camera alone while a fly-to owns it', () => {
    const flying = flyTo(
      still(GLOBAL),
      { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(0), duration: CAMERA.durations.spatialTransition },
      CAMERA,
    );
    const drifting = { drag: null, drift: vec3(5, 0, 0), driftAt: at(0) };
    const result = applyDrift(flying, drifting, at(50), CAMERA, NAV);
    expect(result.camera).toBe(flying);
    expect(result.navigation).toBe(drifting);
  });
});

describe('zoom', () => {
  it('scales the view distance and holds the target still', () => {
    const start = still(SECTOR, 'SECTOR_FOCUS');
    const before = currentViewDistance(start);
    const zoomed = zoomBy(start, 0.5, CAMERA, NAV);
    expect(currentViewDistance(zoomed)).toBeCloseTo(before / 2, 9);
    expect(zoomed.pose.target).toEqual(SECTOR.target);
  });

  it('clamps to the readable range instead of passing through the target', () => {
    const start = still(SECTOR, 'SECTOR_FOCUS');
    expect(currentViewDistance(zoomBy(start, 1e-6, CAMERA, NAV))).toBeCloseTo(
      NAV.minViewDistance,
      9,
    );
    // A boundary wide enough not to take part, so this measures the zoom clamp
    // alone. The two limits interacting is the subject of the next test.
    const roomy: CameraConfig = { ...CAMERA, boundaryRadius: 100_000 };
    expect(currentViewDistance(zoomBy(start, 1e6, roomy, NAV))).toBeCloseTo(NAV.maxViewDistance, 9);
  });

  it('is pulled back further by the world boundary when the two limits meet', () => {
    // The zoom clamp and the soft boundary of §81.4 are separate rails, and the
    // tighter one wins. Pulling back to the full 4 000 units would put the
    // camera outside a 2 000-unit world, so it comes to rest inside it — free
    // navigation cannot leave the world behind (§37.7).
    const start = still(SECTOR, 'SECTOR_FOCUS');
    const pulled = zoomBy(start, 1e6, CAMERA, NAV);
    expect(currentViewDistance(pulled)).toBeLessThan(NAV.maxViewDistance);
    expect(length(pulled.pose.position)).toBeLessThan(CAMERA.boundaryRadius * 1.5);
  });

  it('covers the same proportion per notch at every distance', () => {
    // Multiplicative rather than additive: an additive step is useless from the
    // global view and violent inside a sector.
    const near = still({ position: vec3(0, 100, 0), target: vec3(0, 0, 0) });
    const far = still({ position: vec3(0, 1_000, 0), target: vec3(0, 0, 0) });
    const nearRatio = currentViewDistance(zoomByNotches(near, 1, CAMERA, NAV)) / 100;
    const farRatio = currentViewDistance(zoomByNotches(far, 1, CAMERA, NAV)) / 1_000;
    expect(nearRatio).toBeCloseTo(farRatio, 12);
    expect(nearRatio).toBeCloseTo(1 + NAV.zoomStep, 12);
  });

  it('treats spreading fingers as moving closer', () => {
    const start = still(SECTOR, 'SECTOR_FOCUS');
    const before = currentViewDistance(start);
    expect(currentViewDistance(pinchTo(start, 2, CAMERA, NAV))).toBeCloseTo(before / 2, 9);
    expect(currentViewDistance(pinchTo(start, 0.5, CAMERA, NAV))).toBeCloseTo(before * 2, 9);
  });

  it('refuses impossible factors rather than producing a NaN pose', () => {
    const start = still(SECTOR, 'SECTOR_FOCUS');
    expect(() => zoomBy(start, 0, CAMERA, NAV)).toThrow(RangeError);
    expect(() => zoomBy(start, -1, CAMERA, NAV)).toThrow(RangeError);
    expect(() => pinchTo(start, 0, CAMERA, NAV)).toThrow(RangeError);
  });

  it('is refused during a cinematic', () => {
    const cinematic = flyTo(
      still(BATTLE, 'BATTLE_TACTICAL'),
      {
        to: BATTLE,
        mode: 'CINEMATIC_TEMP',
        at: at(0),
        duration: CAMERA.durations.cinematic,
        interruptible: false,
      },
      CAMERA,
    );
    expect(zoomBy(cinematic, 0.5, CAMERA, NAV)).toBe(cinematic);
  });
});

describe('stepping outward', () => {
  it('walks the spatial hierarchy one level at a time', () => {
    expect(outwardMode('CINEMATIC_TEMP')).toBe('BATTLE_TACTICAL');
    expect(outwardMode('BATTLE_TACTICAL')).toBe('SECTOR_FOCUS');
    expect(outwardMode('SECTOR_FOCUS')).toBe('GLOBAL_FREE');
    expect(outwardMode('GLOBAL_FREE')).toBeNull();
  });

  it('answers for every camera mode, including the two that are not levels', () => {
    // A `default` branch here would answer for modes nobody thought about. This
    // pins the two that are easy to forget: the profile presentation returns to
    // the world, and a reset already in flight is left to finish.
    expect(outwardMode('GLOBAL_FOCUS')).toBe('GLOBAL_FREE');
    expect(outwardMode('PROFILE_PRESENTATION')).toBe('GLOBAL_FREE');
    expect(outwardMode('RESETTING')).toBeNull();
    for (const mode of CAMERA_MODES) {
      expect(() => outwardMode(mode)).not.toThrow();
    }
  });

  it('flies to the level above and keeps the focused battle', () => {
    const start: CameraState = { ...still(BATTLE, 'BATTLE_TACTICAL'), focusedBattleId: 'b-2' };
    const stepped = stepOutward(start, poseFor, at(0), CAMERA);
    expect(stepped.transition?.toMode).toBe('SECTOR_FOCUS');
    expect(stepped.focusedBattleId).toBe('b-2');
  });

  it('clears the focused battle on reaching the global level', () => {
    const start: CameraState = { ...still(SECTOR, 'SECTOR_FOCUS'), focusedBattleId: 'b-2' };
    expect(stepOutward(start, poseFor, at(0), CAMERA).focusedBattleId).toBeNull();
  });

  it('does nothing at the global level, so holding ESC cannot overshoot', () => {
    const start = still(GLOBAL);
    expect(stepOutward(start, poseFor, at(0), CAMERA)).toBe(start);
  });

  it('releases a cinematic, because it is an orientation rail (§37.7)', () => {
    const cinematic = flyTo(
      still(BATTLE, 'BATTLE_TACTICAL'),
      {
        to: BATTLE,
        mode: 'CINEMATIC_TEMP',
        at: at(0),
        duration: CAMERA.durations.cinematic,
        interruptible: false,
      },
      CAMERA,
    );
    // Half a second in, the cinematic is still flying and `mode` is therefore
    // still BATTLE_TACTICAL. `ESC` acts on where the camera is *going*, so it
    // steps out of the cinematic and back to the tactical view §81.3 returns
    // control to — rather than out of the level the cinematic was launched
    // from, which is one level further than anyone asked for. And crucially it
    // is not refused: an uninterruptible transition still yields to the rail.
    const stepped = stepOutward(cinematic, poseFor, at(500), CAMERA);
    expect(stepped.transition?.interruptible).toBe(true);
    expect(stepped.transition?.toMode).toBe('BATTLE_TACTICAL');
  });

  it('acts on the level being flown to, not the one being left', () => {
    // A player who taps a sector and presses `ESC` half a second later has
    // changed their mind. Reading `mode` — which only becomes the destination
    // when the transition finishes — made the key do nothing for the length of
    // every move, which §37.7's "never leave the user stranded" covers just as
    // much as a dead end does.
    const flying = flyTo(
      still(GLOBAL),
      { to: SECTOR, mode: 'SECTOR_FOCUS', at: at(0), duration: milliseconds(1_000) },
      CAMERA,
    );

    expect(flying.mode).toBe('GLOBAL_FREE');
    expect(intendedMode(flying)).toBe('SECTOR_FOCUS');
    expect(stepOutward(flying, poseFor, at(400), CAMERA).transition?.toMode).toBe('GLOBAL_FREE');
  });

  it('reads the settled mode when nothing is in flight', () => {
    expect(intendedMode(still(SECTOR, 'SECTOR_FOCUS'))).toBe('SECTOR_FOCUS');
  });

  it('arrives immediately under reduced motion', () => {
    const start = still(BATTLE, 'BATTLE_TACTICAL');
    const stepped = stepOutward(start, poseFor, at(0), REDUCED);
    expect(stepped.transition).toBeNull();
    expect(stepped.mode).toBe('SECTOR_FOCUS');
    expect(stepped.pose).toEqual(SECTOR);
  });

  it('stays put when the layout has no pose for the level above', () => {
    const start = still(BATTLE, 'BATTLE_TACTICAL');
    expect(stepOutward(start, () => null, at(0), CAMERA)).toBe(start);
  });
});

describe('the initial camera', () => {
  it('starts idle, with nothing to drift', () => {
    const camera = initialCamera(CAMERA);
    const result = applyDrift(camera, IDLE_NAVIGATION, at(16), CAMERA, NAV);
    expect(result.camera).toBe(camera);
    expect(result.navigation).toBe(IDLE_NAVIGATION);
  });
});
