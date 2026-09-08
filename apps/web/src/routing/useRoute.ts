import { useCallback, useEffect, useState } from 'react';
import { parseRoute, pathFor, type Route } from './route.js';

/**
 * The current route, and a way to change it (§80.4).
 *
 * `pushState` plus a `popstate` listener — no library, no route tree, and
 * crucially nothing that owns a subtree it could unmount. The world scene is
 * mounted by the shell and stays mounted through every navigation, which is
 * what §80.4 requires and §37.9 makes the whole point of the product.
 *
 * `navigate` is a no-op when the path has not changed, so clicking the control
 * for the view you are already in does not stack duplicate history entries the
 * player then has to press Back through.
 */
export function useRoute(): { route: Route; navigate: (next: Route) => void } {
  const [route, setRoute] = useState<Route>(() => parseRoute(currentPathname()));

  useEffect(() => {
    const onPopState = (): void => {
      setRoute(parseRoute(currentPathname()));
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  const navigate = useCallback((next: Route) => {
    const path = pathFor(next);
    if (path !== currentPathname()) {
      window.history.pushState(null, '', path);
    }
    setRoute(next);
  }, []);

  return { route, navigate };
}

/**
 * The current path, or `/` where there is no DOM.
 *
 * A test environment or a server render has no location; falling back keeps the
 * shell rendering the world rather than throwing before anything appears.
 */
function currentPathname(): string {
  if (typeof window === 'undefined') {
    return '/';
  }
  return window.location.pathname;
}
