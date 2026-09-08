#!/usr/bin/env node
/**
 * Recomputes a wallet's Genesis outcome from the inputs that produced it.
 *
 * The tool the disputed-result runbook assumes exists
 * (`docs/operations/disputed-result.md`, "A disputed Genesis outcome"). §45.4
 * governs RNG integrity and §76 the derivation; this is how someone checks a
 * specific claim rather than being asked to trust it.
 *
 *   node tools/audit-genesis.mjs <record.json>
 *
 * The record is what the draw was made *from*, plus what was recorded, so the
 * two can be compared:
 *
 *   {
 *     "finalizedBlockHash": "0x…",
 *     "wallet": "0x…",
 *     "requestId": "…",
 *     "secretAvailable": true,
 *     "recorded": { "slot": 412_337, "rarity": "RARE", "cardType": "BULL_RUN" }
 *   }
 *
 * `recorded` is optional. Without it the outcome is printed; with it, the
 * recomputation is compared and a mismatch exits non-zero.
 *
 * Two things this checks that are easy to miss by hand, both named in the
 * runbook: which rarity table was in force, and that card selection draws from
 * its own stream (§76.4) rather than from the rarity roll.
 *
 * Plain ESM run directly by node. It imports compiled output, so run
 * `pnpm run build` first.
 */

import { readFile } from 'node:fs/promises';
import { argv, exit, stderr, stdout } from 'node:process';

const USAGE = `Usage: node tools/audit-genesis.mjs <record.json>`;

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

const args = argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  stdout.write(`${USAGE}\n`);
  exit(args.length === 0 ? 1 : 0);
}
if (args.length > 1) {
  fail(`Unrecognised argument ${args[1]}.\n${USAGE}`);
}

const math = await import('../packages/battle-math/dist/index.js').catch(() => {
  fail('Could not load the battle-math module. Run `pnpm run build` first.');
});
const shared = await import('../packages/shared-types/dist/index.js').catch(() => {
  fail('Could not load shared types. Run `pnpm run build` first.');
});

const { resolveGenesis, initialUsesFor, RARITY_TABLE_FUNDED, RARITY_TABLE_SECRET_DISABLED } = math;
const { RARITY_RATE_BPS, RARITY_RATE_BPS_SECRET_DISABLED, CARD_CATALOG } = shared;

let record;
try {
  record = JSON.parse(await readFile(args[0], 'utf8'));
} catch (error) {
  fail(`Could not read ${args[0]}: ${error instanceof Error ? error.message : String(error)}`);
}

for (const field of ['finalizedBlockHash', 'wallet', 'requestId', 'secretAvailable']) {
  if (!(field in record)) {
    fail(`Record is missing ${field}.`);
  }
}
if (typeof record.secretAvailable !== 'boolean') {
  // §8.3 makes coverage a fact about the vault at commit time, and the same
  // slot yields a different rarity depending on it. A missing or fuzzy value
  // here would silently audit against the wrong table.
  fail('secretAvailable must be true or false — it decides which rarity table applies.');
}

const input = {
  finalizedBlockHash: record.finalizedBlockHash,
  wallet: record.wallet,
  requestId: record.requestId,
};

let outcome;
try {
  outcome = resolveGenesis(input, record.secretAvailable);
} catch (error) {
  fail(`Could not recompute: ${error instanceof Error ? error.message : String(error)}`);
}

const table = record.secretAvailable ? RARITY_RATE_BPS : RARITY_RATE_BPS_SECRET_DISABLED;
const expectedVersion = record.secretAvailable ? RARITY_TABLE_FUNDED : RARITY_TABLE_SECRET_DISABLED;

stdout.write(`wallet         ${record.wallet}\n`);
stdout.write(`request        ${record.requestId}\n`);
stdout.write(`seed           ${outcome.seed}\n`);
stdout.write(`slot           ${outcome.slot} of 1000000\n\n`);
stdout.write(`rarity         ${outcome.rarity}\n`);
stdout.write(`card           ${CARD_CATALOG[outcome.cardType]?.name ?? outcome.cardType}\n`);
stdout.write(`uses           ${initialUsesFor(outcome.cardType)}\n\n`);

// The runbook's first "easy to miss": a card opened while the vault was dormant
// was drawn against a different table, and it is auditable as such.
stdout.write(`secret funded  ${record.secretAvailable ? 'yes' : 'no'}\n`);
stdout.write(`rarity table   ${outcome.rarityTableVersion}\n`);
if (outcome.rarityTableVersion !== expectedVersion) {
  fail(`Table version ${outcome.rarityTableVersion} disagrees with coverage ${expectedVersion}.`);
}
stdout.write(`               SECRET ${(table.SECRET / 100).toFixed(2)}%`);
stdout.write(`, LEGENDARY ${(table.LEGENDARY / 100).toFixed(2)}%\n\n`);

if (!('recorded' in record)) {
  stdout.write('No recorded outcome supplied, so there is nothing to compare against.\n');
  exit(0);
}

const recorded = record.recorded;
const mismatches = [];
for (const field of ['slot', 'rarity', 'cardType']) {
  if (!(field in recorded)) {
    fail(`recorded is missing ${field}.`);
  }
  if (recorded[field] !== outcome[field]) {
    mismatches.push(
      `${field}: recorded ${String(recorded[field])}, recomputed ${String(outcome[field])}`,
    );
  }
}

if (mismatches.length > 0) {
  // A Genesis that does not recompute is a larger incident than the complaint
  // that surfaced it: §45.4 makes the RNG auditable precisely so this answer is
  // a fact rather than an assurance.
  stderr.write(`MISMATCH — the recorded outcome does not recompute\n`);
  for (const mismatch of mismatches) {
    stderr.write(`  ${mismatch}\n`);
  }
  exit(1);
}

stdout.write('OK — the recorded outcome recomputes exactly.\n');
