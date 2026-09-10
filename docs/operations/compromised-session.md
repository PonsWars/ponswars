# A session that should not exist

**When:** a player says someone else is acting as them, a session token has been
pasted somewhere public, or a wallet is doing something a person would not.

Masterplan §45.2 (session revocation), §48.2 (private channels), §5
(spectating).

## What is true before you touch anything

A session proves one thing: that whoever holds the token controlled that wallet
at the moment it was issued. It is a bearer credential — anyone holding it is
that wallet as far as this system is concerned — and it is revocable, which is
exactly why sessions are rows in PostgreSQL rather than signed tokens nobody can
withdraw.

Revoking a session takes nothing away from the player permanently. They press
connect, sign once, and are back. That asymmetry is what makes revocation the
cheap, safe move: **when in doubt, revoke.**

## What a revoked session stops, and when

| Effect                                     | When                                                |
| ------------------------------------------ | --------------------------------------------------- |
| REST writes with that token (§47.5, §47.6) | Immediately — every request reads the row           |
| A live socket's private channel (§48.2)    | On its next connection, or when it re-authenticates |
| A pick already recorded this round         | **Never.** See below                                |

The last row is the one to be clear about before anybody expects otherwise. A
pick that was accepted is part of the round; §22 allows a change only while
`PICK_OPEN`, and revoking a session is not a way to reach into a round. If a
pick must be withdrawn, that is the pick endpoint before the lock, made by
whoever holds the wallet — not this.

## Ending every session a wallet holds

```sql
UPDATE auth_sessions
   SET revoked_at = now()
 WHERE wallet = '0x…'          -- lowercase, as stored
   AND revoked_at IS NULL
   AND expires_at > now();
```

`PostgresAuthStore.revokeEverySession` does exactly this and is what a service
would call; the statement is here because an operator at three in the morning
has `psql` and not a deploy.

Count the rows it reports. More live sessions than the player has devices is
itself the finding — each one is a separate sign-in that somebody completed with
that wallet's key.

## Ending one session

Only when you know which. The stored value is a SHA-256 fingerprint of the
token, never the token, so there is nothing here to look a session up by unless
you already have the fingerprint from a log or a support ticket:

```sql
UPDATE auth_sessions SET revoked_at = now()
 WHERE token_fingerprint = '…' AND revoked_at IS NULL;
```

If you have the token itself rather than the fingerprint, do not paste it into a
query — a token in a query log is a live credential in a query log. Revoke every
session for the wallet instead.

## What not to do

**Do not delete the row.** `revoked_at` is a fact with a time on it, and the
question after an incident is always _when_. Pruning removes rows that have
already expired; revocation marks them.

**Do not change `AUTH_SESSION_TTL_MS` in response to one incident.** It applies
to everybody, it only takes effect for sessions issued after the restart, and it
does nothing at all to the session in front of you. Revoke that one.

**Do not block the wallet from signing in again** unless there is a decision to
ban it, which is a different thing entirely and is not implemented. A wallet
whose sessions were revoked can sign in again by producing a signature — which
is the point: the person who controls the key gets back in, and the person who
had a stolen token does not.

## Afterwards

Two questions worth answering while it is fresh:

1. **How did the token get out?** The client stores it in `localStorage` on the
   deployment's own origin, and the deployed page sets `script-src 'self'` with
   no inline scripts. A leaked token means either that origin ran something it
   should not have, or the player's own machine did.
2. **Did anything happen under it?** `wp_ledger` and `battle_results` are
   append-only and carry the wallet. A revoked session leaves the round it
   played in intact; §26's evidence is what says what it did.
