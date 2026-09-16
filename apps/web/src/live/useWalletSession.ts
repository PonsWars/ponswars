import { chainLabel } from '@ponswars/shared-types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../state/session.js';
import {
  deploymentChain,
  fetchSession,
  requestChallenge,
  rotateSession,
  signOut as revokeSession,
  verifySignature,
  type Session,
} from './auth-client.js';
import { liveEndpoints, type LiveEndpoints } from './endpoints.js';
import { fromServer, fromWallet, type WalletStatus } from './wallet-status.js';
import { clearStoredSession, readStoredSession, storeSession } from './session-store.js';
import {
  browserProvider,
  connectWallet,
  currentChain,
  signMessage,
  switchChain,
} from './wallet-provider.js';

/**
 * Connecting a wallet, and staying connected (§45.2, §68.2).
 *
 * The whole flow behind one `connect()`: ask the wallet who it is, ask the
 * server for something to sign, have the wallet sign it, exchange the signature
 * for a session, and remember it. §45.2 is explicit that a player is not asked
 * to sign again for every ten-minute action — one signature, then a session
 * that rotates.
 *
 * §5 makes spectating the normal case, so *not* connecting is a first-class
 * state rather than a locked door. Nothing here runs until somebody clicks.
 */

export type { WalletStatus };

