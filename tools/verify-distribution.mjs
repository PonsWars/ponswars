#!/usr/bin/env node
/**
 * Recomputes a distribution and checks it before the root is published.
 *
 * The tool the rewards runbook assumes exists
 * (`docs/operations/rewards-distribution.md`, "Between calculation and
 * publication"). That window is the only one where an error is cheap: §17 makes
 * a published root immutable and the contract will not let anyone edit it
 * afterwards.
 *
 *   node tools/verify-distribution.mjs <snapshot.json>
 *   node tools/verify-distribution.mjs <snapshot.json> --expect-root <hash>
 *
 * The snapshot is what the window is calculated *from*, never what it produced:
 *
 *   {
 *     "distributionId": 42,
 *     "poolBalance": "12400000",      // base units, as a decimal string
 *     "minimumClaim": "1000",
 *     "standings": [{ "wallet": "0x...", "windowWarPoints": 84 }]
 *   }
 *
 * Everything below is derived. A snapshot carrying allocations could "verify"
 * them by handing them back, which is the same trap the round recording avoids.
 *
 * Plain ESM run directly by node. It imports compiled output, so run
 * `pnpm run build` first.
 */

import { readFile } from 'node:fs/promises';
import { argv, exit, stderr, stdout } from 'node:process';

const USAGE = `Usage: node tools/verify-distribution.mjs <snapshot.json> [--expect-root <hash>]`;

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

const args = argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  stdout.write(`${USAGE}\n`);
  exit(args.length === 0 ? 1 : 0);
}

const path = args[0];
let expectedRoot = null;
for (let index = 1; index < args.length; index += 1) {
  if (args[index] !== '--expect-root') {
    fail(`Unrecognised argument ${args[index]}.\n${USAGE}`);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`--expect-root needs a value.\n${USAGE}`);
  }
  expectedRoot = value;
  index += 1;
}

const rewards = await import('../packages/rewards-math/dist/index.js').catch(() => {
  fail('Could not load the rewards module. Run `pnpm run build` first.');
});
const shared = await import('../packages/shared-types/dist/index.js').catch(() => {
  fail('Could not load shared types. Run `pnpm run build` first.');
});

const { allocateDistribution, buildMerkleTree, verifyProof } = rewards;
const { MIN_QUALIFYING_WP, PER_WALLET_CAP_BPS, POOL_DISTRIBUTABLE_BPS } = shared;

let snapshot;
try {
  snapshot = JSON.parse(await readFile(path, 'utf8'));
} catch (error) {
  fail(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
}

for (const field of ['distributionId', 'poolBalance', 'minimumClaim', 'standings']) {
  if (!(field in snapshot)) {
    fail(`Snapshot is missing ${field}.`);
  }
}
if (!Array.isArray(snapshot.standings) || snapshot.standings.length === 0) {
  fail('Snapshot has no standings, so there is nothing to distribute.');
}
if ('allocations' in snapshot) {
  // A snapshot is an input. One carrying results would let this tool "verify"
  // numbers it was handed rather than numbers it derived.
  fail('Snapshot carries allocations. It must contain only what the window is calculated from.');
}

const result = allocateDistribution({
  poolBalance: BigInt(snapshot.poolBalance),
  minimumClaim: BigInt(snapshot.minimumClaim),
  standings: snapshot.standings,
});

const claimable = result.allocations.filter((allocation) => allocation.amount > 0n);

stdout.write(`distribution   #${String(snapshot.distributionId).padStart(3, '0')}\n`);
stdout.write(`pool           ${snapshot.poolBalance}\n`);
stdout.write(`distributable  ${result.distributable}  (${POOL_DISTRIBUTABLE_BPS / 100}%)\n`);
stdout.write(`allocated      ${result.totalAllocated}\n`);
stdout.write(`carried        ${result.carriedForward}\n`);
stdout.write(`qualified      ${result.allocations.length}  (floor ${MIN_QUALIFYING_WP} WP)\n`);
stdout.write(`unqualified    ${result.unqualifiedWalletCount}\n`);
stdout.write(`capped         ${result.cappedWalletCount}  (cap ${PER_WALLET_CAP_BPS / 100}%)\n`);
stdout.write(`claimable      ${claimable.length}  (rest carried forward)\n\n`);

const problems = [];

// §16.3: allocated plus carried is the whole pool. Nothing is created, nothing
// is lost — the invariant the simulation asserts, restated here against the
// numbers actually about to be published.
if (result.totalAllocated + result.carriedForward !== BigInt(snapshot.poolBalance)) {
  problems.push(
    `conservation: allocated ${result.totalAllocated} + carried ${result.carriedForward} ` +
      `is not the pool ${snapshot.poolBalance}`,
  );
}

// §16.4: a wallet below the floor is absent, not present with zero.
for (const allocation of result.allocations) {
  if (allocation.windowWarPoints < MIN_QUALIFYING_WP) {
    problems.push(`${allocation.wallet}: below the ${MIN_QUALIFYING_WP} WP floor but allocated`);
  }
}

// §16.6: no wallet takes more than the cap of the distributable amount.
const capLimit = (result.distributable * BigInt(PER_WALLET_CAP_BPS)) / 10_000n;
for (const allocation of result.allocations) {
  if (allocation.amount > capLimit) {
    problems.push(`${allocation.wallet}: ${allocation.amount} exceeds the cap ${capLimit}`);
  }
}

if (claimable.length === 0) {
  stdout.write('No wallet is above the minimum claim threshold; there is no tree to build.\n');
} else {
  const tree = buildMerkleTree(BigInt(snapshot.distributionId), claimable);
  stdout.write(`root           ${tree.root}\n`);
  stdout.write(`committed      ${tree.total}\n\n`);

  if (tree.total !== claimable.reduce((sum, entry) => sum + entry.amount, 0n)) {
    problems.push('tree total does not equal the sum of its claims');
  }

  // Every proof is checked, not a sample. A tree that verifies for most wallets
  // is a tree that will fail for someone, and they will be the one who cannot
  // claim.
  const bad = tree.claims.filter((claim) => !verifyProof(claim.leaf, claim.proof, tree.root));
  if (bad.length > 0) {
    problems.push(`${bad.length} claim(s) do not verify against the root`);
  } else {
    stdout.write(`every one of ${tree.claims.length} proofs verifies against the root\n\n`);
  }

  if (expectedRoot !== null && tree.root !== expectedRoot) {
    problems.push(`root ${tree.root} does not match the expected ${expectedRoot}`);
  }
}

if (problems.length > 0) {
  stderr.write(`FAILED — ${problems.length} problem(s). Do not publish.\n`);
  for (const problem of problems) {
    stderr.write(`  ${problem}\n`);
  }
  exit(1);
}

stdout.write('OK — recomputed cleanly. Safe to publish.\n');
