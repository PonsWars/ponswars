import { About } from '../about/About.js';
import { NavBar } from '../hud/NavBar.js';
import { controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import { useState, type JSX } from 'react';
import {
  CARD_CATALOG,
  type ActiveTicker,
  type CardType,
  type ConfidenceLabel,
  type FinalizedBattleResult,
} from '@ponswars/shared-types';
import { FACTION_ART } from '../art/manifest.js';
import { GenesisCardFace } from '../art/GenesisCardFace.js';
import { CardLadder } from '../genesis/CardLadder.js';
import { GenesisClaim, type GenesisPageData } from '../genesis/GenesisClaim.js';
import { WarRoom, type ProfileData } from '../profile/WarRoom.js';
import { RewardClaims, type RewardClaimsData } from '../rewards/RewardClaims.js';
import { RewardsHub, type PoolStatus } from '../rewards/RewardsHub.js';
import { SecretClaim } from '../rewards/SecretClaim.js';
import type { SecretClaimView } from '../rewards/secret-view.js';
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
import { signedOutCopy, type PersonalData, type PersonalPage } from './unpublished.js';

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
  claims,
  secret,
  genesis,
  result,
  voided,
}: {
  readonly route: PresentationRoute | ResultRoute;
  readonly navigate: (next: Route) => void;
  readonly profile: PersonalData<ProfileData>;
  readonly reward: PersonalData<RewardView>;
  readonly pool: PoolStatus | null;
  /** The wallet's published rewards, once read; `null` where there are none to show. */
  readonly claims: RewardClaimsData | null;
  /** The Secret this wallet holds; `null` for every wallet that holds none. */
  readonly secret: { readonly view: SecretClaimView; readonly onClaim: () => void } | null;
  readonly genesis: PersonalData<GenesisPageData>;
  readonly result: FinishedBattle | null;
  /**
   * The battle this page was opened for, if it voided (§4.4).
   *
   * Separate from `result` because it is not one: a void produces no score, no
   * winner and no award. What it produces is an explanation, and the page owes
   * the reader that rather than "nothing has finished yet".
   */
  readonly voided: { readonly message: string; readonly nextStep: string } | null;
}): JSX.Element {
  const close = (): void => {
    navigate(WORLD_ROUTE);
  };

  /**
   * A personal page in whatever state its record is in.
   *
   * Every state but `READY` says what is happening instead of showing a record,
   * so an empty record can only ever mean a wallet that has not played.
   */
  function personal<T>(
    page: PersonalPage,
    data: PersonalData<T>,
    render: (value: T) => JSX.Element,
  ): JSX.Element {
    switch (data.status) {
      case 'READY':
        return render(data.value);
      case 'LOADING':
        return <LoadingState page={page} />;
      case 'SIGNED_OUT': {
        const copy = signedOutCopy(page);
        return (
          <EmptyState
            headline={copy.headline}
            body={copy.body}
            action="BACK TO THE WORLD →"
            onAction={close}
            {...(page === 'GENESIS'
              ? { showcase: <GenesisShowcase /> }
              : { art: page === 'REWARDS' ? SIGNED_OUT_ART.REWARDS : SIGNED_OUT_ART.PROFILE })}
          />
        );
      }
      case 'UNPUBLISHED':
        return (
          <EmptyState
            headline={data.copy.headline}
            body={data.copy.body}
            action="BACK TO THE WORLD →"
            onAction={close}
          />
        );
      case 'FAILED':
        return (
          <EmptyState
            headline={data.copy.headline}
            body={data.copy.body}
            action="TRY AGAIN"
            onAction={data.retry}
          />
        );
    }
  }

  switch (route.kind) {
    case 'PROFILE':
      return (
        <Overlay
          title="COMMANDER PROFILE"
          route={route}
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          {personal('PROFILE', profile, (value) => (
            <WarRoom profile={value} />
          ))}
        </Overlay>
      );
    case 'REWARDS':
      return (
        <Overlay
          title="REWARDS"
          route={route}
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          {personal('REWARDS', reward, (value) => (
            <>
              <RewardsPresentation view={value} pool={pool} />
              {secret === null ? null : <SecretClaim view={secret.view} onClaim={secret.onClaim} />}
              {claims === null ? null : <RewardClaims data={claims} />}
            </>
          ))}
        </Overlay>
      );
    case 'ABOUT':
      return (
        <Overlay
          title="ABOUT"
          route={route}
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
          route={route}
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          {result === null && voided !== null ? (
            // §4.4: this battle did finish, and nothing further is coming. The
            // sentences are the server's own (§110.5, §110.6) — including the
            // one about the card charge — because a client that wrote its own
            // would be a second place for that copy to drift.
            <EmptyState
              headline="BATTLE VOID"
              body={`${voided.message} ${voided.nextStep}`}
              action="WATCH THE WORLD →"
              onAction={close}
            />
          ) : result === null ? (
            // §22: a result exists only after finalization. Before that there is
            // nothing honest to show, and inventing a placeholder scoreline on
            // the one screen that carries real numbers would be the worst place
            // in the product to do it. §110.5 still asks the copy to say what
            // happened and what to do — a bare line reads as a page that failed
            // to load rather than as a battle that has not finished.
            <EmptyState
              headline="NOTHING HAS FINISHED YET"
              body="A result is published when a battle finalizes, with the full working behind it. Watch a round in the world and this page fills in when the bell goes."
              action="WATCH THE WORLD →"
              onAction={close}
            />
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
          route={route}
          nav={<NavBar current={route} onNavigate={navigate} />}
          onClose={close}
        >
          {personal('GENESIS', genesis, (value) => (
            <GenesisClaim page={value} onDone={close} />
          ))}
          {/* What a card can be, under whatever the page is saying — except
              during the reveal itself, which keeps the screen to itself
              (§40.6). Read from the locked catalog (§7.2). */}
          {genesis.status === 'READY' && genesis.value.view.kind === 'CARD' ? null : <CardLadder />}
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

/**
 * A record on its way (§42.14).
 *
 * Says what is being fetched rather than spinning, and holds the page's place
 * so the record does not arrive into a layout that jumps.
 */
function LoadingState({ page }: { readonly page: PersonalPage }): JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)', maxWidth: 560 }}
    >
      <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>
        {page === 'REWARDS'
          ? 'READING YOUR WINDOW…'
          : page === 'GENESIS'
            ? 'READING YOUR GENESIS CLAIM…'
            : 'READING YOUR RECORD…'}
      </h2>
      <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.55 }}>
        From the battles you have played and the War Points they earned.
      </p>
    </div>
  );
}

