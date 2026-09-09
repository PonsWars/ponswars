import { About } from '../about/About.js';
import { NavBar } from '../hud/NavBar.js';
import { useState, type JSX } from 'react';
import type { ActiveTicker, ConfidenceLabel, FinalizedBattleResult } from '@ponswars/shared-types';
import { GenesisReveal, type GenesisOutcome } from '../genesis/GenesisReveal.js';
import { WarRoom, type ProfileData } from '../profile/WarRoom.js';
import { RewardsHub, type PoolStatus } from '../rewards/RewardsHub.js';
import { canTransitionClaim, type ClaimState, type RewardView } from '../rewards/reward-view.js';
import { ResultScreen } from '../result/ResultScreen.js';
import { playerResultView } from '../result/result-view.js';
import {
  WORLD_ROUTE,
  type PresentationRoute,
  type ResultRoute,
  type Route,
} from '../routing/route.js';
import { Overlay } from './Overlay.js';

/**
 * Routes the three presentations that layer over the world (§80.4).
 *
 * A `switch`, not a route tree. The world is mounted by the shell and stays
 * mounted through every one of these — §80.4 forbids a route change from
 * destroying the scene, and the surest way to keep that true is to give no
 * route the power to own the canvas.
 */
export function Presentations({
  route,
  navigate,
  profile,
  reward,
  pool,
  genesis,
  result,
}: {
  readonly route: PresentationRoute | ResultRoute;
  readonly navigate: (next: Route) => void;
  readonly profile: ProfileData;
  readonly reward: RewardView;
  readonly pool: PoolStatus | null;
  readonly genesis: GenesisOutcome | null;
  readonly result: FinishedBattle | null;
}): JSX.Element {
  const close = (): void => {
    navigate(WORLD_ROUTE);
  };

  switch (route.kind) {
    case 'PROFILE':
      return (
        <Overlay
          title="COMMANDER PROFILE"
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          <WarRoom profile={profile} />
        </Overlay>
      );
    case 'REWARDS':
      return (
        <Overlay
          title="REWARDS"
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          <RewardsPresentation view={reward} pool={pool} />
        </Overlay>
      );
    case 'ABOUT':
      return (
        <Overlay
          title="ABOUT"
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          <About onNavigate={navigate} />
        </Overlay>
      );
    case 'RESULT':
      return (
        <Overlay
          title="BATTLE RESULT"
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          {result === null ? (
            // §22: a result exists only after finalization. Before that there is
            // nothing honest to show, and inventing a placeholder scoreline on
            // the one screen that carries real numbers would be the worst place
            // in the product to do it.
            <div style={{ color: 'var(--pw-text-3)', fontSize: 13 }}>NO FINALIZED BATTLE YET</div>
          ) : (
            <ResultScreen
              result={result.result}
              player={
                result.backed === null
                  ? null
                  : playerResultView({
                      backed: result.backed,
                      winner: result.result.winner,
                      winnerConfidence: result.winnerConfidence,
                      cardDeployed: result.cardDeployed,
                    })
              }
            />
          )}
        </Overlay>
      );
    case 'GENESIS':
      return (
        // The reveal keeps its own pacing (§40.6) and the bar sits above it
        // rather than in it — a ceremony a visitor cannot navigate away from is
        // a trap, and §80.4 puts the same bar on every surface.
        <Overlay
          title="GENESIS"
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          {genesis === null ? (
            // §42.14: say what is actually true rather than showing an empty
            // ceremony. A wallet with no Genesis claim has nothing to reveal.
            <div style={{ color: 'var(--pw-text-3)', fontSize: 13 }}>
              NO GENESIS CLAIM ON THIS WALLET
            </div>
          ) : (
            <GenesisReveal outcome={genesis} onDone={close} />
          )}
        </Overlay>
      );
  }
}

/**
 * A finalized battle plus what the player had riding on it.
 *
 * The backing is separate from the result because the result is the same for
 * every spectator and the backing is not (§61 principle 3). `null` is a
 * spectator, which is the common case.
 */
export interface FinishedBattle {
  readonly result: FinalizedBattleResult;
  readonly backed: ActiveTicker | null;
  /** The winner's pre-battle confidence, snapshotted at lock (§10.3). */
  readonly winnerConfidence: ConfidenceLabel;
  readonly cardDeployed: boolean;
}

/**
 * Drives the claim state machine (§35.6).
 *
 * Every step goes through `canTransitionClaim`, so the UI cannot reach a state
 * the machine does not allow — a submit that skipped wallet confirmation, or a
 * failure treated as final. The transitions are advanced locally here because
 * the wallet and RPC clients are `OPEN` (§102); when they land, each step is
 * driven by a real event and the guard stays exactly as it is.
 */
function RewardsPresentation({
  view,
  pool,
}: {
  readonly view: RewardView;
  readonly pool: PoolStatus | null;
}): JSX.Element {
  const [claim, setClaim] = useState<ClaimState>('READY_TO_CLAIM');

  const advance = (next: ClaimState): void => {
    setClaim((current) => (canTransitionClaim(current, next) ? next : current));
  };

  return (
    <RewardsHub
      view={view}
      pool={pool}
      claim={view.kind === 'FINALIZED' ? claim : null}
      onClaim={() => {
        // From FAILED the first legal step is back to ready; from ready it is
        // wallet confirmation. Asking the machine rather than branching here
        // keeps the two paths from drifting apart.
        advance(claim === 'FAILED' ? 'READY_TO_CLAIM' : 'CONFIRM_IN_WALLET');
      }}
    />
  );
}
