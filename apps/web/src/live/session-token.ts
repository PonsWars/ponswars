/**
 * The session a write is made under, or the absence of one (§5, §45.2).
 *
 * **This is not authentication and must never become it.** §45.2 puts a wallet
 * session behind a signed challenge, and that flow is not built — the choice of
 * wallet connector and the signing statement are decisions nobody has made. What
 * this does is let a development stack exercise the pick path end to end, using
 * the same header a real session will carry.
 *
 * The absence of a token is not a failure. §5 makes spectating the normal case:
 * a visitor with no wallet watches the world, and the pick controls simply do
 * not offer a decision they cannot make. That is why this returns `null` rather
 * than throwing or inventing an identity.
 *
 * It is `VITE_`-prefixed, so it is compiled into the bundle and public. That is
 * acceptable only because it is a development affordance against a stack that
 * accepts any token as one demo wallet. A real session token must never be
 * built into a bundle, which is another reason this cannot grow into the auth
 * path.
 */

export interface SessionEnvironment {
  readonly VITE_DEV_SESSION_TOKEN?: string | undefined;
}

/**
 * The `authorization` header value for writes, or `null` for a spectator.
 *
 * Already formatted as a header rather than a bare token, so no caller has to
 * remember the scheme — and so a token pasted in with `Bearer ` already on it
 * is not double-prefixed.
 */
export function sessionAuthorization(env: SessionEnvironment): string | null {
  const token = env.VITE_DEV_SESSION_TOKEN?.trim();
  if (token === undefined || token === '') {
    return null;
  }
  return /^bearer\s/i.test(token) ? token : `Bearer ${token}`;
}
