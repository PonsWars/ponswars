import { RARITY_USES } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  CARD_STATES,
  cardStateLabel,
  pickFlowView,
  type CardHolding,
  type PickFlowInput,
} from './pick-flow.js';

const CARD: CardHolding = { name: 'Bull Run', rarity: 'RARE', usesRemaining: 7 };

function input(overrides: Partial<PickFlowInput> = {}): PickFlowInput {
  return {
    picksAllowed: true,
    backing: null,
    pickProposed: false,
    card: CARD,
    decision: null,
    ...overrides,
  };
}

describe('the pick sequence', () => {
  it('starts by asking for a side', () => {
    expect(pickFlowView(input()).stage).toBe('CHOOSE_SIDE');
  });

  it('brings the card in once a side is chosen', () => {
    // §40.7 step 2: the Genesis Card enters after the faction, not before.
    expect(pickFlowView(input({ pickProposed: true })).stage).toBe('CARD_DECISION');
    expect(pickFlowView(input({ backing: { cardDeployed: false } })).stage).toBe('CARD_DECISION');
  });

  it('offers no card decision before a side is chosen', () => {
    expect(pickFlowView(input()).mayDecideCard).toBe(false);
  });

  it('becomes a readout after lock', () => {
    // §27.7 shows what was backed and whether a card went in. It offers nothing.
    const view = pickFlowView(input({ picksAllowed: false, backing: { cardDeployed: true } }));
    expect(view.stage).toBe('COMMITTED');
    expect(view.mayDecideCard).toBe(false);
    expect(view.mayChangePick).toBe(false);
  });

  it('says spectating when the round locked without a pick', () => {
    expect(pickFlowView(input({ picksAllowed: false })).stage).toBe('SPECTATING');
  });
});

describe('changing a pick', () => {
  it('is allowed until lock, once something exists to change', () => {
    // §27.6: allow CHANGE PICK until lock.
    expect(pickFlowView(input({ pickProposed: true })).mayChangePick).toBe(true);
    expect(pickFlowView(input({ backing: { cardDeployed: false } })).mayChangePick).toBe(true);
  });

  it('is not offered before there is a pick', () => {
    expect(pickFlowView(input()).mayChangePick).toBe(false);
  });

  it('ends at lock', () => {
    expect(
      pickFlowView(input({ picksAllowed: false, backing: { cardDeployed: false } })).mayChangePick,
    ).toBe(false);
  });
});

describe('the card', () => {
  it('is undecided until the player chooses', () => {
    expect(pickFlowView(input({ pickProposed: true })).cardState).toBe('UNDECIDED');
  });

  it('arms on USE and stays saved on SAVE', () => {
    expect(pickFlowView(input({ pickProposed: true, decision: 'USE' })).cardState).toBe('ARMED');
    expect(pickFlowView(input({ pickProposed: true, decision: 'SAVE' })).cardState).toBe('SAVED');
  });

  it('distinguishes armed from deployed', () => {
    // §40.7 arms during Pick Phase and deploys at lock, and only deployment
    // consumes a use — a player who changes their mind before lock spends
    // nothing. Collapsing the two would make the panel claim otherwise.
    const armed = pickFlowView(input({ pickProposed: true, decision: 'USE' }));
    const deployed = pickFlowView(
      input({ picksAllowed: false, backing: { cardDeployed: true }, decision: 'USE' }),
    );
    expect(armed.cardState).toBe('ARMED');
    expect(deployed.cardState).toBe('DEPLOYED');
  });

  it('lets the server outrank a local decision', () => {
    // The engine's word on whether a card went in is the one that counts.
    const view = pickFlowView(
      input({ picksAllowed: false, backing: { cardDeployed: true }, decision: 'SAVE' }),
    );
    expect(view.cardState).toBe('DEPLOYED');
  });

  it('stays saved when the round locks with no decision made', () => {
    const view = pickFlowView(input({ picksAllowed: false, backing: { cardDeployed: false } }));
    expect(view.cardState).toBe('SAVED');
  });

  it('reports a depleted card without offering it', () => {
    // §40.9: depleted cards remain visible forever as Genesis artifacts, which
    // is not the same as being usable.
    const view = pickFlowView(input({ pickProposed: true, card: { ...CARD, usesRemaining: 0 } }));
    expect(view.cardState).toBe('DEPLETED');
    expect(view.mayDecideCard).toBe(false);
  });

  it('offers nothing when the wallet holds no card', () => {
    const view = pickFlowView(input({ pickProposed: true, card: null }));
    expect(view.cardState).toBe('NO_CARD');
    expect(view.mayDecideCard).toBe(false);
    expect(view.usesLabel).toBeNull();
  });
});

describe('remaining uses', () => {
  it('is zero-padded against the rarity total', () => {
    // §40.9 wants an unambiguous numeric count.
    expect(pickFlowView(input()).usesLabel).toBe(
      `07 / ${String(RARITY_USES.RARE).padStart(2, '0')}`,
    );
  });

  it('calls out the final use', () => {
    expect(pickFlowView(input({ card: { ...CARD, usesRemaining: 1 } })).finalUse).toBe(true);
    expect(pickFlowView(input({ card: { ...CARD, usesRemaining: 2 } })).finalUse).toBe(false);
  });

  it('does not call a depleted card a final use', () => {
    expect(pickFlowView(input({ card: { ...CARD, usesRemaining: 0 } })).finalUse).toBe(false);
  });
});

describe('card copy', () => {
  it('names every state', () => {
    for (const state of CARD_STATES) {
      expect(cardStateLabel(state).length).toBeGreaterThan(0);
    }
  });

  it('keeps armed and deployed distinguishable to a reader', () => {
    expect(cardStateLabel('ARMED')).toBe('CARD ARMED');
    expect(cardStateLabel('DEPLOYED')).toBe('CARD DEPLOYED');
  });
});
