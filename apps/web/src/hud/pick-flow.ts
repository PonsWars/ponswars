import { RARITY_USES, type CardDecision, type Rarity } from '@ponswars/shared-types';

/**
 * The pick and card decision flow (§27.6, §40.7).
 *
 * §40.7's sequence is: choose a faction, the Genesis Card enters, choose USE or
 * SAVE, USE arms the card, and at lock it becomes deployed and a use is
 * consumed. §27.6 adds that the player may change their pick until lock.
 *
 * All of that is one small state machine, so it lives here rather than as
 * conditions spread through a component. The stage a player is at determines
 * which controls exist at all — an inert button that looks available is worse
 * than no button (§42.1).
 */

/** Where the player is in the sequence. */
export const PICK_STAGES = ['CHOOSE_SIDE', 'CARD_DECISION', 'COMMITTED', 'SPECTATING'] as const;

export type PickStage = (typeof PICK_STAGES)[number];

/**
 * What the Genesis Card is doing.
 *
 * `ARMED` and `DEPLOYED` are different facts, not different words for one. §40.7
 * arms the card during Pick Phase and deploys it *at lock*, and only deployment
 * consumes a use — a player who changes their mind before lock has spent
 * nothing.
 */
export const CARD_STATES = [
  'NO_CARD',
  'DEPLETED',
  'UNDECIDED',
  'SAVED',
  'ARMED',
  'DEPLOYED',
] as const;

export type CardState = (typeof CARD_STATES)[number];

export interface CardHolding {
  readonly name: string;
  readonly rarity: Rarity;
  readonly usesRemaining: number;
}

export interface PickFlowInput {
  /** Whether the round is still in its Pick Phase (§3.2). */
  readonly picksAllowed: boolean;
  /** The server-confirmed backing, or `null` if the player has not picked. */
  readonly backing: { readonly cardDeployed: boolean } | null;
  /** A pick the player has proposed but the server has not confirmed. */
  readonly pickProposed: boolean;
  readonly card: CardHolding | null;
  /** USE or SAVE, once chosen. */
  readonly decision: CardDecision | null;
}

export interface PickFlowView {
  readonly stage: PickStage;
  readonly cardState: CardState;
  /** §27.6: the player may change their pick until lock. */
  readonly mayChangePick: boolean;
  /** Whether USE / SAVE should be offered right now. */
  readonly mayDecideCard: boolean;
  /** `07 / 10`, or `null` when there is no card. */
  readonly usesLabel: string | null;
  /** §40.9: the last use is called out before it is spent. */
  readonly finalUse: boolean;
}

export function pickFlowView(input: PickFlowInput): PickFlowView {
  const cardState = cardStateFor(input);
  const stage = stageFor(input);

  return {
    stage,
    cardState,
    // Only while the phase is open, and only once there is something to change.
    mayChangePick: input.picksAllowed && (input.backing !== null || input.pickProposed),
    // A depleted or absent card offers no decision — §40.9 keeps a depleted card
    // visible as a Genesis artifact, which is not the same as offering it.
    mayDecideCard:
      input.picksAllowed &&
      stage === 'CARD_DECISION' &&
      (cardState === 'UNDECIDED' || cardState === 'SAVED' || cardState === 'ARMED'),
    usesLabel: input.card === null ? null : usesLabelFor(input.card),
    finalUse: input.card !== null && input.card.usesRemaining === 1,
  };
}

function stageFor(input: PickFlowInput): PickStage {
  if (!input.picksAllowed) {
    // After lock the decision is made and the panel becomes a readout. §27.7
    // shows what was backed and whether a card went in; it offers nothing.
    return input.backing === null ? 'SPECTATING' : 'COMMITTED';
  }
  if (input.backing === null && !input.pickProposed) {
    return 'CHOOSE_SIDE';
  }
  // §40.7 step 2: the card enters once a side is chosen.
  return 'CARD_DECISION';
}

function cardStateFor(input: PickFlowInput): CardState {
  if (input.card === null) {
    return 'NO_CARD';
  }
  if (input.card.usesRemaining === 0) {
    return 'DEPLETED';
  }
  // Deployment is a server fact and outranks any local decision: once the round
  // has locked and the engine says the card went in, that is what happened.
  if (input.backing?.cardDeployed === true) {
    return 'DEPLOYED';
  }
  if (!input.picksAllowed) {
    // Locked with a card that was never armed. It stayed in the player's hand,
    // and no use was consumed.
    return 'SAVED';
  }
  switch (input.decision) {
    case 'USE':
      return 'ARMED';
    case 'SAVE':
      return 'SAVED';
    case null:
      return 'UNDECIDED';
  }
}

/** §40.9 wants an unambiguous zero-padded count, e.g. `08 / 10`. */
function usesLabelFor(card: CardHolding): string {
  const total = RARITY_USES[card.rarity];
  return `${String(card.usesRemaining).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
}

/** Headline copy for a card state, in the vocabulary §40.7 and §40.9 use. */
export function cardStateLabel(state: CardState): string {
  switch (state) {
    case 'NO_CARD':
      return 'NO GENESIS CARD';
    case 'DEPLETED':
      return 'DEPLETED';
    case 'UNDECIDED':
      return 'CARD READY';
    case 'SAVED':
      return 'CARD SAVED';
    case 'ARMED':
      return 'CARD ARMED';
    case 'DEPLOYED':
      return 'CARD DEPLOYED';
  }
}
