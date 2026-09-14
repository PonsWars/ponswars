import { Color, type MeshStandardMaterial } from 'three';

/**
 * Lit windows on a building, drawn by the shader (§36.4, §38.10).
 *
 * Every delivered world frame is a city at night: thousands of small lit
 * windows up the sides of every structure, which is most of what makes those
 * islands read as inhabited places rather than grey blocks. The district kit
 * has no UVs to hang a texture on, and a texture would tile visibly across a
 * skyline anyway — so the windows are computed per pixel from where the pixel
 * is in the world.
 *
 * - Only on walls: a face turned upward is a roof and gets none.
 * - A grid of floors and bays in world units, so a tall tower has more floors
 *   than a short one rather than stretched ones.
 * - Each window lit or dark by a hash of its cell, so the pattern is fixed:
 *   the same city on every frame and every client.
 * - Warm and cold light mixed, with the faction accent on a share of them:
 *   §36.5 keeps faction colour an accent, and this is exactly an accent.
 * - Filtered with distance, so a far skyline glows in bands instead of
 *   crawling with sub-pixel speckle.
 *
 * Emission above the bloom threshold, so windows throw a little light into the
 * air around them the way the art direction's do.
 */

export interface CityLightOptions {
  /** The faction accent a share of the windows take. */
  readonly accent: string;
  /** Share of windows lit, 0–1. */
  readonly density: number;
  /** Brightness of a lit window. */
  readonly intensity: number;
  /** Floor height and bay width, in world units. */
  readonly floor?: number;
  readonly bay?: number;
}

const WARM = new Color('#ffc98a');
const COLD = new Color('#a9dcff');

/**
 * Adds the windows to a standard material, in place.
 *
 * `onBeforeCompile` rather than a new shader, so the building keeps every
 * lighting term three gives a standard material — environment, key, fog — and
 * the windows are only added on top of its emissive.
 */
export function withCityLights(
  material: MeshStandardMaterial,
  options: CityLightOptions,
): MeshStandardMaterial {
  const accent = new Color(options.accent);
  const floor = options.floor ?? 3.2;
  const bay = options.bay ?? 2.6;

  material.onBeforeCompile = (shader) => {
    shader.uniforms['pwWarm'] = { value: WARM };
    shader.uniforms['pwCold'] = { value: COLD };
    shader.uniforms['pwAccent'] = { value: accent };
    shader.uniforms['pwDensity'] = { value: options.density };
    shader.uniforms['pwIntensity'] = { value: options.intensity };
    shader.uniforms['pwCell'] = { value: [bay, floor] };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 pwWorldPosition;
        varying vec3 pwWorldNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec4 pwLocal = vec4(transformed, 1.0);
          vec3 pwNormal = objectNormal;
          #ifdef USE_INSTANCING
            pwLocal = instanceMatrix * pwLocal;
            pwNormal = mat3(instanceMatrix) * pwNormal;
          #endif
          pwWorldPosition = (modelMatrix * pwLocal).xyz;
          pwWorldNormal = normalize(mat3(modelMatrix) * pwNormal);
        }`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 pwWarm;
        uniform vec3 pwCold;
        uniform vec3 pwAccent;
        uniform float pwDensity;
        uniform float pwIntensity;
        uniform vec2 pwCell;
        varying vec3 pwWorldPosition;
        varying vec3 pwWorldNormal;
        float pwWindowHash(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.x + p.y) * p.z);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 n = normalize(pwWorldNormal);
          // Walls only: a roof or a floor carries no windows.
          float wall = 1.0 - smoothstep(0.35, 0.6, abs(n.y));
          // Along the wall: whichever horizontal axis the wall runs along.
          float along = abs(n.x) > abs(n.z) ? pwWorldPosition.z : pwWorldPosition.x;
          vec2 facade = vec2(along, pwWorldPosition.y) / pwCell;
          vec2 cell = floor(facade);
          vec2 inCell = fract(facade);
          // A window is the middle of its cell, with frame around it.
          // Small against the wall: a lit city at night is dark towers with
          // points of light in them, and a large pane reads as a lit wall.
          float pane = step(0.3, inCell.x) * step(inCell.x, 0.7)
                     * step(0.34, inCell.y) * step(inCell.y, 0.64);
          // Which face this is matters too, or opposite walls light as one.
          vec3 key = vec3(cell, floor(dot(n, vec3(3.0, 5.0, 7.0)) + 0.5));
          float roll = pwWindowHash(key);
          float lit = step(1.0 - pwDensity, roll);
          float tone = pwWindowHash(key + 17.0);
          vec3 light = tone < 0.18 ? pwAccent : (tone < 0.62 ? pwWarm : pwCold);
          float strength = mix(0.55, 1.0, pwWindowHash(key + 41.0));
          vec3 windows = light * pane * lit * strength;

          // Filtered with distance. A window smaller than a pixel is not a
          // window, it is noise: individual panes alias into a speckle that
          // crawls as the camera moves. So as a cell shrinks below a few
          // pixels the facade blends to what those windows average to — the
          // glow of a lit wall, with each floor's share of warm and cold.
          float footprint = max(length(fwidth(facade)), 1e-4);
          float resolved = 1.0 - smoothstep(0.06, 0.2, footprint);
          // What the panes average to — their share of the cell, the share lit,
          // their mean strength, and the mix of tones above — dimmed further,
          // because from far away the eye reads a dark wall with light in it,
          // not a wall glowing evenly.
          vec3 average = (pwWarm * 0.44 + pwCold * 0.38 + pwAccent * 0.18)
                       * (0.4 * 0.3) * pwDensity * 0.78 * 0.15;
          // The average still varies floor by floor, so a far tower keeps
          // bands of light rather than a flat wash.
          float band = mix(0.6, 1.25, pwWindowHash(vec3(0.0, cell.y, key.z)));
          vec3 glow = mix(average * band, windows, resolved);

          // Between the two, where a window is a pixel but a floor is still a
          // few: runs of lit floor. A run is a whole floor across several bays
          // — an office level with its lights on — which is big enough to
          // stay a line of light when single windows no longer can.
          vec2 run = vec2(floor(facade.x / 7.0), cell.y);
          float runLit = step(0.9 - pwDensity * 0.25, pwWindowHash(vec3(run, key.z + 91.0)));
          float runBand = smoothstep(0.3, 0.38, inCell.y) * (1.0 - smoothstep(0.58, 0.66, inCell.y));
          float floorFootprint = max(fwidth(facade.y), 1e-4);
          float runVisible = (1.0 - resolved) * (1.0 - smoothstep(0.25, 0.6, floorFootprint));
          vec3 runTone = pwWindowHash(vec3(run, 7.0)) < 0.25 ? pwAccent : pwWarm;
          glow += runTone * runLit * runBand * runVisible * 0.2;
          totalEmissiveRadiance += glow * wall * pwIntensity;
        }`,
      );
  };
  // Distinct programs for distinct options, rather than one cached program
  // silently shared by every accent.
  material.customProgramCacheKey = () =>
    `pw-city-lights:${options.accent}:${String(options.density)}:${String(options.intensity)}:${String(floor)}:${String(bay)}`;
  material.needsUpdate = true;
  return material;
}
