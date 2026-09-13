import {
  baseUnits,
  RARITY_USES,
  tokenDecimals,
  utcTimestamp,
  type BaseUnits,
  type WalletAddress,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  ENTROPY_TARGET_DISTANCE,
  GenesisChainError,
  GenesisFlow,
  type GenesisChain,
  type SecretVault,
} from './flow.js';
import {
  commitEntropy,
  genesisRequestId,
  openRequest,
  resolveRequest,
  warThreshold,
} from './genesis-service.js';
import { MemoryGenesisRepository } from './memory.js';

const WAR = tokenDecimals(18);
const MILLION = warThreshold(WAR);
const WALLET = '0x1234567890abcdef1234567890abcdef12345678' as WalletAddress;
const OTHER = '0x00000000000000000000000000000000000000aa' as WalletAddress;

/** A chain whose head and finalized head a test moves by hand. */
function chain(): GenesisChain & { head: number; finalized: number; asked: number[] } {
  const state = {
    head: 5_000,
    finalized: 4_900,
    asked: [] as number[],
    headBlock: () => Promise.resolve(state.head),
    finalizedBlock: (number: number) => {
      state.asked.push(number);
      return Promise.resolve(
        number > state.finalized
          ? null
          : { number, hash: `0x${number.toString(16).padStart(64, '0')}` },
      );
    },
  };
  return state;
}

function flow(
  options: {
    balances?: ReadonlyMap<WalletAddress, BaseUnits>;
    vault?: SecretVault | null;
    repository?: MemoryGenesisRepository;
    chain?: ReturnType<typeof chain>;
  } = {},
) {
  const repository = options.repository ?? new MemoryGenesisRepository();
  const blocks = options.chain ?? chain();
  let now = 1_800_000_000_000;
  const readBalances: WalletAddress[] = [];
  const genesis = new GenesisFlow({
    repository,
    chain: blocks,
    warBalanceOf: (wallet) => {
      readBalances.push(wallet);
      return Promise.resolve(options.balances?.get(wallet) ?? baseUnits(0n));
    },
    warDecimals: WAR,
    secretVault: options.vault ?? null,
    now: () => utcTimestamp((now += 1_000)),
  });
  return { genesis, repository, blocks, readBalances };
}

const holding = (amount: bigint) => new Map([[WALLET, baseUnits(amount)]]);

describe('asking for a Genesis card (§6, §69.6)', () => {
  it('refuses a wallet under a million $WAR, and writes nothing', async () => {
    const { genesis, repository } = flow({ balances: holding(MILLION - 1n) });

    expect(await genesis.request(WALLET)).toEqual({
      kind: 'NOT_ELIGIBLE_BALANCE',
      balance: MILLION - 1n,
      threshold: MILLION,
      decimals: WAR,
    });
    expect(await repository.find(WALLET)).toBeNull();
  });

  it('binds an eligible wallet to a block past the chain head (§9, §76.1)', async () => {
    const { genesis, blocks } = flow({ balances: holding(MILLION) });

    expect(await genesis.request(WALLET)).toEqual({
      kind: 'PENDING_FINALITY',
      requestId: genesisRequestId(WALLET),
      targetBlock: blocks.head + ENTROPY_TARGET_DISTANCE,
    });
  });

  it('is idempotent: asking again returns the same request and its first block', async () => {
    const { genesis, blocks, readBalances } = flow({ balances: holding(MILLION) });
    const first = await genesis.request(WALLET);

    blocks.head += 500;
    const again = await genesis.request(WALLET);

    expect(again).toEqual(first);
    // Eligibility is decided once, when the request is made (§6).
    expect(readBalances).toEqual([WALLET]);
  });

  it('keeps a wallet that sold its $WAR after asking (§6)', async () => {
    const balances = new Map([[WALLET, MILLION]]);
    const { genesis, blocks } = flow({ balances });
    await genesis.request(WALLET);

    balances.set(WALLET, baseUnits(0n));
    blocks.finalized = blocks.head + ENTROPY_TARGET_DISTANCE;

    expect((await genesis.request(WALLET)).kind).toBe('READY');
  });
});

