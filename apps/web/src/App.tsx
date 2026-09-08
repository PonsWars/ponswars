import { lazy, Suspense, useEffect, type JSX } from 'react';
import { Hud } from './hud/Hud.js';
import { useSession, type ClientBattle } from './state/session.js';

/**
 * §82.3 stages the load: shell and UI first, then the global world.
 *
 * Three.js and the scene are the bulk of the bundle, so they arrive behind a
 * dynamic import and the shell paints without waiting for them. Nothing above
 * this line imports `three`, which is what keeps the split from collapsing
 * back into the main chunk.
 */
const WorldCanvas = lazy(async () => import('./world/WorldCanvas.js'));

/**
 * The application shell (§80.1).
 *
 * One canvas, one HUD, one persistent world. §37 is explicit that PonsWars is
 * *"not a conventional website with disconnected pages"* — there is no router
 * here yet because there is nothing to route between: moving from the global
 * world to a sector to a battlefield is camera movement inside one place.
 *
 * §80.4 will add shareable routes for `/war/:battleId`, `/profile` and
 * `/rewards`, with the constraint that a route change *"must not require
 * destroying the persistent world scene"*. Adding routes before the scene is
 * proven persistent would make that easy to get backwards.
 */

/**
 * Placeholder round data.
 *
 * The real source is `GET /v1/rounds/current` and the `ROUND_OPENED` event, both
 * already schema'd in `@ponswars/schemas`. Wiring them needs the API host, which
 * is `OPEN` — so the prototype seeds the world locally rather than inventing a
 * default endpoint, which §102 would make a silent product decision.
 */
const PLACEHOLDER_BATTLES: readonly ClientBattle[] = [
  {
    battleId: 'preview-b0',
    sectorIndex: 0,
    left: 'NVDA',
    right: 'AAPL',
    leftConfidence: 'FAVORED',
    rightConfidence: 'UNDERDOG',
    momentum: 'CONTESTED',
    frontline: 0.5,
  },
  {
    battleId: 'preview-b1',
    sectorIndex: 1,
    left: 'MSFT',
    right: 'TSLA',
    leftConfidence: 'EVEN',
    rightConfidence: 'EVEN',
    momentum: 'PUSHING',
    frontline: 0.58,
  },
  {
    battleId: 'preview-b2',
    sectorIndex: 2,
    left: 'GME',
    right: 'META',
    leftConfidence: 'HEAVY_UNDERDOG',
    rightConfidence: 'DOMINANT',
    momentum: 'SURGING',
    frontline: 0.34,
  },
  {
    battleId: 'preview-b3',
    sectorIndex: 3,
    left: 'AMZN',
    right: 'GOOGL',
    leftConfidence: 'STRONG_FAVORITE',
    rightConfidence: 'UNDERDOG',
    momentum: 'DOMINATING',
    frontline: 0.71,
  },
  {
    battleId: 'preview-b4',
    sectorIndex: 4,
    left: 'AMD',
    right: 'SPY',
    leftConfidence: 'UNDERDOG',
    rightConfidence: 'FAVORED',
    momentum: 'COMEBACK',
    frontline: 0.53,
  },
];

export function App(): JSX.Element {
  const setBattles = useSession((state) => state.setBattles);
  const setMyBattle = useSession((state) => state.setMyBattle);
  const setReducedMotion = useSession((state) => state.setReducedMotion);

  useEffect(() => {
    setBattles(PLACEHOLDER_BATTLES);
    setMyBattle('preview-b2');
  }, [setBattles, setMyBattle]);

  useEffect(() => {
    // §83.3: honour the operating-system preference, and keep honouring it if
    // the user changes it mid-session rather than only reading it once.
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);

    const onChange = (event: MediaQueryListEvent): void => {
      setReducedMotion(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [setReducedMotion]);

  return (
    <>
      <Suspense fallback={<WorldLoading />}>
        <WorldCanvas />
      </Suspense>
      <Hud />
    </>
  );
}

/**
 * The loading state while the world chunk arrives.
 *
 * §42.14: useful sync states rather than a generic spinner, and *"do not fake
 * unnecessary loading time merely for cinematic effect"* — this shows only for
 * as long as the chunk actually takes.
 */
function WorldLoading(): JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--pw-bg-0)',
        color: 'var(--pw-text-3)',
        fontFamily: 'var(--pw-font-display)',
        letterSpacing: '0.14em',
        fontSize: 13,
      }}
    >
      INITIALIZING WORLD
    </div>
  );
}
