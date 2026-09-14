# Deploying the contracts

**Deciding sections:** §17 rewards distribution, §18 the Secret vault, §19
contract principles, §20 roles and multisig.

Two contracts, deployed once per network: `RewardsDistributor` pays the 24-hour
distributions against published Merkle roots, and `SecretStockVault` holds and
pays the fixed Secret reward. Both are non-upgradeable (§19). A mistake is fixed
by deploying new contracts, not by editing these — so the checks happen before
anything is sent.

## Before you start

| You need                     | Why                                                                   |
| ---------------------------- | --------------------------------------------------------------------- |
| The admin address            | Receives `DEFAULT_ADMIN_ROLE` on both. A multisig in production (§20) |
| The SPY token address        | The reward token, on the same Robinhood Chain network                 |
| SPY's decimals               | Read them from the token; the script checks, and refuses a mismatch   |
| A deploying key with gas ETH | Any key. It is given **no role** — once deployed, it holds no power   |
| Foundry                      | `forge` and `cast`, from https://getfoundry.sh                        |

`--rpc-url robinhood_testnet` and `robinhood` are Robinhood's public endpoints,
set in `foundry.toml`. Pass a vendor's URL instead when one is chosen.

Keep the deploying key in a Foundry keystore (`cast wallet import`), not on the
command line: a `--private-key` argument lands in shell history.

## Deploy

From the repository root, testnet first:

```bash
DEPLOY_ADMIN=0x… SPY_TOKEN_ADDRESS=0x… SPY_TOKEN_DECIMALS=18 \
  forge script contracts/script/Deploy.s.sol \
  --rpc-url robinhood_testnet --broadcast --account deployer
```

Run it once without `--broadcast` first. That simulates every check and both
deployments against the live network and sends nothing.

The script stops before sending anything when:

- the RPC endpoint is not Robinhood Chain mainnet (4663) or testnet (46630);
- `DEPLOY_ADMIN` or `SPY_TOKEN_ADDRESS` is the zero address;
- there is no token at `SPY_TOKEN_ADDRESS`, or its decimals are not
  `SPY_TOKEN_DECIMALS` — the Secret reward is `0.2 SPY` fixed in base units at
  construction, and cannot be corrected afterwards.

A broadcast writes `contracts/deployments/<chainId>.json`: the two addresses,
the admin, the token and the Secret reward in base units. Commit it. The
server's `REWARDS_DISTRIBUTOR_ADDRESS` and `SECRET_STOCK_VAULT_ADDRESS` come from
it, and it is the record of which contracts a network runs.

## Check what landed

```bash
cast call <vault> 'REWARD_AMOUNT()(uint256)' --rpc-url robinhood_testnet
cast call <distributor> 'REWARD_TOKEN()(address)' --rpc-url robinhood_testnet
cast call <distributor> 'hasRole(bytes32,address)(bool)' \n  0x0000000000000000000000000000000000000000000000000000000000000000 <admin> --rpc-url robinhood_testnet
```

`REWARD_AMOUNT` is `0.2 × 10^decimals`. The admin holds the all-zero admin role;
the deploying key holds nothing.

## Grant the operational roles

Only the admin can grant. On testnet, with the admin as a key:

```bash
REWARDS_DISTRIBUTOR_ADDRESS=0x… SECRET_STOCK_VAULT_ADDRESS=0x… \
DISTRIBUTION_PUBLISHER=0x… PAUSER=0x… TREASURY=0x… \
  forge script contracts/script/GrantRoles.s.sol \
  --rpc-url robinhood_testnet --broadcast --account admin
```

In production the admin is a multisig. Propose the same grants there as
`grantRole(role, account)` calls; the role ids are `cast keccak <ROLE_NAME>`.

Each role is optional, and an unset one is granted to nobody:

| Role                          | On                   | Held by                                          |
| ----------------------------- | -------------------- | ------------------------------------------------ |
| `DISTRIBUTION_PUBLISHER_ROLE` | `RewardsDistributor` | Whoever publishes the daily root                 |
| `RESERVER_ROLE`               | `SecretStockVault`   | The Genesis service — **only once it holds it**  |
| `PAUSER_ROLE`                 | both                 | The incident responder                           |
| `TREASURY_ROLE`               | both                 | The treasury multisig; withdraws uncommitted SPY |

**Grant `SECRET_RESERVER` only to the key the server runs with**, set as its
`SECRET_RESERVER_KEY` ([Turning Secret on](secret-vault.md)). A reserver the
Genesis service does not control is a key that can promise vault SPY to wallets
for no reason.

## What never happens

- The deploying key is never the admin in production. It needs no power after
  the transactions land, so it is given none.
- A deployment is never "fixed" by redeploying over a live one. Published roots
  and reservations stay with the contract that holds them; a new deployment is a
  new address, announced as such.
