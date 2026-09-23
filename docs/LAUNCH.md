# The road to launch

What stands between this repository and PonsWars live on Robinhood Chain
mainnet (`4663`), in the order it has to happen — written for one person running
it.

The game itself is built and tested. What remains is mostly **not code**: it is
decisions, money, keys, and review by people outside the project.
[`OPEN_PARAMETERS.md`](OPEN_PARAMETERS.md) is the full registry of every value
still to be decided; this page is the path through it.

Each step says who moves it. **You** is the founder. **Claude** is work that can
be done in the repository without waiting on anyone.

## Straight to mainnet

There is no testnet stage. The launch goes to mainnet directly, and what a
testnet run would have caught is caught three other ways instead:

1. **The game loop, locally** — `apps/local-stack` runs rounds, picks, results
   and War Points end to end on this machine, against a synthetic market. It
   reads no chain, so Genesis cards, `$WAR` balances and SPY payouts are not
   exercised there; the soft launch is where they are.
2. **The deployment, simulated against mainnet** — `forge script` without
   `--broadcast` runs every check of `Deploy.s.sol` and both deployments against
   the live chain and the real SPY token, and sends nothing (step 7).
3. **A private soft launch** — the real contracts and the real server on
   mainnet, lightly funded, played only by your own wallets until every flow has
   been through once (step 9).

**Not a local fork of mainnet.** `anvil --fork-url` cannot fork Robinhood Chain
today: its blocks carry no blob-gas fields, which anvil (1.8.1) requires from
Cancun on, and on an older hardfork the SPY token's own calls revert. Checked on
2026-09-21. Revisit when Foundry supports Arbitrum chains' headers.

## 1. Choose the infrastructure — you

Nothing past step 7 can start until these exist.

- [ ] **An RPC provider for Robinhood Chain mainnet.** Needed for the market
      recorder, the chain reads and every contract call. One with a WebSocket
      endpoint and archive reads; ask for its rate limits in writing, because
      §23's feed-integrity rules void battles when data is late. The public
      endpoint throttles hard and is not for production.
- [ ] **Hosting** for the server, the rewards worker, PostgreSQL, Redis and the
      web client. [`operations/deployment.md`](operations/deployment.md) lists
      what a deployment consists of.
- [ ] **A domain**, and the web origin it serves from (`WEB_ORIGINS`).
- [ ] **A deploying key with a little mainnet ETH.** The simulation on
      2026-09-21 estimated **0.000213 ETH** for both contracts; hold a few times
      that. The key is given no role, and holds nothing once deployed.

## 2. Calibrate the market — Claude

- [ ] **Replay the recorded tapes** and choose the values marked `CALIBRATE`.
      [`operations/market-calibration.md`](operations/market-calibration.md).
      A week of tapes (from 2026-09-15) was recorded through the public
      endpoint; record again through the chosen vendor before launch, because a
      throttled endpoint's lag is part of what the tapes measure.

## 3. Have the contracts reviewed — you, with outside help

The two contracts hold real SPY and cannot be changed once deployed (§19).
Review before mainnet found one real flaw already: the distributor would
publish a distribution it could not pay, so one window's claims could be paid
from another's SPY. It is fixed, and it is the reason this step is not
optional — and without a testnet stage it matters more, not less.

- [x] **Automated analysis run**, and what it found written down:
      [`security/contract-analysis.md`](security/contract-analysis.md). Slither
      reports three naming conventions and nothing else; `forge lint` reports
      nothing. That is a floor, not a review — the one real flaw these contracts
      had was found by reading them, and no tool reports it even now.
- [ ] **An independent review.** A paid audit firm is the strongest option. A
      competitive audit contest is cheaper for a codebase this size (440 lines
      of Solidity).

## 4. Decide the money and the law — you

- [ ] **Treasury values** in [`OPEN_PARAMETERS.md` §1](OPEN_PARAMETERS.md#1-launch-and-treasury-591-102):
      the creator-tax rate, the initial Rewards pool and Secret vault funding,
      the minimum claim threshold.
- [ ] **Compliance** in [`OPEN_PARAMETERS.md` §6](OPEN_PARAMETERS.md#6-compliance-595):
      permitted jurisdictions, terms and privacy text, geofencing and age
      controls, and how the Secret Stock Drop is treated. The rewards are
      tokenized stock, which is exactly the kind of thing a lawyer should see
      before players do.

## 5. Set up keys for one person — you

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

## 6. Launch $WAR on Pons — you

The server cannot start without it: `WAR_TOKEN_ADDRESS` and
`WAR_TOKEN_DECIMALS` are required configuration, and Genesis eligibility reads a
wallet's `$WAR` balance against the 1,000,000 threshold (§6). So the token comes
**before** the server goes live, not after.

- [ ] Launch `$WAR` on the Pons launchpad.
- [ ] Record its address and decimals — read the decimals from the token, never
      assume 18 — in the deployment's configuration.

The contracts do not depend on `$WAR` (they pay SPY), so steps 7 and 8 can run
before it exists; only the server waits for it.

## 7. Simulate the deployment against mainnet — Claude, with your addresses

[`operations/contract-deployment.md`](operations/contract-deployment.md) is the
procedure. Run it without `--broadcast` first, with the Safe as `DEPLOY_ADMIN`:
that runs every check against the live chain and the real SPY token and sends
nothing.

- [x] Dry run on 2026-09-21 against the public endpoint, with a placeholder
      admin: the chain check, the SPY token and its 18 decimals, and both
      deployments passed; the Secret reward came out as `2e17` base units (0.2
      SPY); estimated cost 0.000213 ETH.
- [ ] The same dry run with the real Safe address as admin.

## 8. Deploy — you, with the Safe

- [ ] Deploy with the Safe as admin; commit `contracts/deployments/4663.json`.
- [ ] Propose the role grants from the Safe (step 5).
- [ ] Fund the Secret vault for a few Secrets; fund the distributor with the
      first pool.

## 9. Soft launch in private — you, with Claude

The mainnet stand-in for a testnet run: real contracts, real server, real
market, before anybody is told.

- [ ] Start the server and the rewards worker against mainnet with the chosen
      vendor, the deployed addresses and `$WAR`.
- [ ] With your own wallets, go through every flow once: rounds finalize, a pick
      and a card use, a Genesis claim, a distribution snapshotted, published
      from the Safe and claimed, a Secret reserved and claimed.
- [ ] Fix what it finds. Anything wrong in the contracts means new contracts at
      new addresses (§19) — which is why the funding stays small until here.

## 10. Watch it without watching it — built; the rest is yours

A round opens every ten minutes, around the clock, and one person cannot watch
that. The system is built to fail safe on its own: a battle whose data fails the
integrity rules is voided and card uses are restored (§4.4, §110.6), and claims can be
paused without erasing anyone's entitlement. What it needs is to **tell you**
when something happened.

- [x] **Alerts from the server** — a round that will not finalize, battles
      voided, the Secret vault out of cover, a rewards snapshot that is due and
      failing, and either process stopping on an error. Each points at its
      runbook in [`operations/`](operations/).
- [ ] **Subscribe your phone.** Set `ALERT_WEBHOOK` to an ntfy topic with a long
      random name and subscribe to it in the ntfy app; choose
      `ALERT_ROUND_STUCK_AFTER_MS`. [`operations/deployment.md`](operations/deployment.md#alerts).
- [ ] **An uptime monitor outside the deployment**, pointed at `/v1/ready`. A
      server whose machine has gone away cannot say so; something elsewhere has
      to notice the silence.

## 11. Open to players — you

- [ ] Announce, and let the first public round open.
