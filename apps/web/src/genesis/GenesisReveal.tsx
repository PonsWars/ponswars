import type { CardType, Rarity } from '@ponswars/shared-types';
import { GenesisCardFace } from '../art/GenesisCardFace.js';
import { RARITY_COLOR } from '@ponswars/ui-tokens';
import { useEffect, useState, type JSX } from 'react';
import { captionStyle, controlStyle, panelStyle, readoutStyle } from '../hud/styles.js';
import { useSession } from '../state/session.js';
import { revealPlan, type RevealPlan } from './reveal-sequence.js';

/**
 * Plays the Genesis reveal (§27.3, §40.6).
 *
 * The script comes from `revealPlan`; this walks it. Keeping the sequence out of
 * the component is what lets the Secret ordering — reserve before reveal — be
 * asserted in a test rather than hoped for in a `useEffect`.
 *
 * A plan that has not completed never shows a card. When the vault has not yet
 * reserved a Secret, the script simply has no revealing step to reach, so there
 * is no path through this component that names one early.
 */

export interface GenesisOutcome {
  readonly genesisId: string;
  readonly rarity: Rarity;
  /**
   * Which card was drawn (§9.2).
   *
   * The type rather than the name, because the name is display copy and the
   * type is what `resolveGenesis` returns and what the catalog, the art and the
   * charge count are all keyed by. Matching art to a card by its printed name
   * would break the first time one is reworded.
   */
  readonly cardType: CardType;
  readonly cardName: string;
  readonly effect: string;
  /** §8.4: for a Secret, whether the vault reservation is confirmed. */
  readonly secretReservationSecured: boolean;
}

export function GenesisReveal({
  outcome,
  onDone,
}: {
  readonly outcome: GenesisOutcome;
  readonly onDone: () => void;
}): JSX.Element {
  const reducedMotion = useSession((state) => state.reducedMotion);
  const plan = revealPlan({
    rarity: outcome.rarity,
    secretReservationSecured: outcome.secretReservationSecured,
    reducedMotion,
  });
  const stepIndex = useRevealProgress(plan);
  const step = plan.steps[stepIndex];
  const finished = stepIndex === plan.steps.length - 1;

  return (
    <div style={{ display: 'grid', gap: 'var(--pw-space-4)', justifyItems: 'center' }}>
      <div
        style={{
          ...panelStyle,
          display: 'grid',
          gap: 'var(--pw-space-3)',
          justifyItems: 'center',
          minWidth: 280,
          padding: 'var(--pw-space-6)',
          textAlign: 'center',
        }}
      >
        {/* The sequence log. Each beat is a distinct thing the player is being
            told (§40.6), so completed lines stay legible rather than being
            replaced by the next one. */}
        <div style={{ display: 'grid', gap: 'var(--pw-space-1)', justifyItems: 'center' }}>
          {plan.steps.slice(0, stepIndex).map((completed) => (
            <div key={completed.label} style={{ ...captionStyle, color: 'var(--pw-text-3)' }}>
              {completed.label}
            </div>
          ))}
        </div>

        <div
          style={{
            ...readoutStyle,
            fontSize: 20,
            color: finished && plan.complete ? RARITY_COLOR[outcome.rarity] : 'var(--pw-text-1)',
          }}
          aria-live="polite"
        >
          {step?.label ?? ''}
        </div>

        {finished && plan.complete ? <RevealedCard outcome={outcome} /> : null}

        {finished && !plan.complete ? (
          // A Secret whose reservation has not landed. Not an error — the
          // sequence is waiting, and saying so beats a spinner with no subject.
          <div style={{ fontSize: 12, color: 'var(--pw-text-2)', maxWidth: 280 }}>
            Your reward is being reserved before it is revealed. This page will finish on its own.
          </div>
        ) : null}
      </div>

      {finished ? (
        <button type="button" style={controlStyle} onClick={onDone}>
          {plan.complete ? 'CONTINUE' : 'BACK TO WORLD'}
        </button>
      ) : null}
    </div>
  );
}

function RevealedCard({ outcome }: { readonly outcome: GenesisOutcome }): JSX.Element {
  return (
    <div
      style={{
        ...panelStyle,
        borderColor: RARITY_COLOR[outcome.rarity],
        display: 'grid',
        gap: 'var(--pw-space-3)',
        justifyItems: 'center',
        width: '100%',
      }}
    >
      {/* The card itself (§40.6).
          §17 of the visual guide makes the card art the object a player owns,
          and this is the moment they receive it — a panel of text describing a
          card is not a reveal. Every card in the pool has a face now, so this
          moment no longer depends on which of the fourteen was drawn.

          A rarity-tinted halo rather than a border: a frame around a framed
          card reads as a picture of one. */}
      <div
        style={{
          filter: `drop-shadow(0 0 26px ${RARITY_COLOR[outcome.rarity]}55)`,
          maxWidth: '100%',
        }}
      >
        <GenesisCardFace
          cardType={outcome.cardType}
          rarity={outcome.rarity}
          genesisId={outcome.genesisId}
          width={300}
        />
      </div>

      {/* The effect once more in running text. The card prints it too, and this
          is the line a screen reader reaches — the face is one image with one
          label, and §110 does not let the only statement of what a card does be
          inside a picture. */}
      <div style={{ fontSize: 13, color: 'var(--pw-text-2)' }}>
        {outcome.cardName} — {outcome.effect}
      </div>
    </div>
  );
}

/**
 * Walks the script one step at a time.
 *
 * Each step schedules the next from its own duration, so the sequence keeps the
 * pacing §40.6 describes instead of a single interval that would give every
 * beat the same weight. Restarts when the plan changes — a Secret reservation
 * landing mid-sequence extends the script, and the extra beats should play.
 */
function useRevealProgress(plan: RevealPlan): number {
  const [index, setIndex] = useState(0);
  // Labels *and* durations: toggling reduced motion keeps every label and
  // changes every duration, so a key built from labels alone would leave the
  // sequence playing at the old pace.
  const shape = plan.steps.map((step) => `${step.label}:${String(step.duration)}`).join('|');

  useEffect(() => {
    setIndex(0);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const advance = (at: number): void => {
      if (cancelled || at >= plan.steps.length - 1) {
        return;
      }
      const current = plan.steps[at];
      if (current === undefined) {
        return;
      }
      timer = setTimeout(() => {
        if (cancelled) {
          return;
        }
        setIndex(at + 1);
        advance(at + 1);
      }, current.duration);
    };
    advance(0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `shape` alone. `plan` is rebuilt on every render, so depending on it
    // would restart the sequence on every render and the reveal would never
    // advance past its first beat. Two plans with the same labels and the same
    // durations play identically, which is exactly what `shape` compares.
  }, [shape]);

  return index;
}
