import { useLayoutEffect, useRef, type JSX } from 'react';
import { BufferGeometry, Mesh, Object3D, type InstancedMesh } from 'three';

/**
 * One instance of a shape, in the coordinate space of the field it belongs to.
 *
 * Positions rather than a scene graph, because these go through an
 * `InstancedMesh`: a hundred boxes as a hundred meshes is a hundred draw calls,
 * and §82.2 puts a frame budget on a world that has five of these fields in it
 * at once.
 */
export interface Placement {
  readonly position: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
}

/**
 * A field of one shape, drawn in a single call.
 *
 * The geometry and material come in as children, so the same helper draws
 * buildings, their lit crowns, the rock under an island and the debris around
 * the world — four fields that differ in what they are made of and not at all
 * in how they are placed.
 *
 * Matrices are written in a layout effect rather than per frame: none of this
 * moves. Nothing here is animated, so nothing here costs anything after the
 * first commit.
 */
export function InstancedField({
  placements,
  children,
}: {
  readonly placements: readonly Placement[];
  readonly children: readonly JSX.Element[];
}): JSX.Element | null {
  const field = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = field.current;
    if (mesh === null) {
      return;
    }
    const step = new Object3D();
    for (const [index, placement] of placements.entries()) {
      step.position.set(...placement.position);
      step.rotation.set(...placement.rotation);
      step.scale.set(...placement.scale);
      step.updateMatrix();
      mesh.setMatrixAt(index, step.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // The renderer culls against bounds it did not compute: the matrices were
    // set here, so the sphere it inherited from a unit cube is wrong until it
    // is told. Without this a field vanishes as soon as its centre leaves frame.
    mesh.computeBoundingSphere();
  }, [placements]);

  if (placements.length === 0) {
    return null;
  }

  return (
    <instancedMesh ref={field} args={[undefined, undefined, placements.length]}>
      {children}
    </instancedMesh>
  );
}

/**
 * The first mesh geometry in a loaded model, prepared once and shared.
 *
 * Every model this world instances is a single mesh — the district pieces are
 * exported one per file, the props are one object each — so "the first" is
 * "the only" and returning a list would be ceremony.
 *
 * **Cached by key, globally.** This is not an optimisation, it is the
 * difference between working and not. Ten sectors have two districts each, and
 * every one of them draws the same four structures and the same six props: a
 * clone per component is two hundred geometry uploads of ten distinct shapes,
 * and the first version of this lost the WebGL context outright. `useGLTF`
 * already caches the parsed scene per URL; this caches what is made from it.
 *
 * `prepare` runs once per key. It may mutate what it is given — scaling,
 * translating — because the result belongs to the cache and never to a caller.
 */
const PREPARED = new Map<string, BufferGeometry | null>();

export function preparedGeometry(
  key: string,
  scene: Object3D,
  prepare?: (geometry: BufferGeometry) => void,
): BufferGeometry | null {
  const cached = PREPARED.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const found: BufferGeometry[] = [];
  scene.traverse((node) => {
    if (found.length > 0 || !(node instanceof Mesh)) {
      return;
    }
    const source: unknown = node.geometry;
    if (source instanceof BufferGeometry) {
      // The cast is deliberate and is the only one in this file. `instanceof`
      // narrows to the class's default generic parameters, which are wider
      // than the ones every consumer expects.
      found.push(source.clone() as BufferGeometry);
    }
  });

  const geometry = found[0] ?? null;
  if (geometry !== null) {
    prepare?.(geometry);
  }
  PREPARED.set(key, geometry);
  return geometry;
}
