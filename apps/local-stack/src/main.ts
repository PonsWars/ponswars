import { buildServer, PickStore } from '@ponswars/api';
import {
  createRound,
  CURRENT_ENGINE_VERSIONS,
  nextRoundOpensAt,
  pollDelay,
  type EngineConfig,
  type RoundEngineState,
} from '@ponswars/battle-engine';
import { clockForRound, RATIO_SCALE, roundIdFor } from '@ponswars/battle-math';
import { startSocketServer } from '@ponswars/gateway';
import { MemoryRoundStore, stepRound, type RoundPorts } from '@ponswars/round-service';
import {
  ACTIVE_TICKERS,
  milliseconds,
  roundId as toRoundId,
  utcTimestamp,
  walletAddress,
  type CanonicalClock,
  type ConfidenceLabel,
  type UtcTimestamp,
  type WalletAddress,
} from '@ponswars/shared-types';
import { SyntheticMarket } from './synthetic-market.js';

/**
 * The whole loop, running locally (§68).
 *
 * One process: the round orchestrator, the HTTP API and the WebSocket gateway,
 * wired to each other through the ports they already define. Rounds open, take
 * picks, lock, tick for nine minutes and finalize, and anything connected
 * watches it happen.
 *
 * **Development only.** Two of the five ports are stand-ins: the market is
 * synthetic and the store is in memory. Both are deliberate — the market-data
 * vendor and the database are `OPEN` (§102), and a stack that quietly picked
 * one would be shipping that decision as policy. What this proves is that the
 * seam is real: replacing either is one constructor argument.
 *
 * It is named `local-stack` and says so on startup, because the failure mode
 * for a thing like this is somebody running it and believing it.
 */

const PORT_API = Number(process.env['PORT_API'] ?? 4000);
const PORT_WS = Number(process.env['PORT_WS'] ?? 4001);

/**
 * Scoring tick interval (§12.5, §23.1).
 *
 * `BASELINE` rather than `OPEN`: the masterplan names approximately one
 * authoritative tick per second, so this is the documented figure rather than
 * an invented one. Stated explicitly because the loop would otherwise tick as
 * fast as it spins — the first run of this stack emitted four updates a second,
 * which is not the cadence the product describes and would be four times the
 * realtime volume a client is built to receive.
 */
const TICK_MS = Number(process.env['BATTLE_ENGINE_TICK_MS'] ?? 1_000);

/**
 * Engine calibration for the local stack.
 *
 * `OPEN` production tuning (§59.4). These are the simulation's values, chosen
 * because they are the ones every test in this repository already exercises —
 * not because they are recommended for production, which is a decision that has
 * not been made.
 */
const CONFIG: EngineConfig = {
  scoring: {
    priceEdgeDivisor: 2n * RATIO_SCALE,
    volumeEdgeDivisor: 1n * RATIO_SCALE,
    ponsEdgeDivisor: 20n * RATIO_SCALE,
    cardEdgeDivisor: 10n * RATIO_SCALE,
  },
  momentum: { push: 100_000n, surge: 200_000n, dominance: 400_000n, comeback: 300_000n },
  victory: { narrowMargin: 4_000_000n, decisiveMargin: 30_000_000n },
  finalization: { maxWait: milliseconds(5_000) },
  versions: CURRENT_ENGINE_VERSIONS,
  cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
};

/**
 * Confidence for every ticker (§10.1).
 *
 * Snapshotted at round open in production, from market and Pons signals. Fixed
 * at EVEN here rather than randomised, so nothing in a local session looks like
 * a real assessment of a real stock.
 */
const CONFIDENCE: Readonly<Record<string, ConfidenceLabel>> = Object.fromEntries(
  ACTIVE_TICKERS.map((ticker) => [ticker, 'EVEN']),
);

const now = (): UtcTimestamp => utcTimestamp(Date.now());

/** A demo wallet for any authenticated request. Real auth is §45.2. */
const DEMO_WALLET: WalletAddress = walletAddress(`0x${'d'.repeat(40)}`);

function openRound(index: number, clock: CanonicalClock): RoundEngineState {
  const round = createRound({
    roundId: toRoundId(roundIdFor(index)),
    roundIndex: index,
    clock,
    baseSeedHex: `0x${'5c'.repeat(32)}`,
    recentRounds: [],
    confidence: CONFIDENCE,
  });
  // §22 makes opening the phase an explicit transition rather than something
  // the clock implies, which is why the driver refuses to infer it.
  return { ...round, state: 'PICK_OPEN' };
}

async function main(): Promise<void> {
  const picks = new PickStore();
  const store = new MemoryRoundStore();
  const market = new SyntheticMarket();

  const sockets = startSocketServer({
    port: PORT_WS,
    now,
    walletOf: (authorization) => (authorization === undefined ? null : DEMO_WALLET),
  });

  const ports: RoundPorts = {
    marketData: market,
    picks,
    // A local block hash. On chain this is a finalized block (§13.6), which is
    // what makes the tiebreak unpredictable in advance — a constant here would
    // make it predictable, and that is fine for a demo and fatal in production.
    chain: { finalizationBlockHash: () => Promise.resolve(`0x${'e1'.repeat(32)}`) },
    publisher: sockets.gateway,
    store,
  };

  // Rounds are contiguous (§3.1): each opens where the last ended, so the
  // schedule never drifts even if a finalization runs late.
  let index = 0;
  let clock = clockForRound(now(), 0, now());
  let round = openRound(index, clock);

  const api = buildServer({
    currentRound: () => round,
    picks,
    config: CONFIG,
    now,
    walletOf: (authorization) => (authorization === undefined ? null : DEMO_WALLET),
  });

  await api.listen({ port: PORT_API, host: '127.0.0.1' });

  process.stdout.write(
    [
      '',
      'PonsWars local stack — development only.',
      '  The market is synthetic and the store is in memory. Neither is a',
      '  production choice; both are still OPEN decisions (§102).',
      '',
      `  API       http://127.0.0.1:${String(PORT_API)}/v1/rounds/current`,
      `  WebSocket ws://127.0.0.1:${String(PORT_WS)}`,
      '',
    ].join('\n'),
  );

  let previousState = round.state;

  for (;;) {
    const result = await stepRound(round, now(), ports, CONFIG);
    round = result.state;

    if (round.state !== previousState) {
      process.stdout.write(`${round.roundId}  ${previousState} → ${round.state}\n`);
      previousState = round.state;
    }

    if (result.finalization !== undefined) {
      for (const battleResult of result.finalization.results) {
        process.stdout.write(
          `  ${battleResult.left} vs ${battleResult.right} → ${battleResult.winner} (${battleResult.victoryLabel})\n`,
        );
      }
      for (const voided of result.finalization.voided) {
        process.stdout.write(`  ${voided} → VOID\n`);
      }

      // §3.1: the next round opens where this one ended.
      index += 1;
      clock = clockForRound(nextRoundOpensAt(clock), 0, now());
      round = openRound(index, clock);
      previousState = round.state;
      process.stdout.write(`\n${round.roundId}  opened\n`);
      continue;
    }

    // A live battle sleeps the tick cadence; anything else sleeps until the
    // boundary the driver named, capped so the loop never overshoots one it was
    // told about.
    const delay =
      result.action.kind === 'TICK'
        ? TICK_MS
        : Math.max(pollDelay(result.action, now(), milliseconds(1_000)), 100);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`local stack failed: ${String(error)}\n`);
  process.exitCode = 1;
});
