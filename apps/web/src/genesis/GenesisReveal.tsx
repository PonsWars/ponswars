import { CARD_CATALOG, RARITY_USES, type CardType, type Rarity } from '@ponswars/shared-types';
import { GenesisCardFace } from '../art/GenesisCardFace.js';
import { PonsWarsMark } from '../art/PonsWarsMark.js';
import { RARITY_COLOR } from '@ponswars/ui-tokens';
import { useEffect, useState, type JSX } from 'react';
import { captionStyle, controlStyle, readoutStyle } from '../hud/styles.js';
import { useNarrowViewport } from '../hud/useNarrowViewport.js';
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
  const finished = stepIndex === plan.steps.length - 1;

  const revealed = finished && plan.complete;
  const tint = revealed ? RARITY_COLOR[outcome.rarity] : SEALED_TINT;
  const uses = RARITY_USES[outcome.rarity];
  const narrow = useNarrowViewport();

  return (
    <section
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        alignItems: 'center',
        gap: 'var(--pw-space-6)',
        minHeight: narrow ? undefined : 540,
        padding: narrow ? 'var(--pw-space-5) var(--pw-space-4)' : 'var(--pw-space-6)',
        borderRadius: 'var(--pw-radius-panel)',
        border: 'var(--pw-line-hair) solid var(--pw-border-1)',
        // The chamber the card is dealt in: dark, lit from under the card, and
        // in the rarity's own light once it is known (§40.6). Before that, a
        // neutral cold light — the colour must not arrive before the word.
        background: `radial-gradient(ellipse 42% 60% at 72% 62%, ${tint}40, transparent 70%), var(--pw-surface-2)`,
        transition: 'background var(--pw-dur-cinematic) var(--pw-ease-spatial)',
      }}
    >
      {/* On a phone the card leads: §42.16 asks for a near-fullscreen reveal,
          and a reveal whose card is below the fold is a page of text. */}
      <div
        style={{
          display: 'grid',
          gap: 'var(--pw-space-4)',
          alignContent: 'center',
          order: narrow ? 1 : 0,
        }}
      >
        <div style={captionStyle}>GENESIS PROTOCOL</div>

        {revealed ? (
          <>
            <div
              style={{
                ...captionStyle,
                justifySelf: 'start',
                padding: '3px 10px',
                borderRadius: 999,
                border: `1px solid ${tint}`,
                color: tint,
              }}
            >
              {outcome.rarity}
            </div>
            {/* The card named in words as well as on its face: the face is one
                image with one label, and §110 does not let the only statement
                of what a card does be inside a picture. */}
            <h2
              style={{
                ...readoutStyle,
                margin: 0,
                fontSize: 'clamp(30px, 4vw, 44px)',
                fontWeight: 700,
                lineHeight: 1.05,
                color: tint,
              }}
            >
              {outcome.cardName.toUpperCase()}
            </h2>
            <p style={{ margin: 0, color: 'var(--pw-text-2)', fontSize: 14, lineHeight: 1.55 }}>
              {CARD_CATALOG[outcome.cardType].visualSignature}.
            </p>
            <dl style={{ margin: 0, display: 'grid', gap: 'var(--pw-space-2)' }}>
              <Fact term="EFFECT" value={outcome.effect} />
              <Fact term="BATTLES" value={`${String(uses)} ${uses === 1 ? 'USE' : 'USES'}`} />
              <Fact term="GENESIS" value={`#${outcome.genesisId}`} />
            </dl>
            <button
              type="button"
              onClick={onDone}
              style={{
                ...controlStyle,
                justifySelf: 'start',
                marginTop: 'var(--pw-space-2)',
                padding: 'var(--pw-space-3) var(--pw-space-6)',
                borderColor: tint,
                color: tint,
              }}
            >
              CONTINUE →
            </button>
          </>
        ) : (
          <>
            <h2
              style={{
                ...readoutStyle,
                margin: 0,
                fontSize: 'clamp(28px, 3.6vw, 40px)',
                fontWeight: 700,
                lineHeight: 1.05,
              }}
            >
              INITIALIZING
              <br />
              GENESIS CARD
            </h2>

            {/* The sequence log. Each beat is a distinct thing the player is
                being told (§40.6), so completed lines stay, ticked, rather than
                being replaced by the next one. Only what has happened and what
                is happening: listing the beats still to come would name a
                Secret's steps before the Secret. */}
            <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
              {plan.steps.slice(0, stepIndex + 1).map((beat, index) => (
                <li
                  key={beat.label}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--pw-space-3)',
                    fontSize: 13,
                    letterSpacing: '0.08em',
                    color: index === stepIndex ? 'var(--pw-text-1)' : 'var(--pw-text-3)',
                  }}
                >
                  <StepMark done={index < stepIndex} />
                  <span aria-live={index === stepIndex ? 'polite' : undefined}>{beat.label}</span>
                </li>
              ))}
            </ol>

            {finished ? (
              // A Secret whose reservation has not landed. Not an error — the
              // sequence is waiting, and saying so beats a spinner with no subject.
              <>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--pw-text-2)', maxWidth: 340 }}>
                  Your reward is being reserved before it is revealed. This page will finish on its
                  own.
                </p>
                <button
                  type="button"
                  onClick={onDone}
                  style={{ ...controlStyle, justifySelf: 'start' }}
                >
                  BACK TO WORLD
                </button>
              </>
            ) : null}
          </>
        )}
      </div>

      {/* The stage: the card over a lit plinth. Sealed until the script names
          what was drawn, then the face (§40.6). */}
      <div
        style={{
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
          minHeight: narrow ? 420 : 460,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            bottom: 18,
            width: 300,
            height: 46,
            borderRadius: '50%',
            border: `1px solid ${tint}66`,
            boxShadow: `0 0 40px ${tint}44, inset 0 0 30px ${tint}33`,
            transition: 'border-color var(--pw-dur-cinematic), box-shadow var(--pw-dur-cinematic)',
          }}
        />
        {revealed ? (
          <div
            className="pw-card-arrive"
            style={{
              position: 'relative',
              filter: `drop-shadow(0 0 34px ${tint}66)`,
              maxWidth: '100%',
            }}
          >
            <GenesisCardFace
              cardType={outcome.cardType}
              rarity={outcome.rarity}
              genesisId={outcome.genesisId}
              width={290}
            />
          </div>
        ) : (
          <SealedCard />
        )}
      </div>
    </section>
  );
}

