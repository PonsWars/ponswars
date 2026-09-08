/**
 * Shareable routes over one persistent world (§80.4).
 *
 * *"A route change must not require destroying the persistent world scene."*
 * That constraint is the reason this is a parser and not a router: there is no
 * route tree, no per-route component ownership, and nothing that can unmount the
 * canvas. A route names what is presented *over* the world — the world itself is
 * mounted once by the shell and never taken down (§37.9).
 *
 * Hand-written rather than pulled in, for the same reason. Four routes with no
 * nesting need a `switch`, and a router library would add weight to the shell
 * chunk §82.3 wants small while making the "never unmount" rule a convention
 * rather than a fact about the code.
 */

/** The world itself, with an optional battle in focus. */
export interface WorldRoute {
  readonly kind: 'WORLD';
  /** Focus this battle on arrival, so `/war/:id` is shareable (§80.4). */
  readonly battleId: string | null;
}

/** A presentation layered over the world. */
export interface PresentationRoute {
  readonly kind: 'PROFILE' | 'REWARDS' | 'GENESIS' | 'RESULT';
}

export type Route = WorldRoute | PresentationRoute;

export const WORLD_ROUTE: WorldRoute = { kind: 'WORLD', battleId: null };

/**
 * Parses a pathname into a route.
 *
 * Anything unrecognised is the world. A deep link that no longer resolves — a
 * battle from a finished round, a renamed path — should land the player in the
 * world they came for rather than on a not-found page, because in a spatial
 * product there is nowhere else for them to be (§37.1).
 */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  const [first, second] = segments;

  switch (first) {
    case 'profile':
      return { kind: 'PROFILE' };
    case 'rewards':
      return { kind: 'REWARDS' };
    case 'genesis':
      return { kind: 'GENESIS' };
    case 'result':
      return { kind: 'RESULT' };
    case 'war':
      // `/war` with no id is still the world, just unfocused. A URL truncated
      // in a chat client should not become a dead end.
      return { kind: 'WORLD', battleId: second ?? null };
    default:
      return WORLD_ROUTE;
  }
}

/** The canonical path for a route, so links and history entries agree. */
export function pathFor(route: Route): string {
  switch (route.kind) {
    case 'PROFILE':
      return '/profile';
    case 'REWARDS':
      return '/rewards';
    case 'GENESIS':
      return '/genesis';
    case 'RESULT':
      return '/result';
    case 'WORLD':
      return route.battleId === null ? '/' : `/war/${route.battleId}`;
  }
}

/**
 * Whether a route presents something over the world.
 *
 * The world keeps rendering underneath either way; this only says whether an
 * overlay is on top of it, which is what the camera uses to choose
 * `PROFILE_PRESENTATION` (§81.2).
 */
export function isPresentation(route: Route): route is PresentationRoute {
  return route.kind !== 'WORLD';
}
