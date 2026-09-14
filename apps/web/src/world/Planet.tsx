import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import { AdditiveBlending, BackSide, Color, ShaderMaterial, Vector3 } from 'three';
import { useSession } from '../state/session.js';
import { NOISE_GLSL } from './Atmosphere.js';

/**
 * The world the market war hangs above (§38.10).
 *
 * Every delivered world frame puts a planet's limb behind the islands: a thin
 * bright rim of atmosphere, a night side scattered with city light, and the
 * curve of it giving the void a floor and a scale. §38.1 is explicit that the
 * *world* is not a planet — the continent floats — so this is backdrop only:
 * far past the boundary, not interactive, never in the fog.
 *
 * Procedural, like the sky and the sea: continents from noise, cities from
 * finer noise on the land, and a fresnel shell for the atmosphere. Two draw
 * calls and no texture to stream.
 */

/**
 * Placed so that from the global anchor its limb rises out of the lower right
 * of the frame, the way the art direction frames it: a curve that gives the
 * void a floor, never a disc competing with the islands for the middle.
 */
const POSITION = new Vector3(3_770, -4_340, -4_090);
const RADIUS = 1_700;
/** Where the light comes from: high behind the camera's right shoulder. */
const SUN = new Vector3(0.55, 0.45, 0.7).normalize();

export function Planet(): JSX.Element {
  const reducedMotion = useSession((state) => state.reducedMotion);

  const surface = useMemo(
    () =>
      new ShaderMaterial({
        fog: false,
        uniforms: {
          uSun: { value: SUN },
          uTime: { value: 0 },
          uOcean: { value: new Color('#06131f') },
          uLand: { value: new Color('#16242a') },
          uCity: { value: new Color('#ffb869') },
          uRim: { value: new Color('#4aa3ff') },
        },
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vView;
          varying vec3 vLocal;
          void main() {
            vLocal = normalize(position);
            vNormal = normalize(mat3(modelMatrix) * normal);
            vec4 world = modelMatrix * vec4(position, 1.0);
            vView = normalize(cameraPosition - world.xyz);
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: `
          uniform vec3 uSun;
          uniform float uTime;
          uniform vec3 uOcean;
          uniform vec3 uLand;
          uniform vec3 uCity;
          uniform vec3 uRim;
          varying vec3 vNormal;
          varying vec3 vView;
          varying vec3 vLocal;
          ${NOISE_GLSL}
          void main() {
            // Longitude and latitude, drifting so the planet turns very slowly.
            float lon = atan(vLocal.z, vLocal.x) + uTime * 0.002;
            float lat = asin(clamp(vLocal.y, -1.0, 1.0));
            vec2 map = vec2(lon * 2.2, lat * 3.4);
            float continents = smoothstep(0.48, 0.58, pwFbm(map * 1.3 + 4.0));
            float day = clamp(dot(vNormal, uSun), 0.0, 1.0);
            float night = 1.0 - smoothstep(-0.05, 0.25, dot(vNormal, uSun));
            vec3 ground = mix(uOcean, uLand, continents);
            vec3 colour = ground * (0.12 + day * 0.9);
            // Cities on the land, on the night side: fine clustered noise.
            float cluster = smoothstep(0.62, 0.8, pwFbm(map * 9.0 + 11.0));
            float sparkle = smoothstep(0.55, 0.9, pwNoise(map * 60.0));
            colour += uCity * continents * cluster * sparkle * night * 1.4;
            // The limb: atmosphere thickening toward the edge of the disc.
            float fresnel = pow(1.0 - clamp(dot(vNormal, vView), 0.0, 1.0), 3.0);
            colour += uRim * fresnel * (0.25 + day * 1.2);
            gl_FragColor = vec4(colour, 1.0);
          }
        `,
      }),
    [],
  );

  const halo = useMemo(
    () =>
      new ShaderMaterial({
        fog: false,
        transparent: true,
        depthWrite: false,
        side: BackSide,
        blending: AdditiveBlending,
        uniforms: { uRim: { value: new Color('#3d8fff') }, uSun: { value: SUN } },
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            vNormal = normalize(mat3(modelMatrix) * normal);
            vec4 world = modelMatrix * vec4(position, 1.0);
            vView = normalize(cameraPosition - world.xyz);
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: `
          uniform vec3 uRim;
          uniform vec3 uSun;
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            // Seen from inside the shell: brightest just outside the limb,
            // falling away into space.
            float edge = pow(clamp(1.0 + dot(vNormal, vView), 0.0, 1.0), 6.0);
            float lit = 0.35 + 0.65 * clamp(dot(-vNormal, uSun) * 0.5 + 0.5, 0.0, 1.0);
            gl_FragColor = vec4(uRim * edge * lit * 0.6, edge);
          }
        `,
      }),
    [],
  );

  useEffect(
    () => () => {
      surface.dispose();
      halo.dispose();
    },
    [surface, halo],
  );

  useFrame((state) => {
    if (reducedMotion) {
      return;
    }
    const time = surface.uniforms['uTime'];
    if (time !== undefined) {
      time.value = state.clock.elapsedTime;
    }
  });

  return (
    <group position={POSITION} renderOrder={-1}>
      <mesh material={surface} frustumCulled={false}>
        <sphereGeometry args={[RADIUS, 96, 64]} />
      </mesh>
      <mesh material={halo} frustumCulled={false}>
        <sphereGeometry args={[RADIUS * 1.025, 96, 64]} />
      </mesh>
    </group>
  );
}
