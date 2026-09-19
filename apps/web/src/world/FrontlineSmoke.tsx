import type { DetailLevel } from '@ponswars/world-runtime';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type JSX } from 'react';
import {
  Color,
  InstancedBufferAttribute,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  type InstancedMesh,
} from 'three';
import { useSession } from '../state/session.js';
import { SMOKE_MAX_PUFFS, smokePuffs } from './battle-energy.js';
import { glslFloat } from './glsl.js';

/**
 * Smoke hanging over the frontline, lit from inside by the fire meeting there
 * (§36.10, §13).
 *
 * `battle-energy.ts` decides how much; this draws it. A child of the frontline
 * marker, so it stands wherever the marker stands — eased toward the
 * authoritative line, never ahead of it — and collapses with it at a
 * reshuffle. Nothing here reads the battle beyond the one intensity number.
 *
 * In the marker's own frame: x runs along the line, y up, z across it.
 *
 * One draw call. Each puff is a quad turned to face the camera in the vertex
 * shader, and rises, spreads and fades on its own clock, so nothing is written
 * per frame but the time.
 *
 * Neutral (§36.5): grey smoke and the warm light of fire, never either side's
 * colour — the smoke is where both armies' rounds land.
 */

/** How long one puff lives, in seconds. `CALIBRATE` (§59.4). */
const LIFE = 5.5;

/** How far along the line the smoke spreads: most of the marker's 108. */
const SPREAD = 96;

/** How high a puff climbs before it has faded. Under a trooper and a half. */
const RISE = 13;

/**
 * Grey, cold, and a little blue. Lighter than the floor under it: smoke the
 * colour of the ground it hangs over was simply not there.
 */
const SMOKE = new Color('#56626e');
/** Fire light from under the smoke, where rounds are landing. */
const FIRE = new Color('#ff9446');

const VERTEX = /* glsl */ `
  attribute vec3 aSeed;
  uniform float uTime;
  varying vec2 vUv;
  varying float vAge;
  varying float vFlicker;

  void main() {
    // aSeed: x is where along the line, y the puff's own phase, z which way
    // across the line it drifts.
    float age = fract(uTime / ${glslFloat(LIFE)} + aSeed.y);
    vec3 centre = vec3(
      aSeed.x * ${glslFloat(SPREAD)},
      // From the marker's height (it stands 8 above the deck) down to the deck.
      -7.0 + age * ${glslFloat(RISE)},
      aSeed.z * (1.5 + age * 4.0)
    );
    float size = mix(7.0, 18.0, sqrt(age));
    vec4 view = modelViewMatrix * vec4(centre, 1.0);
    view.xy += position.xy * size;
    gl_Position = projectionMatrix * view;
    vUv = uv;
    vAge = age;
    // A flicker of its own, so the fire under the smoke never pulses in step.
    vFlicker = 0.5 + 0.5 * sin(uTime * (5.0 + aSeed.y * 7.0) + aSeed.x * 40.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uSmoke;
  uniform vec3 uFire;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vAge;
  varying float vFlicker;

  void main() {
    vec2 p = vUv - 0.5;
    float r = length(p) * 2.0;
    // A soft ball with a lumpy edge, not a disc. From the coordinates rather
    // than from an angle: atan at the quad's exact centre is undefined, and
    // one NaN pixel here is smeared by the bloom across the whole frame.
    float lumps = 0.82 + 0.18 * sin(p.x * 9.0 + vAge * 6.0) * cos(p.y * 7.0 - vAge * 4.0);
    float body = 1.0 - smoothstep(0.35 * lumps, 1.0 * lumps, r);
    // Thickens as it leaves the ground, thins away as it rises.
    float life = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.45, 1.0, vAge));
    // Young smoke is lit from under by the fire it came from.
    float fire = (1.0 - smoothstep(0.0, 0.35, vAge)) * (0.55 + 0.45 * vFlicker);
    vec3 colour = mix(uSmoke, uFire, fire * 0.85);
    gl_FragColor = vec4(colour, body * life * uOpacity);
  }
`;

export function FrontlineSmoke({
  detail,
  intensity,
  live,
}: {
  readonly detail: DetailLevel;
  readonly intensity: number | undefined;
  readonly live: boolean;
}): JSX.Element | null {
  const reducedMotion = useSession((state) => state.reducedMotion);
  const mesh = useRef<InstancedMesh>(null);
  const count = smokePuffs(detail, intensity, live);

  const geometry = useMemo(() => {
    const plane = new PlaneGeometry(1, 1);
    // Spread evenly along the line with a little jitter, so the smoke is a
    // band rather than clumps with gaps between them. Seeded, so the same
    // battle's smoke is the same shape on every reload.
    const seeds = new Float32Array(SMOKE_MAX_PUFFS * 3);
    let state = 0x2f6b;
    const random = (): number => {
      state = (state * 1_103_515_245 + 12_345) >>> 0;
      return state / 0xffffffff;
    };
    for (let index = 0; index < SMOKE_MAX_PUFFS; index += 1) {
      // Interleaved, so the first few puffs a thin battle draws are spread
      // along the whole line rather than bunched at one end.
      const slot = (index * 7) % SMOKE_MAX_PUFFS;
      seeds[index * 3] = (slot + random()) / SMOKE_MAX_PUFFS - 0.5;
      seeds[index * 3 + 1] = random();
      seeds[index * 3 + 2] = random() * 2 - 1;
    }
    plane.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 3));
    return plane;
  }, []);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          uTime: { value: 0 },
          uSmoke: { value: SMOKE },
          uFire: { value: FIRE },
          uOpacity: { value: 0.62 },
        },
        transparent: true,
        blending: NormalBlending,
        depthWrite: false,
      }),
    [],
  );

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame((_, delta) => {
    // §83.3: the smoke stays, and stops.
    if (!reducedMotion) {
      const time = material.uniforms['uTime'];
      if (time !== undefined) {
        // Wrapped at a whole number of lives, so no puff jumps at the wrap.
        time.value = (Number(time.value) + delta) % (LIFE * 1_000);
      }
    }
    if (mesh.current !== null) {
      mesh.current.count = count;
    }
  });

  if (count === 0) {
    return null;
  }

  return (
    <instancedMesh
      ref={mesh}
      args={[geometry, material, SMOKE_MAX_PUFFS]}
      // Placed by the shader, not by instance matrices, so three's bounds for
      // it are meaningless and would cull it at the wrong moments.
      frustumCulled={false}
      renderOrder={3}
    />
  );
}
