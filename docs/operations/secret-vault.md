# Secret vault coverage

**Deciding sections:** §8.3 the coverage rule, §8.4 reservation before reveal,
§8.5 claim and trophy, §44.8 vault funding, §76 the RNG.

## The rule the whole thing rests on

> A user must never see a successful Secret reveal without secured reward
> coverage. (§8.4)

Everything below is in service of that one sentence. A player told they hold a
Secret Stock Drop the vault cannot pay has been told something false about
`0.2 SPY` of real money, and no amount of later remediation makes that not have
happened.

## Coverage is not the vault balance

```
availableSecretBalance = vaultBalance - reservedBalance
```

Reserved funds belong to winners who have not claimed yet. They are not
treasury, they are not available, and `SecretStockVault` will not let an admin
withdraw them (§8.5) — `withdrawAvailable` can only move `balance -
totalReserved`, and the contract tests cover it.

An operator reading the raw vault balance and concluding there is coverage is
the most likely way this goes wrong.

## When coverage runs out

This is **not an incident**. It is a designed state.

Below `0.2 SPY` of _available_ coverage, Secret is disabled automatically and
its `0.1%` probability is reassigned to Legendary — the distribution becomes
Legendary `2.0%`, Secret `0%` (§8.3). When coverage returns, normal `1.9%` /
`0.1%` resumes on its own.

Two things follow, and both matter:

- **No manual intervention is needed to disable it.** If you find yourself
  disabling Secret by hand, something else is wrong.
- **The rarity table version changes.** `RARITY_TABLE_SECRET_DISABLED` is
  recorded on the Genesis outcome (§76.3), so a card opened during a dormant
  period is auditable as such. Do not treat the two tables as interchangeable
  when investigating a fairness question.

With exactly `0.2 SPY` available, one final Secret may be reserved, after which
Secret goes dormant until the vault is refunded (§8.4).

## When a reservation fails

The order in §8.4 is not negotiable:

1. acquire the reservation lock
2. re-check coverage
3. create the on-chain entitlement
4. reserve exactly `0.2 SPY`
5. commit the Genesis result
6. **only then** reveal

A failure at any step before 6 means the player has not been told anything. The
reveal sequence holds at `SECURING REWARD` and never names the Secret — the
client cannot show one, because an unreserved reveal plan has no revealing step
to reach (`apps/web/src/genesis/reveal-sequence.ts`).

So a failed reservation is recoverable. Retry it. What is not recoverable is a
reveal that ran first.

The step-2 re-check exists for the concurrency case: two Secret results racing
for the last `0.2 SPY`. One wins the lock, reserves, and the other re-checks
into a vault with no coverage left. That second player's Genesis is not a
Secret — the RNG is re-evaluated against the disabled table, which is why the
table version is recorded.

## Refunding the vault

§44.8 governs funding. It is manual and deliberate.

After a refund, coverage returns and Secret reactivates automatically. Nothing
needs to be switched back on, and switching something on by hand risks
reactivating it against a balance that is not yet settled.

## When a winner claims

The trophy is permanent and stays on the profile after the claim (§34.8). It is
non-transferable and tied to the original Genesis wallet record.

A claim that fails on chain changes nothing about the entitlement — the reserved
`0.2 SPY` is still reserved, still unwithdrawable, and still theirs. The claim
flow returns to `READY_TO_CLAIM` and they try again (§35.6).

## What never happens

- **Reassigning a reservation.** Reserved funds cannot be allocated to another
  Secret winner (§8.5). The contract enforces it.
- **Revealing to "fix" a stuck reservation.** The reveal is the last step for a
  reason.
- **Changing the Secret amount.** `0.2 SPY` is fixed in V1 (§61 principle 7) and
  is a constructor value on the deployed vault.
- **Changing the odds without versioned disclosure.** §110.3 forbids it, and
  §76.3's recorded table version is what makes a change visible.