describe('finishing a claim', () => {
  it('waits for the target block to be finalized, then deals the card', async () => {
    const { genesis, blocks } = flow({ balances: holding(MILLION) });
    const opened = await genesis.request(WALLET);
    if (opened.kind !== 'PENDING_FINALITY') throw new Error('expected a pending request');

    blocks.finalized = opened.targetBlock - 1;
    expect((await genesis.status(WALLET)).kind).toBe('PENDING_FINALITY');

    blocks.finalized = opened.targetBlock;
    const ready = await genesis.status(WALLET);
    if (ready.kind !== 'READY') throw new Error('expected a card');

    expect(ready.claim.entropyBlock).toBe(opened.targetBlock);
    expect(ready.claim.entropyBlockHash).toBe(
      `0x${opened.targetBlock.toString(16).padStart(64, '0')}`,
    );
    expect(ready.claim.initialUses).toBe(RARITY_USES[ready.claim.rarity]);
    expect(ready.claim.genesisId).toBe('000001');
  });

  it('reads only the target block, never a later one', async () => {
    // However late the claim is finished, the entropy is the block it was bound to.
    const { genesis, blocks } = flow({ balances: holding(MILLION) });
    await genesis.request(WALLET);
    const target = blocks.head + ENTROPY_TARGET_DISTANCE;

    blocks.finalized = target + 100_000;
    await genesis.status(WALLET);

    expect(new Set(blocks.asked)).toEqual(new Set([target]));
  });

  it('deals the same card however many times it is asked, and records it once', async () => {
    const { genesis, blocks } = flow({ balances: holding(MILLION) });
    await genesis.request(WALLET);
    blocks.finalized = Number.MAX_SAFE_INTEGER;

    const [a, b] = await Promise.all([genesis.status(WALLET), genesis.status(WALLET)]);
    const c = await genesis.status(WALLET);

    expect(a).toEqual(b);
    expect(c).toEqual(a);
  });

  it('answers a second request for a claimed wallet with ALREADY_CLAIMED (§6)', async () => {
    const { genesis, blocks } = flow({ balances: holding(MILLION * 1_000n) });
    await genesis.request(WALLET);
    blocks.finalized = Number.MAX_SAFE_INTEGER;
    const ready = await genesis.status(WALLET);
    if (ready.kind !== 'READY') throw new Error('expected a card');

    expect(await genesis.request(WALLET)).toEqual({ kind: 'ALREADY_CLAIMED', claim: ready.claim });
  });

  it('reports a chain that did not answer as a chain error, and writes nothing', async () => {
    const blocks = chain();
    blocks.headBlock = () => Promise.reject(new Error('503 from the RPC endpoint'));
    const { genesis, repository } = flow({ balances: holding(MILLION), chain: blocks });

    await expect(genesis.request(WALLET)).rejects.toBeInstanceOf(GenesisChainError);
    expect(await repository.find(WALLET)).toBeNull();
  });

  it('reads a dealt card from the record, without touching the chain', async () => {
    const { genesis, blocks } = flow({ balances: holding(MILLION) });
    await genesis.request(WALLET);
    expect(await genesis.claimOf(WALLET)).toBeNull();

    blocks.finalized = Number.MAX_SAFE_INTEGER;
    const ready = await genesis.status(WALLET);
    if (ready.kind !== 'READY') throw new Error('expected a card');
    blocks.asked.length = 0;

    expect(await genesis.claimOf(WALLET)).toEqual(ready.claim);
    expect(blocks.asked).toEqual([]);
  });

  it('says NONE for a wallet that never asked, without reading its balance', async () => {
    const { genesis, readBalances } = flow();

    expect(await genesis.status(OTHER)).toEqual({ kind: 'NONE' });
    expect(readBalances).toEqual([]);
  });

  it('reads a dealt card with no reservation when it is not a Secret', async () => {
    const { genesis, blocks } = flow({ balances: holding(MILLION) });
    blocks.finalized = Number.MAX_SAFE_INTEGER;

    const dealt = await genesis.request(WALLET);
    if (dealt.kind !== 'READY') throw new Error(`expected a card, got ${dealt.kind}`);
    expect(dealt.claim.secretReservationTx).toBeNull();
  });
});

