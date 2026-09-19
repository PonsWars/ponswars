import type { CardSupportTier } from '@ponswars/shared-types';
import type { DetailLevel } from '@ponswars/world-runtime';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { useSession } from '../state/session.js';
import { supportCurtain } from './battle-energy.js';

/**
 * Community card support, standing along the contested ground (§15, §40).
 *
 * Two curtains of light on the long edges of the strip the frontline crosses,
 * framing the arena rather than either army: the tier is the whole battle's,
 * and it does not say which side the cards are behind. `battle-energy.ts`
 * decides how tall and bright each tier stands.
 *
 * Additive, so it can only add light — the frontline marker and the fire stay
 * visible through the near curtain from any camera — and faintly striated, so
 * it reads as a field of energy rather than as a pane of glass. It breathes,
 * faster as support grows; under reduced motion (§83.3) it holds still.
 *
 * Champagne rather than any faction's colour: cards are the one thing on the
 * field that belongs to the players rather than to the factions, and §36.5
 * keeps faction colour to the factions.
 */

/** Card energy: the Genesis reveal's champagne, dimmed to sit under bloom. */
const CARD_LIGHT = '#e6d3a1';

/** The contested strip, which the curtains stand along: 76 across, 150 deep. */
const STRIP_WIDTH = 76;
const STRIP_EDGE_Z = 77;

/** The deck the curtains stand on. */
const DECK_Y = 11;

/** Only a sector near enough to read a battle draws its support (§37.6). */
const DRAWS: Readonly<Record<DetailLevel, boolean>> = {
  FULL: true,
  REDUCED: true,
  SILHOUETTE: false,
  CULLED: false,
};

export function SupportCurtain({
  tier,
  detail,
  live,
}: {
  readonly tier: CardSupportTier | undefined;
  readonly detail: DetailLevel;
  readonly live: boolean;
}): JSX.Element | null {
  const reducedMotion = useSession((state) => state.reducedMotion);
  const curtain = supportCurtain(tier);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        fog: false,
        uniforms: {
          uColour: { value: new Color(CARD_LIGHT) },
          uOpacity: { value: 0 },
          uTime: { value: 0 },
          uPulse: { value: 0 },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uColour;
          uniform float uOpacity;
          uniform float uTime;
          uniform float uPulse;
          varying vec2 vUv;
          void main() {
            // Brightest at its foot and gone at the top, so it stands up out of
            // the ground rather than hanging as a sheet with an edge.
            //
            // Clamped before the power, and this is not tidiness. Interpolated
            // at the plane's top edge, 1.0 - vUv.y can land a hair below zero,
            // and pow() of a negative base is NaN — which the bloom pass then
            // spreads through its blur chain until the whole world renders
            // black, with nothing in the console to say why. The first version
            // of this shader did exactly that.
            float rise = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.6);
            // Fine vertical striations drifting slowly along it: a field, not
            // a pane.
            float grain = 0.72 + 0.28 * sin(vUv.x * 140.0 + uTime * 1.3);
            float breath = 0.8 + 0.2 * sin(uTime * uPulse * 6.2831853);
            gl_FragColor = vec4(uColour, rise * grain * breath * uOpacity);
          }
        `,
      }),
    [],
  );

  useEffect(
    () => () => {
      material.dispose();
    },
    [material],
  );

  useEffect(() => {
    const opacity = material.uniforms['uOpacity'];
    const pulse = material.uniforms['uPulse'];
    if (opacity !== undefined) {
      // Cards are deployed at the lock and the support is fixed from there
      // (§23.1), so before the battle is live there is nothing to show.
      opacity.value = curtain !== null && live ? curtain.opacity : 0;
    }
    if (pulse !== undefined) {
      pulse.value = curtain?.pulse ?? 0;
    }
  }, [material, curtain, live]);

  useFrame((state) => {
    if (reducedMotion) {
      return;
    }
    const time = material.uniforms['uTime'];
    if (time !== undefined) {
      time.value = state.clock.elapsedTime;
    }
  });

  if (curtain === null || !live || !DRAWS[detail]) {
    return null;
  }

  return (
    <group>
      {[STRIP_EDGE_Z, -STRIP_EDGE_Z].map((z) => (
        <mesh
          key={z}
          position={[0, DECK_Y + curtain.height / 2, z]}
          material={material}
          renderOrder={3}
        >
          <planeGeometry args={[STRIP_WIDTH, curtain.height]} />
        </mesh>
      ))}
    </group>
  );
}
