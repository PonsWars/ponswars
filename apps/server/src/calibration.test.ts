import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEngineCalibration } from './calibration.js';

/**
 * The calibration a deployment scores by, loaded from its file.
 *
 * The file the tool measures a candidate as is the file the server runs, so
 * the repository's own starting candidate is loaded here: a change that makes
 * one unreadable by the other fails.
 */

const CANDIDATE = join(
  dirname(new URL(import.meta.url).pathname),
  '../../../tools/calibration/initial-candidate.json',
);

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')).replace(/^\/([A-Za-z]:)/, '$1');
}

async function fileWith(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ponswars-calibration-'));
  const path = join(directory, 'engine-calibration.json');
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('loadEngineCalibration', () => {
  it('loads the candidate the calibration tool starts from', async () => {
    const { engine, confidence } = await loadEngineCalibration(CANDIDATE);

    expect(engine.victory.narrowMargin).toBe(4_000_000n);
    expect(engine.momentum.push).toBe(100_000n);
    expect(confidence.matchup.dominant).toBe(120);
  });

  it('says which file, and every problem in it', async () => {
    const path = await fileWith(
      JSON.stringify({
        engine: { scoring: {}, momentum: {}, victory: {} },
        confidence: {},
      }),
    );

    await expect(loadEngineCalibration(path)).rejects.toThrow(
      /engine\.scoring\.priceEdgeDivisor[\s\S]*confidence\.matchup\.favored/,
    );
    await expect(loadEngineCalibration(path)).rejects.toThrow(path);
  });

  it('refuses a file that is not there, naming what it is for', async () => {
    await expect(loadEngineCalibration(join(tmpdir(), 'no-such-calibration.json'))).rejects.toThrow(
      /ENGINE_CALIBRATION_FILE[\s\S]*§59\.4/,
    );
  });

  it('refuses a file that is not JSON', async () => {
    const path = await fileWith('engine = everything');

    await expect(loadEngineCalibration(path)).rejects.toThrow('not JSON');
  });

  it('refuses bands that cannot mean what they say', async () => {
    const candidate = JSON.parse(
      await (await import('node:fs/promises')).readFile(CANDIDATE, 'utf8'),
    ) as { confidence: { priceTrend: unknown } };
    const path = await fileWith(
      JSON.stringify({
        ...candidate,
        confidence: { ...candidate.confidence, priceTrend: { strong: '-1', weak: '1' } },
      }),
    );

    await expect(loadEngineCalibration(path)).rejects.toThrow('confidence:');
  });
});
