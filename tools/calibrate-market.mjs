#!/usr/bin/env node
/**
 * Plays recorded market tapes through the market adapter and the engine, and
 * reports what a candidate set of bounds and tuning would have done.
 *
 *   node tools/calibrate-market.mjs [--tapes <dir or file>]... [--candidate <json>]
 *                                   [--clock chain|wall] [--tick-ms <n>] [--out <report.json>]
 *
 * Defaults: every `tape-*.jsonl` under `recordings/market`, the candidate in
 * `tools/calibration/initial-candidate.json`, the chain clock (the market alone,
 * without the recorder's lag; `wall` replays it as the endpoint delivered it),
 * one tick a second. The summary
 * is printed; `--out` also writes the whole report and the suggested starting
 * values as JSON, to compare candidates side by side.
 *
 * Read the void rates before the suggestions. The market's bounds decide which
 * battles are played at all, and are a product decision (§102): a candidate
 * that voids a third of GME's battles may still be the right one.
 *
 * Plain ESM run directly by node. It imports compiled output, so run
 * `pnpm run build` first.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

const USAGE =
  'Usage: node tools/calibrate-market.mjs [--tapes <dir or file>]... [--candidate <json>] [--clock chain|wall] [--tick-ms <n>] [--out <report.json>]';

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

const options = {
  tapes: [],
  candidate: join('tools', 'calibration', 'initial-candidate.json'),
  clock: 'chain',
  tickMs: 1_000,
  out: null,
};
const args = argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const name = args[index];
  if (name === '--help' || name === '-h') {
    stdout.write(`${USAGE}\n`);
    exit(0);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail(`${name} needs a value.\n${USAGE}`);
  }
  if (name === '--tapes') {
    options.tapes.push(value);
  } else if (name === '--candidate') {
    options.candidate = value;
  } else if (name === '--clock') {
    if (value !== 'chain' && value !== 'wall') {
      fail(`--clock is chain or wall.\n${USAGE}`);
    }
    options.clock = value;
  } else if (name === '--tick-ms') {
    options.tickMs = Number(value);
    if (!Number.isInteger(options.tickMs) || options.tickMs <= 0) {
      fail(`--tick-ms must be a positive whole number of milliseconds.\n${USAGE}`);
    }
  } else if (name === '--out') {
    options.out = value;
  } else {
    fail(`Unrecognised argument ${name}.\n${USAGE}`);
  }
  index += 1;
}
if (options.tapes.length === 0) {
  options.tapes.push(join('recordings', 'market'));
}

const load = (path) =>
  import(path).catch(() => {
    fail('Could not load compiled packages. Run `pnpm run build` first — this tool reads dist/.');
  });
const { calibrate, parseCandidate, suggest } = await load('../packages/calibration/dist/index.js');
const { decodeTapeEntry } = await load('../packages/market-data/dist/index.js');
const { ROBINHOOD_CHAIN_MAINNET_MARKET } = await load('../packages/chain/dist/index.js');

/** Every tape file named, directories expanded to their tapes in date order. */
function tapeFiles(paths) {
  const files = [];
  for (const path of paths) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      fail(`No tape at ${path}.`);
    }
    if (stats.isDirectory()) {
      files.push(
        ...readdirSync(path)
          .filter((name) => /^tape-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
          .sort()
          .map((name) => join(path, name)),
      );
    } else {
      files.push(path);
    }
  }
  if (files.length === 0) {
    fail(
      `No tape-*.jsonl files under ${paths.join(', ')}. Record some with tools/record-market.mjs.`,
    );
  }
  return files;
}

const entries = [];
for (const file of tapeFiles(options.tapes)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }
    try {
      entries.push(decodeTapeEntry(line));
    } catch (error) {
      // A recorder still writing leaves a partial last line; anything else is
      // a tape that cannot be trusted.
      if (index === lines.length - 1) {
        return;
      }
      fail(`${file}:${String(index + 1)}: ${String(error)}`);
    }
  });
  stderr.write(`read ${file}\n`);
}

let candidate;
try {
  candidate = parseCandidate(JSON.parse(readFileSync(options.candidate, 'utf8')));
} catch (error) {
  fail(`${options.candidate}: ${error instanceof Error ? error.message : String(error)}`);
}