describe('a Secret draw (§8.3, §8.4, §76.5)', () => {
  const RESERVATION_TX = `0x${'5e'.repeat(32)}`;

  /** A vault a test scripts: whether it is covered, and what each reserve does. */
  function vault(covered: boolean, answers: ('RESERVE' | 'UNCOVERED' | 'THROW')[]) {
    const reserved: WalletAddress[] = [];
    const port: SecretVault = {
      isCovered: () => Promise.resolve(covered),
      reserve: (wallet) => {
        reserved.push(wallet);
        const answer = answers.shift() ?? 'THROW';
        if (answer === 'THROW') {
          return Promise.reject(new Error('RPC endpoint timed out'));
        }
        return Promise.resolve(
          answer === 'UNCOVERED'
            ? { kind: 'UNCOVERED' }
            : {
                kind: 'RESERVED',
                reservation: {
                  entitlementId: `secret-${wallet}`,
                  amount: baseUnits(200_000n),
                  reservationTx: RESERVATION_TX,
                },
              },
        );
      },
    };
    return { port, reserved };
  }

  /** A chain whose target block is final, and a wallet whose draw there is a Secret. */
  function secretDraw() {
    const blocks = chain();
    blocks.finalized = Number.MAX_SAFE_INTEGER;
    const target = blocks.head + ENTROPY_TARGET_DISTANCE;
    for (let index = 0; index < 20_000; index += 1) {
      const wallet = `0x${index.toString(16).padStart(40, '0')}` as WalletAddress;
      const request = commitEntropy(
        openRequest(genesisRequestId(wallet), wallet, target, utcTimestamp(0)),
        { number: target, hash: `0x${target.toString(16).padStart(64, '0')}` },
        utcTimestamp(0),
      );
      if (resolveRequest(request, true).outcome.rarity === 'SECRET') {
        return { blocks, wallet, balances: new Map([[wallet, MILLION]]) };
      }
    }
    throw new Error('no Secret draw in the search range');
  }

  it('reveals a Secret only with its reservation, and reserves it once', async () => {
    const { blocks, wallet, balances } = secretDraw();
    const { port, reserved } = vault(true, ['RESERVE']);
    const { genesis } = flow({ balances, vault: port, chain: blocks });

    const dealt = await genesis.request(wallet);
    if (dealt.kind !== 'READY') throw new Error(`expected a card, got ${dealt.kind}`);
    expect(dealt.claim.rarity).toBe('SECRET');
    expect(dealt.claim.secretReservationTx).toBe(RESERVATION_TX);

    expect(await genesis.status(wallet)).toEqual(dealt);
    expect(reserved).toEqual([wallet]);
  });

  it('holds a Secret back while its reservation fails, then reveals it once it lands', async () => {
    const { blocks, wallet, balances } = secretDraw();
    const { port, reserved } = vault(true, ['THROW', 'THROW', 'RESERVE']);
    const { genesis, repository } = flow({ balances, vault: port, chain: blocks });

    for (const ask of [() => genesis.request(wallet), () => genesis.status(wallet)]) {
      expect(await ask()).toEqual({
        kind: 'SECRET_RESERVATION_PENDING',
        requestId: genesisRequestId(wallet),
      });
      const stored = await repository.find(wallet);
      // The entropy is committed, so the card cannot change; nothing is shown.
      expect(stored?.request.state).toBe('COMMITTED');
      expect(stored?.claim).toBeNull();
    }

    const dealt = await genesis.status(wallet);
    if (dealt.kind !== 'READY') throw new Error(`expected a card, got ${dealt.kind}`);
    expect(dealt.claim.rarity).toBe('SECRET');
    expect(reserved).toHaveLength(3);
  });

  it('deals Legendary under the disabled table when the last reward was taken first', async () => {
    // Covered when resolved, gone by the time the reservation ran (§8.4's race).
    const { blocks, wallet, balances } = secretDraw();
    const { port } = vault(true, ['UNCOVERED']);
    const { genesis } = flow({ balances, vault: port, chain: blocks });

    const dealt = await genesis.request(wallet);
    if (dealt.kind !== 'READY') throw new Error(`expected a card, got ${dealt.kind}`);
    expect(dealt.claim).toMatchObject({
      rarity: 'LEGENDARY',
      secretAvailable: false,
      rarityTableVersion: 'rarity-table-v1-secret-disabled',
      secretReservationTx: null,
    });
  });

  it('never reserves while the vault is uncovered, and deals Legendary', async () => {
    const { blocks, wallet, balances } = secretDraw();
    const { port, reserved } = vault(false, []);
    const { genesis } = flow({ balances, vault: port, chain: blocks });

    const dealt = await genesis.request(wallet);
    if (dealt.kind !== 'READY') throw new Error(`expected a card, got ${dealt.kind}`);
    expect(dealt.claim.rarity).toBe('LEGENDARY');
    expect(reserved).toEqual([]);
  });

  it('deals Legendary where the service holds no vault key at all', async () => {
    const { blocks, wallet, balances } = secretDraw();
    const { genesis } = flow({ balances, vault: null, chain: blocks });

    const dealt = await genesis.request(wallet);
    if (dealt.kind !== 'READY') throw new Error(`expected a card, got ${dealt.kind}`);
    expect(dealt.claim.rarity).toBe('LEGENDARY');
    expect(dealt.claim.secretAvailable).toBe(false);
  });
});
