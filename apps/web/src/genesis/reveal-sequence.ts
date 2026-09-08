import { milliseconds, type DurationMs, type Rarity } from '@ponswars/shared-types';
import { durations } from '@ponswars/ui-tokens';

/**
 * The Genesis reveal sequence (§27.3, §40.6).
 *
 * A script, computed rather than choreographed by hand, so the sequence can be
 * asserted without rendering anything. §40.6 makes rarity change the *motion
 * grammar* and not merely the colour, so the grammar is the thing this module
 * returns — a component plays it, it does not invent it.
 *
 * The one rule here that is not about feel: a Secret reveals only after its
 * reward reservation is secured (§8.4, §27.3). That is not pacing, it is the
 * difference between telling someone they have won 0.2 SPY and being able to
 * pay them. The script cannot name a Secret before the vault has reserved it.
 */

/** The three motion grammars §40.6 distinguishes. */
export const REVEAL_GRAMMARS = ['STANDARD', 'LEGENDARY', 'SECRET'] as const;

export type RevealGrammar = (typeof REVEAL_GRAMMARS)[number];

export function grammarFor(rarity: Rarity): RevealGrammar {
  switch (rarity) {
    case 'SECRET':
      return 'SECRET';
    case 'LEGENDARY':
      return 'LEGENDARY';
    case 'COMMON':
    case 'UNCOMMON':
    case 'RARE':
    case 'EPIC':
      return 'STANDARD';
  }
}

export interface RevealStep {
  /** What the player reads during this step. */
  readonly label: string;
  readonly duration: DurationMs;
  /**
   * Whether this step names the rarity.
   *
   * Exactly one step in a completed script does. A plan that never reaches it
   * is a plan that has not revealed anything.
   */
  readonly revealsRarity: boolean;
}

export interface RevealRequest {
  readonly rarity: Rarity;
  /**
   * Whether the Secret vault has reserved this wallet's reward (§8.4).
   *
   * Ignored for every other rarity — nothing else needs a reservation, because
   * nothing else pays out on reveal.
   */
  readonly secretReservationSecured: boolean;
  readonly reducedMotion: boolean;
}

export interface RevealPlan {
  readonly grammar: RevealGrammar;
  readonly steps: readonly RevealStep[];
  /** True once the script actually names what was drawn. */
  readonly complete: boolean;
  readonly totalDuration: DurationMs;
}

/**
 * Words §40.6 forbids: *"Do not use confetti, slot-machine effects, or casino
 * celebration language."*
 *
 * Kept as data so a test can check every label in every script against it. A
 * prohibition written only in a comment is one a future label quietly breaks.
 */
export const FORBIDDEN_REVEAL_WORDS = [
  'confetti',
  'jackpot',
  'slot',
  'spin',
  'lucky',
  'congratulations',
  'winner',
  'prize',
  'gamble',
  'bet',
] as const;

export function revealPlan(request: RevealRequest): RevealPlan {
  const timing = durations(request.reducedMotion);
  const grammar = grammarFor(request.rarity);
  const steps = scriptFor(grammar, request, timing);
  return {
    grammar,
    steps,
    complete: steps.some((step) => step.revealsRarity),
    totalDuration: milliseconds(steps.reduce((total, step) => total + step.duration, 0)),
  };
}

type Timing = Readonly<
  Record<'instant' | 'fast' | 'ui' | 'panel' | 'spatial' | 'cinematic', number>
>;

function scriptFor(
  grammar: RevealGrammar,
  request: RevealRequest,
  timing: Timing,
): readonly RevealStep[] {
  const step = (label: string, duration: number, revealsRarity = false): RevealStep => ({
    label,
    duration: milliseconds(duration),
    revealsRarity,
  });

  // §40.6's base sequence, shared by every grammar. Reduced Motion shortens
  // each beat rather than dropping any: §83.3 collapses long sequences but
  // requires the information to stay complete, and each of these lines is a
  // distinct thing the player is being told.
  const base = [
    step('VERIFYING HOLDER', timing.panel),
    step('GENESIS ACCESS GRANTED', timing.panel),
    step('GENERATING SIGNAL', timing.spatial),
  ];

  switch (grammar) {
    case 'STANDARD':
      // *"Quick clean decrypt/snap."*
      return [
        ...base,
        step('DECRYPTING', timing.spatial),
        step('RARITY DETECTED', timing.ui, true),
      ];

    case 'LEGENDARY':
      // *"Darkness → frame pieces assemble → champagne-gold reflection sweep →
      // artwork lights → rarity reveal."* The beats are longer because the
      // grammar itself is different, not because the colour changed.
      return [
        ...base,
        step('DECRYPTING', timing.cinematic),
        step('ASSEMBLING FRAME', timing.spatial),
        step('ARTWORK ILLUMINATING', timing.spatial),
        step('RARITY DETECTED', timing.panel, true),
      ];

    case 'SECRET':
      // *"System uncertainty → unstable artifact → classification failure →
      // asset signal → Secret reveal."* The sequence performs the system
      // failing to classify what it drew, which is why it reads as `???`
      // rather than as a prize.
      return [
        ...base,
        step('SIGNAL UNSTABLE', timing.cinematic),
        step('CLASSIFICATION FAILED — ???', timing.cinematic),
        step('ASSET SIGNAL DETECTED', timing.spatial),
        ...secretTail(request, step),
      ];
  }
}

/**
 * The last beats of a Secret reveal.
 *
 * §27.3 and §8.4: the reward is reserved *before* the reveal. Until the vault
 * confirms, the script holds at securing and never names the Secret — a player
 * told they hold a Secret that the vault then cannot cover has been told
 * something false about real money.
 *
 * The holding step is not an error state. The reservation is expected to
 * succeed; this is the sequence waiting for it, and the copy says so plainly
 * rather than implying something went wrong.
 */
function secretTail(
  request: RevealRequest,
  step: (label: string, duration: number, revealsRarity?: boolean) => RevealStep,
): readonly RevealStep[] {
  const timing = durations(request.reducedMotion);
  if (!request.secretReservationSecured) {
    return [step('SECURING REWARD', timing.spatial)];
  }
  return [step('REWARD SECURED', timing.panel), step('SECRET STOCK DROP', timing.cinematic, true)];
}
