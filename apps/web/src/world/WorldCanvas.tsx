import { Canvas } from '@react-three/fiber';
import type { JSX } from 'react';
import { GLOBAL_ANCHOR } from './layout.js';
import { WorldScene } from './WorldScene.js';

/**
 * The world canvas, isolated so it can be code-split.
 *
 * §82.3 stages the load: shell and UI first, then the global world at low LOD,
 * then the focused sector. Three.js and the scene are the heaviest thing in the
 * bundle by a wide margin, so keeping them behind a dynamic import is what lets
 * the shell paint at all before they arrive.
 *
 * Everything React Three Fiber touches lives at or below this file. Nothing
 * above it imports `three`, which is what keeps the split from silently
 * collapsing back into the main chunk.
 */
export default function WorldCanvas(): JSX.Element {
  return (
    <Canvas
      style={{ position: 'fixed', inset: 0 }}
      camera={{
        position: [GLOBAL_ANCHOR.position.x, GLOBAL_ANCHOR.position.y, GLOBAL_ANCHOR.position.z],
        fov: 45,
        near: 1,
        far: 8_000,
      }}
      // Capped device pixel ratio: §82 asks for explicit budgets rather than
      // unlimited complexity, and a 3x retina panel rendering the full world at
      // native density is the fastest way to lose the frame budget.
      dpr={[1, 2]}
    >
      <WorldScene />
    </Canvas>
  );
}
