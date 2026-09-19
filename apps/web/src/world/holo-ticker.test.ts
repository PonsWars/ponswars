import { ACTIVE_TICKERS, FACTIONS } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  BASE_INNER_X,
  CONTESTED_EDGE_X,
  DISTRICT_CENTRE_X,
  HOLO_BANDS,
  tapeText,
} from './holo-ticker.js';
import { SECTOR_SKYLINE_HEIGHT } from './layout.js';

/**
 * The tape round each district (§38.11), and the two things it may not do:
 * say something untrue about the market, or get between a viewer and the fight.
 */

describe('the ticker tape', () => {
  it('carries no number, for any faction', () => {
    // The client holds no price and §24 hides the score, so a digit on this
    // tape would be a figure this client made up and dressed as market data —
    // the thing the art bible's mockup corrections forbid by name.
    for (const ticker of ACTIVE_TICKERS) {
      expect(tapeText(ticker)).not.toMatch(/[0-9]/);
    }
  });

  it('says whose district it is, and nothing else', () => {
    for (const ticker of ACTIVE_TICKERS) {
      const text = tapeText(ticker);
      expect(text).toContain(ticker);
      expect(text).toContain(FACTIONS[ticker].name.toUpperCase());
    }
  });
});

describe('a band of tape', () => {
  it('never reaches over the contested ground (§36.15)', () => {
    for (const band of HOLO_BANDS) {
      expect(DISTRICT_CENTRE_X - band.radiusX).toBeGreaterThan(CONTESTED_EDGE_X);
    }
  });

  it('never passes through the forward base behind it (§38.5)', () => {
    for (const band of HOLO_BANDS) {
      expect(DISTRICT_CENTRE_X + band.radiusX).toBeLessThan(BASE_INNER_X);
    }
  });

  it('stays inside the skyline a camera already keeps clear of', () => {
    // Above the towers, a band is something a battlefield camera can fly
    // through. The poses keep clear of the skyline, so the tape stays in it.
    for (const band of HOLO_BANDS) {
      expect(band.y + band.height / 2).toBeLessThan(SECTOR_SKYLINE_HEIGHT);
      expect(band.arc).toBeGreaterThan(0);
      expect(band.arc).toBeLessThanOrEqual(1);
    }
  });
});
