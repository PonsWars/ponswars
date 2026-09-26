import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCandidate } from './candidate.js';

/** The candidate the calibration tool starts from, so it is proved to load. */
function initialCandidateJson(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL('../../../tools/calibration/initial-candidate.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

describe('parseCandidate', () => {
  it('reads the tool’s starting candidate, market values through the server’s own parsers', () => {
    const candidate = parseCandidate(initialCandidateJson());
    expect(candidate.market.MARKET_OUTLIER_BPS).toBe(300);
    // Parsed into dates, one per entry in the file's comma list, rather than
    // pinned: the list grows each year the exchange publishes another.
    const listed = String(
      (initialCandidateJson()['market'] as Record<string, unknown>)['MARKET_HOLIDAYS'],
    );
    expect(candidate.market.MARKET_HOLIDAYS).toEqual(listed.split(','));
    expect(candidate.market.MARKET_HOLIDAYS).toContain('2027-01-01');
    expect(candidate.market.MARKET_MIN_TRADE_USD).toBe('5');
    expect(candidate.engine.victory.narrowMargin).toBe(4_000_000n);
    expect(candidate.confidence.momentumStability).toEqual({ stable: 26, mixed: 32 });
  });

  it('lists every problem at once', () => {
    const json = initialCandidateJson();
    const market = { ...(json['market'] as Record<string, unknown>) };
    market['MARKET_OUTLIER_BPS'] = '0';
    market['MARKET_HOLIDAYS'] = '2026-02-30';
    delete market['PONS_MIN_ACTIVITY_USD'];
    const broken = { ...json, market, engine: { scoring: {}, momentum: {}, victory: {} } };

    let message = '';
    try {
      parseCandidate(broken);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('market.MARKET_OUTLIER_BPS');
    expect(message).toContain('market.MARKET_HOLIDAYS');
    expect(message).toContain('market.PONS_MIN_ACTIVITY_USD');
    expect(message).toContain('engine.scoring.priceEdgeDivisor');
    expect(message).toContain('engine.victory.decisiveMargin');
  });

  it('refuses confidence bands that cannot mean what they say', () => {
    const json = initialCandidateJson();
    const confidence = json['confidence'] as Record<string, unknown>;
    expect(() =>
      parseCandidate({
        ...json,
        confidence: { ...confidence, priceTrend: { strong: '-500000', weak: '500000' } },
      }),
    ).toThrow('confidence:');
  });
});
