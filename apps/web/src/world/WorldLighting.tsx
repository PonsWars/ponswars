import type { QualityTier } from '@ponswars/world-runtime';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, type JSX } from 'react';
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Mesh,
  MeshBasicMaterial,
  PMREMGenerator,
  Scene,
  Vector2,
  WebGLRenderTarget,
  HalfFloatType,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { useSession } from '../state/session.js';
import { BLOOM, ENVIRONMENT } from './navigation-config.js';

/**
 * What the world is lit by, and what happens to the light afterwards (§36.5,
 * §38.10, §82.2).
 *
 * Two things were missing, and between them they are most of why the scene read
 * as flat next to the art direction.
 *
 * **There was no environment.** Every surface was lit by three lights and
 * nothing else, so a physically-based material had nothing to reflect. That is
 * also why the first pass at the districts came out black: a metal with no
 * environment renders as the absence of one, and the fix at the time was to
 * make everything nearly dielectric. With an environment the metals can be
 * metal again.
 *
 * **There was no bloom.** §38.10 asks for a permanent dark cinematic
 * atmosphere, and the delivered frames are half glow — every lit edge in them
 * throws light into the air around it. Emissive geometry alone cannot do that;
 * a pixel can be at most white, and what makes a light read as bright is what
 * it does to its neighbours.
 *
 * Both are built here rather than loaded. There are no image assets in this
 * app: the environment is a small scene of lit planes convolved into a
 * reflection probe, and the bloom is three's own pass. Nothing is fetched.
 */
export function WorldLighting(): JSX.Element | null {
  const quality = useSession((state) => state.quality);

  return (
    <>
      <Environment />
      {bloomAllowed(quality) ? <Bloom tier={quality} /> : null}
    </>
  );
}

/**
 * Whether this tier can afford the extra full-screen passes.
 *
 * §82.2 makes the quality tier the place a performance decision is expressed,
 * and bloom is three more passes over every pixel. Reduced motion turns it off
 * for a different reason: §83.3 asks for less movement, and a bloom that
 * pulses with the Market Core is movement.
 */
function bloomAllowed(tier: QualityTier): boolean {
  return tier !== 'PERFORMANCE' && tier !== 'REDUCED_MOTION';
}

/**
 * A reflection probe built out of lit planes.
 *
 * Not three's `RoomEnvironment`, which is a bright white studio — reflections
 * from it read as a showroom and §38.10 asks for a dark void. This is the sky
 * the world actually sits under: cold light from above, a dim warm bounce from
 * one side, near black everywhere else. It gives a metal something to be metal
 * against without lifting the scene off its ground.
 */
function Environment(): null {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    const source = new Scene();
    const geometry = new BoxGeometry();
    const panels: Mesh[] = [];

    const panel = (
      color: string,
      position: readonly [number, number, number],
      scale: readonly [number, number, number],
    ): void => {
      const mesh = new Mesh(geometry, new MeshBasicMaterial({ color }));
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      source.add(mesh);
      panels.push(mesh);
    };

    // The sky: cold, wide, overhead.
    panel(ENVIRONMENT.sky, [0, 8, 0], [22, 0.2, 22]);
    // A rim from one side, warmer and much dimmer, so a silhouette separates
    // from the background instead of dissolving into it.
    panel(ENVIRONMENT.rim, [-9, 1, -4], [0.2, 9, 14]);
    // The ground the islands float over: almost nothing, but not nothing.
    panel(ENVIRONMENT.ground, [0, -8, 0], [22, 0.2, 22]);

    const pmrem = new PMREMGenerator(gl);
    // The widest blur the generator can take without clipping. It samples at
    // most 20 taps across three standard deviations, and 0.05 asked for 25 —
    // the extra width was being thrown away with a console warning on every
    // load. 0.04 is the blur that was actually being drawn, asked for honestly.
    const target = pmrem.fromScene(source, 0.04);
    scene.environment = target.texture;
    scene.environmentIntensity = ENVIRONMENT.intensity;

    // Filmic rather than linear. Linear clips the moment two lit things overlap
    // — the Market Core's beacon over its own spires was a white disc — and a
    // scene built on emissive accents overlaps constantly.
    gl.toneMapping = ACESFilmicToneMapping;
    gl.toneMappingExposure = ENVIRONMENT.exposure;

    return () => {
      scene.environment = null;
      target.texture.dispose();
      pmrem.dispose();
      for (const mesh of panels) {
        (mesh.material as MeshBasicMaterial).dispose();
      }
      geometry.dispose();
    };
  }, [gl, scene]);

  return null;
}

/**
 * Bloom, and the render loop that goes with it.
 *
 * A positive `useFrame` priority takes the render away from React Three Fiber,
 * which is the point: the composer has to draw instead of the renderer. It runs
 * after every priority-zero subscriber, so the camera has already been aimed
 * and the reshuffle already applied by the time this draws them.
 */
function Bloom({ tier }: { readonly tier: QualityTier }): null {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);

  const composer = useMemo(() => {
    // A render target with multisampling, rather than the composer's default.
    //
    // `Canvas` asks the renderer for antialiasing, and that applies to the
    // canvas — which the composer stops drawing to the moment it takes over.
    // Without this the whole world loses its edges the instant bloom is
    // switched on, which is a strange trade to make for a glow.
    const target = new WebGLRenderTarget(Math.max(1, size.width), Math.max(1, size.height), {
      type: HalfFloatType,
      samples: BLOOM.samples,
    });
    const made = new EffectComposer(gl, target);
    made.addPass(new RenderPass(scene, camera));
    made.addPass(
      new UnrealBloomPass(
        new Vector2(size.width, size.height),
        BLOOM.strength,
        BLOOM.radius,
        // Only what is genuinely bright. A low threshold blooms the whole
        // world, which reads as a dirty lens rather than as light.
        BLOOM.threshold,
      ),
    );
    // Tone mapping and the colour-space conversion happen here, at the end of
    // the chain, because everything before it works in linear light.
    made.addPass(new OutputPass());
    return made;
  }, [gl, scene, camera, size.width, size.height]);

  useEffect(() => {
    composer.setSize(size.width, size.height);
    composer.setPixelRatio(Math.min(gl.getPixelRatio(), tier === 'ULTRA' ? 2 : 1.5));
    return () => {
      composer.dispose();
    };
  }, [composer, gl, size.width, size.height, tier]);

  useFrame(() => {
    composer.render();
  }, 1);

  return null;
}
