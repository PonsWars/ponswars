import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { RecoverSigner } from './verify.js';

/**
 * Recovering signers on worker threads (§45.2, §21.3).
 *
 * Sign-in is the one request in this service that is limited by arithmetic
 * rather than by IO: recovering a public key from a signature runs a few
 * hundred times a second on one core, and every player who opens the app at a
 * round boundary asks for one within the same sixty seconds (§3.1). Node runs
 * JavaScript on one thread, so the only way to use the machine a service is
 * already paying for is to hand this work to threads.
 *
 * Deliberately small: no queue of its own, no retries, no restarts on a thread
 * that dies. A recovery that fails is a refused sign-in, which is what a bad
 * signature is anyway, and a service that cannot start its threads runs in one.
 */

export interface RecoveryPool {
  readonly recover: RecoverSigner;
  /** How many threads are doing the work. */
  readonly threads: number;
  /** Stops the threads; the pool must not be used afterwards. */
  close(): Promise<void>;
}

/** The most threads a pool will start, however many cores it finds. */
const MAX_THREADS = 8;

/**
 * A pool of `threads` workers, or `null` where one core is all there is.
 *
 * `null` rather than a pool of one: a single worker thread is the same
 * arithmetic on the same core plus a message hop, and the caller's default —
 * recovering in its own thread — is the honest answer there.
 */
export function workerRecovery(
  options: {
    readonly threads?: number;
    /**
     * The worker's compiled file. Defaults to the one beside this module — a
     * test running from source points at the built one, because a thread runs
     * JavaScript and nothing else.
     */
    readonly workerUrl?: URL;
  } = {},
): RecoveryPool | null {
  const threads = options.threads ?? Math.min(MAX_THREADS, Math.max(0, availableParallelism() - 1));
  if (threads < 2) {
    return null;
  }

  const url = options.workerUrl ?? new URL('./recover-worker.js', import.meta.url);
  const pending = new Map<
    number,
    { resolve: (address: string) => void; reject: (error: Error) => void }
  >();
  let nextId = 0;
  /**
   * Threads are referenced only while they have work.
   *
   * Idle threads must not hold a process open — a job that finishes should
   * exit. But a thread left unreferenced while a recovery is in flight lets the
   * loop empty and the process exit with the answer never delivered, which is a
   * sign-in that hangs rather than one that fails.
   */
  const settle = (): void => {
    const busy = pending.size > 0;
    for (const worker of workers) {
      if (busy) {
        worker.ref();
      } else {
        worker.unref();
      }
    }
  };
  const workers = Array.from({ length: threads }, () => {
    const worker = new Worker(url);
    worker.on('message', (reply: { id: number; address?: string; error?: string }) => {
      const waiting = pending.get(reply.id);
      pending.delete(reply.id);
      settle();
      if (waiting === undefined) {
        return;
      }
      if (typeof reply.address === 'string') {
        waiting.resolve(reply.address);
      } else {
        waiting.reject(new Error(reply.error ?? 'recovery failed'));
      }
    });
    worker.on('error', (error) => {
      // Every request in flight fails; they are sign-ins, and a refused
      // sign-in is a thing a client already knows how to handle.
      for (const [id, waiting] of pending) {
        pending.delete(id);
        waiting.reject(error);
      }
      settle();
    });
    worker.unref();
    return worker;
  });

  let turn = 0;
  return {
    threads,
    recover: (message, signature) =>
      new Promise<string>((resolve, reject) => {
        const id = (nextId += 1);
        pending.set(id, { resolve, reject });
        settle();
        // Round robin. Recoveries take the same time as each other, so the
        // simplest fair order is the right one.
        const worker = workers[turn % workers.length];
        turn += 1;
        if (worker === undefined) {
          pending.delete(id);
          settle();
          reject(new Error('the recovery pool has no threads'));
          return;
        }
        worker.postMessage({ id, message, signature });
      }),
    close: async () => {
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}
