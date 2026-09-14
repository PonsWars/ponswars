import {
  MIN_QUALIFYING_WP,
  PER_WALLET_CAP_BPS,
  POOL_DISTRIBUTABLE_BPS,
} from '@ponswars/shared-types';
import { useEffect, useState, type JSX } from 'react';
import { RewardVault } from '../art/RewardVault.js';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import {
  claimCopy,
  formatWindowCountdown,
  type ClaimState,
  type RewardView,
} from './reward-view.js';

/**
 * The Rewards Hub (§35).
 *
 * Two shapes, one screen. An open window shows War Points, weight, pool status
 * and qualification; a published one shows the final allocation and the claim.
 * The split is not a rendering convenience — `RewardView`'s active variant has
 * no allocation field at all, so §35.2's ban on estimated SPY during an active
 * window is a fact about the data rather than a rule this component has to keep
 * remembering.
 */

export interface PoolStatus {
  /** Current Rewards Distribution Wallet balance, formatted by the caller. */
  readonly balance: string;
}

export function RewardsHub({
  view,
  pool,
  claim,
  onClaim,
}: {
  readonly view: RewardView;
  readonly pool: PoolStatus | null;
  readonly claim: ClaimState | null;
  readonly onClaim: () => void;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-4)' }}>
      {/* Two columns: where this wallet stands on the left, what the pool is
          doing on the right. It was five full-width panels in a column, which
          is exactly the stack of figures about money the delivered hub avoids. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: 'var(--pw-space-4)',
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'grid', gap: 'var(--pw-space-4)' }}>
          <div
            style={{
              ...panelStyle,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              alignItems: 'center',
              gap: 'var(--pw-space-5)',
              padding: 'var(--pw-space-5)',
              background:
                'radial-gradient(ellipse 40% 80% at 18% 50%, rgba(156, 255, 56, 0.1), transparent 70%), var(--pw-surface-2)',
            }}
          >
            {/* The object the whole page is about. §35 measures participation
                against a published formula, and a column of figures about money
                is exactly the shape the delivered hub avoids. */}
            <RewardVault size={150} charged={pool !== null} />

            <div style={{ display: 'grid', gap: 'var(--pw-space-3)', minWidth: 0 }}>
              <div style={captionStyle}>{view.label}</div>
              {view.kind === 'ACTIVE' ? <WindowCountdown closesAt={view.closesAt} /> : null}
              <Qualification view={view} />
            </div>
          </div>
          {view.kind === 'ACTIVE' ? <WeightPanel view={view} /> : null}
        </div>

        <div style={{ display: 'grid', gap: 'var(--pw-space-4)' }}>
          {view.kind === 'ACTIVE' ? (
            <>
              {pool === null ? null : <PoolPanel pool={pool} />}
              <NoEstimateYet />
            </>
          ) : (
            <FinalizedPanels view={view} claim={claim} onClaim={onClaim} />
          )}
        </div>
      </div>

      <RewardsFlow />
    </div>
  );
}

/** §35.1: `84 WP · Minimum: 50 WP · QUALIFIED ✓`, or the shortfall. */
function Qualification({ view }: { readonly view: RewardView }): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-1)' }}>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 30 }}>
        {view.qualified
          ? `${String(view.warPoints)} WP`
          : `${String(view.warPoints)} / ${String(MIN_QUALIFYING_WP)} WP`}
      </div>
      {view.qualified ? (
        <div style={{ ...captionStyle, color: 'var(--pw-accent)' }}>
          QUALIFIED FOR DISTRIBUTION ✓
        </div>
      ) : (
        <div style={{ ...captionStyle, color: 'var(--pw-warning)' }}>
          {view.wpToQualify} WP TO QUALIFY
        </div>
      )}
    </div>
  );
}

/**
 * §35.2: this wallet's weight while the window is open.
 *
 * The explanatory line is not filler. Without it, a reward weight next to a pool
 * balance reads as a payout in waiting, which is precisely the impression §35.2
 * exists to prevent.
 */
function WeightPanel({
  view,
}: {
  readonly view: Extract<RewardView, { kind: 'ACTIVE' }>;
}): JSX.Element | null {
  if (view.weightLabel === null) {
    return null;
  }
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>YOUR REWARD WEIGHT</div>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 30 }}>
        <span style={{ color: 'var(--pw-text-3)', fontSize: 18 }}>√{view.warPoints} = </span>
        <span style={{ color: 'var(--pw-accent)' }}>{view.weightLabel}</span>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--pw-text-2)' }}>
        Based on <span className="pw-tabular">sqrt({view.warPoints} WP)</span>. Final SPY allocation
        is calculated after the window closes.
      </div>
    </div>
  );
}

