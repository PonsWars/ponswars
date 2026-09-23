# Automated analysis of the contracts

**Deciding sections:** §19 contract principles, §20 roles and multisig.
Launch step: [`LAUNCH.md` §3](../LAUNCH.md#3-have-the-contracts-reviewed--you-with-outside-help).

Two contracts, 440 lines, non-upgradeable, holding real SPY. This page is what
the automated tools say about them, so that an outside reviewer starts where
the tools stop rather than repeating them.

**It is not the review.** Static analysis finds known shapes. The one real flaw
found in these contracts so far — the distributor would publish a distribution
it could not pay, so one window's claims could be paid from another's SPY — was
found by reading them, and no tool here reports it even now that it is known
what to look for. §19 makes a mistake permanent; `LAUNCH.md` §3 still stands.

## Running them

```bash
pip install --user slither-analyzer
python -m slither . --filter-paths "node_modules|contracts/test|lib" --exclude-dependencies
```

```bash
forge lint contracts/src
```

Slither compiles through Foundry, so `forge` must be on the PATH. Filtering the
paths keeps OpenZeppelin, the tests and `lib/` out of the report: findings in a
dependency are a decision about the dependency, and the tests deliberately do
things the contracts must survive.

## What they said — 2026-09-23

| Tool                         | Findings                                   |
| ---------------------------- | ------------------------------------------ |
| Slither 0.11.6               | 3, all `naming-convention`, all deliberate |
| `forge lint` (Foundry 1.8.1) | none on `contracts/src`                    |

Slither's three:

```
Variable RewardsDistributor.REWARD_TOKEN is not in mixedCase
Variable SecretStockVault.REWARD_TOKEN is not in mixedCase
Variable SecretStockVault.REWARD_AMOUNT is not in mixedCase
```

All three are `immutable`, set once at construction and never again, and named
the way a constant is named because that is what they are to every caller: the
reward token and the fixed 0.2 SPY reward. Renaming them to `rewardToken` would
read as ordinary storage that something might change.

102 detectors ran. Nothing else was reported: no reentrancy, no unchecked
return, no arbitrary `from`, no uninitialised state, no shadowing, no
unprotected function.

`forge lint` reports nothing in `contracts/src`. It does report two style notes
in `contracts/script/Deploy.s.sol` — a state variable that could be constant and
an internal function used once — which are the deploy script's, not the
contracts'.

## Aderyn

Not run. `cargo install aderyn` fails to resolve its dependencies on this
machine (`error: key with no value, expected =`, aderyn 0.1.9). Recorded so the
next person does not spend the time again; it is worth another try from a
release binary before the outside review.
