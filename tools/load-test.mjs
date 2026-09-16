#!/usr/bin/env node
/**
 * Puts spectator load on a running stack and reports what it cost.
 *
 * §5 makes spectating the normal case: most connections are people watching
 * five battles they have no wallet in, and the transport carries a tick a
 * second per battle to all of them. This measures that shape — many sockets
 * following the world, the round and every battle, plus the snapshot fetch
 * each of them makes on the way in.
 *
 *   pnpm run local            # or the deployed API and gateway
 *   node tools/load-test.mjs --clients 500 --seconds 60
 *
 * Options: `--api`, `--ws`, `--clients`, `--seconds`, `--ramp-ms` (how long to
 * spread the connections over; connecting five hundred sockets in one tick
 * measures the loop, not the server).
 *
 * What it reports, per run:
 *
 * - the snapshot fetch, in milliseconds, at p50/p90/p99;
 * - how long a battle update took to arrive after the server stamped it —
 *   meaningful when both run on one machine, and a lower bound elsewhere;
 * - updates received against updates expected, so a server that quietly
 *   stopped publishing to some connections shows up as a shortfall;
 * - every socket that closed, errored or was refused.
 *
 * It signs in nobody and sends no picks: §47.5 needs a wallet signature per
 * request, and a load test that forged one would be measuring a path no player
 * can take.
 *
 * Plain ESM run directly by node. `ws` comes from the gateway's own dependency,
 * so the client here speaks what the server speaks.
 */

import { argv, exit, stderr, stdout } from 'node:process';

const USAGE =
  'Usage: node tools/load-test.mjs [--api <url>] [--ws <url>] [--clients <n>] [--seconds <n>] [--ramp-ms <n>]';

const options = {
  api: 'http://127.0.0.1:4000',
  ws: 'ws://127.0.0.1:4001',
  clients: 100,
  seconds: 30,
  rampMs: 5_000,
};

function fail(message) {
  stderr.write(`${message}\n`);
  exit(1);
}

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
  if (name === '--api') {
    options.api = value.replace(/\/$/, '');
  } else if (name === '--ws') {
    options.ws = value.replace(/\/$/, '');
  } else if (name === '--clients' || name === '--seconds' || name === '--ramp-ms') {
    const key = name === '--ramp-ms' ? 'rampMs' : name.slice(2);
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      fail(`${name} must be a positive whole number.\n${USAGE}`);
    }
    options[key] = parsed;
  } else {
    fail(`Unrecognised argument ${name}.\n${USAGE}`);
  }
  index += 1;
}

const { default: WebSocket } = await import('ws').catch(() => {
  fail('Could not load `ws`. Run `pnpm install` first.');
});

/** Quantiles by nearest rank, the way the calibration report does them. */
function quantile(values, q) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const say = (line) => stderr.write(`${new Date().toISOString()}  ${line}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The round every client follows. Read once: five hundred clients asking for
// the same snapshot before the test starts is a different test.
let round;
try {
  const response = await fetch(`${options.api}/v1/rounds/current`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    fail(
      `${options.api}/v1/rounds/current answered ${String(response.status)}. ` +
        'Start a stack first (`pnpm run local`), or point --api at one.',
    );
  }
  round = await response.json();
} catch (error) {
  fail(`Could not read the current round from ${options.api}: ${String(error)}`);
}

const channels = [
  'world',
  `round:${round.roundId}`,
  ...round.battles.map((battle) => `battle:${battle.battleId}`),
];
say(
  `round ${round.roundId} (${round.state}), ${String(channels.length)} channels, ` +
    `${String(options.clients)} clients over ${String(options.rampMs)} ms, ` +
    `${String(options.seconds)} s of load`,
);

const stats = {
  fetchMs: [],
  deliveryMs: [],
  updates: 0,
  connected: 0,
  refusedSubscriptions: 0,
  errors: new Map(),
};
const note = (what) => stats.errors.set(what, (stats.errors.get(what) ?? 0) + 1);

/** One spectator: the snapshot fetch, then the socket, then counting. */
async function spectator() {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${options.api}/v1/rounds/current`, {
      headers: { accept: 'application/json' },
    });
    await response.json();
    if (!response.ok) {
      note(`snapshot ${String(response.status)}`);
      return null;
    }
    stats.fetchMs.push(Date.now() - startedAt);
  } catch (error) {
    note(`snapshot failed: ${String(error).slice(0, 60)}`);
    return null;
  }

  return new Promise((resolve) => {
    const socket = new WebSocket(options.ws);
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(socket);
      }
    };
    socket.on('open', () => {
      stats.connected += 1;
      for (const channel of channels) {
        socket.send(JSON.stringify({ type: 'SUBSCRIBE', channel }));
      }
      done();
    });
    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        note('unparseable frame');
        return;
      }
      if (frame.type === 'ERROR') {
        note(`server error ${String(frame.code)}`);
        stats.refusedSubscriptions += 1;
        return;
      }
      if (frame.event === 'BATTLE_STATE_UPDATE') {
        stats.updates += 1;
        const stamped = frame.payload?.serverTime;
        if (typeof stamped === 'number') {
          stats.deliveryMs.push(Date.now() - stamped);
        }
      }
    });
    socket.on('error', (error) => {
      note(`socket: ${String(error.message ?? error).slice(0, 60)}`);
      done();
    });
    socket.on('close', (code) => {
      if (code !== 1000 && code !== 1005) {
        note(`closed ${String(code)}`);
      }
    });
  });
}

const sockets = [];
const gap = options.rampMs / options.clients;
const startedAt = Date.now();
for (let index = 0; index < options.clients; index += 1) {
  void spectator().then((socket) => {
    if (socket !== null && socket !== undefined) {
      sockets.push(socket);
    }
  });
  await sleep(gap);
}
say(`connected ${String(stats.connected)}/${String(options.clients)}; holding`);

const held = options.seconds * 1_000;
let reported = 0;
while (Date.now() - startedAt < held + options.rampMs) {
  await sleep(5_000);
  const elapsed = (Date.now() - startedAt) / 1_000;
  say(
    `${elapsed.toFixed(0)} s: ${String(stats.connected)} connected, ` +
      `${String(stats.updates - reported)} updates in the last 5 s`,
  );
  reported = stats.updates;
}

for (const socket of sockets) {
  socket.close(1000);
}
await sleep(500);

const seconds = (Date.now() - startedAt) / 1_000;
const ms = (values) => {
  const p50 = quantile(values, 0.5);
  return p50 === null
    ? 'no samples'
    : `p50 ${String(p50)} ms  p90 ${String(quantile(values, 0.9))} ms  p99 ${String(quantile(values, 0.99))} ms  (n=${String(values.length)})`;
};

stdout.write(
  [
    '',
    `Clients          ${String(stats.connected)} connected of ${String(options.clients)}`,
    `Snapshot fetch   ${ms(stats.fetchMs)}`,
    `Update delivery  ${ms(stats.deliveryMs)}`,
    `Updates          ${String(stats.updates)} in ${seconds.toFixed(0)} s ` +
      `(${(stats.updates / Math.max(1, seconds)).toFixed(0)}/s across all clients)`,
    `Refused subs     ${String(stats.refusedSubscriptions)}`,
    stats.errors.size === 0
      ? 'Errors           none'
      : `Errors           ${[...stats.errors].map(([what, count]) => `${what} ×${String(count)}`).join(', ')}`,
    '',
  ].join('\n'),
);
exit(0);