/**
 * What a presentation shows when there is honestly nothing to show.
 *
 * §110.5 asks error and empty copy to say what happened and what to do next.
 * A single grey line saying `NO FINALIZED BATTLE YET` says the first badly and
 * the second not at all — on a full-width page it reads as something that
 * failed to load rather than as a round that has not finished yet.
 */
function EmptyState({
  headline,
  body,
  action,
  onAction,
  art,
  showcase,
}: {
  readonly headline: string;
  readonly body: string;
  readonly action: string;
  readonly onAction: () => void;
  /** A plate across the top: what the page is about, before there is a record in it. */
  readonly art?: string;
  /** Something to look at beside the copy, where the page has one to show. */
  readonly showcase?: JSX.Element;
}): JSX.Element {
  const copy = (
    <div style={{ display: 'grid', gap: 'var(--pw-space-3)', alignContent: 'center' }}>
      <h2 style={{ ...readoutStyle, margin: 0, fontSize: 18 }}>{headline}</h2>
      <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 13, lineHeight: 1.55 }}>{body}</p>
      <button type="button" onClick={onAction} style={{ ...controlStyle, justifySelf: 'start' }}>
        {action}
      </button>
    </div>
  );

  if (showcase !== undefined) {
    return (
      <div
        style={{
          ...panelStyle,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 'var(--pw-space-5)',
          alignItems: 'center',
          padding: 'var(--pw-space-5)',
        }}
      >
        {copy}
        {showcase}
      </div>
    );
  }

  return (
    <div
      style={{
        ...panelStyle,
        padding: 0,
        overflow: 'hidden',
        maxWidth: art === undefined ? 560 : 760,
      }}
    >
      {art === undefined ? null : (
        <div style={{ position: 'relative', height: 220 }}>
          <img
            src={art}
            alt=""
            decoding="async"
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'center 40%',
            }}
          />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'linear-gradient(180deg, rgba(6,11,16,0) 45%, var(--pw-surface-2) 100%)',
            }}
          />
        </div>
      )}
      <div style={{ padding: 'var(--pw-space-3) var(--pw-space-4) var(--pw-space-4)' }}>{copy}</div>
    </div>
  );
}

/**
 * The plates the signed-out record pages stand under.
 *
 * An army rather than a record: a page with no wallet behind it has nothing of
 * the visitor's to show, and a blank panel on an empty screen read as a page
 * that had failed. Faction plates, because they are the art made at a width a
 * banner can use — a card illustration is cut for a card and goes soft here.
 * The AI Mech Legion for the war room, the benchmark faction (§28); the Market
 * Federation for the rewards, the index every faction is measured against.
 */
const SIGNED_OUT_ART = {
  PROFILE: FACTION_ART.NVDA,
  REWARDS: FACTION_ART.SPY,
} as const;

/**
 * Three cards from the pool, fanned, beside the Genesis sign-in.
 *
 * Catalog entries, not anyone's claim: no Genesis number and no charges spent,
 * which is how `GenesisCardFace` draws a class rather than a card (§7.6). One of
 * each of three rarities, so the fan says the pool has range without saying
 * what this visitor will draw.
 *
 * Spread wide enough that the card in front clears the name plates behind it.
 * At a narrower spread it cut both of them in half — REINFORCEM, AR MACHINE —
 * which reads as a stacking mistake rather than as a hand of cards. The cards
 * are a little smaller for it, so the whole fan still sits inside its panel on
 * a 1280-wide window.
 */
const SHOWCASE: readonly CardType[] = ['REINFORCEMENT', 'GOLDEN_ARMY', 'WAR_MACHINE'];

function GenesisShowcase(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        height: 330,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {SHOWCASE.map((type, index) => {
        const offset = index - 1;
        return (
          <div
            key={type}
            style={{
              position: 'absolute',
              transform: `translateX(${String(offset * 138)}px) translateY(${String(Math.abs(offset) * 20)}px) rotate(${String(offset * 11)}deg) scale(${offset === 0 ? '1' : '0.8'})`,
              zIndex: offset === 0 ? 2 : 1,
              filter: offset === 0 ? 'none' : 'brightness(0.72)',
              boxShadow: '0 18px 40px rgba(0, 0, 0, 0.55)',
            }}
          >
            <GenesisCardFace cardType={type} rarity={CARD_CATALOG[type].rarity} width={170} />
          </div>
        );
      })}
    </div>
  );
}
