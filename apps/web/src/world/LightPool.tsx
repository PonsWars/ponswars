import { useEffect, useMemo, type JSX } from 'react';
import { AdditiveBlending, Color, ShaderMaterial } from 'three';

/**
 * Light pooled on the ground among buildings (§38.2, §36.5).
 *
 * A disc drawn additively with a soft radial falloff: brightest in the middle,
 * gone by the edge. Depth-tested, so whatever stands in it occludes it and it
 * reads as light on the ground between the buildings rather than as a decal
 * over them.
 *
 * Every delivered world frame bathes its cities in their own light from below.
 * Without it a lit city was dark towers on a dark plate: the windows were lit
 * and nothing they shone on was.
 */
export function LightPool({
  radius,
  colour,
  strength,
  stretch = [1, 1],
  position = [0, 0, 0],
}: {
  /** Radius of the disc, in world units, before `stretch`. */
  readonly radius: number;
  readonly colour: string;
  /** Brightness at the centre. Additive, so small numbers: 0.1 to 0.5. */
  readonly strength: number;
  /** Scale along the ground's two axes, for a pool longer than it is wide. */
  readonly stretch?: readonly [number, number];
  readonly position?: readonly [number, number, number];
}): JSX.Element {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        toneMapped: false,
        uniforms: {
          uColour: { value: new Color(colour) },
          uStrength: { value: strength },
        },
        vertexShader: `
          varying vec2 vUnit;
          void main() {
            // The circle's own unit coordinates, so the falloff follows any
            // stretch applied to the mesh.
            vUnit = uv * 2.0 - 1.0;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uColour;
          uniform float uStrength;
          varying vec2 vUnit;
          void main() {
            float r = length(vUnit);
            float pool = exp(-r * r * 3.2) * (1.0 - smoothstep(0.85, 1.0, r));
            gl_FragColor = vec4(uColour * pool * uStrength, 1.0);
          }
        `,
      }),
    [colour, strength],
  );

  useEffect(
    () => () => {
      material.dispose();
    },
    [material],
  );

  return (
    <mesh
      material={material}
      position={position}
      rotation={[-Math.PI / 2, 0, 0]}
      scale={[stretch[0], stretch[1], 1]}
    >
      <circleGeometry args={[radius, 64]} />
    </mesh>
  );
}
