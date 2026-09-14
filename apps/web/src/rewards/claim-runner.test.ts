import { describe, expect, it } from 'vitest';
import type { Eip1193Provider } from '../live/wallet-provider.js';
import type { ClaimState } from './reward-view.js';
import { runClaim } from './claim-runner.js';

const WALLET = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const DISTRIBUTOR = `0x${'d1'.repeat(20)}`;
const TX = `0x${'ab'.repeat(32)}`;

function wallet(options: {
  account?: string;
  chain?: string;
  send?: () => unknown;
  receipts?: unknown[];
  switchTo?: string | null;
}) {
  const sent: unknown[] = [];
  let chain = options.chain ?? '0xb626';
  const receipts = [...(options.receipts ?? [{ status: '0x1' }])];
  const provider: Eip1193Provider = {
    request: ({ method, params }) =>
      new Promise((resolve) => {
        switch (method) {
          case 'eth_requestAccounts':
            resolve([options.account ?? WALLET]);
            return;
          case 'eth_chainId':
            resolve(chain);
            return;
          case 'wallet_switchEthereumChain':
            if (options.switchTo === null) {
              throw Object.assign(new Error('rejected'), { code: 4001 });
            }
            chain = options.switchTo ?? '0xb626';
            resolve(null);
            return;
          case 'eth_sendTransaction':
            sent.push(params?.[0]);
            resolve(options.send === undefined ? TX : options.send());
            return;
          case 'eth_getTransactionReceipt':
            resolve(receipts.length > 1 ? receipts.shift() : receipts[0]);
            return;
          default:
            throw new Error(`unexpected ${method}`);
        }
      }),
  };
  return { provider, sent };
}

async function claim(fixture: ReturnType<typeof wallet>) {
  const states: ClaimState[] = [];
  const result = await runClaim({
    provider: fixture.provider,
    wallet: WALLET,
    chainId: 46630,
    distributor: DISTRIBUTOR,
    claim: { distributionId: 8n, amount: 400n, proof: [`0x${'aa'.repeat(32)}`] },
    onState: (state) => states.push(state),
    sleep: () => Promise.resolve(),
    maxPolls: 5,
  });
  return { result, states };
}

describe('claiming a reward from the wallet (§35.6)', () => {
  it('asks the wallet, submits, and confirms once the receipt lands', async () => {
    const fixture = wallet({ receipts: [null, null, { status: '0x1' }] });

    const { result, states } = await claim(fixture);

    expect(result).toEqual({ state: 'CONFIRMED', transaction: TX });
    expect(states).toEqual(['CONFIRM_IN_WALLET', 'SUBMITTING', 'CONFIRMED']);
    expect(fixture.sent).toEqual([
      expect.objectContaining({ from: WALLET, to: DISTRIBUTOR, value: '0x0' }),
    ]);
  });

  it('refuses an account other than the signed-in wallet, and sends nothing', async () => {
    const fixture = wallet({ account: `0x${'9'.repeat(40)}` });

    const { result, states } = await claim(fixture);

    expect(result).toEqual({ state: 'FAILED', reason: 'WRONG_ACCOUNT' });
    expect(states.at(-1)).toBe('FAILED');
    expect(fixture.sent).toEqual([]);
  });

  it('switches to Robinhood Chain first, and refuses if the wallet will not', async () => {
    const switched = wallet({ chain: '0x1' });
    expect((await claim(switched)).result.state).toBe('CONFIRMED');

    const stuck = wallet({ chain: '0x1', switchTo: null });
    expect((await claim(stuck)).result).toEqual({ state: 'FAILED', reason: 'WRONG_CHAIN' });
    expect(stuck.sent).toEqual([]);
  });

  it('fails without touching the allocation when declined or reverted', async () => {
    const declined = wallet({
      send: () => {
        throw Object.assign(new Error('User rejected'), { code: 4001 });
      },
    });
    expect((await claim(declined)).result).toEqual({ state: 'FAILED', reason: 'DECLINED' });

    const reverted = wallet({ receipts: [{ status: '0x0' }] });
    expect((await claim(reverted)).result).toEqual({ state: 'FAILED', reason: 'REVERTED' });
  });

  it('stops waiting after its polls, and says the claim is unconfirmed rather than lost', async () => {
    const slow = wallet({ receipts: [null] });

    expect((await claim(slow)).result).toEqual({ state: 'FAILED', reason: 'UNCONFIRMED' });
  });
});
