/**
 * The build-time variables this client reads.
 *
 * Augments the interface `vite/client` already declares, which `tsconfig` loads
 * through `types`. There is deliberately no triple-slash reference and no
 * `ImportMeta` here: redeclaring that interface replaces Vite's, taking `DEV`,
 * `PROD` and `MODE` with it.
 *
 * Declared at all because Vite's own `ImportMetaEnv` has no index signature, so
 * an unlisted `VITE_` key is a type error rather than a value that arrives as
 * `undefined` in a browser.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  /** Development only — see `live/session-token.ts`. Never a real session. */
  readonly VITE_DEV_SESSION_TOKEN?: string;
}
