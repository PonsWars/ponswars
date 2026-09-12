import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../state/session.js';
import {
  fetchSession,
  requestChallenge,
  rotateSession,
  signOut as revokeSession,
  verifySignature,
  type AuthFailure,
  type Session,
} from './auth-client.js';
import { liveEndpoints, type LiveEndpoints } from './endpoints.js';
import { clearStoredSession, readStoredSession, storeSession } from './session-store.js';
import {
  browserProvider,
  connectWallet,
  currentChain,
  signMessage,
  switchChain,
  type WalletFailure,
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

export type WalletStatus =
  /** No wallet extension in this browser. Watching still works. */
  | { readonly kind: 'UNAVAILABLE' }
  /** A wallet is available and nobody has connected it. */
  | { readonly kind: 'DISCONNECTED' }
  /** Mid-flow. The wallet is showing a prompt, or the server is answering. */
  | { readonly kind: 'CONNECTING'; readonly step: 'WALLET' | 'SIGNATURE' | 'SESSION' }
  | { readonly kind: 'CONNECTED'; readonly wallet: string; readonly expiresAt: number }
  /** It did not work, and this is what to say about it (§110.5). */
  | { readonly kind: 'REFUSED'; readonly message: string; readonly nextStep: string };

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
      setStatus(browserProvider() === null ? { kind: 'UNAVAILABLE' } : { kind: 'DISCONNECTED' });
      return;
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
  const expected = await expectedChain(endpoints, address);
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
      message: `PonsWars runs on chain ${String(expected)} and your wallet is on another.`,
      nextStep: 'Switch networks in your wallet, then connect again.',
    };
  }

  const now = await currentChain(provider);
  return now === expected
    ? { kind: 'DISCONNECTED' }
    : {
        kind: 'REFUSED',
        message: `PonsWars runs on chain ${String(expected)}.`,
        nextStep: 'Switch networks in your wallet, then connect again.',
      };
}

/**
 * The chain this deployment wants, asked for rather than guessed.
 *
 * The refusal already named it in a sentence, and parsing a number back out of
 * a sentence is exactly the kind of thing that works until the wording changes.
 * A challenge request for the wrong chain is refused; one for the right chain
 * is answered *with* the chain, so this asks for chain 1 and reads the answer.
 */
async function expectedChain(endpoints: LiveEndpoints, address: string): Promise<number | null> {
  const probe = await requestChallenge(endpoints, address, 1);
  return probe.ok ? probe.value.chainId : null;
}

function fromWallet(failure: WalletFailure): WalletStatus {
  switch (failure.kind) {
    case 'NO_WALLET':
      return { kind: 'UNAVAILABLE' };
    case 'DECLINED':
      // Changing your mind is not an error. Back to where you were, silently.
      return { kind: 'DISCONNECTED' };
    case 'WRONG_CHAIN':
      return {
        kind: 'REFUSED',
        message: `PonsWars runs on chain ${String(failure.expected)}.`,
        nextStep: 'Switch networks in your wallet, then connect again.',
      };
    case 'FAILED':
      return {
        kind: 'REFUSED',
        message: `Your wallet could not complete the request: ${failure.detail}`,
        nextStep: 'Try again. Nothing was signed and no funds moved.',
      };
  }
}

function fromServer(failure: AuthFailure): WalletStatus {
  switch (failure.kind) {
    case 'REFUSED':
      return { kind: 'REFUSED', message: failure.message, nextStep: failure.nextStep };
    case 'UNREACHABLE':
      return {
        kind: 'REFUSED',
        message: 'The server did not answer.',
        nextStep: 'Check your connection and try again. Nothing was recorded.',
      };
    case 'MALFORMED':
      return {
        kind: 'REFUSED',
        message: 'The server answered with something this client cannot read.',
        nextStep: 'Reload the page. If it keeps happening, this build is out of date.',
      };
  }
}

/** `0x4f2…9c1`. §42.2 keeps the full address out of the HUD. */
function fragment(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-3)}`;
}
