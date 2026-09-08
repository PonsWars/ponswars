#!/usr/bin/env node
/**
 * Replays a recorded round and prints what it produced.
 *
 * The tool the disputed-result runbook assumes exists
 * (`docs/operations/disputed-result.md`). §26 promises a finalized result is
 * reproducible from published evidence; this is how someone checks that claim
 * without reading the engine.
 *
 *   node tools/replay-round.mjs <recording.json>
 *   node tools/replay-round.mjs <recording.json> --expect <battleId>=<hash> ...
 *
 * Each battle has its own evidence hash, so `--expect` names the battle it
 * applies to and may be given more than once. Any mismatch, or a named battle
 * that is not in the round, exits non-zero — so it can be run from a script and
 * believed. Without it the hashes are printed for a human to compare.
 *
 * Plain ESM run directly by node, like the other scripts in this repository. It
 * imports the compiled `dist/` output, so run `pnpm run build` first.
 */

import { readFile } from 'node:fs/promises';
import { argv, exit, stderr, stdout } from 'node:process';

const USAGE = `Usage: node tools/replay-round.mjs <recording.json> [--expect <battleId>=<hash>]...`;

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

/** Expected evidence hash per battle, from repeated `--expect id=hash`. */
const expectations = new Map();
for (let index = 1; index < args.length; index += 1) {
  if (args[index] !== '--expect') {
    fail(`Unrecognised argument ${args[index]}.\n${USAGE}`);
  }
  const pair = args[index + 1];
  if (pair === undefined || pair.startsWith('--') || !pair.includes('=')) {
    fail(`--expect needs <battleId>=<hash>.\n${USAGE}`);
  }
  const separator = pair.indexOf('=');
  expectations.set(pair.slice(0, separator), pair.slice(separator + 1));
  index += 1;
}

const { decodeRecording, replayRound } = await import('../packages/replay/dist/index.js').catch(
  () => {
    fail(
      'Could not load the replay module. Run `pnpm run build` first — this tool reads compiled output.',
    );
  },
);

let recording;
try {
  // `decodeRecording` validates the shape before the engine sees it. A
  // truncated download reaching the engine as a plausible-looking round is the
  // failure §66.2 exists to prevent, and an incident is exactly when a file is
  // most likely to be truncated.
  recording = decodeRecording(await readFile(path, 'utf8'));
} catch (error) {
  fail(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
}

const finalization = replayRound(recording);

stdout.write(`round      ${recording.roundId}\n`);
stdout.write(`engine     ${finalization.results[0]?.scoringEngineVersion ?? '—'}\n`);
stdout.write(`results    ${finalization.results.length}\n`);
stdout.write(`voided     ${finalization.voided.length}\n`);
stdout.write(`awards     ${finalization.awards.length}\n\n`);

for (const result of finalization.results) {
  const total = (breakdown) =>
    breakdown.priceMomentum +
    breakdown.relativeVolume +
    breakdown.ponsPower +
    breakdown.holderCardSupport;
  // One point is POINT_SCALE (1 000 000), so a component arrives as a large
  // integer. Rounded half up to one decimal, in integer arithmetic.
  const score = (scaled) => {
    const perTenth = 100_000;
    const tenths = Math.floor((scaled + perTenth / 2) / perTenth);
    return `${Math.floor(tenths / 10)}.${tenths % 10}`;
  };

  stdout.write(`${result.battleId}\n`);
  stdout.write(
    `  ${result.left} ${score(total(result.leftScore))}  vs  ${result.right} ${score(total(result.rightScore))}\n`,
  );
  stdout.write(`  winner    ${result.winner} (${result.victoryLabel})\n`);
  if (result.tiebreakStep !== undefined) {
    stdout.write(`  tiebreak  ${result.tiebreakStep}\n`);
  }
  stdout.write(`  evidence  ${result.evidenceHash}\n\n`);
}

for (const battleId of finalization.voided) {
  stdout.write(`${battleId}\n  VOID — no scorable data\n\n`);
}

if (expectations.size === 0) {
  exit(0);
}

const problems = [];
const byId = new Map(finalization.results.map((result) => [result.battleId, result]));

for (const [battleId, hash] of expectations) {
  const result = byId.get(battleId);
  if (result === undefined) {
    // A named battle that is not in the round is a mismatch of a different
    // kind, and silently passing it would let a typo look like a clean check.
    problems.push(`${battleId}  not in this round (voided, or the wrong recording)`);
    continue;
  }
  if (result.evidenceHash !== hash) {
    problems.push(`${battleId}  expected ${hash}
             got      ${result.evidenceHash}`);
  }
}

if (problems.length > 0) {
  // Named loudly: a replay that does not reproduce is a larger incident than
  // whatever complaint prompted it. Either the recording is incomplete or the
  // engine is not deterministic, and both need answering before another round
  // finalizes.
  stderr.write(`MISMATCH — ${problems.length} of ${expectations.size} did not reproduce
`);
  for (const problem of problems) {
    stderr.write(`  ${problem}
`);
  }
  exit(1);
}

stdout.write(`OK — ${expectations.size} battle(s) reproduced exactly
`);
