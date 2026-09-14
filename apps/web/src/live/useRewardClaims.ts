import type { RewardClaims } from '@ponswars/schemas';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runClaim, type ClaimFailure } from '../rewards/claim-runner.js';
import type { ClaimState } from '../rewards/reward-view.js';
import { liveEndpoints, type LiveEndpoints } from './endpoints.js';
import type { ProfileFailure } from './profile-client.js';
import { fetchRewardClaims } from './rewards-client.js';
import { browserProvider } from './wallet-provider.js';

/**
 * The signed-in wallet's published rewards, and claiming them (§17, §35.6).
 *
 * Read when the rewards page opens. `claim` walks one reward through the
 * wallet; a confirmed claim reads the list again, so what the page shows
 * afterwards is what the contract says rather than what the page assumed.
 */

export type LiveRewardClaims =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'LOADING' }
  | {
      readonly kind: 'READY';
      readonly claims: RewardClaims;
      readonly progress: ReadonlyMap<
        string,
        { readonly state: ClaimState; readonly failure: ClaimFailure | null }
      >;
      readonly claim: (distributionId: string) => void;
    }
  | { readonly kind: 'FAILED'; readonly failure: ProfileFailure; readonly retry: () => void };

export function useRewardClaims(
  authorization: string | null,
  wallet: string | null,
  active: boolean,
): LiveRewardClaims {
  const endpoints = useMemo<LiveEndpoints | null>(() => liveEndpoints(import.meta.env), []);
  const [attempt, setAttempt] = useState(0);
  const [latest, setLatest] = useState<{
    readonly authorization: string;
    readonly result: Awaited<ReturnType<typeof fetchRewardClaims>>;
  } | null>(null);
  const [progress, setProgress] = useState<
    ReadonlyMap<string, { readonly state: ClaimState; readonly failure: ClaimFailure | null }>
  >(new Map());
  const running = useRef(new Set<string>());

  const readable = authorization !== null && endpoints !== null && active;

  useEffect(() => {
    if (!readable) {
      return;
    }
    const controller = new AbortController();
    void fetchRewardClaims(endpoints, authorization, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        setLatest({ authorization, result });
      }
    });
    return () => {
      controller.abort();
    };
  }, [readable, authorization, endpoints, attempt]);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  const current = latest?.authorization === authorization ? latest.result : null;
  const readClaims = current?.ok === true ? current.claims : null;

  const claim = useCallback(
    (distributionId: string) => {
      const provider = browserProvider();
      if (readClaims?.status !== 'READ' || wallet === null || running.current.has(distributionId)) {
        return;
      }
      const entry = readClaims.claims.find(
        (candidate) => candidate.distributionId === distributionId,
      );
      if (entry === undefined) {
        return;
      }
      const record = (state: ClaimState, failure: ClaimFailure | null): void => {
        setProgress((previous) => new Map(previous).set(distributionId, { state, failure }));
      };
      if (provider === null) {
        record('FAILED', 'NO_WALLET');
        return;
      }
      running.current.add(distributionId);
      void runClaim({
        provider,
        wallet,
        chainId: readClaims.chainId,
        distributor: readClaims.distributor,
        claim: {
          distributionId: BigInt(entry.distributionId),
          amount: BigInt(entry.amount),
          proof: entry.proof,
        },
        onState: (state) => {
          record(state, null);
        },
      })
        .then((result) => {
          if (result.state === 'FAILED') {
            record('FAILED', result.reason);
          } else {
            retry();
          }
        })
        .finally(() => {
          running.current.delete(distributionId);
        });
    },
    [readClaims, wallet, retry],
  );

  if (!readable) {
    return { kind: 'IDLE' };
  }
  if (current === null) {
    return { kind: 'LOADING' };
  }
  return current.ok
    ? { kind: 'READY', claims: current.claims, progress, claim }
    : { kind: 'FAILED', failure: current.failure, retry };
}
