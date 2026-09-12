import type { Profile } from '@ponswars/schemas';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { liveEndpoints, type LiveEndpoints } from './endpoints.js';
import { fetchProfile, type ProfileFailure, type ProfileResult } from './profile-client.js';

/**
 * The signed-in wallet's record (§69.9).
 *
 * `authorization` is `null` whenever there is nothing to read for — no session,
 * or no live round — and the hook then reads nothing. With a session it reads
 * the record, and reads it again whenever `refresh` changes: a player who opens
 * their profile after a battle ends has to see that battle, and the War Points
 * in the bar have to move when a round pays out. The last record stays on
 * screen while the new one loads, rather than blanking a page the player is
 * already reading.
 */

export type LiveProfile =
  | { readonly kind: 'IDLE' }
  | { readonly kind: 'LOADING' }
  | { readonly kind: 'READY'; readonly profile: Profile }
  | { readonly kind: 'FAILED'; readonly failure: ProfileFailure; readonly retry: () => void };

export function useLiveProfile(
  authorization: string | null,
  /**
   * Changes whenever the record may have changed — a round finalized, a page
   * that shows it opened — and every change reads it again.
   */
  refresh: string,
): LiveProfile {
  const endpoints = useMemo<LiveEndpoints | null>(() => liveEndpoints(import.meta.env), []);
  const [attempt, setAttempt] = useState(0);
  const [latest, setLatest] = useState<{
    readonly authorization: string;
    readonly result: ProfileResult;
  } | null>(null);

  useEffect(() => {
    if (authorization === null || endpoints === null) {
      return;
    }
    const controller = new AbortController();
    void fetchProfile(endpoints, authorization, controller.signal).then((result) => {
      // An aborted request is a page that stopped asking, not a failure to show.
      if (!controller.signal.aborted) {
        setLatest({ authorization, result });
      }
    });
    return () => {
      controller.abort();
    };
  }, [authorization, endpoints, attempt, refresh]);

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  if (authorization === null || endpoints === null) {
    return { kind: 'IDLE' };
  }
  // Only a result for this session. A record fetched for a wallet that has
  // since signed out and been replaced is somebody else's.
  if (latest?.authorization !== authorization) {
    return { kind: 'LOADING' };
  }
  return latest.result.ok
    ? { kind: 'READY', profile: latest.result.profile }
    : { kind: 'FAILED', failure: latest.result.failure, retry };
}
