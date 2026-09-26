import { useGLTF } from '@react-three/drei';

/**
 * Loading the world's .glb models, with no decoder attached.
 *
 * drei's `useGLTF` attaches two by default, whether a model needs them or not:
 * Meshopt, which compiles WebAssembly the moment a loader is made, and Draco,
 * which fetches its decoder from Google's CDN the first time it meets a
 * compressed mesh. Every model here is quantized (`KHR_mesh_quantization`,
 * which three reads natively) and neither Meshopt- nor Draco-compressed —
 * `model-loader.test.ts` holds that of every file shipped.
 *
 * Attached anyway, Meshopt's WebAssembly is refused by the page's
 * Content-Security-Policy (`script-src 'self'`, no `wasm-unsafe-eval`) on
 * every load, as an uncaught error: found on the Netlify showcase, which serves
 * the same policy as the real deployment. Not attaching what nothing uses is
 * the fix, rather than loosening the policy for it.
 *
 * A model that does arrive compressed fails to load, loudly, naming the
 * extension — not quietly, and not by fetching code from another origin.
 */

const USE_DRACO = false;
const USE_MESHOPT = false;

/** `useGLTF`, for a model of this world. */
export function useModel(url: string): ReturnType<typeof useGLTF<string>> {
  return useGLTF(url, USE_DRACO, USE_MESHOPT);
}

/** `useGLTF.preload`, with the same loader `useModel` reads it through. */
export function preloadModel(url: string): void {
  useGLTF.preload(url, USE_DRACO, USE_MESHOPT);
}
