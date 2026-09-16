import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { workerRecovery } from './recover-pool.js';
import { recoverInThisThread } from './verify.js';

/**
 * The pool, against the built worker.
 *
 * A worker thread runs JavaScript, so these point at `dist/` — which `tsc
 * --build` has written by the time tests run. Where it has not, the tests say
 * so rather than passing on a pool that was never started.
 */
const worker = new URL('../dist/recover-worker.js', import.meta.url);
const built = existsSync(worker);

/** A started pool, or a failure that says the pool is what failed. */
function started(): NonNullable<ReturnType<typeof workerRecovery>> {
  const pool = workerRecovery({ threads: 2, workerUrl: worker });
  if (pool === null) {
    throw new Error('two threads were asked for and none were started');
  }
  return pool;
}

describe.skipIf(!built)('workerRecovery', () => {
  it('recovers the same signer as the caller’s own thread', async () => {
    const pool = started();
    expect(pool.threads).toBe(2);

    const account = privateKeyToAccount(generatePrivateKey());
    const message = 'ponswars.test wants you to sign in with your Ethereum account';
    const signature = await account.signMessage({ message });

    const [onThreads, inThread] = await Promise.all([
      pool.recover(message, signature),
      recoverInThisThread(message, signature),
    ]);

    expect(onThreads).toBe(inThread);
    await pool.close();
  });

  it('spreads work across its threads and answers every request', async () => {
    const pool = started();
    const account = privateKeyToAccount(generatePrivateKey());
    const signatures = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        account.signMessage({ message: `message ${String(index)}` }),
      ),
    );

    const recovered = await Promise.all(
      signatures.map((signature, index) => pool.recover(`message ${String(index)}`, signature)),
    );

    expect(new Set(recovered)).toEqual(new Set([account.address]));
    await pool.close();
  });

  it('fails the request rather than the pool when a signature is not one', async () => {
    const pool = started();

    await expect(pool.recover('anything', '0xnope')).rejects.toThrow();

    // Still usable: one bad signature is a refused sign-in, not an outage.
    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signMessage({ message: 'after' });
    expect(await pool.recover('after', signature)).toBe(account.address);
    await pool.close();
  });
});

describe('workerRecovery on one core', () => {
  it('is nothing at all, rather than a thread that adds a message hop', () => {
    expect(workerRecovery({ threads: 1 })).toBeNull();
    expect(workerRecovery({ threads: 0 })).toBeNull();
  });
});
