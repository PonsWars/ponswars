#!/usr/bin/env node
/**
 * Reports how much of each recorded day the market recorder was actually
 * running.
 *
 *   node tools/tape-coverage.mjs [--tapes <dir or file>]... [--gap-ms <n>]
 *
 * Read this before `tools/calibrate-market.mjs`, and before believing anything
 * it says. Calibration skips rounds the tapes do not cover, so a half-recorded
 * week does not produce wrong numbers — it produces numbers about half a week,
 * printed with the same confidence as a whole one. The first calibration run
 * here read 70% of battles as void until the tapes were checked and the holes
 * turned out to be a sleeping laptop rather than a thin market.
 *
 * A gap is measured between `COVERED` marks, which the recorder writes once per
 * poll pass whether or not anything traded (`tape-recorder.ts`). So a gap is
 * always the recorder missing, never the market being quiet: a quiet market
 * still leaves a mark every few seconds. Anything longer than `--gap-ms`
 * (default two minutes, comfortably above a throttle pause) is counted as time
 * the tape has no evidence about.
 *
 * Plain ESM run directly by node. It reads the tapes as text and imports
 * nothing, so it works before `pnpm run build`.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { argv, exit, stderr, stdout } from 'node:process';
import { join } from 'node:path';

const USAGE = 'Usage: node tools/tape-coverage.mjs [--tapes <dir or file>]... [--gap-ms <n>]';

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

const options = { tapes: [], gapMs: 120_000 };
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
  } else if (name === '--gap-ms') {
    options.gapMs = Number(value);
    if (!Number.isInteger(options.gapMs) || options.gapMs <= 0) {
      fail(`--gap-ms must be a positive whole number of milliseconds.\n${USAGE}`);
    }
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
 * One tape's coverage.
 *
 * Streamed rather than read whole: a busy day is tens of megabytes, and only
 * the `COVERED` marks matter. `wallAt` is the recorder's own clock — the
 * question here is when the recorder ran, not what the chain's timestamps say.
 */
async function coverage(file) {
  let previous = null;
  let first = null;
  let last = null;
  let lost = 0;
  let gaps = 0;
  let worst = 0;
  let marks = 0;

  const lines = createInterface({
    input: createReadStream(file, 'utf8'),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    // Cheap filter first: most lines are trades, and parsing every one of them
    // costs more than the whole rest of this tool.
    if (!line.includes('"COVERED"')) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind !== 'COVERED' || typeof entry.wallAt !== 'number') {
      continue;
    }
    marks += 1;
    first ??= entry.wallAt;
    last = entry.wallAt;
    if (previous !== null && entry.wallAt - previous > options.gapMs) {
      lost += entry.wallAt - previous;
      gaps += 1;
      worst = Math.max(worst, entry.wallAt - previous);
    }
    previous = entry.wallAt;
  }

  const span = first === null ? 0 : last - first;
  return { file, marks, span, lost, gaps, worst };
}

const hours = (ms) => (ms / 3_600_000).toFixed(1);
const minutes = (ms) => (ms / 60_000).toFixed(0);

const files = tapeFiles(options.tapes);
let totalSpan = 0;
let totalLost = 0;
let clean = 0;

stdout.write(
  `day         recorded   span    lost   gaps   worst\n` +
    `─────────────────────────────────────────────────\n`,
);
for (const file of files) {
  const day = await coverage(file);
  totalSpan += day.span;
  totalLost += day.lost;
  const recorded = day.span === 0 ? 0 : (100 * (day.span - day.lost)) / day.span;
  if (recorded >= 95) {
    clean += 1;
  }
  const name = /tape-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(day.file)?.[1] ?? day.file;
  stdout.write(
    `${name}  ${recorded.toFixed(1).padStart(6)} %  ` +
      `${hours(day.span).padStart(5)} h  ${hours(day.lost).padStart(5)} h  ` +
      `${String(day.gaps).padStart(4)}  ${minutes(day.worst).padStart(5)} min\n`,
  );
}

const overall = totalSpan === 0 ? 0 : (100 * (totalSpan - totalLost)) / totalSpan;
stdout.write(
  `─────────────────────────────────────────────────\n` +
    `${String(files.length).padStart(2)} day(s)     ${overall.toFixed(1).padStart(6)} %  ` +
    `${hours(totalSpan).padStart(5)} h  ${hours(totalLost).padStart(5)} h\n\n`,
);

// The bar is a day, not a week: a week of tapes is seven of these, and one
// broken day in the middle is a hole that calibration will quietly skip past.
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