/**
 * §35.3: the pool while the window is open, with the split it is divided on.
 *
 * The same caveat as the weight: the balance shown is not the amount that will
 * be distributed, and the page says so beside it rather than in a footnote.
 */
function PoolPanel({ pool }: { readonly pool: PoolStatus }): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)' }}>
      <div style={captionStyle}>CURRENT REWARDS POOL</div>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 34 }}>
        {pool.balance} <span style={{ color: 'var(--pw-text-3)', fontSize: 20 }}>SPY</span>
      </div>
      <PoolAllocation />
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--pw-text-2)' }}>
        {POOL_DISTRIBUTABLE_BPS / 100}% distributable at snapshot. The final distributable amount is
        determined from the actual wallet balance at snapshot, not from this figure.
      </div>
    </div>
  );
}

/** §35.4 and §35.5: the finalized allocation, claimed or carried forward. */
function FinalizedPanels({
  view,
  claim,
  onClaim,
}: {
  readonly view: Extract<RewardView, { kind: 'FINALIZED' }>;
  readonly claim: ClaimState | null;
  readonly onClaim: () => void;
}): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)' }}>
      <div style={captionStyle}>DISTRIBUTION FINALIZED</div>
      <div style={{ display: 'flex', gap: 'var(--pw-space-5)', flexWrap: 'wrap' }}>
        <Field caption="YOUR WP" value={String(view.warPoints)} />
        <Field caption="REWARD WEIGHT" value={view.weightLabel ?? '—'} />
        <Field caption="FINAL ALLOCATION" value={`${view.allocation} SPY`} />
      </div>

      {view.capReached ? (
        <div style={{ ...captionStyle, color: 'var(--pw-warning)' }}>
          MAX ALLOCATION CAP REACHED
        </div>
      ) : null}

      {view.carriedForward ? (
        // §35.5: below the minimum claim threshold. *"The reward is not lost."*
        // Saying so is the whole point — a small number with no explanation
        // reads as a reward that quietly vanished.
        <div style={{ display: 'grid', gap: 'var(--pw-space-1)' }}>
          <div style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>CARRIED FORWARD</div>
          <div style={{ fontSize: 12, color: 'var(--pw-text-2)' }}>
            Below the minimum claim threshold, so it rolls into the next distribution. It is not
            lost.
          </div>
        </div>
      ) : (
        <ClaimAction claim={claim} onClaim={onClaim} />
      )}
    </div>
  );
}

/** §35.6: the claim state machine, in the player's words. */
function ClaimAction({
  claim,
  onClaim,
}: {
  readonly claim: ClaimState | null;
  readonly onClaim: () => void;
}): JSX.Element | null {
  if (claim === null) {
    return null;
  }
  const copy = claimCopy(claim);

  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-2)', justifyItems: 'start' }}>
      <div
        style={{
          ...readoutStyle,
          fontSize: 15,
          color: claim === 'FAILED' ? 'var(--pw-danger)' : 'var(--pw-text-1)',
        }}
      >
        {copy.headline}
      </div>
      {copy.detail === null ? null : (
        <div style={{ fontSize: 12, color: 'var(--pw-text-2)' }}>{copy.detail}</div>
      )}
      {copy.actionable ? (
        <button type="button" style={controlStyle} onClick={onClaim}>
          {claim === 'FAILED' ? 'TRY AGAIN' : 'CLAIM'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The countdown to the window closing (§35.1).
 *
 * Ticks once a second, aligned to the second boundary. Twenty-four hours is long
 * enough that a drifting timer would visibly disagree with itself over a
 * session.
 */
function WindowCountdown({ closesAt }: { readonly closesAt: number | null }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (closesAt === null) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      const current = Date.now();
      setNow(current);
      timer = setTimeout(schedule, 1_000 - (current % 1_000));
    };
    schedule();
    return () => {
      clearTimeout(timer);
    };
  }, [closesAt]);

  if (closesAt === null) {
    return (
      <div>
        <div style={captionStyle}>NEXT SNAPSHOT</div>
        <div style={{ fontSize: 13, color: 'var(--pw-text-2)' }}>
          Not scheduled yet. Your War Points keep counting toward this window until it is.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={captionStyle}>CLOSES IN</div>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 38, lineHeight: 1.1 }}>
        {formatWindowCountdown(closesAt - now)}
      </div>
    </div>
  );
}

function Field({
  caption,
  value,
}: {
  readonly caption: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div>
      <div style={captionStyle}>{caption}</div>
      <div className="pw-tabular" style={{ ...readoutStyle, fontSize: 18 }}>
        {value}
      </div>
    </div>
  );
}

