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

**A deployment can open a round today. It cannot finish one.**

§13.6 makes the finalization tiebreak depend on a finalized block hash, and the
RPC vendor is an `OPEN` decision (`docs/OPEN_PARAMETERS.md` §1). The server has
no chain client, so its chain port rejects rather than returning a constant — a
predictable tiebreak is worse than a failed finalization, because a failed one
gets looked at. The consequence is exactly what it sounds like: the driver
raises at the first finalization and the process exits non-zero.

That is the last thing blocking a first live round. The others matter but do not
stop one:

| Decision           | Effect until it is made                                           |
| ------------------ | ----------------------------------------------------------------- |
| Chain RPC (§59.3)  | **No round can finalize.** The driver fails and the process exits |
| Market data (§102) | Prices are synthetic; the banner says so on every start           |
| Redis (§21.3)      | `REDIS_URL` is required and validated but nothing reads it yet    |

Authentication is no longer on that list. §45.2 is built: a wallet signs an
EIP-4361 challenge, the signature is verified, and the session that comes back
lives in PostgreSQL so it survives a deploy and can be revoked. What a
deployment has to decide is how long a challenge and a session last — both are
`OPEN` (`docs/OPEN_PARAMETERS.md` §4) and both are required at startup.

One limitation worth knowing before somebody reports it as a bug: a
smart-contract wallet cannot sign in. EIP-1271 verification is a call to the
wallet's own contract, which needs the chain client that does not exist yet, so
a signature that does not recover to the expected address is refused. That is
the same open decision as the tiebreak, arriving in a second place.

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
