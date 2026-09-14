import { describe, expect, it } from 'vitest';
import { genesisViewFrom } from './genesis-view.js';

const CLAIM = {
  genesisId: '000042',
  requestId: 'genesis-0x00000000000000000000000000000000000000aa',
  wallet: '0x00000000000000000000000000000000000000aa',
  rarity: 'RARE' as const,
  cardType: 'BULL_RUN' as const,
  initialUses: 3,
  slot: 812_345,
  seed: 'ab'.repeat(32),
  entropyBlock: 62_000_010,
  entropyBlockHash: `0x${'cd'.repeat(32)}`,
  secretAvailable: false,
  rarityTableVersion: 'rarity-table-v1-secret-disabled',
  secretReservationTx: null,
  finalizedAt: 1_800_000_000_000,
};

describe('the Genesis page, from the server’s status', () => {
  it('offers the request to a wallet that never asked', () => {
    expect(genesisViewFrom({ status: 'NONE' })).toEqual({ kind: 'OFFER' });
  });

  it('writes an ineligible balance and the threshold down exactly', () => {
    expect(
      genesisViewFrom({
        status: 'NOT_ELIGIBLE_BALANCE',
        balance: '999999999999999999999999',
        threshold: '1000000000000000000000000',
        decimals: 18,
      }),
    ).toEqual({ kind: 'NOT_ELIGIBLE', balance: '999,999.99', threshold: '1,000,000' });
  });

  it('shows the block a pending claim is waiting on', () => {
    expect(
      genesisViewFrom({ status: 'PENDING_FINALITY', requestId: CLAIM.requestId, targetBlock: 7 }),
    ).toEqual({ kind: 'SEALING', targetBlock: 7 });
  });

  it('names nothing about a Secret waiting on its reservation (§76.5)', () => {
    expect(
      genesisViewFrom({ status: 'SECRET_RESERVATION_PENDING', requestId: CLAIM.requestId }),
    ).toEqual({ kind: 'RESERVING' });
  });

  it('reveals the card the server dealt, named from the catalog', () => {
    for (const status of ['READY', 'ALREADY_CLAIMED'] as const) {
      expect(genesisViewFrom({ status, claim: CLAIM })).toEqual({
        kind: 'CARD',
        outcome: {
          genesisId: '000042',
          rarity: 'RARE',
          cardType: 'BULL_RUN',
          cardName: 'Bull Run',
          effect: 'Market Support +2',
          secretReservationSecured: true,
        },
      });
    }
  });

  it('says a server that reads no chain cannot deal one', () => {
    expect(genesisViewFrom({ status: 'UNPUBLISHED' })).toEqual({ kind: 'UNPUBLISHED' });
  });
});
