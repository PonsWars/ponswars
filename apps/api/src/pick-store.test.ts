import { PicksLockedError } from '@ponswars/round-service';
import {
  battleId,
  clientRequestId,
  roundId,
  utcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { PickStore, type SubmittedPick } from './pick-store.js';

/**
 * The in-memory store, held to what the database store does.
 *
 * It is what the local stack runs, so it has to behave like the store a
 * deployment runs: a player trying the product locally should meet the same
 * rules — the same replay, the same lock — they will meet in production.
 */

const ROUND = roundId('round-0000000000');
const wallet = (n: number): WalletAddress =>
  `0x${n.toString(16).padStart(40, '0')}` as WalletAddress;

const pick = (
  who: WalletAddress,
  key: string,
  ticker: 'NVDA' | 'TSLA' = 'NVDA',
): SubmittedPick => ({
  wallet: who,
  roundId: ROUND,
  battleId: battleId('battle-a'),
  backedTicker: ticker,
  cardDecision: 'SAVE',
  receivedAt: utcTimestamp(1_800_000_000_000),
  clientRequestId: clientRequestId(key),
});

describe('the in-memory pick store', () => {
  it('scopes a request key to its wallet', async () => {
    // It was keyed on the request key alone, so one wallet's key answered
    // another wallet's request as a replay and recorded nothing for it.
    const store = new PickStore();
    await store.submit(pick(wallet(1), 'shared'));

    expect(await store.submit(pick(wallet(2), 'shared'))).toMatchObject({ replayed: false });
    expect(await store.count(ROUND)).toBe(2);
  });

  it('keeps the newer decision when a superseded request is retried', async () => {
    const store = new PickStore();
    await store.submit(pick(wallet(1), 'first', 'NVDA'));
    await store.submit(pick(wallet(1), 'second', 'TSLA'));

    expect(await store.submit(pick(wallet(1), 'first', 'NVDA'))).toMatchObject({ replayed: true });
    expect((await store.find(ROUND, wallet(1)))?.backedTicker).toBe('TSLA');
  });

  it('refuses every change once the picks have been read for the engine', async () => {
    const store = new PickStore();
    await store.submit(pick(wallet(1), 'first'));
    await store.lockedPicks(ROUND);

    await expect(store.submit(pick(wallet(2), 'late'))).rejects.toBeInstanceOf(PicksLockedError);
    await expect(store.withdraw(ROUND, wallet(1))).rejects.toBeInstanceOf(PicksLockedError);
    await expect(
      store.decideCard(ROUND, wallet(1), 'USE', utcTimestamp(1_800_000_001_000)),
    ).rejects.toBeInstanceOf(PicksLockedError);
  });

  it('hands the engine its picks ordered by wallet, as the database does', async () => {
    const store = new PickStore();
    await store.submit(pick(wallet(9), 'a'));
    await store.submit(pick(wallet(2), 'b'));
    await store.submit(pick(wallet(5), 'c'));

    const locked = await store.lockedPicks(ROUND);

    expect(locked.map((entry) => entry.wallet)).toEqual([wallet(2), wallet(5), wallet(9)]);
  });
});
