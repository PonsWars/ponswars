import { RARITY_USES, type Rarity } from '@ponswars/shared-types';
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
        gap: 'var(--pw-space-2)',
        justifyItems: 'center',
        width: '100%',
      }}
    >
      <div style={{ ...readoutStyle, fontSize: 24 }}>{outcome.cardName.toUpperCase()}</div>
      <div style={{ ...captionStyle, color: RARITY_COLOR[outcome.rarity] }}>{outcome.rarity}</div>
      <div style={{ fontSize: 13, color: 'var(--pw-text-2)' }}>{outcome.effect}</div>
      <div className="pw-tabular" style={{ ...captionStyle, color: 'var(--pw-text-3)' }}>
        USES {String(RARITY_USES[outcome.rarity]).padStart(2, '0')} · GENESIS #{outcome.genesisId}
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
