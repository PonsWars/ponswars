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
      nothing, and no single compromised machine can move funds. This Safe
      holds `DEFAULT_ADMIN_ROLE` and `TREASURY_ROLE` on both contracts.
- [ ] **Separate hot keys for the server**, one per role, none of them the
      Safe's: the distribution publisher, the Secret reserver, and the pauser.
      They can act without a hardware wallet in hand, which is the point — the
      pauser especially has to work at three in the morning — and none of them
      can move committed or reserved SPY, which the contracts guarantee.

## 7. Watch it without watching it — Claude, then you

A round opens every ten minutes, around the clock, and one person cannot watch
that. The system is built to fail safe on its own: a battle whose data fails the
integrity rules is voided and card uses are restored (§4.4, §110.6), and claims can be
paused without erasing anyone's entitlement. What it needs is to **tell you**
when something happened.

- [ ] Alerts to your phone for a round that will not finalize, market data that
      is degraded, a failed publication, and the Secret vault running out of
      cover. Each has a runbook in [`operations/`](operations/).

## 8. Mainnet — you, with the Safe

- [ ] Deploy with the Safe as admin; propose the role grants from it.
- [ ] Fund the Secret vault, then the distributor.
- [ ] Open the first round.
