import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import { Color, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import type { DetailLevel } from '@ponswars/world-runtime';
import { useSession } from '../state/session.js';
import { withDataFlow } from './data-flow.js';
import { InstancedField, type Placement } from './InstancedField.js';
import { channelStrip, sectorIdentity } from './sector-identity.js';
import { withGround } from './ground.js';

/**
 * The terrain that makes a sector somewhere (§38.4, §38.9, §38.11).
 *
 * `sector-identity.ts` decides the shapes; this draws them. Two fields, so the
 * whole of a sector's landscape is two draw calls however much of it there is:
 * the stone it is cut from, and the data channels running through it — with
 * data running down them toward the battle (`data-flow.ts`).
 *
 * The stone takes the same ground shader the plateau does, so a ridge is the
 * same paving and wear as the deck it rises out of rather than a clean box
 * sitting on a textured floor. Neutral by construction (§38.3): nothing here
 * takes a faction's colour, and the only light in it is the world's own.
 *
 * Scenery is the first thing LOD gives up (§37.6, §82.1). At silhouette range
 * an island is an outline, and these are inside it.
 */

/** The stone, across the range `tone` picks from. Neutral, like the deck. */
const STONE_DARK = new Color('#1a1f24');
const STONE_LIGHT = new Color('#3a4149');

/**
 * A data channel's light: the world's own teal, under the bloom threshold.
 * Opaque — a thin strip of light, not a pane of tinted glass.
 */
const CHANNEL = '#3a9aa8';

/** How much of a sector's landscape each detail level draws. */
const SHARE: Readonly<Record<DetailLevel, number>> = {
  FULL: 1,
  // The tall things, which are what a neighbouring island reads as.
  REDUCED: 0.55,
  SILHOUETTE: 0,
  CULLED: 0,
};

export function SectorTerrain({
  index,
  detail,
}: {
  readonly index: number;
  readonly detail: DetailLevel;
}): JSX.Element | null {
  const share = SHARE[detail];

  const { stone, channels, tones } = useMemo(() => {
    const identity = sectorIdentity(index);
    // Tallest first, so a reduced sector keeps the blocks that carry its
    // outline and drops the ones that only fill it in.
    const ordered = [...identity.blocks].sort((a, b) => b.size[1] - a.size[1]);
    const kept = ordered.slice(0, Math.round(ordered.length * share));
    const place = (block: (typeof kept)[number]): Placement => ({
      position: block.position,
      scale: block.size,
      rotation: [0, block.rotation, 0],
    });
    return {
      // Every block is stone. A lit one carries its channel along its top.
      stone: kept.map(place),
      channels: kept
        .filter((block) => block.lit)
        .map((block): Placement => {
          const strip = channelStrip(block);
          return { position: strip.position, scale: strip.size, rotation: [0, strip.rotation, 0] };
        }),
      tones: kept.map((block) => block.tone),
    };
  }, [index, share]);

  const material = useMemo(() => {
    // One material for the field, so the variation between blocks has to come
    // from somewhere else: the ground shader already varies by world position,
    // which is why a row of identical boxes does not read as identical.
    const stoneMaterial = new MeshStandardMaterial({
      color: STONE_DARK.clone().lerp(
        STONE_LIGHT,
        tones.length === 0 ? 0.4 : tones.reduce((sum, tone) => sum + tone, 0) / tones.length,
      ),
      roughness: 0.92,
      metalness: 0.08,
    });
    return withGround(stoneMaterial, 7);
  }, [tones]);

  // Basic rather than standard: a channel is light, not a lit surface, and a
  // material that took the key light would go dark whenever the camera came
  // round to its shadow side.
  const flow = useMemo(() => withDataFlow(new MeshBasicMaterial({ color: CHANNEL })), []);
  const reducedMotion = useSession((state) => state.reducedMotion);

  useEffect(
    () => () => {
      flow.material.dispose();
    },
    [flow],
  );

  useFrame((_, delta) => {
    // §83.3: the channels stay lit, and the data stops running.
    if (!reducedMotion) {
      flow.time.value += delta;
    }
  });

  if (share === 0 || (stone.length === 0 && channels.length === 0)) {
    return null;
  }

  return (
    <group>
      <InstancedField placements={stone}>
        <boxGeometry key="terrain" args={[1, 1, 1]} />
        <primitive key="terrain-material" object={material} attach="material" />
      </InstancedField>
      {channels.length > 0 ? (
        <InstancedField placements={channels}>
          <boxGeometry key="channel" args={[1, 1, 1]} />
          <primitive key="channel-material" object={flow.material} attach="material" />
        </InstancedField>
      ) : null}
    </group>
  );
}
