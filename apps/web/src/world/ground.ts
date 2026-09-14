import { Color, type MeshStandardMaterial } from 'three';
import { NOISE_GLSL } from './Atmosphere.js';

/**
 * The surface of a plateau, drawn by the shader (§38.1, §38.9).
 *
 * A plateau was one flat colour, and from the global view that is most of an
 * island: a dark disc with a battlefield on it. Every delivered world frame
 * gives that ground texture — paved slabs, worn and patched, with growth in the
 * seams and scorching where the fighting has been — which is what makes it read
 * as a place people built on rather than a plate.
 *
 * Computed from world position, like the windows: the plateaus have no UVs to
 * hang a texture on, and a texture would tile across a disc anyway.
 *
 * - Slabs on a world grid, each a slightly different tone.
 * - Seams between them, darker.
 * - Patches of dark growth and of scorch from low-frequency noise, so the wear
 *   is in places rather than everywhere.
 * - On the walls, bands instead of slabs.
 *
 * Neutral by construction (§38.3): nothing here takes a faction's colour.
 */

const GROWTH = new Color('#1f2b22');
const SCORCH = new Color('#0a0b0c');

export function withGround(material: MeshStandardMaterial, slab = 9): MeshStandardMaterial {
  material.onBeforeCompile = (shader) => {
    shader.uniforms['pwSlab'] = { value: slab };
    shader.uniforms['pwGrowth'] = { value: GROWTH };
    shader.uniforms['pwScorch'] = { value: SCORCH };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 pwGroundPosition;
        varying vec3 pwGroundNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        pwGroundPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        pwGroundNormal = mat3(modelMatrix) * objectNormal;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float pwSlab;
        uniform vec3 pwGrowth;
        uniform vec3 pwScorch;
        varying vec3 pwGroundPosition;
        varying vec3 pwGroundNormal;
        ${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 n = pwGroundNormal / max(length(pwGroundNormal), 1e-5);
          float up = smoothstep(0.5, 0.85, n.y);

          // Slabs, and the seams between them, filtered with distance so a far
          // plateau does not shimmer with grid lines.
          vec2 cell = pwGroundPosition.xz / pwSlab;
          vec2 inCell = fract(cell);
          vec2 id = floor(cell);
          float footprint = max(length(fwidth(cell)), 1e-4);
          float seamWidth = 0.05 + footprint;
          float seam = 1.0 - smoothstep(0.0, seamWidth, min(min(inCell.x, inCell.y), min(1.0 - inCell.x, 1.0 - inCell.y)));
          seam *= 1.0 - smoothstep(0.3, 0.8, footprint);
          float tone = 0.82 + pwHash(id) * 0.36;

          // Wear in places: growth where the noise is high, scorch where low.
          vec2 wide = pwGroundPosition.xz * 0.018;
          float wear = pwFbm(wide);
          float growth = smoothstep(0.58, 0.75, wear);
          float scorch = 1.0 - smoothstep(0.22, 0.34, wear);

          vec3 top = diffuseColor.rgb * tone * (1.0 - seam * 0.45);
          top = mix(top, pwGrowth, growth * 0.55);
          top = mix(top, pwScorch, scorch * 0.5);

          // Walls: bands of stone rather than slabs.
          float bands = 0.85 + 0.3 * step(0.5, fract(pwGroundPosition.y / 3.5));
          vec3 wall = diffuseColor.rgb * bands;

          diffuseColor.rgb = mix(wall, top, up);
        }`,
      );
  };
  material.customProgramCacheKey = () => `pw-ground:${String(slab)}`;
  material.needsUpdate = true;
  return material;
}
