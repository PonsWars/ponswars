import { CURRENT_ENGINE_VERSIONS, type EngineConfig } from '@ponswars/battle-engine';
import { assertCalibration, type ConfidenceCalibration } from '@ponswars/battle-math';
import { PARAMETERS } from '@ponswars/config';
import type { OnchainMarketSettings } from '@ponswars/market-data';
import { milliseconds } from '@ponswars/shared-types';

/**
 * One set of values to measure: the market's bounds, the engine's tuning and
 * the confidence bands, together.
 *
 * Together because they are decided together. §59.4 treats the engine block as
 * one decision, and the market's bounds decide which ticks the engine ever
 * sees — a void rate measured under one set of bounds says nothing about a
 * scoring spread measured under another.
 *
 * The market half is written the way an operator writes it: the environment
 * variables, as strings, parsed by the same parsers the server's loader uses.
 * A candidate that calibrates cleanly is therefore one that loads cleanly.
 */

/** The engine block §59.4 treats as one decision: how battles score and read. */
export interface EngineTuning {
  readonly engine: EngineConfig;
  readonly confidence: ConfidenceCalibration;
}

export interface CalibrationCandidate extends EngineTuning {
  readonly market: OnchainMarketSettings;
}

const MARKET_SETTINGS = [
  'PRICE_FEED_STALE_AFTER_MS',
  'VOLUME_FEED_STALE_AFTER_MS',
  'PONS_FEED_STALE_AFTER_MS',
  'MARKET_PRICE_WINDOW_MS',
  'MARKET_MIN_TRADE_USD',
  'MARKET_OUTLIER_BPS',
  'MARKET_DIVERGENCE_BPS',
  'MARKET_REFERENCE_MAX_AGE_MS',
  'MARKET_MIN_WINDOW_TRADES',
  'MARKET_VOLATILITY_LOOKBACK_MS',
  'MARKET_VOLATILITY_FLOOR_BPS',
  'MARKET_COMPARABLE_SESSIONS',
  'MARKET_EXPECTED_VOLUME_FLOOR_USD',
  'MARKET_HOLIDAYS',
  'PONS_MIN_ACTIVITY_USD',
  'PONS_MAX_IDENTICAL_PER_WALLET',
] as const satisfies readonly (keyof OnchainMarketSettings & keyof typeof PARAMETERS)[];

/**
 * Reads a candidate from parsed JSON.
 *
 * @throws Error listing every problem at once, the way the server's loader
 *   does — a calibration run is long, and learning one mistake per run is slow.
 */
