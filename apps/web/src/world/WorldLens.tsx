import { intendedMode } from '@ponswars/world-runtime';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { PerspectiveCamera } from 'three';
import { useSession } from '../state/session.js';
import { easeLens, fittedFov, lensTighten } from './lens.js';
import { useFinalPush } from './useFinalPush.js';

/**
 * Sets the camera's field of view: fitted to the window (§37.4), and closed in
 * a little for the Final Push while a battle is being watched (§36.2).
 *
 * Its own component because the Final Push is read from a once-a-second clock,
 * and that re-render belongs here rather than on the whole scene.
 *
 * Renders nothing.
 */
export function WorldLens(): null {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  const pushing = useFinalPush();
  const reducedMotion = useSession((state) => state.reducedMotion);
  // Where the lens is between its two framings, as a share of the fitted one.
  const share = useRef(1);

  const project = (): void => {
    // Reads the renderer's own size rather than the window's: the canvas is
    // what the projection has to match, and on a split view or an embedded
    // pane those are not the same number.
    const fov = fittedFov(width / Math.max(height, 1)) * share.current;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  };

  // On a resize as well as every frame. A page painted without the loop
  // running — a hidden tab, a screenshot — must still get the lens that fits
  // its window, or a phone shows two islands and the Market Core.
  useEffect(project);

  useFrame((_, delta) => {
    const mode = intendedMode(useSession.getState().camera);
    const target = lensTighten(pushing, mode, reducedMotion);
    // Under reduced motion the lens is simply where it should be: easing back
    // out would be the very move §83.3 asked to leave out.
    share.current = reducedMotion ? target : easeLens(share.current, target, delta * 1000);
    project();
  });

  return null;
}
