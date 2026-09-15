# Deploying PonsWars

What a deployment consists of, what it needs decided before it can run a round,
and what the images refuse to do.

This is not a hosting recommendation. §59.3 leaves the provider open — where the
containers run, who runs the database, and which RPC endpoint answers are all
decisions nobody has made. What is settled is the shape: two images, one schema
job, and a configuration contract that fails fast when it is incomplete.

## What is here

| Piece                    | File                                       |
| ------------------------ | ------------------------------------------ |
| The service              | `infra/containers/server.Dockerfile`       |
| The client               | `infra/containers/web.Dockerfile`          |
| How the client is served | `infra/containers/web.nginx.conf`          |
| A whole deployment       | `infra/containers/docker-compose.prod.yml` |
| Development dependencies | `infra/containers/docker-compose.yml`      |

Both images build from the repository root, because a workspace package cannot
be installed without the lockfile and the manifests of everything it depends on.

## Before anything else: what is still open

**A deployment can run rounds end to end.** What it still lacks is a real market.

PonsWars runs on **Robinhood Chain**. `CHAIN_ID` is `4663` for mainnet or
`46630` for testnet, and `loadConfig` refuses any other id. `RPC_URL` is any
Robinhood Chain JSON-RPC endpoint — Robinhood's public one
(`https://rpc.mainnet.chain.robinhood.com`, `https://rpc.testnet.chain.robinhood.com`)
works, and a vendor's works the same way; which vendor is `OPEN`
(`docs/OPEN_PARAMETERS.md` §3). On startup the server asks the endpoint which
chain it serves and exits if that is not `CHAIN_ID`, before it connects to
anything else.

Startup also reads `decimals()` from `WAR_TOKEN_ADDRESS` and `SPY_TOKEN_ADDRESS`
and exits if either differs from `WAR_TOKEN_DECIMALS` / `SPY_TOKEN_DECIMALS`, or
if an address is not a token on that network. A decimals value that is off by
one converts every amount by a power of ten, and nothing else would notice.

The Rewards page reads each published allocation's claimed status from
`RewardsDistributor` at `REWARDS_DISTRIBUTOR_ADDRESS`; players claim from their
own wallets. Publishing a root is the distribution job's, with its own
`DISTRIBUTION_PUBLISHER_KEY` — the server holds no publisher key
([Rewards distribution](rewards-distribution.md)).

A signed-in wallet's profile carries its `$WAR` balance, read at the latest
block when the profile is asked for. A read that fails or takes longer than
2.5 seconds answers `UNAVAILABLE`, and the rest of the profile arrives anyway.

The chain decides two things.

**Genesis cards (§6, §9).** A signed-in wallet holding at least 1,000,000 `$WAR`
asks once, and its one request is bound to a block ten past the Robinhood Chain
head — a block that does not exist yet. The card is dealt from that block's hash
once the block is **finalized**, which is usually around twenty minutes; the
Genesis page waits and re-reads on its own. The claim, the card with its charges
and the wallet's claimed flag are written in one transaction, and a claim cannot
be updated or deleted. Every card recomputes with `pnpm run audit:genesis`.

**Secret results follow `SECRET_RESERVER_KEY`.** Revealing a Secret needs its
SPY reward reserved in the Secret Stock Vault first (§8.4, §76.5), and only a key
holding the vault's `RESERVER_ROLE` can reserve. With `SECRET_RESERVER_KEY=disabled`
the Secret band deals Legendary (§8.3), and each claim records the
`rarity-table-v1-secret-disabled` table. With a key, startup checks the key holds
the role and refuses to start if it does not; a Secret is then reserved on chain
before it is recorded, and a reservation that fails is retried on the next read.
The banner says which. The key needs gas ETH for `reserve` transactions.

**The last tiebreak step (§12.7).** Only a battle
level through every market component reaches it, and for that battle the server
waits for the first Robinhood Chain block at or after the cutoff to be
**finalized** and breaks the tie with its hash. Finalization trails the head by
minutes, so a dead heat publishes that much later, and the log says so:

```
a battle is tied through every market component; waiting for the first Robinhood Chain block after … to be finalized
```

An endpoint that fails is retried every fifteen seconds and each failure is
logged. A stop signal during the wait ends it without writing anything; the next
start asks for the same block.