export function parseCandidate(json: unknown): CalibrationCandidate {
  const problems: string[] = [];
  const root = objectAt(json, 'candidate', problems);
  const marketRaw = objectAt(root['market'], 'market', problems);
  const market: Record<string, unknown> = {};
  for (const name of MARKET_SETTINGS) {
    const raw = marketRaw[name];
    if (typeof raw !== 'string') {
      problems.push(`market.${name}: expected a string, as it would be set in the environment`);
      continue;
    }
    const parsed = PARAMETERS[name].parse(raw);
    if (parsed.ok) {
      market[name] = parsed.value;
    } else {
      problems.push(`market.${name}: ${parsed.error}`);
    }
  }

  const { engine, confidence } = engineTuning(root, problems);

  if (problems.length === 0) {
    try {
      assertCalibration(confidence);
    } catch (error) {
      problems.push(`confidence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid calibration candidate (${String(problems.length)} problem(s)):\n  ${problems.join('\n  ')}`,
    );
  }
  return { market: market as unknown as OnchainMarketSettings, engine, confidence };
}

/**
 * The engine's tuning and the confidence bands, without the market's bounds.
 *
 * Its own function because the server loads exactly this — the calibration it
 * was decided to run under (§59.4) — from a file, while its market bounds come
 * from the environment. One parser, so a file that calibrates is a file that
 * runs.
 */
export function parseEngineTuning(json: unknown): EngineTuning {
  const problems: string[] = [];
  const root = objectAt(json, 'calibration', problems);
  const tuning = engineTuning(root, problems);
  if (problems.length === 0) {
    try {
      assertCalibration(tuning.confidence);
    } catch (error) {
      problems.push(`confidence: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid engine calibration (${String(problems.length)} problem(s)):\n  ${problems.join('\n  ')}`,
    );
  }
  return tuning;
}

function engineTuning(root: Record<string, unknown>, problems: string[]): EngineTuning {
  const engineRaw = objectAt(root['engine'], 'engine', problems);
  const scoring = objectAt(engineRaw['scoring'], 'engine.scoring', problems);
  const momentum = objectAt(engineRaw['momentum'], 'engine.momentum', problems);
  const victory = objectAt(engineRaw['victory'], 'engine.victory', problems);
  const confidenceRaw = objectAt(root['confidence'], 'confidence', problems);
  const band = (name: string): Record<string, unknown> =>
    objectAt(confidenceRaw[name], `confidence.${name}`, problems);
  const priceTrend = band('priceTrend');
  const volumePulse = band('volumePulse');
  const ponsActivity = band('ponsActivity');
  const stability = band('momentumStability');
  const matchup = band('matchup');

  const scaled = (fields: Record<string, unknown>, path: string, key: string): bigint => {
    const value = fields[key];
    if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
      problems.push(`${path}.${key}: expected a decimal integer string`);
      return 0n;
    }
    return BigInt(value);
  };
  const count = (fields: Record<string, unknown>, path: string, key: string): number => {
    const value = fields[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      problems.push(`${path}.${key}: expected an integer`);
      return 0;
    }
    return value;
  };

  const engine: EngineConfig = {
    scoring: {
      priceEdgeDivisor: scaled(scoring, 'engine.scoring', 'priceEdgeDivisor'),
      volumeEdgeDivisor: scaled(scoring, 'engine.scoring', 'volumeEdgeDivisor'),
      ponsEdgeDivisor: scaled(scoring, 'engine.scoring', 'ponsEdgeDivisor'),
      cardEdgeDivisor: scaled(scoring, 'engine.scoring', 'cardEdgeDivisor'),
    },
    momentum: {
      push: scaled(momentum, 'engine.momentum', 'push'),
      surge: scaled(momentum, 'engine.momentum', 'surge'),
      dominance: scaled(momentum, 'engine.momentum', 'dominance'),
      comeback: scaled(momentum, 'engine.momentum', 'comeback'),
    },
    victory: {
      narrowMargin: scaled(victory, 'engine.victory', 'narrowMargin'),
      decisiveMargin: scaled(victory, 'engine.victory', 'decisiveMargin'),
    },
    // Not calibrated against a market: how long finalization waits and how the
    // card tiers read are service and presentation choices.
    finalization: { maxWait: milliseconds(5_000) },
    versions: CURRENT_ENGINE_VERSIONS,
    cardSupportTiers: { medium: 100n, high: 1_000n, max: 10_000n },
  };

  const confidence: ConfidenceCalibration = {
    priceTrend: {
      strong: scaled(priceTrend, 'confidence.priceTrend', 'strong'),
      weak: scaled(priceTrend, 'confidence.priceTrend', 'weak'),
    },
    volumePulse: {
      rising: scaled(volumePulse, 'confidence.volumePulse', 'rising'),
      weak: scaled(volumePulse, 'confidence.volumePulse', 'weak'),
    },
    ponsActivity: {
      high: scaled(ponsActivity, 'confidence.ponsActivity', 'high'),
      medium: scaled(ponsActivity, 'confidence.ponsActivity', 'medium'),
    },
    momentumStability: {
      stable: count(stability, 'confidence.momentumStability', 'stable'),
      mixed: count(stability, 'confidence.momentumStability', 'mixed'),
    },
    matchup: {
      favored: count(matchup, 'confidence.matchup', 'favored'),
      strongFavorite: count(matchup, 'confidence.matchup', 'strongFavorite'),
      dominant: count(matchup, 'confidence.matchup', 'dominant'),
    },
  };
  return { engine, confidence };
}

function objectAt(value: unknown, path: string, problems: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`${path}: expected an object`);
    return {};
  }
  return value as Record<string, unknown>;
}