/**
 * The split the pool is divided on, as a bar (§35.3).
 *
 * The same two figures the sentence beside it carries. A ratio stated only in
 * prose is a ratio most readers take on trust; the bar is what makes *most of
 * it goes out, some of it stays* something you can see before you read.
 */
function PoolAllocation(): JSX.Element {
  const distributable = POOL_DISTRIBUTABLE_BPS / 100;

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          height: 8,
          borderRadius: 2,
          overflow: 'hidden',
          border: '1px solid var(--pw-border-1)',
        }}
      >
        <div style={{ width: `${String(distributable)}%`, background: 'var(--pw-accent)' }} />
        <div style={{ flex: 1, background: 'var(--pw-surface-2)' }} />
      </div>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', ...captionStyle, fontSize: 9 }}
      >
        <span>{distributable}% DISTRIBUTABLE AT SNAPSHOT</span>
        <span style={{ color: 'var(--pw-text-3)' }}>{100 - distributable}% CARRYOVER</span>
      </div>
    </div>
  );
}

/**
 * The reward that does not exist yet, said out loud (§35.2).
 *
 * §35.2 bans an estimated SPY figure during an active window, and the data
 * model enforces it: the active variant of `RewardView` has no allocation
 * field. But a rule kept by omission is invisible — the page simply had no
 * reward on it, which reads as something that failed to load rather than as a
 * number that does not exist yet. The delivered hub shows the blank and says
 * why, which is the same restraint stated as a promise instead of a gap.
 */
function NoEstimateYet(): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-2)' }}>
      <div style={captionStyle}>YOUR REWARD (LIVE WINDOW)</div>
      <div
        className="pw-tabular"
        style={{ ...readoutStyle, fontSize: 26, color: 'var(--pw-text-3)' }}
      >
        — — — SPY
      </div>
      <div style={{ fontSize: 12, color: 'var(--pw-text-2)', lineHeight: 1.5 }}>
        Your exact reward is calculated after the snapshot. There are no estimates during an open
        window — the pool balance and the number of qualified participants both change until it
        closes, so any figure shown now would be a guess that later reads as a broken promise.
      </div>
    </div>
  );
}

/** Where the pool comes from and how it reaches a wallet (§35). */
const FLOW: readonly { readonly title: string; readonly body: string }[] = [
  { title: 'CREATOR FEES', body: 'The rewards wallet is funded from real trading activity.' },
  {
    title: 'SNAPSHOT',
    body: 'At the window close, the balance and every qualified wallet are read.',
  },
  { title: 'CALCULATION', body: 'Each share is the square root of that wallet’s War Points.' },
  { title: 'YOU CLAIM', body: 'The allocation is published and claimed onchain from this page.' },
];

/**
 * The four steps between a trade and a claim (§35).
 *
 * A rewards page that shows a pool and a button asks to be trusted about
 * everything in between. §26's principle — a result you can argue with rather
 * than only believe — is not only about battles.
 */
function RewardsFlow(): JSX.Element {
  return (
    <div style={{ ...panelStyle, display: 'grid', gap: 'var(--pw-space-3)' }}>
      <div style={captionStyle}>HOW A REWARD REACHES YOU</div>
      <ol
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 'var(--pw-space-3)',
          listStyle: 'none',
          margin: 0,
          padding: 0,
        }}
      >
        {FLOW.map((step, index) => (
          <li key={step.title} style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--pw-space-2)' }}>
              <span
                className="pw-tabular"
                style={{ ...readoutStyle, fontSize: 22, color: 'var(--pw-accent)' }}
              >
                {String(index + 1).padStart(2, '0')}
              </span>
              <span style={{ ...readoutStyle, fontSize: 15 }}>{step.title}</span>
            </div>
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--pw-text-2)' }}>
              {step.body}
            </p>
          </li>
        ))}
      </ol>
      {/* §35.8: the cap, explained before anyone hits it. A footnote to the
          flow rather than a panel of its own: it is a rule of step three. */}
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--pw-text-3)',
          paddingTop: 'var(--pw-space-3)',
          borderTop: 'var(--pw-line-hair) solid var(--pw-border-1)',
        }}
      >
        <span style={{ ...captionStyle, color: 'var(--pw-text-2)' }}>FAIR DISTRIBUTION CAP · </span>
        A single wallet can receive at most {PER_WALLET_CAP_BPS / 100}% of each distribution pool.
        Excess is redistributed according to the reward formula.
      </div>
    </div>
  );
}
