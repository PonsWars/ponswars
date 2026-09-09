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
  readonly kind: 'PROFILE' | 'REWARDS' | 'GENESIS';
}

/**
 * The way in.
 *
 * Its own type rather than a fourth presentation kind, because it is not one: a
 * presentation is something a player opens *from* the world, and this is what
 * they see before entering it. Keeping them separate is what lets the component
 * that renders presentations be exhaustive over exactly the three it handles.
 */
export interface LandingRoute {
  readonly kind: 'LANDING';
}

/**
 * A finished battle, shown over the world (§27.8).
 *
 * Carries a battle id because a result is about one battle, and because a
 * result is the thing a player most wants to send someone — the same reason
 * `/war/:battleId` exists. `null` falls back to whatever the client last saw
 * finish, so a bare `/result` is still somewhere rather than nowhere.
 */
export interface ResultRoute {
  readonly kind: 'RESULT';
  readonly battleId: string | null;
}

export type Route = WorldRoute | LandingRoute | PresentationRoute | ResultRoute;

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
    // The way in. A visitor who has never seen this needs telling what it is
    // before being dropped into a war — and the world keeps rendering behind
    // it, so entering is an overlay lifting rather than a page load (§37.9).
    case undefined:
      return { kind: 'LANDING' };
    case 'profile':
      return { kind: 'PROFILE' };
    case 'rewards':
      return { kind: 'REWARDS' };
    case 'genesis':
      return { kind: 'GENESIS' };
    case 'result':
      return { kind: 'RESULT', battleId: second ?? null };
    case 'world':
      return WORLD_ROUTE;
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
    case 'LANDING':
      return '/';
    case 'RESULT':
      return route.battleId === null ? '/result' : `/result/${route.battleId}`;
    case 'WORLD':
      return route.battleId === null ? '/world' : `/war/${route.battleId}`;
  }
}

/**
 * Whether a route presents something over the world.
 *
 * The world keeps rendering underneath either way; this only says whether an
 * overlay is on top of it, which is what the camera uses to choose
 * `PROFILE_PRESENTATION` (§81.2).
 */
export function isPresentation(
  route: Route,
): route is LandingRoute | PresentationRoute | ResultRoute {
  return route.kind !== 'WORLD';
}
