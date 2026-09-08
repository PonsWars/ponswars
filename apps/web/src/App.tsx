import { buildCanonicalClock, utcTimestamp } from '@ponswars/shared-types';
import { lazy, Suspense, useEffect, type JSX } from 'react';
import type { GenesisOutcome } from './genesis/GenesisReveal.js';
import { Hud } from './hud/Hud.js';
import { Presentations } from './presentation/Presentations.js';
import type { ProfileData } from './profile/WarRoom.js';
import { activeWindowView } from './rewards/reward-view.js';
import type { PoolStatus } from './rewards/RewardsHub.js';
import { isPresentation } from './routing/route.js';
import { useRoute } from './routing/useRoute.js';
import { nowUtc, useSession, type ClientBattle, type ClientRound } from './state/session.js';

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
 * *"not a conventional website with disconnected pages"*, and the routes here
 * do not contradict that: moving between the global world, a sector and a
 * battlefield is camera movement inside one place, and `/profile`, `/rewards`
 * and `/genesis` are presentations layered *over* that place.
 *
 * §80.4 requires that a route change *"must not require destroying the
 * persistent world scene"*. The canvas is mounted here, once, outside every
 * route branch — so no route has the power to unmount it, whatever anyone adds
 * later.
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

/**
 * A placeholder profile, pool and Genesis outcome.
 *
 * Every one of these comes from the indexer, the Player Service or the chain in
 * production. They are seeded here so the presentations can be built and looked
 * at; none of the numbers is derived on the client, which is the property that
 * has to survive when the real sources are wired (§34, §35).
 */
const PLACEHOLDER_PROFILE: ProfileData = {
  addressFragment: PLACEHOLDER_WALLET.addressFragment,
  warBalance: PLACEHOLDER_WALLET.warBalance,
  warHolder: true,
  card: {
    genesisId: '008271',
    name: 'Bull Run',
    rarity: 'RARE',
    effect: 'Market Support +2',
    usesRemaining: 7,
    secretTrophy: false,
  },
  lifetime: {
    battles: 128,
    wins: 71,
    losses: 57,
    winRateBps: 5_547,
    upsets: 14,
    majorUpsets: 3,
    cardAssistedWins: 22,
    lifetimeWarPoints: 1_842,
  },
  history: [
    {
      roundId: '#718',
      matchup: 'GME vs SPY',
      backed: 'GME',
      outcome: 'MAJOR_UPSET',
      warPoints: 14,
      cardName: 'Bull Run',
    },
    {
      roundId: '#717',
      matchup: 'NVDA vs AAPL',
      backed: 'NVDA',
      outcome: 'WIN',
      warPoints: 6,
      cardName: null,
    },
    {
      roundId: '#716',
      matchup: 'AMD vs MSFT',
      backed: 'AMD',
      outcome: 'UPSET',
      warPoints: 10,
      cardName: null,
    },
  ],
  mostBacked: { ticker: 'NVDA', battles: 37, winRateBps: 6_480 },
  biggestUpset: {
    headline: 'GME defeated SPY',
    classification: 'MAJOR UPSET',
    roundId: '#718',
  },
};

const PLACEHOLDER_POOL: PoolStatus = { balance: '12.40' };

const PLACEHOLDER_GENESIS: GenesisOutcome = {
  genesisId: '008271',
  rarity: 'RARE',
  cardName: 'Bull Run',
  effect: 'Market Support +2',
  secretReservationSecured: true,
};

export function App(): JSX.Element {
  const { route, navigate } = useRoute();
  const battles = useSession((state) => state.battles);
  const focusSector = useSession((state) => state.focusSector);
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
    // A shared `/war/:battleId` link arrives focused on that battle (§80.4).
    // The camera flies rather than cutting, so a deep link lands the visitor in
    // the world the same way navigating there would have.
    if (route.kind !== 'WORLD' || route.battleId === null) {
      return;
    }
    const index = battles.findIndex((battle) => battle.battleId === route.battleId);
    if (index >= 0) {
      focusSector(index, nowUtc());
    }
  }, [route, battles, focusSector]);

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
      {/* Mounted once, outside every route branch. Nothing below can unmount
          it, which is how §80.4's constraint stays true by construction. */}
      <Suspense fallback={<WorldLoading />}>
        <WorldCanvas />
      </Suspense>
      <Hud onNavigate={navigate} />
      {isPresentation(route) ? (
        <Presentations
          route={route}
          navigate={navigate}
          profile={PLACEHOLDER_PROFILE}
          reward={activeWindowView({
            distributionId: 42,
            warPoints: PLACEHOLDER_WALLET.warPoints,
            closesAt: utcTimestamp(Date.now() + 6 * 3_600_000 + 42 * 60_000 + 18_000),
          })}
          pool={PLACEHOLDER_POOL}
          genesis={PLACEHOLDER_GENESIS}
        />
      ) : null}
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