/** The neutral light of the chamber before a rarity is known. */
const SEALED_TINT = '#7fd4ff';

function Fact({ term, value }: { readonly term: string; readonly value: string }): JSX.Element {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '84px 1fr',
        alignItems: 'baseline',
        gap: 'var(--pw-space-3)',
        paddingBottom: 'var(--pw-space-2)',
        borderBottom: 'var(--pw-line-hair) solid var(--pw-border-1)',
      }}
    >
      <dt style={captionStyle}>{term}</dt>
      <dd style={{ margin: 0, fontSize: 14, color: 'var(--pw-text-1)' }}>{value}</dd>
    </div>
  );
}

/** A beat done, or the one in progress. */
function StepMark({ done }: { readonly done: boolean }): JSX.Element {
  return done ? (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden style={{ flex: 'none' }}>
      <circle cx={9} cy={9} r={8.5} fill="var(--pw-accent-muted)" stroke="var(--pw-accent)" />
      <path d="M5 9.4 L7.8 12 L13 6.4" fill="none" stroke="var(--pw-accent)" strokeWidth={1.8} />
    </svg>
  ) : (
    <svg
      width={18}
      height={18}
      viewBox="0 0 18 18"
      aria-hidden
      className="pw-spin"
      style={{ flex: 'none' }}
    >
      <circle cx={9} cy={9} r={7.5} fill="none" stroke="var(--pw-border-2)" strokeWidth={1.5} />
      <path
        d="M9 1.5 A7.5 7.5 0 0 1 16.5 9"
        fill="none"
        stroke="var(--pw-text-1)"
        strokeWidth={1.8}
      />
    </svg>
  );
}

/**
 * The card before it is known: a dark frame with the house mark, breathing.
 *
 * The same proportions as the face that replaces it, so the reveal is the card
 * turning up its face rather than one rectangle swapped for another.
 */
function SealedCard(): JSX.Element {
  return (
    <div
      className="pw-seal-pulse"
      aria-hidden="true"
      style={{
        position: 'relative',
        width: 290,
        aspectRatio: '300 / 420',
        borderRadius: 14,
        border: '1px solid rgba(214, 236, 248, 0.28)',
        background:
          'linear-gradient(160deg, rgba(38, 52, 64, 0.95), rgba(8, 13, 18, 0.98) 55%, rgba(22, 32, 40, 0.95))',
        boxShadow: `0 0 40px ${SEALED_TINT}33, inset 0 0 0 6px rgba(5, 8, 11, 0.9), inset 0 0 0 7px rgba(214, 236, 248, 0.14)`,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <PonsWarsMark size={96} color="rgba(214, 236, 248, 0.55)" />
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
