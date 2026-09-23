#!/usr/bin/env node
/**
 * Reports how much of each recorded day the tapes can actually answer for.
 *
 *   node tools/tape-coverage.mjs [--tapes <dir or file>]... [--clock chain|wall]
 *
 * Read this before `tools/calibrate-market.mjs`, and before believing anything
 * it says. Calibration refuses to play a round it has no tape for, so a
 * half-recorded week does not produce wrong numbers — it produces numbers about
 * half a week, printed with the same confidence as a whole one.
 *
 * ## What counts as a hole
 *
 * The same thing `TapeSource.records` counts: a break between the runs the
 * recorder read without stopping. A run ends where the recorder did, and the
 * next begins where it started again — and it starts at the chain's head
 * (`market-indexer.ts` sets `lastBlock = head`), so whatever happened while it
 * was down was never read by anything.
 *
 * A gap between two coverage marks is **not** a hole, which is the mistake this
 * tool was written wrong to make first. The recorder is throttled hard by the
 * public endpoint, and a poll after a pause covers everything since the last
 * one — `poll()` always resumes at `lastBlock + 1` and never skips forward. So
 * a long stretch between marks is the recorder catching up, and counting it as
 * missing turned three fully recorded days into a report of 43%.
 *
 * Plain ESM run directly by node. It reads the tapes as text and imports
 * nothing, so it works before `pnpm run build`.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { argv, exit, stderr, stdout } from 'node:process';
import { join } from 'node:path';

const USAGE = 'Usage: node tools/tape-coverage.mjs [--tapes <dir or file>]... [--clock chain|wall]';

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

const options = { tapes: [], clock: 'chain' };
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
  } else if (name === '--clock') {
    if (value !== 'chain' && value !== 'wall') {
      fail(`--clock is chain or wall.\n${USAGE}`);
    }
    options.clock = value;
  } else {
    fail(`Unrecognised argument ${name}.\n${USAGE}`);
  }
  index += 1;
}
if (options.tapes.length === 0) {
  options.tapes.push(join('recordings', 'market'));
}

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

/**
 * One tape's runs, the way `TapeSource` builds them.
 *
 * Streamed rather than read whole: a busy day is tens of megabytes, and only
 * the coverage marks and the restarts matter.
 */
async function runsIn(file) {
  const runs = [];
  let open = null;

  const lines = createInterface({
    input: createReadStream(file, 'utf8'),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    // Cheap filter first: most lines are trades, and parsing every one of them
    // costs more than the whole rest of this tool.
    if (!line.includes('"COVERED"') && !line.includes('"START"')) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind === 'START') {
      // The recorder stopped here and came back at the chain's head.
      if (open !== null) {
        runs.push(open);
        open = null;
      }
      continue;
    }
    if (entry.kind !== 'COVERED') {
      continue;
    }
    const at = options.clock === 'wall' ? entry.wallAt : entry.at;
    if (typeof at !== 'number') {
      continue;
    }
    open = open === null ? { from: at, to: at } : { from: open.from, to: Math.max(open.to, at) };
  }
  if (open !== null) {
    runs.push(open);
  }
  return runs;
}

const hours = (ms) => (ms / 3_600_000).toFixed(1);
const minutes = (ms) => (ms / 60_000).toFixed(0);

const files = tapeFiles(options.tapes);
let totalSpan = 0;
let totalCovered = 0;
let clean = 0;

stdout.write(
  `day         covered    span    lost   breaks  longest\n` +
    `───────────────────────────────────────────────────\n`,
);
for (const file of files) {
  const runs = await runsIn(file);
  const span = runs.length === 0 ? 0 : runs[runs.length - 1].to - runs[0].from;
  const covered = runs.reduce((sum, run) => sum + (run.to - run.from), 0);
  let longest = 0;
  for (let index = 1; index < runs.length; index += 1) {
    longest = Math.max(longest, runs[index].from - runs[index - 1].to);
  }
  totalSpan += span;
  totalCovered += covered;
  const share = span === 0 ? 0 : (100 * covered) / span;
  if (share >= 95) {
    clean += 1;
  }
  const name = /tape-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file)?.[1] ?? file;
  stdout.write(
    `${name}  ${share.toFixed(1).padStart(6)} %  ${hours(span).padStart(5)} h  ` +
      `${hours(span - covered).padStart(5)} h  ${String(runs.length - 1).padStart(5)}  ` +
      `${minutes(longest).padStart(5)} min\n`,
  );
}

const overall = totalSpan === 0 ? 0 : (100 * totalCovered) / totalSpan;
stdout.write(
  `───────────────────────────────────────────────────\n` +
    `${String(files.length).padStart(2)} day(s)      ${overall.toFixed(1).padStart(6)} %  ` +
    `${hours(totalSpan).padStart(5)} h  ${hours(totalSpan - totalCovered).padStart(5)} h\n\n`,
);

// The bar is a day, not a week: a week of tapes is seven of these, and one
// broken day in the middle is a hole calibration will quietly skip past.
stdout.write(
  clean === 0
    ? 'No day is 95% recorded. Calibrate for a feel of the shape, not for values.\n'
    : `${String(clean)} of ${String(files.length)} day(s) are 95% recorded or better.\n`,
);
if (clean < 7) {
  stdout.write(
    `A week's calibration wants seven of them; keep the recorder running (and the machine awake).\n`,
  );
}