**Market data follows `MARKET_DATA_PROVIDER`.** `onchain` scores battles from
Stock Token trading on Robinhood Chain mainnet, guarded by each token's
Chainlink feed ([ADR 0007](../adr/0007-robinhood-chain-market-with-session-pause.md)).
It refuses to start on testnet, where there are no Stock Tokens; run
`synthetic` there, and the banner says the prices are generated.

With `onchain`, startup backfills the market before the first round: pool
discovery across all of history, then every trade in the last
`MARKET_COMPARABLE_SESSIONS` trading days. The API and gateway bind first, so
`/v1/health` answers throughout and `/v1/ready` stays `503` until a round
loads — give the readiness probe minutes, not seconds. The log narrates it:

```
market: reading Robinhood Chain — no round opens until the backfill is done
market: 959 USDG pools, 1460 Pons pools
market: caught up
```

Once caught up it reads new blocks every second. A failed poll is logged once
and retried; while the indexer is more than thirty seconds behind, its market
is `STALE` and live battles void rather than score old data.

What that costs, measured on mainnet during a US session with the public
endpoint and `RPC_MIN_INTERVAL_MS=250`: a poll is one log query, one block
read and a sender lookup for each routed Pons trade — about one and a half a
second, and the largest share of the calls. The indexer stayed one to two
seconds behind the chain, with spikes past twenty when the endpoint throttled.
That is enough to develop against and not enough to run battles on; a vendor
endpoint with a lower `RPC_MIN_INTERVAL_MS` is.

**No round opens while the market is shut.** Stock Tokens trade 24/5, from
Sunday 20:00 to Friday 20:00 New York time, except on `MARKET_HOLIDAYS`. A
round only opens where all ten minutes fit inside that; otherwise the server
waits and says when:

```
market closed — the next round opens 2026-09-20T20:00:00.000Z
```

Update `MARKET_HOLIDAYS` when the exchange publishes the next year's calendar.
A holiday missing from it opens rounds that void.

| Decision                   | Effect until it is made                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Robinhood Chain RPC vendor | Required for `onchain`: the public endpoint throttles the indexer with a challenge page, and backfills crawl behind the retries |
| Redis (§21.3)              | `REDIS_URL` is required and validated but nothing reads it yet                                                                  |

Authentication is no longer on that list. §45.2 is built: a wallet signs an
EIP-4361 challenge, the signature is verified, and the session that comes back
lives in PostgreSQL so it survives a deploy and can be revoked. What a
deployment has to decide is how long a challenge and a session last — both are
`OPEN` (`docs/OPEN_PARAMETERS.md` §4) and both are required at startup.

One limitation worth knowing before somebody reports it as a bug: a
smart-contract wallet cannot sign in. EIP-1271 verification is a call to the
wallet's own contract, and sign-in does not make chain calls, so a signature
that does not recover to the expected address is refused.

## Configuration

Every variable in `.env.example` is required and none has a default. §65.2 wants
startup to fail fast; §102 forbids inventing an `OPEN` value and shipping it as
policy. `loadConfig` reports every missing or invalid parameter at once, so one
restart tells you the whole list:

```
Invalid configuration (19 problem(s)):
  CHAIN_ID: is required and was not set
  ...
```

Six variables are the composition's rather than the server's, and live in the
same file: `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB` for the
bundled database, and `VITE_API_URL`, `VITE_WS_URL`, `WEB_PORT` for the client.
The two `VITE_` values are compiled into the bundle and are public the moment it
ships — which is why they are not in the server's table, where the secrets are.

`AUTH_ORIGIN` is the one worth reading twice. A sign-in signature is bound to
the origin named in the message, so this is the **client's** public URL, not the
API's — and a signature produced for one deployment must not authenticate at
another. Getting it wrong works perfectly right up until somebody clones the
front end.

## Bringing it up

```bash
cp .env.example .env      # then fill it in — every value is required
docker compose --env-file .env -f infra/containers/docker-compose.prod.yml \
  --profile bundled-database up -d --build
```

`--env-file .env` is not optional: Compose looks for `.env` beside the compose
file otherwise, which is not where it is.

