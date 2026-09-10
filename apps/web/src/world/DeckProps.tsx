import { useGLTF } from '@react-three/drei';
import { useMemo, type JSX } from 'react';
import { Box3, Vector3 } from 'three';
import type { DetailLevel } from '@ponswars/world-runtime';
import { InstancedField, preparedGeometry, type Placement } from './InstancedField.js';

/**
 * What a district is made of besides towers (§38.3, §38.5).
 *
 * A deck was a plate with an army standing on it. These are what make it a
 * place the army came *from*: containers stacked at the back, fuel tanks, a
 * chimney, a water tower. None of it means anything — that is the point.
 * §13 keeps every readable thing about a battle in the frontline and the
 * intel panels, so scenery has to be scenery, and a crate that changed with
 * the score would be a second, worse readout.
 *
 * Static meshes, so unlike the units these instance: one draw call per kind
 * however many are standing. CC0 from Kenney's industrial kit — see
 * `docs/operations/third-party-models.md`.
 */

const PROPS = [
  'container-a',
  'container-b',
  'tank',
  'tank-large',
  'chimney',
  'water-tower',
] as const;

type Prop = (typeof PROPS)[number];

/**
 * How tall each prop stands, in world units.
 *
 * Read against the army in front of them: a trooper is 11 and a mech 22, so a
 * container at 9 is something a person walks past and a water tower at 34 is a
 * landmark on the deck. Stated rather than left to the model's own units, for
 * the same reason the units are.
 */
const HEIGHT: Readonly<Record<Prop, number>> = {
  'container-a': 9,
  'container-b': 9,
  tank: 13,
  'tank-large': 18,
  chimney: 26,
  'water-tower': 34,
};

/**
 * How many of each stand on a deck, by detail level (§37.6).
 *
 * Scenery is the first thing to go. At `REDUCED` a neighbouring island keeps
 * the tall silhouettes — the chimney and the tower, which are what read at
 * distance — and loses the crates, which do not.
 */
const COUNT: Readonly<Record<DetailLevel, Readonly<Record<Prop, number>>>> = {
  FULL: {
    'container-a': 5,
    'container-b': 4,
    tank: 2,
    'tank-large': 1,
    chimney: 1,
    'water-tower': 1,
  },
  REDUCED: {
    'container-a': 2,
    'container-b': 0,
    tank: 1,
    'tank-large': 0,
    chimney: 1,
    'water-tower': 1,
  },
  SILHOUETTE: {
    'container-a': 0,
    'container-b': 0,
    tank: 0,
    'tank-large': 0,
    chimney: 0,
    'water-tower': 0,
  },
  CULLED: {
    'container-a': 0,
    'container-b': 0,
    tank: 0,
    'tank-large': 0,
    chimney: 0,
    'water-tower': 0,
  },
};

/**
 * The strip of deck scenery stands on.
 *
 * Behind the army and in front of the towers. The ranks occupy `side * 40`
 * outward to about `side * 68`; the towers start further back again. Anything
 * placed between them would be standing in the middle of a formation.
 */
const DECK_Y = 21;
const NEAR = 70;
const FAR = 84;
const SPREAD = 88;

export function DeckProps({
  side,
  detail,
  seed,
}: {
  readonly side: -1 | 1;
  readonly detail: DetailLevel;
  readonly seed: number;
}): JSX.Element | null {
  const counts = COUNT[detail];

  const placements = useMemo(() => {
    const out = new Map<Prop, Placement[]>();
    let salt = seed;
    for (const prop of PROPS) {
      const list: Placement[] = [];
      for (let index = 0; index < counts[prop]; index += 1) {
        salt += 1;
        const across = pseudo(salt * 3.7);
        const along = pseudo(salt * 7.1);
        list.push({
          position: [side * (NEAR + across * (FAR - NEAR)), DECK_Y, (along - 0.5) * SPREAD],
          // Scaled at render time to the stated height; this carries only the
          // small variation that keeps a row of crates from looking stamped.
          scale: [1, 1, 1],
          rotation: [0, pseudo(salt * 11.9) * Math.PI * 2, 0],
        });
      }
      out.set(prop, list);
    }
    return out;
  }, [counts, seed, side]);

  if (PROPS.every((prop) => counts[prop] === 0)) {
    return null;
  }

  return (
    <group>
      {PROPS.map((prop) => (
        <PropField key={prop} prop={prop} placements={placements.get(prop) ?? []} />
      ))}
    </group>
  );
}

function PropField({
  prop,
  placements,
}: {
  readonly prop: Prop;
  readonly placements: readonly Placement[];
}): JSX.Element | null {
  const { scene } = useGLTF(`/models/props/${prop}.glb`);

  /**
   * The prop's geometry, scaled to its stated height and stood on the deck.
   *
   * Baked into the geometry rather than applied per instance: every copy of a
   * prop is the same size, so doing it once at load costs nothing per frame
   * and keeps the placement list free of a number that never varies.
   */
  const geometry = useMemo(
    () =>
      preparedGeometry(`prop:${prop}`, scene, (shaped) => {
        shaped.computeBoundingBox();
        const box: unknown = shaped.boundingBox;
        if (!(box instanceof Box3)) {
          return;
        }
        const size = box.getSize(new Vector3());
        const fit = size.y > 0.0001 ? HEIGHT[prop] / size.y : 1;
        shaped.scale(fit, fit, fit);
        // Stood on the deck rather than sunk into it: these export centred on
        // their own origin, and half a water tower below the plate is not
        // scenery.
        shaped.translate(0, -box.min.y * fit, 0);
      }),
    [scene, prop],
  );

  if (geometry === null || placements.length === 0) {
    return null;
  }

  return (
    <InstancedField placements={placements}>
      <primitive key={`geometry-${prop}`} object={geometry} attach="geometry" />
      {/* The same treatment the units get: the kit's own colours are bright and
          clean, and §36 fixes this world as dark and matte. No map — these
          carry their colour in vertex data the atlas would only tint. */}
      <meshStandardMaterial
        key={`material-${prop}`}
        color="#43596a"
        metalness={0.24}
        roughness={0.74}
      />
    </InstancedField>
  );
}

/** A stable value in [0, 1). The generator the terrain and the army use. */
function pseudo(value: number): number {
  const x = Math.sin(value * 127.1) * 43_758.545_312;
  return x - Math.floor(x);
}

for (const prop of PROPS) {
  useGLTF.preload(`/models/props/${prop}.glb`);
}
