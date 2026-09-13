import {
  baseUnits,
  RARITY_USES,
  tokenDecimals,
  utcTimestamp,
  type BaseUnits,
  type WalletAddress,
} from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import { ENTROPY_TARGET_DISTANCE, GenesisFlow, type GenesisChain } from './flow.js';
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
    secretAvailable?: boolean;
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
    secretAvailable: () => Promise.resolve(options.secretAvailable ?? false),
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

  it('says NONE for a wallet that never asked, without reading its balance', async () => {
    const { genesis, readBalances } = flow();

    expect(await genesis.status(OTHER)).toEqual({ kind: 'NONE' });
    expect(readBalances).toEqual([]);
  });

  it('holds back a Secret it cannot reserve, and deals Legendary while Secret is off (§8.3, §76.5)', async () => {
    // Find a wallet whose draw lands in the Secret band when Secret is on.
    const blocks = chain();
    blocks.finalized = Number.MAX_SAFE_INTEGER;
    const target = blocks.head + ENTROPY_TARGET_DISTANCE;
    let secretWallet: WalletAddress | null = null;
    for (let index = 0; index < 20_000 && secretWallet === null; index += 1) {
      const wallet = `0x${index.toString(16).padStart(40, '0')}` as WalletAddress;
      const request = commitEntropy(
        openRequest(genesisRequestId(wallet), wallet, target, utcTimestamp(0)),
        { number: target, hash: `0x${target.toString(16).padStart(64, '0')}` },
        utcTimestamp(0),
      );
      if (resolveRequest(request, true).outcome.rarity === 'SECRET') {
        secretWallet = wallet;
      }
    }
    if (secretWallet === null) throw new Error('no Secret draw in the search range');
    const balances = new Map([[secretWallet, MILLION]]);

    // Secret on, and no reservation possible: nothing is shown or recorded.
    const on = flow({ balances, secretAvailable: true, chain: blocks });
    expect(await on.genesis.request(secretWallet)).toEqual({
      kind: 'SECRET_RESERVATION_PENDING',
      requestId: genesisRequestId(secretWallet),
    });
    expect((await on.repository.find(secretWallet))?.claim).toBeNull();
    // And asking again does not resolve it a second time under other coverage.
    expect((await on.genesis.status(secretWallet)).kind).toBe('SECRET_RESERVATION_PENDING');

    // Secret off: the same draw is a Legendary card.
    const off = flow({ balances, secretAvailable: false, chain: blocks });
    const dealt = await off.genesis.request(secretWallet);
    if (dealt.kind !== 'READY') throw new Error(`expected a card, got ${dealt.kind}`);
    expect(dealt.claim.rarity).toBe('LEGENDARY');
    expect(dealt.claim.secretAvailable).toBe(false);
  });
});
