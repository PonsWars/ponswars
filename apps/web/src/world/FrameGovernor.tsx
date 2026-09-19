import { initialFrameHealth, observeFrame } from '@ponswars/world-runtime';
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { useSession } from '../state/session.js';

/**
 * Keeps the world at a quality tier the device can actually draw (§82.2,
 * §37.10).
 *
 * The rule lives in `@ponswars/world-runtime` as a reducer over frame times;
 * this is the one place that has frames to give it. The tier was a constant
 * before this: every device drew five sectors at the same fidelity, and a
 * machine that could not hold the frame budget simply ran slowly.
 *
 * Nothing is written per frame. The watch is a ref, and the store is touched
 * only when the tier actually moves — twice in a session on most devices,
 * never on a device that was given the right tier to begin with.
 *
 * A tier the player chose restarts the watch at their tier (§82.2): the world
 * may still drop below it to keep the budget, and never climbs past it.
 *
 * Renders nothing.
 */
export function FrameGovernor(): null {
  const quality = useSession((state) => state.quality);
  const setQuality = useSession((state) => state.setQuality);
  const health = useRef(initialFrameHealth(quality));

  useEffect(() => {
    if (health.current.tier !== quality) {
      // Somebody else moved the tier — the player, or the reduced-motion
      // setting. Their tier is the new ceiling.
      health.current = initialFrameHealth(quality);
    }
  }, [quality]);

  useFrame((_, delta) => {
    const next = observeFrame(health.current, delta * 1_000);
    health.current = next;
    if (next.tier !== quality) {
      setQuality(next.tier);
    }
  });

  return null;
}