export interface WalletSession {
  readonly status: WalletStatus;
  /** The header value for writes, or `null` for a spectator. */
  readonly authorization: string | null;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

export function useWalletSession(): WalletSession {
  const endpoints = useMemo<LiveEndpoints | null>(() => liveEndpoints(import.meta.env), []);
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<WalletStatus>({ kind: 'DISCONNECTED' });
  const setWallet = useSession((state) => state.setWallet);

  // Read inside callbacks that outlive the render they were made in.
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  const adopt = useCallback(
    (next: Session | null): void => {
      setSession(next);
      if (next === null) {
        clearStoredSession();
        setWallet(null);
        return;
      }
      storeSession(next);
      setWallet({
        addressFragment: fragment(next.wallet),
        // §7.9: unknown rather than zero. The balance needs a chain client and
        // the RPC vendor is an OPEN decision (§59.3); War Points arrive when
        // the wallet's record has been read. A zero shown to somebody who holds
        // a million $WAR is worse than an honest dash.
        warBalance: null,
        warPoints: null,
      });
    },
    [setWallet],
  );

  /**
   * What a stored token still is.
   *
   * A token in storage is a claim rather than a session — it may have expired
   * while the tab was closed, or been revoked — so it is checked against the
   * server before the HUD says anybody is signed in.
   */
  useEffect(() => {
    if (endpoints === null) {
      setStatus({ kind: 'DISCONNECTED' });
      return;
    }
    const stored = readStoredSession();
    if (stored === null) {
      if (browserProvider() !== null) {
        setStatus({ kind: 'DISCONNECTED' });
        return;
      }
      setStatus({ kind: 'UNAVAILABLE' });
      // A wallet may inject itself after the page has loaded — MetaMask says so
      // with `ethereum#initialized` — and without this the HUD said NO WALLET
      // for the rest of the visit to a player whose wallet had just arrived.
      const arrived = (): void => {
        if (browserProvider() !== null) {
          setStatus((current) =>
            current.kind === 'UNAVAILABLE' ? { kind: 'DISCONNECTED' } : current,
          );
        }
      };
      window.addEventListener('ethereum#initialized', arrived, { once: true });
      return () => {
        window.removeEventListener('ethereum#initialized', arrived);
      };
    }

    let live = true;
    void fetchSession(endpoints, stored.token).then((result) => {
      if (!live) {
        return;
      }
      if (!result.ok) {
        // Unreachable is not "signed out": the token may be perfectly good and
        // the network briefly gone. It stays in storage and the HUD shows
        // disconnected until the next load, rather than throwing away a
        // session because of one failed request.
        if (result.failure.kind !== 'UNREACHABLE') {
          clearStoredSession();
        }
        setStatus({ kind: 'DISCONNECTED' });
        return;
      }
      adopt({ ...stored, wallet: result.value.wallet, expiresAt: result.value.expiresAt });
      setStatus({
        kind: 'CONNECTED',
        wallet: result.value.wallet,
        expiresAt: result.value.expiresAt,
      });
    });

    return () => {
      live = false;
    };
  }, [endpoints, adopt]);

  /**
   * Rotation (§45.2).
   *
   * Halfway to expiry, derived from the session itself rather than from a
   * refresh interval invented here — the server owns how long a session lasts
   * and this follows it. A failure is not shown: the session that exists still
   * works until it does not.
   */
  useEffect(() => {
    if (endpoints === null || session === null) {
      return;
    }
    const remaining = session.expiresAt - Date.now();
    const delay = Math.max(remaining / 2, 60_000);
    // A session already past halfway rotates a minute from now rather than
    // immediately: a reload should not fire a request before the page paints.
    const timer = setTimeout(() => {
      void rotateSession(endpoints, session.token).then((result) => {
        if (result.ok) {
          adopt(result.value);
          setStatus({
            kind: 'CONNECTED',
            wallet: result.value.wallet,
            expiresAt: result.value.expiresAt,
          });
        }
      });
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [endpoints, session, adopt]);

  const connect = useCallback(async (): Promise<void> => {
    if (endpoints === null) {
      setStatus({
        kind: 'REFUSED',
        message: 'This build is not connected to a server.',
        nextStep: 'Nothing to do here — the world on screen is a preview.',
      });
      return;
    }
    const provider = browserProvider();
    if (provider === null) {
      setStatus({ kind: 'UNAVAILABLE' });
      return;
    }

    setStatus({ kind: 'CONNECTING', step: 'WALLET' });
    const connected = await connectWallet(provider);
    if (!connected.ok) {
      setStatus(fromWallet(connected.failure));
      return;
    }

    setStatus({ kind: 'CONNECTING', step: 'SIGNATURE' });
    const challenge = await requestChallenge(
      endpoints,
      connected.value.address,
      connected.value.chainId,
    );
    if (!challenge.ok) {
      // The one refusal worth acting on rather than reporting: a wallet on the
      // wrong network can be asked to switch, and then the whole flow is
      // retried from the top with the chain it actually reports.
      if (challenge.failure.kind === 'REFUSED' && challenge.failure.code === 'WRONG_CHAIN') {
        setStatus(await offerSwitch(provider, endpoints, connected.value.address));
        return;
      }
      setStatus(fromServer(challenge.failure));
      return;
    }

    const signature = await signMessage(provider, connected.value.address, challenge.value.message);
    if (!signature.ok) {
      setStatus(fromWallet(signature.failure));
      return;
    }

    setStatus({ kind: 'CONNECTING', step: 'SESSION' });
    const verified = await verifySignature(endpoints, {
      wallet: connected.value.address,
      nonce: challenge.value.nonce,
      signature: signature.value,
    });
    if (!verified.ok) {
      setStatus(fromServer(verified.failure));
      return;
    }

    adopt(verified.value);
    setStatus({
      kind: 'CONNECTED',
      wallet: verified.value.wallet,
      expiresAt: verified.value.expiresAt,
    });
  }, [endpoints, adopt]);

  const disconnect = useCallback(async (): Promise<void> => {
    const current = sessionRef.current;
    // Cleared here first. A sign-out that failed at the server is still a
    // sign-out on this device, and a token left in storage because the network
    // blinked would be the worst of both.
    adopt(null);
    setStatus({ kind: 'DISCONNECTED' });
    if (endpoints !== null && current !== null) {
      await revokeSession(endpoints, current.token);
    }
  }, [endpoints, adopt]);

  return {
    status,
    authorization: session === null ? null : `Bearer ${session.token}`,
    connect,
    disconnect,
  };
}

/**
 * Offers the network switch and reports what to do next.
 *
 * Split out because the interesting part is what it does *not* do: it never
 * retries the sign-in itself. A player who switched networks presses connect
 * again, which is one click and no ambiguity about which chain they meant.
 */
async function offerSwitch(
  provider: ReturnType<typeof browserProvider> & object,
  endpoints: LiveEndpoints,
  address: string,
): Promise<WalletStatus> {
  const probe = await deploymentChain(endpoints, address);
  // A probe that was stopped says nothing about chains. Reporting it as one
  // would tell a player who had merely asked too often that their wallet is on
  // the wrong network.
  if (!probe.ok) {
    return fromServer(probe.failure);
  }
  const expected = probe.value;
  if (expected === null) {
    return {
      kind: 'REFUSED',
      message: 'Your wallet is on a network this deployment does not accept.',
      nextStep: 'Switch networks in your wallet and connect again.',
    };
  }

  const switched = await switchChain(provider, expected);
  if (!switched.ok) {
    return {
      kind: 'REFUSED',
      message: `PonsWars runs on ${chainLabel(expected)} and your wallet is on another network.`,
      // The step is the line the bar shows, so it is the one that names the
      // network: "switch networks" alone leaves a player guessing which.
      nextStep: `Switch your wallet to ${chainLabel(expected)}, then connect again.`,
    };
  }

  const now = await currentChain(provider);
  return now === expected
    ? { kind: 'DISCONNECTED' }
    : {
        kind: 'REFUSED',
        message: `PonsWars runs on ${chainLabel(expected)}.`,
        nextStep: `Switch your wallet to ${chainLabel(expected)}, then connect again.`,
      };
}

/** `0x4f2…9c1`. §42.2 keeps the full address out of the HUD. */
function fragment(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-3)}`;
}
