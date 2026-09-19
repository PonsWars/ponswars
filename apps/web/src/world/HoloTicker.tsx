import type { ActiveTicker } from '@ponswars/shared-types';
import type { DetailLevel } from '@ponswars/world-runtime';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import {
  AdditiveBlending,
  CanvasTexture,
  DoubleSide,
  MeshBasicMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { useSession } from '../state/session.js';
import { DISTRICT_CENTRE_X, HOLO_BANDS, tapeText, type HoloBand } from './holo-ticker.js';
import { useFinalPush } from './useFinalPush.js';

/**
 * Holographic ticker tape round a district (§38.11, §36.4).
 *
 * `holo-ticker.ts` decides what the tape says and where the bands run; this
 * draws them. The text is painted once into a canvas and scrolled by moving
 * the texture, so a band costs one draw call and no work per frame beyond one
 * number.
 *
 * Drawn in the page's own data face, already loaded for the HUD — no font is
 * fetched for this, which matters under the client's content security policy
 * as much as it does for load time.
 *
 * Additive and faint. §36.5 keeps faction colour an accent: the tape is light
 * passing through the skyline, not a sign bolted to it, and it brightens when
 * the battle goes live (§38.6) rather than burning at full through Pick Phase.
 */

/** The canvas the tape is painted on. Wide, because the band is. */
const TAPE_WIDTH = 2048;
const TAPE_HEIGHT = 64;

/** The face it is painted in: the data role from the design tokens. */
const TAPE_FONT = '600 38px "IBM Plex Mono", "JetBrains Mono", ui-monospace, monospace';

/**
 * How bright the tape is before the battle and during it. `CALIBRATE` (§59.4).
 *
 * Set on the running world rather than on paper: at a third, the tape was
 * present, correctly placed, and invisible from every camera a player uses.
 */
const OPACITY_CALM = 0.45;
const OPACITY_LIVE = 0.8;
/** Full, for the last thirty seconds (§38.6: intensity rises). */
const OPACITY_FINAL_PUSH = 1;

/** Only sectors near the camera draw tape; a far one is an outline (§37.6). */
const DRAWS: Readonly<Record<DetailLevel, boolean>> = {
  FULL: true,
  REDUCED: true,
  SILHOUETTE: false,
  CULLED: false,
};

function paintTape(canvas: HTMLCanvasElement, text: string): void {
  const context = canvas.getContext('2d');
  if (context === null) {
    return;
  }
  context.clearRect(0, 0, TAPE_WIDTH, TAPE_HEIGHT);
  // The tape's own edges: two thin rules, so it reads as a strip of tape
  // rather than as letters floating loose.
  context.fillStyle = 'rgba(255, 255, 255, 0.35)';
  context.fillRect(0, 3, TAPE_WIDTH, 2);
  context.fillRect(0, TAPE_HEIGHT - 5, TAPE_WIDTH, 2);
  context.font = TAPE_FONT;
  context.textBaseline = 'middle';
  context.fillStyle = '#ffffff';
  const step = Math.max(context.measureText(text).width, 1);
  for (let x = 0; x < TAPE_WIDTH; x += step) {
    context.fillText(text, x, TAPE_HEIGHT / 2 + 1);
  }
}

/** Roughly how long a band is, so the text keeps its proportions round it. */
function bandLength(band: HoloBand): number {
  const { radiusX: a, radiusZ: b } = band;
  // Ramanujan's approximation of an ellipse's perimeter.
  const perimeter = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  return perimeter * band.arc;
}

export function HoloTicker({
  side,
  ticker,
  accent,
  detail,
  live,
}: {
  readonly side: -1 | 1;
  readonly ticker: ActiveTicker;
  readonly accent: string;
  readonly detail: DetailLevel;
  readonly live: boolean;
}): JSX.Element | null {
  const reducedMotion = useSession((state) => state.reducedMotion);
  const pushing = useFinalPush();
  const draws = DRAWS[detail];

  const canvas = useMemo(() => {
    if (typeof document === 'undefined') {
      return null;
    }
    const element = document.createElement('canvas');
    element.width = TAPE_WIDTH;
    element.height = TAPE_HEIGHT;
    paintTape(element, tapeText(ticker));
    return element;
  }, [ticker]);

  // One material per band, each with its own copy of the texture: the image is
  // shared, the offset is not, and that is what lets two bands run opposite
  // ways.
  const bands = useMemo(() => {
    if (canvas === null) {
      return [];
    }
    return HOLO_BANDS.map((band) => {
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.repeat.x = Math.max(
        1,
        Math.round(bandLength(band) / ((TAPE_WIDTH / TAPE_HEIGHT) * band.height)),
      );
      const material = new MeshBasicMaterial({
        map: texture,
        color: accent,
        transparent: true,
        opacity: OPACITY_CALM * band.strength,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
        // A hologram, not a lit surface: the world's fog would grey it into
        // the weather it is meant to stand out from.
        fog: false,
      });
      // Facing out over the deck's edge, away from the contested ground, when
      // it covers only part of a turn.
      const facing = side === 1 ? Math.PI / 2 : -Math.PI / 2;
      return {
        band,
        texture,
        material,
        thetaStart: facing - band.arc * Math.PI,
        thetaLength: band.arc * Math.PI * 2,
      };
    });
  }, [canvas, accent, side]);

  // The page's data face may still be loading when the tape is first painted.
  // Repainted once it has arrived, so the tape is set in the face the HUD uses
  // rather than in whatever the browser fell back to.
  useEffect(() => {
    if (canvas === null || typeof document === 'undefined') {
      return;
    }
    let current = true;
    void document.fonts.load(TAPE_FONT).then(() => {
      if (!current) {
        return;
      }
      paintTape(canvas, tapeText(ticker));
      for (const { texture } of bands) {
        texture.needsUpdate = true;
      }
    });
    return () => {
      current = false;
    };
  }, [canvas, bands, ticker]);

  useEffect(() => {
    const level = !live ? OPACITY_CALM : pushing ? OPACITY_FINAL_PUSH : OPACITY_LIVE;
    for (const { band, material } of bands) {
      material.opacity = level * band.strength;
    }
  }, [bands, live, pushing]);

  useEffect(
    () => () => {
      for (const { texture, material } of bands) {
        texture.dispose();
        material.dispose();
      }
    },
    [bands],
  );

  useFrame((_, delta) => {
    // §83.3: the tape stays, and stops.
    if (reducedMotion || !draws) {
      return;
    }
    for (const { band, texture } of bands) {
      texture.offset.x = (texture.offset.x + band.scroll * delta) % 1;
    }
  });

  if (!draws) {
    return null;
  }

  return (
    <group position={[side * DISTRICT_CENTRE_X, 0, 0]}>
      {bands.map(({ band, material, thetaStart, thetaLength }) => (
        <mesh
          key={band.y}
          position={[0, band.y, 0]}
          scale={[band.radiusX, 1, band.radiusZ]}
          material={material}
          renderOrder={2}
        >
          <cylinderGeometry args={[1, 1, band.height, 48, 1, true, thetaStart, thetaLength]} />
        </mesh>
      ))}
    </group>
  );
}
