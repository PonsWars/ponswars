import type { WalletAddress } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  assertReserver,
  ChainSecretVault,
  type ReserveSimulation,
  type VaultContract,
} from './secret-vault.js';

const WALLET = '0x00000000000000000000000000000000000000aa' as WalletAddress;
const TX = `0x${'5e'.repeat(32)}` as const;
const REWARD = 200_000_000_000_000_000n;

function contract(simulation: ReserveSimulation, found: `0x${string}` | null = TX) {
  const sent: WalletAddress[] = [];
  let release = (): void => undefined;
  const landed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake: VaultContract & { sent: WalletAddress[]; release: () => void } = {
    sent,
    release,
    isCovered: () => Promise.resolve(simulation !== 'UNCOVERED'),
    rewardAmount: () => Promise.resolve(REWARD),
    simulateReserve: () => Promise.resolve(simulation),
    sendReserve: async (wallet) => {
      sent.push(wallet);
      await landed;
      return TX;
    },
    findReservation: () => Promise.resolve(found),
    hasReserverRole: (account) => Promise.resolve(account === `0x${'1'.repeat(40)}`),
  };
  return fake;
}

describe('ChainSecretVault', () => {
  it('sends a reservation and returns it with the vault’s reward amount', async () => {
    const fake = contract('WOULD_RESERVE');
    fake.release();

    expect(await new ChainSecretVault(fake).reserve(WALLET)).toEqual({
      kind: 'RESERVED',
      reservation: { entitlementId: `secret-${WALLET}`, amount: REWARD, reservationTx: TX },
    });
    expect(fake.sent).toEqual([WALLET]);
  });

  it('is uncovered, and sends nothing, when the vault would refuse for coverage', async () => {
    const fake = contract('UNCOVERED');

    expect(await new ChainSecretVault(fake).reserve(WALLET)).toEqual({ kind: 'UNCOVERED' });
    expect(fake.sent).toEqual([]);
  });

  it('returns the reservation already on chain instead of reserving twice', async () => {
    // A reservation that landed before its claim was recorded.
    const fake = contract('ALREADY_ENTITLED');

    const result = await new ChainSecretVault(fake).reserve(WALLET);

    expect(result).toMatchObject({ kind: 'RESERVED', reservation: { reservationTx: TX } });
    expect(fake.sent).toEqual([]);
  });

  it('throws when the vault says entitled but no reservation can be found', async () => {
    await expect(
      new ChainSecretVault(contract('ALREADY_ENTITLED', null)).reserve(WALLET),
    ).rejects.toThrow(/no reservation for it was found/);
  });

  it('sends one transaction for two reads racing to reveal the same Secret', async () => {
    const fake = contract('WOULD_RESERVE');
    const vault = new ChainSecretVault(fake);

    const first = vault.reserve(WALLET);
    const second = vault.reserve(WALLET);
    fake.release();

    expect(await first).toEqual(await second);
    expect(fake.sent).toEqual([WALLET]);
  });
});

describe('assertReserver', () => {
  it('accepts a key holding RESERVER_ROLE and refuses one that does not', async () => {
    const fake = contract('WOULD_RESERVE');

    await expect(assertReserver(fake, `0x${'1'.repeat(40)}`, 46630)).resolves.toBeUndefined();
    await expect(assertReserver(fake, `0x${'2'.repeat(40)}`, 46630)).rejects.toThrow(
      /does not hold RESERVER_ROLE on the Secret Stock Vault on Robinhood Chain Testnet \(46630\)/,
    );
  });
});
