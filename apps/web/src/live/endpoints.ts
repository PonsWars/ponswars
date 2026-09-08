/**
 * Where the live services are, or the admission that nobody said.
 *
 * Two environment variables, no defaults. A default here would be a localhost
 * address compiled into a production bundle, and the failure mode is the worst
 * kind: a deployed client quietly showing nothing while looking configured.
 *
 * These are Vite variables rather than entries in `@ponswars/config`, and the
 * difference is not cosmetic. That package is the *server's* contract, read
 * from the process environment when a service starts; these are baked into the
 * bundle at build time and are public the moment it ships. Putting a browser
 * value in the server's table would invite someone to put a server secret in
 * the browser's.
 */

/**
 * The two variables, as plain optional strings.
 *
 * Declared here rather than taken from Vite's ambient `ImportMetaEnv`, so this
 * function is a function of two strings and nothing else. The caller reads
 * `import.meta.env`; this decides what it means, and can be exercised anywhere
 * without a bundler's type definitions in scope.
 */
export interface BuildEnvironment {
  readonly VITE_API_URL?: string | undefined;
  readonly VITE_WS_URL?: string | undefined;
}

export interface LiveEndpoints {
  /** Origin of the public API, without a trailing slash. */
  readonly api: string;
  /** WebSocket URL of the realtime gateway. */
  readonly socket: string;
}

/** A URL that parses and uses one of the schemes we can actually talk over. */
function checked(value: string | undefined, schemes: readonly string[]): string | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  // Checked rather than assumed, because the alternative is a fetch that fails
  // at the moment a player opens a battle rather than at the moment the build
  // was configured wrongly.
  return schemes.includes(parsed.protocol) ? value.replace(/\/+$/, '') : null;
}

/**
 * The configured endpoints, or `null` when the app has not been told.
 *
 * `null` is a real answer and not a failure: an unconfigured build is a preview
 * of the world, and the caller is expected to say so on screen rather than
 * present placeholder battles as a running round.
 */
export function liveEndpoints(env: BuildEnvironment): LiveEndpoints | null {
  const api = checked(env.VITE_API_URL, ['http:', 'https:']);
  const socket = checked(env.VITE_WS_URL, ['ws:', 'wss:']);

  // Both or neither. Half a configuration would fetch a round and then never
  // move it, which looks like a stalled battle rather than a misconfiguration.
  return api === null || socket === null ? null : { api, socket };
}
