import { useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  type Object3D,
} from 'three';

/**
 * The Market Core's structure and its beam (§38.2, §38.10).
 *
 * The core was seven boxes with lit bands wrapped round them — a skyline from
 * the global view and seven boxes from anywhere closer, at the centre of a
 * world whose sectors had just been given terraced citadels. It is modelled now,
 * by `tools/blender/build-core.py`: a buttressed central spire stepping inward
 * as it rises, lesser towers gathered round it, a ring of light at every
 * setback. The spire layout is the one the boxes had, so the landmark stands
 * where players already know it and the camera poses tested against it still
 * clear it.
 */

const CORE_MODEL = '/models/core/market-core.glb';

/** The core's own colour. It belongs to no faction, and §38.3 keeps it that way. */
const CORE_ACCENT = '#4fd8c0';

/**
 * A mesh's geometry from the loaded model, by the name Blender gave it.
 *
 * Read through `unknown` and tested rather than asserted, like every other
 * geometry this world loads. Not cloned and never disposed: there is exactly
 * one core, nothing mutates it, and the loader's cache owns it.
 */
function geometryNamed(scene: Object3D, name: string): BufferGeometry | null {
  const node = scene.getObjectByName(name);
  if (!(node instanceof Mesh)) {
    return null;
  }
  const geometry: unknown = node.geometry;
  return geometry instanceof BufferGeometry ? geometry : null;
}

export function CoreModel(): JSX.Element {
  const { scene } = useGLTF(CORE_MODEL);
  const body = useMemo(() => geometryNamed(scene, 'core_body'), [scene]);
  const bands = useMemo(() => geometryNamed(scene, 'core_bands'), [scene]);
  // Past white on purpose, and not tone-mapped: §38.2 has players find the
  // core by its light before they read its shape, and these rings are that
  // light — they have to clear the bloom threshold to throw it into the air.
  const bandColour = useMemo(() => new Color(CORE_ACCENT).multiplyScalar(1.15), []);

  return (
    <group>
      {body === null ? null : (
        <mesh geometry={body}>
          <meshStandardMaterial
            color="#1e3140"
            metalness={0.22}
            roughness={0.48}
            emissive="#0e3040"
            emissiveIntensity={0.42}
          />
        </mesh>
      )}
      {bands === null ? null : (
        <mesh geometry={bands}>
          <meshBasicMaterial color={bandColour} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

/**
 * The light standing up out of the core's summit.
 *
 * Every delivered world frame has it: a column of light over the central
 * citadel, which is what makes the landmark findable from the far side of the
 * ring before any of its structure is. Additive and depth-transparent, so it
 * reads as light in the air rather than as an object, and brightest facing the
 * camera so its edges dissolve instead of ending at a cylinder's outline.
 *
 * It swells with the core's own pulse through the reshuffle (§15 step 5) — the
 * core is what survives every round, and this is the part of it that says so.
 */
export function CoreBeam({ readPulse }: { readonly readPulse: () => number }): JSX.Element {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        fog: false,
        toneMapped: false,
        uniforms: {
          uColour: { value: new Color('#5fd3b4') },
          uPulse: { value: 0 },
        },
        vertexShader: `
          varying vec2 vUv;
          varying float vFacing;
          void main() {
            vUv = uv;
            // Normalised by hand, with the zero case answered, rather than by
            // GLSL normalize — which answers a zero-length vector with NaN.
            //
            // This is not defensive style for its own sake. One NaN fragment
            // blended additively into the bloom pass's float target is spread
            // over the entire frame by the blur that follows, and the world
            // goes black — every island, not just the beam.
            vec3 n = normalMatrix * normal;
            float len = length(n);
            vFacing = len > 1e-4 ? abs(n.z / len) : 0.0;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uColour;
          uniform float uPulse;
          varying vec2 vUv;
          varying float vFacing;
          void main() {
            // Strongest at the summit and gone well before the top of the sky.
            float rise = pow(1.0 - vUv.y, 2.4);
            float core = pow(vFacing, 1.6);
            // Bounded, because this is blended into a float target that a blur
            // then spreads over the whole frame: anything unbounded here is a
            // bug in every other pixel too.
            float strength = clamp(rise * core * (0.55 + uPulse * 0.9), 0.0, 2.0);
            gl_FragColor = vec4(uColour * strength, strength);
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

  useFrame(() => {
    const pulse = material.uniforms['uPulse'];
    if (pulse !== undefined) {
      // Finite or nothing. The shader clamps what it is given, and a clamp is
      // no defence against NaN — it propagates through `clamp` untouched.
      const value = readPulse();
      pulse.value = Number.isFinite(value) ? value : 0;
    }
  });

  return (
    // From the beacon upward. Open-ended: a cap would be a disc of light
    // floating at the top of the sky.
    <mesh material={material} position={[0, 208 + 450, 0]} frustumCulled={false}>
      <cylinderGeometry args={[5, 16, 900, 24, 1, true]} />
    </mesh>
  );
}

useGLTF.preload(CORE_MODEL);
