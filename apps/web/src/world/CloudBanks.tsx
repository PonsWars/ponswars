import type { QualityTier } from '@ponswars/world-runtime';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import {
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';
import { useSession } from '../state/session.js';
import { NOISE_GLSL } from './Atmosphere.js';
import { cloudBanks, type CloudIsland, type CloudOptions } from './clouds.js';
import { MARKET_CORE, SECTOR_ISLAND_RADIUS, SECTOR_POSITIONS } from './layout.js';
import { VOID_SKY } from './navigation-config.js';

/**
 * Banks of cloud at the islands' own height (§38.1, §38.10).
 *
 * Billboards, shaded per pixel: a soft ragged puff from noise, lit on the side
 * the sun is on and dark underneath, with the Market Core's light coming up
 * through the ones near it. One instanced draw call for all of them.
 *
 * Dim and cold on purpose. The delivered frames paint these bright white, and
 * §36.5 keeps this world dark and neutral — so the weather is moonlit, and what
 * it does is give the void a middle distance, not light the scene.
 *
 * A puff fades as the camera nears it, so a sector or battlefield camera flying
 * through the weather never has a wall of cloud across its lens.
 */

/** Every island the weather gathers under: the core first, then the five sectors. */
const ISLANDS: readonly CloudIsland[] = [
  { x: MARKET_CORE.x, y: MARKET_CORE.y, z: MARKET_CORE.z, radius: 124 },
  ...SECTOR_POSITIONS.map((position) => ({
    x: position.x,
    y: position.y,
    z: position.z,
    radius: SECTOR_ISLAND_RADIUS,
  })),
];

/** How much weather each tier can afford: it is all overdraw. */
const DENSITY: Readonly<Record<QualityTier, CloudOptions>> = {
  ULTRA: { perIsland: 16, open: 70, reach: 1_700 },
  HIGH: { perIsland: 14, open: 56, reach: 1_600 },
  BALANCED: { perIsland: 12, open: 44, reach: 1_500 },
  PERFORMANCE: { perIsland: 6, open: 16, reach: 1_400 },
  REDUCED_MOTION: { perIsland: 12, open: 44, reach: 1_500 },
};

/** Where the moonlight comes from. The same side as the key light and the planet's sun. */
const SUN = new Vector3(0.45, 0.8, 0.4).normalize();

export function CloudBanks(): JSX.Element {
  const quality = useSession((state) => state.quality);
  const reducedMotion = useSession((state) => state.reducedMotion);
  const density = DENSITY[quality];

  const geometry = useMemo(() => {
    const puffs = cloudBanks(7_331, ISLANDS, density);
    const base = new PlaneGeometry(2, 2);
    const instanced = new InstancedBufferGeometry();
    instanced.index = base.index;
    instanced.setAttribute('position', base.getAttribute('position'));
    instanced.setAttribute('uv', base.getAttribute('uv'));
    instanced.setAttribute(
      'aCenter',
      new InstancedBufferAttribute(Float32Array.from(puffs.flatMap((p) => [p.x, p.y, p.z])), 3),
    );
    instanced.setAttribute(
      'aSize',
      new InstancedBufferAttribute(Float32Array.from(puffs.map((p) => p.size)), 1),
    );
    instanced.setAttribute(
      'aSeed',
      new InstancedBufferAttribute(Float32Array.from(puffs.map((p) => p.seed)), 1),
    );
    instanced.instanceCount = puffs.length;
    return instanced;
  }, [density]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        fog: false,
        uniforms: {
          uTime: { value: 0 },
          uSun: { value: SUN },
          uLit: { value: new Color('#557a91') },
          uShadow: { value: new Color('#070e14') },
          uGlow: { value: new Color('#c9a25a') },
          uHorizon: { value: new Color(VOID_SKY.horizon) },
        },
        vertexShader: `
          attribute vec3 aCenter;
          attribute float aSize;
          attribute float aSeed;
          uniform float uTime;
          varying vec2 vUv;
          varying float vSeed;
          varying float vDepth;
          varying float vCore;
          void main() {
            // A slow drift, each puff on its own phase.
            vec3 centre = aCenter + vec3(
              sin(uTime * 0.021 + aSeed * 40.0) * 9.0,
              sin(uTime * 0.017 + aSeed * 23.0) * 3.0,
              cos(uTime * 0.019 + aSeed * 31.0) * 9.0
            );
            vec4 view = viewMatrix * vec4(centre, 1.0);
            // Wider than tall: cloud banks, not balls.
            view.xy += position.xy * vec2(aSize * 1.2, aSize * 0.5);
            gl_Position = projectionMatrix * view;
            vUv = uv;
            vSeed = aSeed;
            vDepth = -view.z;
            vCore = exp(-length(centre.xz) / 260.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uSun;
          uniform vec3 uLit;
          uniform vec3 uShadow;
          uniform vec3 uGlow;
          uniform vec3 uHorizon;
          varying vec2 vUv;
          varying float vSeed;
          varying float vDepth;
          varying float vCore;
          ${NOISE_GLSL}
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            // Density rather than a disc: falling off from the middle, eaten
            // into by two scales of noise so the edge is wisps and gaps, and
            // flatter underneath, the way a bank sits on colder air. A clean
            // radius read as a ball of cotton.
            float n = pwFbm(vUv * 2.6 + vSeed * 57.0);
            float billow = pwFbm(vUv * 6.0 - vSeed * 13.0);
            vec2 q = vec2(p.x, p.y > 0.0 ? p.y * 1.1 : p.y * 1.9);
            float density = (1.0 - length(q)) * 1.3 + (n - 0.5) * 1.1 + (billow - 0.5) * 0.45;
            float body = smoothstep(0.05, 0.65, density);
            if (body <= 0.001) discard;
            // Lit from above and from the sun's side; dark underneath.
            float light = clamp(0.22 + p.y * 0.55 + p.x * uSun.x * 0.2 + (n - 0.5) * 0.9, 0.0, 1.0);
            vec3 colour = mix(uShadow, uLit, light);
            // The core's warm light, up through the banks round it.
            colour += uGlow * vCore * (1.0 - light) * 0.35;
            // Into the horizon with distance, like everything else in the void.
            colour = mix(colour, uHorizon, smoothstep(900.0, 2800.0, vDepth));
            float near = smoothstep(40.0, 240.0, vDepth);
            float far = 1.0 - smoothstep(2600.0, 3400.0, vDepth);
            gl_FragColor = vec4(colour, body * 0.5 * near * far);
          }
        `,
      }),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
    },
    [geometry],
  );
  useEffect(
    () => () => {
      material.dispose();
    },
    [material],
  );

  useFrame((state) => {
    if (reducedMotion) {
      return;
    }
    const time = material.uniforms['uTime'];
    if (time !== undefined) {
      time.value = state.clock.elapsedTime;
    }
  });

  return <mesh geometry={geometry} material={material} frustumCulled={false} />;
}
