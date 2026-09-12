import {
  buildCanonicalClock,
  utcTimestamp,
  type FinalizedBattleResult,
} from '@ponswars/shared-types';
import type { Profile } from '@ponswars/schemas';
import { LAYER } from '@ponswars/ui-tokens';
import { lazy, Suspense, useEffect, useMemo, type JSX } from 'react';
import { liveEndpoints } from './live/endpoints.js';
import { Factions } from './factions/Factions.js';
import { cardEffectLine } from './art/GenesisCardFace.js';
import { Landing } from './landing/Landing.js';
import { PreviewBanner } from './live/PreviewBanner.js';
import { fetchBattleResult } from './live/round-client.js';
import { useLiveProfile, type LiveProfile } from './live/useLiveProfile.js';
import { useLiveWorld } from './live/useLiveWorld.js';
import { useWalletSession } from './live/useWalletSession.js';
import { WalletSessionProvider } from './live/WalletSessionContext.js';
import type { GenesisOutcome } from './genesis/GenesisReveal.js';
import { Hud } from './hud/Hud.js';
import { Presentations, type FinishedBattle } from './presentation/Presentations.js';
import { GENESIS_UNPUBLISHED, failureCopy, type PersonalData } from './presentation/unpublished.js';
import { warRoomFrom } from './profile/profile-view.js';
import type { ProfileData } from './profile/WarRoom.js';
import { activeWindowView, currentWindowView } from './rewards/reward-view.js';
import type { PoolStatus } from './rewards/RewardsHub.js';
import { NavBar } from './hud/NavBar.js';
import { Overlay } from './presentation/Overlay.js';
import { isPresentation, WORLD_ROUTE } from './routing/route.js';
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
const PLACEHOLDER_GENESIS: GenesisOutcome = {
  genesisId: '008271',
  // One of the three cards that has art, so the preview shows the reveal §40.6
  // describes rather than the text-only version a card without art falls back
  // to. Rarity, name and support all match the catalog entry for it.
  rarity: 'LEGENDARY',
  cardType: 'GOLDEN_ARMY',
  cardName: 'Golden Army',
  effect: cardEffectLine('GOLDEN_ARMY'),
  secretReservationSecured: true,
};

