# Incident runbooks

What to do when something goes wrong, and — more often the point — what not to
do.

These exist because the expensive failures in PonsWars are not crashes. A crash
is loud. The expensive ones are quiet: a round that finalizes on data it should
have voided on, a Secret revealed before the vault could cover it, a
distribution root published from a snapshot taken at the wrong moment. Each of
those looks like the system working.

Every runbook is written against the masterplan section that decides the answer,
because in an incident the temptation is to decide it fresh.

| Runbook                                             | When                                                           |
| --------------------------------------------------- | -------------------------------------------------------------- |
| [Market data degraded or lost](feed-degradation.md) | The feed is late, stale, or gone                               |
| [A round will not finalize](round-stuck.md)         | A round is past its cutoff and still not final                 |
| [Secret vault coverage](secret-vault.md)            | The vault cannot cover another Secret, or a reservation failed |
| [Rewards distribution](rewards-distribution.md)     | Snapshot, calculation, publication, claims                     |
| [A disputed result](disputed-result.md)             | Someone says a battle was scored wrongly                       |
| [A compromised session](compromised-session.md)     | A session is being used by somebody it does not belong to      |

Deploying rather than repairing: [Deploying PonsWars](deployment.md) — what a
deployment consists of, and what is still open before it can finish a round.

## Three rules that outrank any runbook

**1. Degrade or void; never fabricate.** §61 principle 19. If required data is
missing or invalid, the battle voids. A voided battle costs a round; an invented
result costs the thing the product is for. A VOID refunds the deployed card and
records no loss (§4.4, §11) — it is not a punishment, and treating it as one is
what tempts an operator to avoid it.

**2. A published root is immutable.** §17. Once a distribution's Merkle root is
on chain, no allocation in it can be edited, and the contract will not let you.
An error found after publication is corrected in the _next_ window, never by
rewriting this one.

**3. A finalized result is immutable.** §25. Finalization is exactly-once. If a
result is wrong, the answer is an investigation and a disclosed correction —
never a re-finalization, which the round state machine refuses anyway.

## Before you act

- **Reproduce it.** Every round is replayable from its recording
  (`simulations/src/replay.ts`, §26). A theory that does not survive a replay is
  a theory.
- **Write down the round or distribution id first.** Ids are how the evidence is
  found later, and they are the first thing lost in an incident.
- **Check whether the system already handled it.** Most degradation paths are
  automatic. Intervening in one that was working is its own incident.

## What is not decided here

Alerting thresholds, on-call rotation, dashboards, backup cadence and hosting
all depend on infrastructure choices still marked `OPEN` in
[`../OPEN_PARAMETERS.md`](../OPEN_PARAMETERS.md). §102 forbids inventing an
`OPEN` value and shipping it as policy, so these runbooks describe decisions and
sequences rather than naming a paging tool or a retention period.
