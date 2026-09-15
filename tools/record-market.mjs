#!/usr/bin/env node
/**
 * Records the Robinhood Chain market to tape, for calibration.
 *
 * Every `OPEN` bound on the market (`docs/OPEN_PARAMETERS.md` §2) is to be
 * measured before battles are decided by it, and measuring needs days of the
 * real market in the shape the service reads it. This runs the same indexer the
 * server runs and writes what it reads, one JSON line per trade, Pons trade and
 * reference, with a coverage mark after every read. `tools/calibrate-market.mjs`
 * replays the result.
 *
 *   node tools/record-market.mjs [--rpc <url>] [--out <dir>] [--min-interval-ms <n>]
 *
 * Defaults: the public mainnet endpoint, `recordings/market`, 250 ms between
 * calls. One file per UTC day (`tape-YYYY-MM-DD.jsonl`), appended to, so a
 * restart continues the same day's file; the tape marks the restart and a
 * replay treats the gap as the lag it was.
 *
 * Runs until stopped. Ctrl+C finishes the read in progress and exits.
 *
 * Plain ESM run directly by node. It imports compiled output, so run
 * `pnpm run build` first.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

const USAGE =
  'Usage: node tools/record-market.mjs [--rpc <url>] [--out <dir>] [--min-interval-ms <n>]';

const PUBLIC_MAINNET_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const MAINNET = 4663;

/** Long enough to re-read across a slow read or a short restart without a hole. */
const RETENTION_MS = 15 * 60_000;
const POLL_MS = 1_000;
const RETRY_START_MS = 30_000;
const PROGRESS_MS = 60_000;

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

const options = { rpc: PUBLIC_MAINNET_RPC, out: join('recordings', 'market'), minIntervalMs: 250 };
const args = argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const name = args[index];
  const value = args[index + 1];
  if (name === '--help' || name === '-h') {
    stdout.write(`${USAGE}\n`);
    exit(0);
  }
  if (value === undefined || value.startsWith('--')) {
    fail(`${name} needs a value.\n${USAGE}`);
  }
  if (name === '--rpc') {
    options.rpc = value;
  } else if (name === '--out') {
    options.out = value;
  } else if (name === '--min-interval-ms') {
    options.minIntervalMs = Number(value);
    if (!Number.isInteger(options.minIntervalMs) || options.minIntervalMs < 0) {
      fail(`--min-interval-ms must be a whole number of milliseconds.\n${USAGE}`);
    }
  } else {
    fail(`Unrecognised argument ${name}.\n${USAGE}`);
  }
  index += 1;
}

const load = (path) =>
  import(path).catch(() => {
    fail('Could not load compiled packages. Run `pnpm run build` first — this tool reads dist/.');
  });
const { RobinhoodMarketIndexer, robinhoodMarketRpc, marketAddressesFor } = await load(
  '../packages/chain/dist/index.js',
);
const { TapeRecorder, encodeTapeEntry } = await load('../packages/market-data/dist/index.js');

const stopping = new AbortController();
let stops = 0;
const stop = () => {
  stops += 1;
  if (stops > 1) {
    exit(130);
  }
  say('stopping after the read in progress (again to quit now)');
  stopping.abort();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function say(line) {
  stderr.write(`${new Date().toISOString()}  ${line}\n`);
}

const wait = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopping.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

mkdirSync(options.out, { recursive: true });
let day = '';
let file = null;
/** Appends entries to the file for the UTC day they were read on. */
async function write(entries) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    if (file !== null) {
      await new Promise((resolve) => file.end(resolve));
    }
    day = today;
    file = createWriteStream(join(options.out, `tape-${day}.jsonl`), { flags: 'a' });
  }
  const text = entries.map((entry) => `${encodeTapeEntry(entry)}\n`).join('');
  if (!file.write(text)) {
    await new Promise((resolve) => file.once('drain', resolve));
  }
}

const addresses = marketAddressesFor(MAINNET);
say(
  `recording ${options.rpc} to ${options.out}, ${String(options.minIntervalMs)} ms between calls`,
);

let written = 0;
while (!stopping.signal.aborted) {
  const indexer = new RobinhoodMarketIndexer({
    rpc: robinhoodMarketRpc(options.rpc, {
      minIntervalMs: options.minIntervalMs,
      retries: 8,
      backoffMs: 2_000,
      maxBackoffMs: 60_000,
      signal: stopping.signal,
    }),
    addresses,
    tradeRetentionMs: RETENTION_MS,
    volumeRetentionMs: RETENTION_MS,
    // Every trade: the minimum is one of the bounds being calibrated.
    minTradeQuote: 1n,
    ponsRetentionMs: RETENTION_MS,
    maxBlocksPerPoll: 5_000n,
    referenceRefreshMs: 30_000,
    now: Date.now,
    onLog: say,
  });
  try {
    await indexer.start();
  } catch (error) {
    if (stopping.signal.aborted) {
      break;
    }
    say(`start failed, retrying in ${String(RETRY_START_MS / 1_000)} s: ${String(error)}`);
    await wait(RETRY_START_MS);
    continue;
  }

  const recorder = new TapeRecorder(indexer, Date.now);
  const first = [...recorder.header(MAINNET), ...recorder.snapshot()];
  await write(first);
  written += first.length;
  say('caught up; recording');

  let lastProgress = Date.now();
  let failing = false;
  while (!stopping.signal.aborted) {
    let caughtUp = false;
    try {
      caughtUp = await indexer.poll();
      failing = false;
    } catch (error) {
      if (stopping.signal.aborted) {
        break;
      }
      if (!failing) {
        say(`read failed, retrying: ${String(error)}`);
      }
      failing = true;
    }
    const entries = recorder.snapshot();
    await write(entries);
    written += entries.length;
    if (Date.now() - lastProgress >= PROGRESS_MS) {
      lastProgress = Date.now();
      const lag = (Date.now() - indexer.coversUntil()) / 1_000;
      say(`${String(written)} entries written; ${lag.toFixed(1)} s behind the chain`);
    }
    if (caughtUp || failing) {
      await wait(POLL_MS);
    }
  }
}

if (file !== null) {
  await new Promise((resolve) => file.end(resolve));
}
say(`stopped; ${String(written)} entries written`);
exit(0);
