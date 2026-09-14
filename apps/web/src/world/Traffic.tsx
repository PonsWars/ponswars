import type { QualityTier } from '@ponswars/world-runtime';
import { useFrame } from '@react-three/fiber';
import { Suspense, useMemo, useRef, type JSX } from 'react';
import { AdditiveBlending, type Group } from 'three';
import { useSession } from '../state/session.js';
import { Dropship } from './Dropship.js';
import { flightAt, flightPaths } from './flight-paths.js';

/**
 * Ships in the air between the islands (§38.6, §36.14).
 *
 * Neutral craft — the Market's, not a faction's (§38.3) — each on its own loop
 * round the core, with a small engine light behind it so a far ship is still a
 * moving point of light when its hull is a few pixels.
 *
 * Under reduced motion (§83.3) they hold where they are: the sky keeps its
 * traffic, and nothing moves.
 */

/** How many each tier flies. Each is a draw call and a little overdraw. */
const FLEET: Readonly<Record<QualityTier, number>> = {
  ULTRA: 16,
  HIGH: 14,
  BALANCED: 12,
  PERFORMANCE: 6,
  REDUCED_MOTION: 12,
};

/**
 * How much larger than a route's dropship a ship out here is drawn.
 *
 * Freighters rather than shuttles, and it is also a matter of reading: at the
 * global view a route-sized hull is a few pixels, and traffic nobody can see is
 * not traffic.
 */
const HULL_SCALE = 1.9;

/** The Market's own cold light. */
const MARKET_LIGHT = '#7fd4ff';

export function Traffic(): JSX.Element {
  const quality = useSession((state) => state.quality);
  const reducedMotion = useSession((state) => state.reducedMotion);
  const paths = useMemo(() => flightPaths(2_917, FLEET[quality]), [quality]);
  const ships = useRef<(Group | null)[]>([]);

  useFrame((state) => {
    const seconds = reducedMotion ? 0 : state.clock.elapsedTime;
    for (const [index, path] of paths.entries()) {
      const ship = ships.current[index];
      if (ship === null || ship === undefined) {
        continue;
      }
      const flight = flightAt(path, seconds);
      ship.position.set(flight.x, flight.y, flight.z);
      ship.rotation.y = flight.heading;
    }
  });

  return (
    <group>
      {paths.map((_, index) => (
        <group
          key={index}
          ref={(node) => {
            ships.current[index] = node;
          }}
          scale={HULL_SCALE}
        >
          <Suspense fallback={null}>
            <Dropship index={index} heading={0} accent={MARKET_LIGHT} />
          </Suspense>
          {/* The engines, behind the hull. */}
          <mesh position={[0, 0, -14]}>
            <sphereGeometry args={[0.9, 8, 8]} />
            <meshBasicMaterial
              color={MARKET_LIGHT}
              transparent
              opacity={0.9}
              blending={AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}
