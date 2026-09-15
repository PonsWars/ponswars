import type { SecretClaim } from '@ponswars/schemas';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runSecretClaim, type ClaimFailure } from '../rewards/claim-runner.js';
import type { ClaimState } from '../rewards/reward-view.js';
import { liveEndpoints, type LiveEndpoints } from './endpoints.js';
import type { ProfileFailure } from './profile-client.js';
import { fetchSecretClaim } from './secret-client.js';
import { browserProvider } from './wallet-provider.js';

/**
 * The Secret this wallet holds, and claiming it (§8.5, §35.7).
 *
 * Read when the rewards page opens, the way the published rewards are.
 * `claim` sends the vault's `claim()` from the player's own wallet; a
 * confirmed one re-reads the vault, so what the page shows afterwards is the
 * vault's answer rather than the page's assumption.
 *
 * A failure is kept, never swallowed: an entitlement has no expiry (§8.5), so
 * the honest thing after a declined signature is to say what happened and
 * leave the reward exactly where it is.
 */

export type LiveSecretClaim =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'LOADING' }
  | {
      readonly kind: 'READY';
      readonly secret: SecretClaim;
      readonly progress: {
        readonly state: ClaimState;
        readonly failure: ClaimFailure | null;
      } | null;
      readonly claim: () => void;
    }
  | { readonly kind: 'FAILED'; readonly failure: ProfileFailure; readonly retry: () => void };

export function useSecretClaim(
  authorization: string | null,
  wallet: string | null,
  active: boolean,
): LiveSecretClaim {
  const endpoints = useMemo<LiveEndpoints | null>(() => liveEndpoints(import.meta.env), []);
  const [attempt, setAttempt] = useState(0);
  const [latest, setLatest] = useState<{
    readonly authorization: string;
    readonly result: Awaited<ReturnType<typeof fetchSecretClaim>>;
  } | null>(null);
  const [progress, setProgress] = useState<{
    readonly state: ClaimState;
    readonly failure: ClaimFailure | null;
  } | null>(null);
  const running = useRef(false);

  const readable = authorization !== null && endpoints !== null && active;

  useEffect(() => {
    if (!readable) {
      return;
    }
    const controller = new AbortController();
    void fetchSecretClaim(endpoints, authorization, controller.signal).then((result) => {
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
  const secret = current?.ok === true ? current.secret : null;

  const claim = useCallback(() => {
    if (secret?.status !== 'READ' || secret.entitlement !== 'RESERVED') {
      return;
    }
    if (wallet === null || running.current) {
      return;
    }
    const provider = browserProvider();
    if (provider === null) {
      setProgress({ state: 'FAILED', failure: 'NO_WALLET' });
      return;
    }
    running.current = true;
    void runSecretClaim({
      provider,
      wallet,
      chainId: secret.chainId,
      vault: secret.vault,
      onState: (state) => {
        setProgress({ state, failure: null });
      },
    })
      .then((result) => {
        if (result.state === 'FAILED') {
          setProgress({ state: 'FAILED', failure: result.reason });
        } else {
          retry();
        }
      })
      .finally(() => {
        running.current = false;
      });
  }, [secret, wallet, retry]);

  if (!readable) {
    return { kind: 'IDLE' };
  }
  if (current === null) {
    return { kind: 'LOADING' };
  }
  return current.ok
    ? { kind: 'READY', secret: current.secret, progress, claim }
    : { kind: 'FAILED', failure: current.failure, retry };
}