const started = Date.now();
const report = await calibrate(entries, candidate, {
  clock: options.clock,
  tickMs: options.tickMs,
  excludedAddresses: ROBINHOOD_CHAIN_MAINNET_MARKET.routers,
  sampleEveryTicks: Math.max(1, Math.round(60_000 / options.tickMs)),
  onRound: (done, total) => {
    if (done % 6 === 0 || done === total) {
      stderr.write(`\r${String(done)}/${String(total)} slots`);
    }
  },
});
stderr.write(`\ndone in ${((Date.now() - started) / 1_000).toFixed(0)} s\n`);
const suggestion = suggest(report);

const percent = (part, whole) =>
  whole === 0 ? '   -' : `${((100 * part) / whole).toFixed(1)}%`.padStart(6);
const quantiles = (d, digits = 2) =>
  d.count === 0
    ? 'no samples'
    : `p10 ${d.p10.toFixed(digits)}  p50 ${d.p50.toFixed(digits)}  p90 ${d.p90.toFixed(digits)}  (n=${String(d.count)})`;

const lines = [
  '',
  `Clock: ${report.clock === 'chain' ? 'chain (the market alone, without the recorder’s lag)' : 'wall (as the recorder’s endpoint delivered it)'}`,
  `Rounds: ${String(report.rounds.played)} played, ${String(report.rounds.marketClosed)} skipped with the market shut` +
    (report.rounds.withoutVolumeHistory > 0
      ? `, ${String(report.rounds.withoutVolumeHistory)} without enough earlier sessions for relative volume`
      : ''),
  '',
  'Ticker   healthy  degraded  stale   battles voided  voids caused   return bps p50/p90   rel. volume p50   most common reasons',
];
for (const [ticker, t] of Object.entries(report.tickers)) {
  const ticks = t.ticks.HEALTHY + t.ticks.DEGRADED + t.ticks.STALE + t.ticks.UNAVAILABLE;
  const battles = t.battles.finalized + t.battles.voided;
  const ret = t.inputs.returnBps;
  lines.push(
    `${ticker.padEnd(8)} ${percent(t.ticks.HEALTHY, ticks)}   ${percent(t.ticks.DEGRADED, ticks)}  ${percent(
      t.ticks.STALE + t.ticks.UNAVAILABLE,
      ticks,
    )}   ${percent(t.battles.voided, battles).padStart(14)}  ${String(t.voidsCaused).padStart(12)}   ${
      ret.count === 0
        ? '-'.padStart(20)
        : `${ret.p50.toFixed(1)} / ${ret.p90.toFixed(1)}`.padStart(20)
    }   ${(t.inputs.relativeVolume.count === 0 ? '-' : t.inputs.relativeVolume.p50.toFixed(2)).padStart(15)}   ${Object.entries(
      t.unhealthyReasons,
    )
      .slice(0, 2)
      .map(([reason, count]) => `${reason} ${percent(count, ticks).trim()}`)
      .join(', ')}`,
  );
}
const { battles } = report;
lines.push(
  '',
  `Battles: ${String(battles.finalized)} finalized, ${String(battles.voided)} voided (${percent(
    battles.voided,
    battles.finalized + battles.voided,
  ).trim()})`,
  `  margin, points      ${quantiles(battles.margin)}`,
  `  advantage           ${quantiles(battles.advantage, 3)}`,
  `  price gap, sigmas   ${quantiles(battles.gaps.adjustedReturn)}`,
  `  volume gap          ${quantiles(battles.gaps.relativeVolume)}`,
  `  Pons strength gap   ${quantiles(battles.gaps.ponsStrength)}`,
  `  victory labels      ${JSON.stringify(battles.victoryLabels)}`,
  `  momentum ticks      ${JSON.stringify(battles.momentum)}`,
  `  confidence labels   ${JSON.stringify(report.confidence.labels)}`,
  '',
  'Suggested starting values (see packages/calibration/src/suggest.ts for the rules):',
  JSON.stringify({ engine: suggestion.engine, confidence: suggestion.confidence }, null, 2),
  ...(suggestion.missing.length > 0
    ? [`Not enough data for: ${suggestion.missing.join(', ')}`]
    : []),
  '',
);
stdout.write(lines.join('\n'));

if (options.out !== null) {
  writeFileSync(
    options.out,
    `${JSON.stringify({ candidate: options.candidate, report, suggestion }, null, 2)}\n`,
  );
  stderr.write(`wrote ${options.out}\n`);
}
