import { Color, MeshStandardMaterial } from 'three';
import { NOISE_GLSL } from './Atmosphere.js';
import { glslFloat } from './glsl.js';

/**
 * The contested ground, as a surface (§38.3, §36.4, §36.10).
 *
 * It was a flat plate in one unlit colour: the only thing on the island that
 * the world's light did not touch, and the same whether the battle on it was
 * level or a rout. Every delivered battle frame has the ground between the two
 * armies built — metal decking in plates — and marked by the fight: scorched
 * and glowing where the fire meets.
 *
 * So it is a lit material now, patched like the plateau's ground (`ground.ts`)
 * rather than a new shader, so it keeps every lighting term three gives a
 * standard material, fog included:
 *
 * - **Plates** on the same 15-unit grid the lit paving is laid on, each a
 *   slightly different tone, with dark seams between them.
 * - **Wear** from low-frequency noise, so the scuffing is in places.
 * - **Heat along the frontline**: the ground where the two sides' fire lands
 *   scorched dark and glowing faintly warm, following the eased marker and as
 *   hot as the battle is fought (`groundHeat`). Under the bloom threshold: the
 *   ground is lit by the fight, it is not a light of its own (§36.5).
 *
 * Neutral by construction (§38.3): grey metal and the colour of fire, never
 * either side's accent — the frontline is where both sides' rounds land.
 *
 * Computed in the floor's own space: the ground is a box centred on the
 * sector, x across the battle and z along the frontline.
 */

/** The plates, one per cell of the lit paving grid. */
const PLATE = 15;

/** Decking, cold and dark. Lit by the world like everything else on the deck. */
const DECK = new Color('#1b2a33');

/** Fire light in the scorch. Warm, and restrained. */
const EMBER = new Color('#ff7a36');

export interface BattleGround {
  readonly material: MeshStandardMaterial;
  /** Where the frontline stands, in the floor's own x. */
  readonly front: { value: number };
  /** How hot it burns, `0` to `1` (`groundHeat`). */
  readonly heat: { value: number };
  /** Seconds, for the flicker. Held still under reduced motion (§83.3). */
  readonly time: { value: number };
}

export function battleGround(): BattleGround {
  const front = { value: 0 };
  const heat = { value: 0 };
  const time = { value: 0 };

  const material = new MeshStandardMaterial({
    color: DECK,
    metalness: 0.45,
    roughness: 0.58,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms['pwFront'] = front;
    shader.uniforms['pwHeat'] = heat;
    shader.uniforms['pwTime'] = time;
    shader.uniforms['pwEmber'] = { value: EMBER };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 pwFloor;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        pwFloor = transformed;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float pwFront;
        uniform float pwHeat;
        uniform float pwTime;
        uniform vec3 pwEmber;
        varying vec3 pwFloor;
        float pwScorch;
        ${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Plates on the paving grid, each its own tone, seams filtered with
          // distance so a far strip does not shimmer.
          vec2 cell = pwFloor.xz / ${glslFloat(PLATE)};
          vec2 inCell = fract(cell);
          vec2 id = floor(cell);
          float footprint = max(length(fwidth(cell)), 1e-4);
          float edge = min(min(inCell.x, inCell.y), min(1.0 - inCell.x, 1.0 - inCell.y));
          float seam = (1.0 - smoothstep(0.0, 0.02 + footprint, edge)) * (1.0 - smoothstep(0.3, 0.8, footprint));
          float tone = 0.8 + pwHash(id + 7.0) * 0.4;

          // Scuffing, in places rather than everywhere.
          float wear = pwFbm(pwFloor.xz * 0.06);
          float scuff = smoothstep(0.52, 0.78, wear);

          // Scorch along the frontline: a band either side of it, broken up by
          // noise so it reads as burnt ground rather than as a stripe.
          float reach = 7.0 + 6.0 * pwHeat;
          float across = abs(pwFloor.x - pwFront);
          float broken = 0.55 + 0.45 * pwFbm(pwFloor.xz * 0.12 + vec2(3.1, 0.0));
          pwScorch = pwHeat * (1.0 - smoothstep(0.0, reach, across)) * broken;

          vec3 deck = diffuseColor.rgb * tone * (1.0 - 0.45 * seam) * (1.0 - 0.3 * scuff);
          diffuseColor.rgb = mix(deck, deck * 0.35, clamp(pwScorch, 0.0, 1.0));
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // What is still burning in the scorch: embers where the noise runs
          // hot, flickering each at its own rate. At its brightest this is a
          // luminance around 0.2 against a bloom threshold of 0.82, so the
          // fight lights the ground rather than the ground becoming a lamp
          // (§36.5).
          float embers = smoothstep(0.5, 0.82, pwFbm(pwFloor.xz * 0.35 + vec2(0.0, pwTime * 0.15)));
          float flicker = 0.7 + 0.3 * sin(pwTime * 3.0 + pwFloor.z * 0.8);
          totalEmissiveRadiance += pwEmber * clamp(pwScorch, 0.0, 1.0) * embers * flicker * 0.4;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'pw-battle-ground';

  return { material, front, heat, time };
}
