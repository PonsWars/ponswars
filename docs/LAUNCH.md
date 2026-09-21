# The road to launch

What stands between this repository and PonsWars live on Robinhood Chain
mainnet, in the order it has to happen — written for one person running it.

The game itself is built and tested. What remains is mostly **not code**: it is
decisions, money, keys, data that has to accumulate, and review by people
outside the project. [`OPEN_PARAMETERS.md`](OPEN_PARAMETERS.md) is the full
registry of every value still to be decided; this page is the path through it.

Each step says who moves it. **You** is the founder. **Claude** is work that can
be done in the repository without waiting on anyone.

## 1. Choose the infrastructure — you

Nothing past this step can start until these exist.

- [ ] **An RPC provider for Robinhood Chain** (`4663` mainnet, `46630` testnet).
      Needed for the market recorder, the chain reads and every contract call.
      One with a WebSocket endpoint and archive reads; ask for its rate limits
      in writing, because §23's feed-integrity rules void battles when data is
      late.
- [ ] **Hosting** for the server, PostgreSQL and Redis. [`operations/deployment.md`](operations/deployment.md)
      lists what a deployment consists of.
- [ ] **A funded deployer key on testnet.** Testnet gas only; it deploys and
      then holds nothing.

## 2. Deploy to testnet and run the whole thing — Claude, with your keys

[`operations/contract-deployment.md`](operations/contract-deployment.md) is the
procedure. This is the step most likely to surface real problems, because it is
the first time the pieces meet a real chain.

- [ ] Deploy `RewardsDistributor` and `SecretStockVault`; grant the roles.
- [ ] Run the full stack against testnet end to end: rounds, picks, a Genesis
      claim, a distribution published and claimed, a Secret reserved and
      claimed.
- [ ] Fix what it finds.

## 3. Let the market data accumulate — time

- [ ] **A week of recorded market tapes**, then calibrate the scoring values
      marked `CALIBRATE` against them. [`operations/market-calibration.md`](operations/market-calibration.md).
      This cannot be hurried: it is a week of the market being the market.

## 4. Have the contracts reviewed — you, with outside help

The two contracts hold real SPY and cannot be changed once deployed (§19).
Review before mainnet found one real flaw already: the distributor would
publish a distribution it could not pay, so one window's claims could be paid
from another's SPY. It is fixed, and it is the reason this step is not
optional.

- [ ] **An independent review.** A paid audit firm is the strongest option. A
      competitive audit contest is cheaper for a codebase this size (about 420
      lines of Solidity). At the very least, automated analysis (Slither,
      Aderyn) run and every finding answered in writing.

## 5. Decide the money and the law — you

- [ ] **Treasury values** in [`OPEN_PARAMETERS.md` §1](OPEN_PARAMETERS.md#1-launch-and-treasury-591-102):
      the creator-tax rate, the initial Rewards pool and Secret vault funding,
      the minimum claim threshold, the token addresses.
- [ ] **Compliance** in [`OPEN_PARAMETERS.md` §6](OPEN_PARAMETERS.md#6-compliance-595):
      permitted jurisdictions, terms and privacy text, geofencing and age
      controls, and how the Secret Stock Drop is treated. The rewards are
      tokenized stock, which is exactly the kind of thing a lawyer should see
      before players do.

## 6. Set up keys for one person — you

§20 requires a multisig for anything that touches the treasury, so that no
single hot key can move it. Running alone does not change that requirement; it
changes how it is met.

- [ ] **A 2-of-3 Safe**, owned by three keys you control on separate devices —
      for example two hardware wallets from different makers, and a third kept
      sealed offline as the backup. Any two can act, so losing one device loses
      nothing, and no single compromised machine can move funds.
- [ ] **The Safe holds `DEFAULT_ADMIN_ROLE`, `TREASURY_ROLE` and
      `DISTRIBUTION_PUBLISHER_ROLE`** on the contracts. Publishing is once a day
      and is already a human step, after the snapshot and the root have been
      verified; the publish job supports it directly — leave
      `DISTRIBUTION_PUBLISHER_KEY` unset and it prints the transaction to
      propose ([`operations/rewards-distribution.md`](operations/rewards-distribution.md#publishing)).
- [ ] **Hot keys only where the server has to act alone**, one per role, none of
      them the Safe's: the **Secret reserver**, because a Genesis reveal has to
      reserve its reward automatically before it is shown (§8.4); and the
      **pauser**, because it has to work at three in the morning.

**Why the publisher belongs on the Safe.** The rewards pool has to live in the
distributor: the rewards worker reads it from the distributor's uncommitted
balance at the snapshot (§16.3), and the Rewards page shows it to players from
there (§35.3). A stolen publisher key could publish a root paying that whole
uncommitted balance to the thief. With the role on the Safe there is no such
key to steal, and the pool can sit where the game needs it.

**What the remaining hot keys can reach.** The contracts guarantee that no
operational key can touch SPY already committed to a published distribution or
reserved for a Secret winner. Beyond that:

- a stolen **reserver** key can reserve Secrets for the thief's wallets, up to
  whatever the vault can cover — so:
- [ ] **Fund the Secret vault for a few Secrets at a time**, topped up from the
      Safe as they are claimed, rather than holding the whole budget.
- a stolen **pauser** key can pause claims. It cannot move anything, and the
  Safe, as admin, can revoke it.

## 7. Watch it without watching it — built; the rest is yours

A round opens every ten minutes, around the clock, and one person cannot watch
that. The system is built to fail safe on its own: a battle whose data fails the
integrity rules is voided and card uses are restored (§4.4, §110.6), and claims can be
paused without erasing anyone's entitlement. What it needs is to **tell you**
when something happened.

- [x] **Alerts from the server** — a round that will not finalize, battles
      voided, the Secret vault out of cover, and the server starting or
      stopping on an error. Each points at its runbook in [`operations/`](operations/).
- [ ] **Subscribe your phone.** Set `ALERT_WEBHOOK` to an ntfy topic with a long
      random name and subscribe to it in the ntfy app; choose
      `ALERT_ROUND_STUCK_AFTER_MS`. [`operations/deployment.md`](operations/deployment.md#alerts).
- [ ] **An uptime monitor outside the deployment**, pointed at `/v1/ready`. A
      server whose machine has gone away cannot say so; something elsewhere has
      to notice the silence.

## 8. Mainnet — you, with the Safe

- [ ] Deploy with the Safe as admin; propose the role grants from it.
- [ ] Fund the Secret vault, then the distributor.
- [ ] Open the first round.
