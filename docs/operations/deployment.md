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

**More than one instance is allowed, and Redis is what makes it safe.** §21.3
gives Redis two jobs here and the server uses both:

- **The rounds lease.** Exactly one instance drives (§25). Each takes
  `ponswars:leader:rounds` with a ten-second expiry and renews it while it
  drives; the others wait, serving the API and the sockets. An instance that
  stops renewing — crashed, paused, partitioned — loses it, and another takes
  it within about the expiry. Losing it stops that driver at once: past the
  expiry another instance is entitled to drive, and two drivers racing into one
  finalization is the thing the lease exists to prevent. A failover resumes the
  round from its checkpoint (§25) rather than restarting it.
- **The event bus.** Every event is published to `ponswars:events` with its
  sequence taken from `INCR ponswars:seq:<channel>`, and every instance
  delivers it to its own connections. The sequence is Redis' rather than a
  process's because §70.1 promises it is monotonic per channel and §24 teaches
  clients to re-fetch on a gap: a counter per process would restart wherever
  the driver moved, and every client elsewhere would read that as a gap.

An instance that is not driving serves the round from the store, re-read once a
second, so it is at most a second behind on the phase; the ticks reach it on the
bus as they are published. Measured locally, a client on a non-driving instance
saw updates at 20 ms p50, and a killed leader was replaced — round resumed from
its checkpoint — inside twenty-five seconds.

Redis is not optional for the server: `REDIS_URL` is required, and a deployment
without it does not start. A single instance uses the same paths as five.

**The rewards windows need their job running.** §16.2 opens a 24-hour window
every 24 hours forever. `rewards-worker.js` in the server image does the
opening and the snapshot; calculating and publishing stay operator commands
with a verification in front of each (see
[Rewards distribution](rewards-distribution.md)). Without the job running,
nothing opens a window and no rewards accrue to one. The compose file runs it
as `rewards-worker`, from the same `.env`, and keeps its snapshot files in the
`snapshots` volume. Copy one out to verify it:

```bash
docker compose -f infra/containers/docker-compose.prod.yml   cp rewards-worker:/var/lib/ponswars/snapshots/snapshot-42.json .
node tools/verify-distribution.mjs snapshot-42.json
```

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

## The processes in the server image

One image, four entry points. Which of them a deployment runs is what its shape
is:

| Command                       | What it is                                         |
| ----------------------------- | -------------------------------------------------- |
| `node dist/main.js`           | The round driver, the REST API and the sockets     |
| `node dist/gateway.js`        | The realtime tier on its own (§48)                 |
| `node dist/migrate.js`        | The schema, run as a job before the rest (§49)     |
| `node dist/rewards-worker.js` | Opens and snapshots rewards windows (§16.2, §16.3) |

`node dist/main.js` is the whole game, and the compose file runs it beside
`node dist/rewards-worker.js`, which the rewards need. The two are the right
answer for one host.

### Running the realtime tier separately

The two halves do not grow together. `docs/operations/load-testing.md` measures
2,500 spectators against a few hundred sign-ins, §5 makes watching the normal
case, and watchers are the cheap half to add machines for. Fan-out also shares
an event loop with the round driver: with five hundred sign-ins in flight,
delivery held its rate but its tail went from 18 ms to 114 ms.

```bash
node dist/main.js --no-sockets     # driver and API; publishes to Redis
node dist/gateway.js               # sockets; delivers what the bus publishes
```

Several gateways can run at once, each delivering to its own connections. The
sequence a client sees comes from Redis rather than from any process (§70.1), so
two clients on two gateways read one number for one event. A gateway holds no
round state: it resolves who a connection is against the sessions table, and
`GET /v1/rounds/current` on the API is still where a snapshot comes from (§24).

It serves `/v1/health` on `GATEWAY_PORT`, the same port the upgrade arrives on,
so an ingress needs one route and an orchestrator that can only probe HTTP can
still tell whether the process is alive. Stopping it closes every connection
with WebSocket 1001, _going away_. The client reads that as a planned restart
rather than an outage: it does not climb its backoff ladder and does not tell
the player the world is offline, and it comes back inside a three-second window
chosen at random per client — because every connection is told at the same
instant, and a fleet that all waited the same time would arrive as one wall.

The compose file does not split them, deliberately. It is the one-host
reference, and on one host two processes and an ingress in front of them buy
nothing; where the split pays is more than one machine, which is the hosting
decision still open (§102).

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

## Alerts

`ALERT_WEBHOOK` says where the server reports what is wrong, and
`ALERT_ROUND_STUCK_AFTER_MS` when a round counts as stuck. Both are required;
`disabled` is a valid answer to the first and has to be written down.

For one person, `ntfy+https://ntfy.sh/<topic>` is the short path: install the
ntfy app, subscribe to the same topic, and critical alerts arrive as urgent
notifications. **The topic name is the password** — anyone who knows it can
read the alerts and post to it — so make it long and random, and treat the
variable as the secret it is marked as.

What is sent, and why only this: a round not finalized past the threshold
(critical, and again when it clears), battles voided in a round, the Secret
vault out of cover, and the server starting or stopping on an error. The
rewards worker adds its own start and failure, and a snapshot that is due and
cannot be taken. Every alert is also a line in the log, sent or not.

**What it cannot report is its own machine going away.** A process that has
lost its host, its network or its power sends nothing — which is exactly when
someone should hear about it. Point an uptime monitor outside the deployment at
`/v1/ready`. That, and not this, is what notices a server that is simply gone.

The rewards worker has no endpoint for a monitor to reach. A worker that fails
says so, but one killed outright — out of memory, `SIGKILL` — says nothing, and
shows only as a snapshot that never comes. Run it with a restart policy, so a
killed worker comes back and announces its start.

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

It also bounds **how often one client may sign in**, which is the request that
costs CPU rather than IO: verifying an EIP-4361 signature recovers a public key,
measured at 281 a second on one core (`docs/operations/load-testing.md`).
`AUTH_RATE_LIMIT_REQUESTS` per `AUTH_RATE_LIMIT_WINDOW_MS` is a token bucket
per client address, kept in Redis so every instance counts against the same one,
and spent by `POST /v1/auth/challenge` and `POST /v1/auth/verify` together — so
asking for challenges and never finishing them costs what signing in costs, and
the challenge table cannot be grown faster than the allowance. A caller over it
gets `429 RATE_LIMITED`, a `Retry-After` in seconds and a `retryAt` naming the
instant a token comes back. `AUTH_RATE_LIMIT_REQUESTS=0` turns it off, for a
deployment that limits at its edge instead.

**Set `API_TRUSTED_PROXIES` or the limit counts the wrong thing.** The bucket is
keyed by the client's address, and behind a load balancer or CDN the address
this process sees is the proxy's: with the list empty, every caller in the world
shares one bucket and the first one over it locks out everybody. List the
proxies — addresses, CIDR blocks, or the shorthands `loopback`, `linklocal`,
`uniquelocal` — and `X-Forwarded-For` is believed from those and nowhere else. A
deployment reached directly leaves it empty, which is also the right answer, and
the wrong answer in the other direction is trusting the header from anyone: a
caller can then invent an address per request and is never limited at all.

What the service still cannot bound is everything before it has a handler:
connection floods, WebSocket upgrades (each holds a socket and its
subscriptions), and traffic volume as such. Those belong to whatever sits in
front of it, which is the hosting decision still open (§102).

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
