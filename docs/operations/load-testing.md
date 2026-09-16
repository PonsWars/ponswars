# Load testing the transport

**Deciding sections:** §5 spectating is the normal case, §21.3 services, §23.1
one tick a second, §48 realtime channels, §102 hosting is `OPEN`.

The load that matters is not picks. §5 makes PonsWars fully watchable without a
wallet, and §23.1 publishes a tick a second for each of five battles: the
transport's job is fanning ~5 updates a second out to every connection, and the
snapshot fetch each one makes on the way in.

```bash
pnpm run local
```

```bash
node tools/load-test.mjs --clients 1000 --seconds 60 --ramp-ms 15000
```

Each simulated spectator fetches `GET /v1/rounds/current`, opens a socket and
subscribes to the world, the round and all five battles — what the web client
does. The report gives the snapshot fetch and the update delivery at p50, p90
and p99, updates received against the rate they should arrive at, and every
socket that closed, errored or was refused.

`--pickers <n>` adds the write path: that many throwaway wallets sign the
EIP-4361 challenge with a real key, exchange it for a session and back a battle
— the same three requests a player makes, through the same verification.
Nothing is forged, so it measures a path a player can take, and the keys are
generated per run and hold nothing. Picks are only accepted during Pick Phase
(§3.2); a run during a battle reports them refused, which is the server being
right rather than the test being wrong.

```bash
node tools/load-test.mjs --clients 200 --pickers 500 --seconds 40
```

**Run it during a battle.** Nothing publishes during Pick Phase, so a minute of
load there reports zero updates and proves nothing. `--seconds 70` from a cold
start covers the lock.

## Measured, so there is a number to argue with

One `pnpm run local` process — round driver, API and gateway together, in-memory
store, synthetic market — on a developer laptop, with the market recorder
running beside it:

| Spectators | Updates/s | Snapshot fetch p50/p99 | Delivery p50/p99 | Losses |
| ---------- | --------- | ---------------------- | ---------------- | ------ |
| 200        | 1,000     | 4 ms / 19 ms           | 9 ms / 18 ms     | none   |
| 1,000      | 5,000     | 15 ms / 46 ms          | 36 ms / 74 ms    | none   |
| 2,500      | 12,500    | 15 ms / 134 ms         | 80 ms / 182 ms   | none   |

Delivery is measured from the `serverTime` the engine stamped on the tick to
the instant the client parsed it, so on one machine it is a real figure and
across a network it is a lower bound.

The write path, on the same process:

| Concurrent sign-ins | Sign-in p50/p99 | Pick p50/p99    | Refused |
| ------------------- | --------------- | --------------- | ------- |
| 50                  | 229 ms / 336 ms | 101 ms / 184 ms | none    |
| 500                 | 1.53 s / 2.56 s | 0.95 s / 1.51 s | none    |

**Signing in is the expensive request, and it is CPU.** Verifying an EIP-4361
signature recovers a public key: measured at 281 a second on one core of this
machine. A round opens every ten minutes and Pick Phase is sixty seconds
(§3.1), so everyone who opens the app at a boundary signs in inside the same
minute.

That work now runs on threads (`workerRecovery`, wired into the server and the
local stack), which took recovery to 1,502 a second on eight of twelve cores —
5.3×. The table above is from before that landed; what it changed most is not
sign-in itself but everything queued behind it. With five hundred sign-ins in
flight, a pick went from 949 ms to 113 ms at p50, because the event loop was no
longer doing elliptic-curve arithmetic between requests.

Two things still follow for capacity: count sign-ins per round open rather than
players, and put the API behind more than one process before that number gets
into the thousands.

**Sign-in load pushes the tick tail, not the tick rate.** With five hundred
sign-ins running through a live battle, updates still went out at the full
rate to two hundred spectators and delivery held at 10 ms p50 — but p99 went
from 18 ms to 114 ms. Nothing was dropped and no tick was skipped. §13.2
interpolates over 3–5 seconds, so it does not show; it is the thing to watch
if the API and the round driver ever share a process in production.

What the numbers say, and do not:

- **Delivery grows with fan-out, and nothing is dropped.** At 2,500 spectators
  one process was still publishing every tick to every connection, ~180 ms
  behind at the tail. §13.2 interpolates the frontline over 3–5 seconds, so
  that is well inside what a player can see.
- **They are one process on a laptop.** A deployment runs the gateway
  separately (`apps/gateway`), on hardware nobody has chosen yet (§102), and
  the useful number is the one measured there before launch.
- **They say nothing about the database.** The local stack keeps rounds in
  memory. A run against PostgreSQL measures finalization, which is the other
  half of a launch-capacity question.

## What to watch while it runs

- **`Refused subs`** — a connection that hit `TOO_MANY_SUBSCRIPTIONS` (the
  gateway caps subscriptions per connection). The test follows seven channels,
  so this should be zero; if it is not, the cap moved.
- **`Errors`** — closures with a code. A server dropping connections under load
  shows up here rather than as a slower percentile.
- **Updates against the rate** — at _n_ clients the run should see about
  `5 × n` a second while a battle is live. A shortfall means some connections
  stopped receiving, which is the failure worth finding before players do.
