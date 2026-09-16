import { parseEngineTuning, type EngineTuning } from '@ponswars/calibration';
import { readFile } from 'node:fs/promises';

/**
 * The calibration this deployment scores by (§59.4, §102).
 *
 * A file rather than a dozen environment variables, because §59.4 treats the
 * engine block as one decision: scoring divisors, momentum and victory
 * thresholds and the confidence bands are chosen together against one market,
 * and a deployment that set half of them would be running a calibration nobody
 * looked at as a whole.
 *
 * It is the same shape `tools/calibrate-market.mjs` measures a candidate as, so
 * the file that was replayed against recorded tapes is the file that runs —
 * `docs/operations/market-calibration.md` is the path from one to the other.
 *
 * Read once, at startup, and never again: a round scored under one calibration
 * and finalized under another would be a result no replay could reproduce
 * (§26). Changing it is a deploy.
 */
export async function loadEngineCalibration(path: string): Promise<EngineTuning> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(
      `ENGINE_CALIBRATION_FILE is ${path}, which could not be read. ` +
        'It holds the engine tuning and confidence bands this deployment scores by (§59.4); ' +
        'tools/calibration/initial-candidate.json is the shape, and docs/operations/market-calibration.md ' +
        'is how one is chosen.',
      { cause: error },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`ENGINE_CALIBRATION_FILE is ${path}, which is not JSON`, { cause: error });
  }
  try {
    return parseEngineTuning(json);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}
