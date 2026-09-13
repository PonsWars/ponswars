import type { GenesisStatusBody } from '@ponswars/schemas';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { liveEndpoints, type LiveEndpoints } from './endpoints.js';
import { fetchGenesis, requestGenesis, type GenesisResult } from './genesis-client.js';
import type { ProfileFailure } from './profile-client.js';

/**
 * The signed-in wallet's Genesis claim, kept current while the page is open (§69.6).
 *
 * Reads the claim when the page opens. While it is `PENDING_FINALITY` it asks
 * again every {@link GENESIS_POLL_MS}: the server finishes the claim on the
 * first read after its Robinhood Chain block is final, so asking is all waiting
 * takes. Nothing is read while the page is closed.
 */

export type LiveGenesis =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'LOADING' }
  | {
      readonly kind: 'READY';
      readonly status: GenesisStatusBody;
      /** Asks for the card. Idempotent on the server. */
      readonly request: () => void;
      readonly requesting: boolean;
      /** Why the last request failed, if it did; the status beside it still stands. */
      readonly requestFailure: ProfileFailure | null;
    }
  | { readonly kind: 'FAILED'; readonly failure: ProfileFailure; readonly retry: () => void };

/**
 * How often a sealing claim is read again.
 *
 * Robinhood Chain finalizes in batches minutes apart; fifteen seconds shows a
 * card within a breath of it being dealt without asking a hundred times. A
 * constant with a reason, not an `OPEN` value (§102).
 */
export const GENESIS_POLL_MS = 15_000;

export function useLiveGenesis(authorization: string | null, active: boolean): LiveGenesis {
  const endpoints = useMemo<LiveEndpoints | null>(() => liveEndpoints(import.meta.env), []);
  const [attempt, setAttempt] = useState(0);
  const [latest, setLatest] = useState<{
    readonly authorization: string;
    readonly result: GenesisResult;
  } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestFailure, setRequestFailure] = useState<ProfileFailure | null>(null);
  const requestController = useRef<AbortController | null>(null);

  const readable = authorization !== null && endpoints !== null && active;
  const sealing =
    latest?.authorization === authorization &&
    latest.result.ok &&
    latest.result.status.status === 'PENDING_FINALITY';

  useEffect(() => {
    if (!readable) {
      return;
    }
    const controller = new AbortController();
    const read = (): void => {
      void fetchGenesis(endpoints, authorization, controller.signal).then((result) => {
        if (!controller.signal.aborted) {
          setLatest({ authorization, result });
        }
      });
    };
    read();
    const timer = sealing ? setInterval(read, GENESIS_POLL_MS) : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [readable, authorization, endpoints, attempt, sealing]);

  useEffect(
    () => () => {
      requestController.current?.abort();
    },
    [],
  );

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  const request = useCallback(() => {
    if (authorization === null || endpoints === null || requesting) {
      return;
    }
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setRequesting(true);
    setRequestFailure(null);
    void requestGenesis(endpoints, authorization, controller.signal).then((result) => {
      if (controller.signal.aborted) {
        return;
      }
      setRequesting(false);
      if (result.ok) {
        setLatest({ authorization, result });
      } else {
        setRequestFailure(result.failure);
      }
    });
  }, [authorization, endpoints, requesting]);

  if (!readable) {
    return { kind: 'IDLE' };
  }
  // Only a result for this session: a claim read for a wallet that has since
  // signed out and been replaced is somebody else's.
  if (latest?.authorization !== authorization) {
    return { kind: 'LOADING' };
  }
  return latest.result.ok
    ? {
        kind: 'READY',
        status: latest.result.status,
        request,
        requesting,
        requestFailure,
      }
    : { kind: 'FAILED', failure: latest.result.failure, retry };
}
