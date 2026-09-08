import { buildCanonicalClock, utcTimestamp } from '@ponswars/shared-types';
import { lazy, Suspense, useEffect, type JSX } from 'react';
import { Hud } from './hud/Hud.js';
import { useSession, type ClientBattle, type ClientRound } from './state/session.js';

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
    leftIntel: {
      label: 'FAVORED',
      priceTrend: 'STRONG',
      volumePulse: 'RISING',
      ponsActivity: 'HIGH',
      momentumStability: 'STABLE',
    },
    rightIntel: {
      label: 'UNDERDOG',
      priceTrend: 'MIXED',
      volumePulse: 'NORMAL',
      ponsActivity: 'MEDIUM',
      momentumStability: 'MIXED',
    },
    momentum: 'CONTESTED',
    frontline: 0.5,
    backing: null,
  },
  {
    battleId: 'preview-b1',
    sectorIndex: 1,
    left: 'MSFT',
    right: 'TSLA',
    leftIntel: {
      label: 'EVEN',
      priceTrend: 'MIXED',
      volumePulse: 'NORMAL',
      ponsActivity: 'MEDIUM',
      momentumStability: 'STABLE',
    },
    rightIntel: {
      label: 'EVEN',
      priceTrend: 'MIXED',
      volumePulse: 'RISING',
      ponsActivity: 'MEDIUM',
      momentumStability: 'MIXED',
    },
    momentum: 'PUSHING',
    frontline: 0.58,
    backing: null,
  },
  {
    battleId: 'preview-b2',
    sectorIndex: 2,
    left: 'GME',
    right: 'META',
    leftIntel: {
      label: 'HEAVY_UNDERDOG',
      priceTrend: 'WEAK',
      volumePulse: 'RISING',
      ponsActivity: 'HIGH',
      momentumStability: 'UNSTABLE',
    },
    rightIntel: {
      label: 'DOMINANT',
      priceTrend: 'STRONG',
      volumePulse: 'NORMAL',
      ponsActivity: 'LOW',
      momentumStability: 'STABLE',
    },
    momentum: 'SURGING',
    frontline: 0.34,
    backing: { ticker: 'GME', cardDeployed: true },
  },
  {
    battleId: 'preview-b3',
    sectorIndex: 3,
    left: 'AMZN',
    right: 'GOOGL',
    leftIntel: {
      label: 'STRONG_FAVORITE',
      priceTrend: 'STRONG',
      volumePulse: 'RISING',
      ponsActivity: 'MEDIUM',
      momentumStability: 'STABLE',
    },
    rightIntel: {
      label: 'UNDERDOG',
      priceTrend: 'WEAK',
      volumePulse: 'WEAK',
      ponsActivity: 'LOW',
      momentumStability: 'MIXED',
    },
    momentum: 'DOMINATING',
    frontline: 0.71,
    backing: null,
  },
  {
    battleId: 'preview-b4',
    sectorIndex: 4,
    left: 'AMD',
    right: 'SPY',
    leftIntel: {
      label: 'UNDERDOG',
      priceTrend: 'MIXED',
      volumePulse: 'RISING',
      ponsActivity: 'HIGH',
      momentumStability: 'UNSTABLE',
    },
    rightIntel: {
      label: 'FAVORED',
      priceTrend: 'STRONG',
      volumePulse: 'NORMAL',
      ponsActivity: 'LOW',
      momentumStability: 'STABLE',
    },
    momentum: 'COMEBACK',
    frontline: 0.53,
    backing: null,
  },
];

/**
 * A placeholder wallet.
 *
 * The real values come from the indexer and the chain. Showing a fixed fragment
 * in the prototype is honest as long as it is never mistaken for a connected
 * wallet — `setWallet(null)` is what a disconnected session looks like, and the
 * HUD renders that state explicitly rather than as a balance of zero.
 */
const PLACEHOLDER_WALLET = {
  addressFragment: '0x4f2…9c1',
  warBalance: '12,400',
  warPoints: 1_180,
};

/**
 * A placeholder round.
 *
 * Built with `buildCanonicalClock` rather than written out, so the prototype's
 * phase boundaries obey §3's timing instead of a set of numbers that happen to
 * look plausible. The real source is `GET /v1/rounds/current` and the
 * `ROUND_OPENED` event — both already schema'd, both waiting on an API host that
 * is still `OPEN` (§102).
 */
function placeholderRound(): ClientRound {
  const now = utcTimestamp(Date.now());
  return {
    roundId: 'preview-round',
    state: 'PICK_OPEN',
    clock: buildCanonicalClock(now, now),
    feedHealth: 'HEALTHY',
  };
}

export function App(): JSX.Element {
  const setBattles = useSession((state) => state.setBattles);
  const setMyBattle = useSession((state) => state.setMyBattle);
  const setWallet = useSession((state) => state.setWallet);
  const setRound = useSession((state) => state.setRound);
  const setReducedMotion = useSession((state) => state.setReducedMotion);

  useEffect(() => {
    setBattles(PLACEHOLDER_BATTLES);
    setMyBattle('preview-b2');
    setWallet(PLACEHOLDER_WALLET);
    setRound(placeholderRound());
  }, [setBattles, setMyBattle, setWallet, setRound]);

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
