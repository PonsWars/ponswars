import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { WalletSession } from './useWalletSession.js';

/**
 * One session per page (§45.2).
 *
 * `useWalletSession` owns a token, a restore on load and a rotation timer.
 * Calling it from two components would give the page two of each — two restores
 * racing, two rotations, and a HUD that disagrees with the nav bar about
 * whether anybody is signed in. So it is called once, at the top, and read
 * through here.
 *
 * A context rather than the store beside it because this is not world state:
 * nothing in `session.ts` should be able to write a session token, and keeping
 * it out of that store is what makes that structural rather than a rule.
 */

const WalletSessionContext = createContext<WalletSession | null>(null);

export function WalletSessionProvider({
  session,
  children,
}: {
  readonly session: WalletSession;
  readonly children: ReactNode;
}): JSX.Element {
  return <WalletSessionContext.Provider value={session}>{children}</WalletSessionContext.Provider>;
}

/**
 * The page's session.
 *
 * Throws outside the provider rather than returning a disconnected stand-in: a
 * component that renders a connect button which silently does nothing is worse
 * than one that fails in development where somebody sees it.
 */
export function useWalletSessionContext(): WalletSession {
  const session = useContext(WalletSessionContext);
  if (session === null) {
    throw new Error('useWalletSessionContext used outside WalletSessionProvider');
  }
  return session;
}