const PLACEHOLDER_PROFILE: ProfileData = {
  addressFragment: PLACEHOLDER_WALLET.addressFragment,
  holdings: {
    status: 'PUBLISHED',
    warBalance: PLACEHOLDER_WALLET.warBalance,
    warHolder: true,
    // The card the Genesis preview reveals, with one charge spent — same id,
    // same name, same rarity, same effect. It was a different card under the
    // same Genesis number, which taught anyone who opened both screens that the
    // reveal and the profile are unrelated.
    card: {
      genesisId: PLACEHOLDER_GENESIS.genesisId,
      name: PLACEHOLDER_GENESIS.cardName,
      cardType: PLACEHOLDER_GENESIS.cardType,
      rarity: PLACEHOLDER_GENESIS.rarity,
      effect: PLACEHOLDER_GENESIS.effect,
      usesRemaining: 2,
      secretTrophy: PLACEHOLDER_GENESIS.secretReservationSecured,
    },
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
      cardName: PLACEHOLDER_GENESIS.cardName,
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

/**
 * A personal page's data from the live profile, for as long as it is loading,
 * failed or arrived — and asking for a wallet when there is no session.
 */
function fromLiveProfile<T>(live: LiveProfile, shape: (profile: Profile) => T): PersonalData<T> {
  switch (live.kind) {
    case 'IDLE':
      return { status: 'SIGNED_OUT' };
    case 'LOADING':
      return { status: 'LOADING' };
    case 'FAILED':
      return { status: 'FAILED', copy: failureCopy(live.failure), retry: live.retry };
    case 'READY':
      return { status: 'READY', value: shape(live.profile) };
  }
}

/**
 * A placeholder finalized battle.
 *
 * Scores are at engine scale: one point is `POINT_SCALE`, so 24.0 points is
 * `24_000_000`. The two sides sum to exactly 100 points, because the result
 * screen is the one place a number is finally shown and halves that did not add
 * up would undermine the only screen whose job is to show the working.
 */
const PLACEHOLDER_RESULT: FinishedBattle = {
  result: {
    battleId: 'preview-b2',
    roundId: 'preview-round',
    left: 'GME',
    right: 'META',
    winner: 'GME',
    leftScore: {
      priceMomentum: 23_800_000,
      relativeVolume: 14_100_000,
      ponsPower: 11_800_000,
      holderCardSupport: 6_600_000,
    },
    rightScore: {
      priceMomentum: 16_200_000,
      relativeVolume: 10_900_000,
      ponsPower: 8_200_000,
      holderCardSupport: 8_400_000,
    },
    victoryLabel: 'MAJOR_UPSET',
    scoringEngineVersion: 'battle-engine-v1',
    finalizedAt: utcTimestamp(Date.now()),
    evidenceHash: '0x9f2c41ab7e5d0c3891fe64d0a27b5c18e3d47f9a0b6c2e81',
  } as FinalizedBattleResult,
  backed: 'GME',
  winnerConfidence: 'HEAVY_UNDERDOG',
  cardDeployed: true,
};

export function App(): JSX.Element {
  const { route, navigate } = useRoute();
  const battles = useSession((state) => state.battles);
  const focusSector = useSession((state) => state.focusSector);
  const presentWorld = useSession((state) => state.presentWorld);
  const setBattles = useSession((state) => state.setBattles);
  const setMyBattle = useSession((state) => state.setMyBattle);
  const setWallet = useSession((state) => state.setWallet);
  const setRound = useSession((state) => state.setRound);
  const setCard = useSession((state) => state.setCard);
  const setReducedMotion = useSession((state) => state.setReducedMotion);

  /**
   * The page's one wallet session (§45.2).
   *
   * Owned here and read everywhere else through the provider below, because
   * `useWalletSession` holds a token, a restore on load and a rotation timer —
   * a second copy would race the first and the bar would disagree with the HUD
   * about who is signed in.
   */
  const walletSession = useWalletSession();

  // Opens the round fetch and the realtime stream, or reports that this build
  // was never told where they are. The session goes in rather than being read
  // there: writes carry it, and so does the socket (§48.2).
  const status = useLiveWorld(walletSession.authorization);

  const lastResults = useSession((state) => state.lastResults);
  const setWalletWarPoints = useSession((state) => state.setWalletWarPoints);

  // The signed-in wallet's record: read on sign-in, again when a round
  // finalizes, and again when a page that shows it opens — so the War Points in
  // the bar move when a round pays out, and a battle that just ended is on the
  // profile.
  const liveProfile = useLiveProfile(
    status.live ? walletSession.authorization : null,
    `${route.kind === 'PROFILE' || route.kind === 'REWARDS' ? route.kind : 'WORLD'}|${Object.keys(
      lastResults,
    )
      .sort()
      .join(',')}`,
  );
  const readWarPoints =
    liveProfile.kind === 'READY' ? liveProfile.profile.currentWindow.warPoints : null;
  useEffect(() => {
    if (readWarPoints !== null) {
      setWalletWarPoints(readWarPoints);
    }
  }, [readWarPoints, setWalletWarPoints]);
  const myBattleId = useSession((state) => state.myBattleId);

  /**
   * The battle the result screen shows, from the round that just finished.
   *
   * The player's own battle when they had one, and otherwise the first — §27.8
   * shows a result to whoever is looking, and a spectator has as much right to
   * see one as a player does (§5). `null` before any round has finalized, which
   * is what keeps a placeholder from standing in for a result.
   */
  const finished = useMemo<FinishedBattle | null>(() => {
    const ids = Object.keys(lastResults);
    if (ids.length === 0) {
      return null;
    }
    const named = route.kind === 'RESULT' ? route.battleId : null;
    const battleId =
      named !== null && named in lastResults
        ? named
        : myBattleId !== null && myBattleId in lastResults
          ? myBattleId
          : ids[0];
    const result = battleId === undefined ? undefined : lastResults[battleId];
    if (result === undefined) {
      return null;
    }
    const battle = battles.find((candidate) => candidate.battleId === result.battleId);
    return {
      result,
      backed: battle?.backing?.ticker ?? null,
      // The winner's own pre-battle label, taken from the intel the round
      // opened with (§10.3). Recomputing it here would be a second answer to a
      // question the round already settled.
      winnerConfidence:
        battle === undefined
          ? 'EVEN'
          : result.winner === battle.left
            ? battle.leftIntel.label
            : battle.rightIntel.label,
      cardDeployed: battle?.backing?.cardDeployed ?? false,
    };
  }, [lastResults, battles, myBattleId, route]);

  useEffect(() => {
    // A result named in the URL that this client has not seen finish (§47.1).
    // The result screen is reached *after* the battle it describes, so arriving
    // from a shared link is the common case rather than the exception — and a
    // client that only learned results from a live event would answer it with
    // "no finalized battle yet", which is true of the client and false of the
    // world.
    if (route.kind !== 'RESULT' || route.battleId === null || route.battleId in lastResults) {
      return;
    }
    const endpoints = liveEndpoints(import.meta.env);
    if (endpoints === null) {
      return;
    }
    const controller = new AbortController();
    void fetchBattleResult(endpoints, route.battleId, controller.signal).then((result) => {
      if (result !== null) {
        useSession.getState().rememberResult(result);
      }
    });
    return () => {
      controller.abort();
    };
  }, [route, lastResults]);

  useEffect(() => {
    // Only when there is nothing real to show. A configured build that fell
    // back to these would be presenting invented battles as a running round,
    // which is the one thing this client must never do — the banner says
    // PREVIEW because the content is a preview, and both have to stay true
    // together.
    if (status.live) {
      return;
    }
    setBattles(PLACEHOLDER_BATTLES);
    setMyBattle('preview-b2');
    setWallet(PLACEHOLDER_WALLET);
    setRound(placeholderRound(), nowUtc());
    // The same card the Genesis preview reveals, with a charge spent. A demo
    // that opened Golden Army and then showed a different card in the profile
    // would teach the reader that the two are unrelated.
    setCard({ name: 'Golden Army', rarity: 'LEGENDARY', usesRemaining: 2 });
  }, [status.live, setBattles, setMyBattle, setWallet, setRound, setCard]);

  useEffect(() => {
    // Every route but the world is a page presented over it (§81.2). The
    // camera reframes so the world sits beside the page instead of behind it,
    // and returns to the global anchor on the way back in. It is one place the
    // whole time — §37.9 — so this is a move, never a load.
    presentWorld(route.kind !== 'WORLD', nowUtc());
  }, [route.kind, presentWorld]);

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
    <WalletSessionProvider session={walletSession}>
      {/* Mounted once, outside every route branch. Nothing below can unmount
          it, which is how §80.4's constraint stays true by construction. */}
      <Suspense fallback={<WorldLoading />}>
        <WorldCanvas />
      </Suspense>
      {/* The HUD belongs to the world, and every other route is a page over it.
          Showing both put a round countdown and a set of world controls behind
          a page explaining what a round is — and, because the HUD carries a
          navigation bar of its own, a second bar underneath the overlay's,
          marking `WORLD` as the current page while the visitor was reading the
          about page. */}
      {route.kind === 'WORLD' ? <Hud onNavigate={navigate} /> : null}
      <div
        style={{
          position: 'fixed',
          top: 'var(--pw-space-3)',
          left: 0,
          right: 0,
          display: 'grid',
          justifyItems: 'center',
          // Information, not a control: it must never intercept a drag meant
          // for the world beneath it (§37.3).
          pointerEvents: 'none',
          zIndex: LAYER.hud,
        }}
      >
        <PreviewBanner status={status} />
      </div>
      {route.kind === 'LANDING' ? <Landing onNavigate={navigate} /> : null}

      {route.kind === 'FACTIONS' ? (
        <Overlay
          title="FACTIONS"
          route={route}
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={() => {
            navigate(WORLD_ROUTE);
          }}
        >
          <Factions ticker={route.ticker} onNavigate={navigate} />
        </Overlay>
      ) : null}

      {isPresentation(route) && route.kind !== 'LANDING' && route.kind !== 'FACTIONS' ? (
        <Presentations
          route={route}
          navigate={navigate}
          // Preview figures under the preview banner, and the signed-in wallet's
          // own record in a live round — never figures invented for it. The
          // pool balance and Genesis claims are read from the chain, which
          // nothing reads yet, so a live round says so rather than guess.
          profile={
            status.live
              ? fromLiveProfile(liveProfile, warRoomFrom)
              : { status: 'READY', value: PLACEHOLDER_PROFILE }
          }
          reward={
            status.live
              ? fromLiveProfile(liveProfile, (profile) => currentWindowView(profile.currentWindow))
              : {
                  status: 'READY',
                  value: activeWindowView({
                    distributionId: 42,
                    warPoints: PLACEHOLDER_WALLET.warPoints,
                    closesAt: utcTimestamp(Date.now() + 6 * 3_600_000 + 42 * 60_000 + 18_000),
                  }),
                }
          }
          pool={status.live ? null : PLACEHOLDER_POOL}
          genesis={
            status.live
              ? walletSession.authorization === null
                ? { status: 'SIGNED_OUT' }
                : { status: 'UNPUBLISHED', copy: GENESIS_UNPUBLISHED }
              : { status: 'READY', value: PLACEHOLDER_GENESIS }
          }
          result={status.live ? finished : PLACEHOLDER_RESULT}
        />
      ) : null}
    </WalletSessionProvider>
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