Drop `--profile bundled-database` when the database is managed, which is the
production answer. `DATABASE_URL` then points wherever it was decided and
nothing else changes — the migration job depends on the bundled container only
when it exists.

Start order is a dependency, not a delay:

1. `postgres` becomes healthy (or is somebody else's, and is already up)
2. `migrate` applies the schema and exits `0`
3. `server` starts, and is not considered healthy until `/v1/ready` answers
4. `web` serves the built client

## Migrations

`node dist/migrate.js` in the server image, run as a job before the server.

The image carries the migrations it expects, so the schema and the code that
reads it are one artifact — a deployment cannot apply the wrong version of the
schema for the binary it is running.

It records every applied file with its SHA-256 in `schema_migrations` and:

- will not re-run a file it has already applied;
- **will refuse to run at all if a file has changed since it was applied**,
  because an edited migration is a schema two databases disagree about — write a
  new one;
- holds an advisory lock for the length of the run, so the several copies a
  rolling deploy starts do not race.

Applying and recording happen in one transaction. Every migration wraps itself
in `BEGIN`/`COMMIT` so that applying it by hand with `psql` is atomic; the
runner requires that shape and refuses a file without it, rather than applying
half of one.

## Health, readiness and stopping

`/v1/health` answers as soon as the process is listening. `/v1/ready` answers
`503` until a round is loaded, and that is the one to point a load balancer at:
a container reported healthy before it has a round is a container traffic
arrives at too early.

`SIGTERM` stops the driver **between** steps, never during one — a round part
way through finalizing has writes to finish (§25). `stop_grace_period` is 45s,
which is long enough for the step in flight and short enough not to hang a
deploy.

A driver that fails rather than stops takes the process down with it. This is
deliberate and was a bug first: the API kept the event loop alive, so a service
whose round loop had died went on answering `/v1/ready` with `200` and serving
the last round it saw, forever.

## What the images will not do

- **Run as root.** The service runs as `node`, and it writes nothing.
- **Assume a port.** `API_PORT` and `GATEWAY_PORT` are required configuration;
  there is no `EXPOSE` in the server image and no fallback in the code.
- **Talk to anything the client was not built for.** The client's
  `Content-Security-Policy` names its `connect-src` origins, written at build
  time from the same two values the bundle was compiled with.
- **Cache `index.html`.** It names the hashed bundles; a cached copy pins a
  browser to a deployment that no longer exists. Everything under `/assets/` is
  immutable for a year, because a changed file is a different URL.

## What the service bounds, and what the edge must

The service bounds what one connection can make it hold: a request body is at
most 16 KiB, a WebSocket frame at most 4 KiB, a socket may follow at most 32
channels and have at most 64 frames waiting, and a card can only be armed by a
wallet that holds one.

What it cannot bound is **how many requests one client sends**. That needs the
client's real address, and behind a load balancer or CDN the address this
process sees is the proxy's — so the limit belongs to whatever sits in front of
it, which is the hosting decision still open. Until one is in place, the edge
must rate-limit at least:

- `POST /v1/auth/challenge` — every request stores a challenge row until it
  expires and the hourly prune removes it, so an unlimited client grows the
  table as fast as it can send;
- WebSocket upgrades — each connection holds a socket and its subscriptions.

## Verifying a deployment

```bash
curl -fsS "http://HOST:$API_PORT/v1/health"          # process is up
curl -fsS "http://HOST:$API_PORT/v1/ready"           # a round is loaded
curl -fsS "http://HOST:$API_PORT/v1/rounds/current"  # five battles, real tickers

# Sign-in is reachable, and names the origin it is bound to (§45.2).
curl -fsS -X POST "http://HOST:$API_PORT/v1/auth/challenge"   -H 'content-type: application/json'   -d '{"wallet":"0x0000000000000000000000000000000000000001","chainId":CHAIN_ID}'
```

The first line of that message is `AUTH_ORIGIN`'s host. If it is not the host
players will be on, no signature they produce will be accepted.

Then open the client. The world view shows the round's five matchups and a
countdown; if it shows a preview instead, `VITE_API_URL` and `VITE_WS_URL` were
not set when the image was built — they are build arguments, not environment
variables, and rebuilding is the only way to change them.
