import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import { Color, ShaderMaterial } from 'three';
import { useSession } from '../state/session.js';
import { VOID_SKY } from './navigation-config.js';

/**
 * The weather the world floats in (§38.1, §38.10).
 *
 * The islands hung in a black void with stars behind them and nothing below.
 * Every delivered world frame puts them over a sea of cloud instead — light
 * from above on the cloud tops, the Market Core glowing up through the layer
 * beneath it, the whole thing melting into the horizon. That sea is most of
 * what makes those frames read as a *place* rather than objects on black.
 *
 * Procedural rather than painted. A texture tiles, and a tiled cloud is
 * unmistakable from above; a shader has no seam and no size, costs one draw
 * call per layer, and drifts without an asset to stream. Two layers at
 * different depths and speeds give the parallax that sells height.
 *
 * Nothing here moves under §83.3's reduced motion: the drift stops, the cloud
 * stays.
 */

/**
 * Value noise and fractal Brownian motion, as a GLSL chunk.
 *
 * Shared with the sky shader so the wisps at the horizon and the sea below it
 * are the same weather rather than two.
 */
export const NOISE_GLSL = `
  float pwHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float pwNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = pwHash(i);
    float b = pwHash(i + vec2(1.0, 0.0));
    float c = pwHash(i + vec2(0.0, 1.0));
    float d = pwHash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float pwFbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    // Rotated between octaves, so the layers do not line up on the grid the
    // noise is built on — without it fBm reads as squares at a distance.
    mat2 turn = mat2(1.6, 1.2, -1.2, 1.6);
    for (int octave = 0; octave < 5; octave++) {
      value += amplitude * pwNoise(p);
      p = turn * p;
      amplitude *= 0.5;
    }
    return value;
  }
`;

/**
 * The two layers, top first.
 *
 * Both well under the lowest rock: the sectors stand at 0 and −18 with crags
 * hanging below them, and a cloud that cut through an island's underside would
 * put it *in* the weather rather than above it.
 */
const LAYERS = [
  { y: -170, scale: 0.0021, drift: 1, opacity: 0.88, lit: '#244a5f', shadow: '#08151e' },
  { y: -260, scale: 0.0012, drift: 0.55, opacity: 0.72, lit: '#17344a', shadow: '#050d14' },
] as const;

/**
 * Where the sea gives out, in world units from the centre.
 *
 * Past the world boundary (2,400) and the fog's far edge (2,600), so the cloud
 * is already the horizon's colour by the time it fades: a sea with a visible
 * edge is a disc, and a disc is a model on a table.
 */
const FADE = 3_600;

/** The Market Core's own light, thrown up through the cloud beneath it (§38.2). */
const CORE_GLOW = '#2a8a78';

export function CloudSea(): JSX.Element {
  const reducedMotion = useSession((state) => state.reducedMotion);

  // Paired with the layer that configures it, rather than a parallel array the
  // render then indexes into: an index lookup is optional by type, and a mesh
  // with no material is not a thing this can ship.
  const sheets = useMemo(
    () =>
      LAYERS.map((layer) => ({
        layer,
        material: new ShaderMaterial({
          transparent: true,
          depthWrite: false,
          fog: false,
          uniforms: {
            uTime: { value: 0 },
            uScale: { value: layer.scale },
            uDrift: { value: layer.drift },
            uOpacity: { value: layer.opacity },
            uFade: { value: FADE },
            uLit: { value: new Color(layer.lit) },
            uShadow: { value: new Color(layer.shadow) },
            uHorizon: { value: new Color(VOID_SKY.horizon) },
            uGlow: { value: new Color(CORE_GLOW) },
          },
          vertexShader: `
              varying vec2 vWorld;
              void main() {
                vec4 world = modelMatrix * vec4(position, 1.0);
                // The noise is sampled in world space, so the sea is one surface
                // under the whole world rather than a pattern stuck to a plane.
                vWorld = world.xz;
                gl_Position = projectionMatrix * viewMatrix * world;
              }
            `,
          fragmentShader: `
              uniform float uTime;
              uniform float uScale;
              uniform float uDrift;
              uniform float uOpacity;
              uniform float uFade;
              uniform vec3 uLit;
              uniform vec3 uShadow;
              uniform vec3 uHorizon;
              uniform vec3 uGlow;
              varying vec2 vWorld;
              ${NOISE_GLSL}
              void main() {
                float dist = length(vWorld);
                vec2 p = vWorld * uScale + vec2(0.012, 0.007) * uTime * uDrift;
                // Warped once by itself. Plain fBm reads as smoke; a warped one
                // reads as weather, with the folds and gaps real cloud has.
                vec2 warp = vec2(pwFbm(p + vec2(3.1, 1.7)), pwFbm(p + vec2(8.3, 2.8)));
                float n = pwFbm(p + warp * 1.4);
                float body = smoothstep(0.38, 0.72, n);
                // Lit from above: the denser a cloud, the more of its top the
                // key light reaches.
                vec3 colour = mix(uShadow, uLit, smoothstep(0.45, 0.95, n));
                colour += uGlow * exp(-dist / 300.0) * body * 0.34;
                // Melting into the horizon, so the sea has no edge.
                colour = mix(colour, uHorizon, smoothstep(uFade * 0.28, uFade, dist));
                float alpha = body * uOpacity * (1.0 - smoothstep(uFade * 0.7, uFade, dist));
                gl_FragColor = vec4(colour, alpha);
              }
            `,
        }),
      })),
    [],
  );

  useEffect(
    () => () => {
      for (const sheet of sheets) {
        sheet.material.dispose();
      }
    },
    [sheets],
  );

  useFrame((state) => {
    if (reducedMotion) {
      return;
    }
    for (const sheet of sheets) {
      const time = sheet.material.uniforms['uTime'];
      if (time !== undefined) {
        time.value = state.clock.elapsedTime;
      }
    }
  });

  return (
    <group>
      {sheets.map(({ layer, material }) => (
        <mesh
          key={layer.y}
          material={material}
          position={[0, layer.y, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          frustumCulled={false}
        >
          {/* One quad: the shading is per pixel, so the geometry carries none of
              the detail and more vertices would buy nothing. */}
          <planeGeometry args={[FADE * 2.2, FADE * 2.2]} />
        </mesh>
      ))}
    </group>
  );
}
