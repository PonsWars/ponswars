import type { MeshBasicMaterial } from 'three';
import { glslFloat } from './glsl.js';

/**
 * Data running along a channel (§38.11, §36.4).
 *
 * §38.11 asks for market data as environment — *routing and energy*, never
 * charts on the ground — and a strip of light that only sits there is a lamp,
 * not a route. So a pulse runs down each channel toward the battle, one after
 * another, the way a feed runs into the thing it feeds.
 *
 * Every channel runs at its own phase, from where it stands, so a flank of
 * them never pulses in step: a row flashing together reads as a sign, and a
 * sign is decoration.
 *
 * Presentation only. The pulse carries no reading of any battle — the
 * channels are the sector's, and §38.3 keeps a sector neutral.
 */

/** How many times a second a pulse runs the length of a channel. `CALIBRATE` (§59.4). */
export const FLOW_RATE = 0.32;

/**
 * How bright the channel is between pulses, and at a pulse's crest, as a
 * multiple of its colour. `CALIBRATE` (§59.4).
 *
 * The floor keeps the channel a channel when no pulse is on it. The crest is
 * the only part of it allowed past the bloom threshold, and only just: §36.5
 * keeps emissive restrained, and a crest that bloomed hard would turn every
 * sector into a neon sign.
 */
export const FLOW_FLOOR = 0.45;
export const FLOW_CREST = 2.4;

/** How much of the channel's length one pulse covers. */
export const FLOW_LENGTH = 0.35;

export interface DataFlow {
  readonly material: MeshBasicMaterial;
  /** Seconds, for the pulse. Held still under reduced motion (§83.3). */
  readonly time: { value: number };
}

/**
 * Adds the running pulse to a basic material, in place, for instanced unit
 * boxes whose length runs along local z.
 */
export function withDataFlow(material: MeshBasicMaterial): DataFlow {
  const time = { value: 0 };

  material.onBeforeCompile = (shader) => {
    shader.uniforms['pwFlowTime'] = time;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float pwAlong;
        varying float pwPhase;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // Along the box's length, -0.5 at its inner end to 0.5 at its outer.
        pwAlong = position.z;
        pwPhase = 0.0;
        #ifdef USE_INSTANCING
          // From where the channel stands, so no two run in step.
          pwPhase = fract(instanceMatrix[3].x * 0.071 + instanceMatrix[3].z * 0.113);
        #endif`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float pwFlowTime;
        varying float pwAlong;
        varying float pwPhase;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // Where along this channel the pulse is, 0 to 1. Adding time moves a
          // fixed phase toward smaller 'along': the pulse runs inward, from the
          // rim toward the battle.
          float travel = fract(pwAlong + 0.5 + pwFlowTime * ${glslFloat(FLOW_RATE)} + pwPhase);
          float head = ${glslFloat(FLOW_LENGTH)};
          // A sharp front and a long tail behind it.
          float pulse = smoothstep(0.0, head * 0.25, travel) * (1.0 - smoothstep(head * 0.25, head, travel));
          diffuseColor.rgb *= ${glslFloat(FLOW_FLOOR)} + pulse * ${glslFloat(FLOW_CREST - FLOW_FLOOR)};
        }`,
      );
  };
  // One program for every channel, and a different one from a plain basic
  // material with the same parameters.
  material.customProgramCacheKey = () => 'pw-data-flow';

  return { material, time };
}
