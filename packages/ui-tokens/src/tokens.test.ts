import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVE_TICKERS, RARITIES } from '@ponswars/shared-types';
import { describe, expect, it } from 'vitest';
import {
  CARD_ASPECT_RATIO,
  cssVar,
  DURATION,
  durations,
  FACTION_ACCENT,
  factionAccentVar,
  LAYER,
  MIN_TOUCH_TARGET,
  RADIUS,
  RARITY_COLOR,
  rarityColorVar,
  REDUCED_MOTION_DURATION,
  SPACE,
} from './tokens.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tokens.css'), 'utf8');

/** Reads a custom property out of the `:root` block. */
const cssValue = (name: string): string | null => {
  const match = new RegExp(`--pw-${name}:\\s*([^;]+);`).exec(css);
  return match?.[1]?.trim() ?? null;
};

describe('the stylesheet and the constants agree', () => {
  // Two copies of the same values that could disagree is the failure design
  // tokens §1 exists to prevent, wearing a different coat. These tests are the
  // only thing keeping them one source.

  it.each(Object.entries(DURATION))('duration %s matches the stylesheet', (name, ms) => {
    const cssName = {
      instant: 'dur-instant',
      fast: 'dur-fast',
      ui: 'dur-ui',
      panel: 'dur-panel',
      spatialShort: 'dur-spatial-short',
      spatial: 'dur-spatial',
      cinematic: 'dur-cinematic',
    }[name];
    expect(cssValue(cssName ?? '')).toBe(`${String(ms)}ms`);
  });

  it.each(Object.entries(LAYER))('layer %s matches the stylesheet', (name, value) => {
    const cssName = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    expect(cssValue(`z-${cssName}`)).toBe(String(value));
  });

  it.each(ACTIVE_TICKERS)('faction accent for %s matches the stylesheet', (ticker) => {
    expect(cssValue(`faction-${ticker.toLowerCase()}`)).toBe(FACTION_ACCENT[ticker]);
  });

  it.each(RARITIES)('rarity colour for %s matches the stylesheet', (rarity) => {
    expect(cssValue(`rarity-${rarity.toLowerCase()}`)).toBe(RARITY_COLOR[rarity]);
  });

  it.each(Object.entries(RADIUS))('radius %s matches the stylesheet', (name, value) => {
    expect(cssValue(`radius-${name}`)).toBe(`${String(value)}px`);
  });

  it('spacing scale matches the stylesheet', () => {
    SPACE.forEach((value, index) => {
      expect(cssValue(`space-${String(index + 1)}`)).toBe(`${String(value)}px`);
    });
  });
});

describe('coverage', () => {
  it('gives every active faction an accent', () => {
    // §36.7: a faction must stay identifiable with colour removed, so an accent
    // is a cue - but a missing one would leave a faction with no cue at all.
    expect(Object.keys(FACTION_ACCENT).sort()).toEqual([...ACTIVE_TICKERS].sort());
  });

  it('gives every rarity a colour', () => {
    expect(Object.keys(RARITY_COLOR).sort()).toEqual([...RARITIES].sort());
  });

  it('gives every faction a distinct accent', () => {
    // Two factions sharing a colour would make the accent useless as an
    // identity cue in exactly the situation it is needed - a matchup.
    const values = ACTIVE_TICKERS.map((ticker) => FACTION_ACCENT[ticker]);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('motion grammar', () => {
  it('orders durations from instant to cinematic', () => {
    // §14 maps each class to a kind of interaction. Out-of-order values would
    // make a microinteraction slower than a panel transition.
    const ordered = [
      DURATION.instant,
      DURATION.fast,
      DURATION.ui,
      DURATION.panel,
      DURATION.spatialShort,
      DURATION.spatial,
      DURATION.cinematic,
    ];
    expect([...ordered].sort((a, b) => a - b)).toEqual(ordered);
  });

  it('collapses but never zeroes under reduced motion', () => {
    // §15: "Never remove functional feedback." A state change still registers;
    // it simply stops travelling.
    for (const value of Object.values(REDUCED_MOTION_DURATION)) {
      expect(value).toBeGreaterThan(0);
    }
    expect(REDUCED_MOTION_DURATION.spatial).toBeLessThan(DURATION.spatial);
    expect(REDUCED_MOTION_DURATION.cinematic).toBeLessThan(DURATION.cinematic);
  });

  it('selects the right set for the mode', () => {
    expect(durations(false).spatial).toBe(DURATION.spatial);
    expect(durations(true).spatial).toBe(REDUCED_MOTION_DURATION.spatial);
  });

  it('declares the reduced-motion overrides in the stylesheet too', () => {
    // A JS-only override would leave CSS transitions running at full length for
    // someone who asked for less motion.
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});

describe('layers', () => {
  it('orders the stack from world to cinematic', () => {
    // §18 assigns ownership rather than suggesting. A component picking its own
    // z-index is how a toast ends up behind a panel.
    const ordered = [
      LAYER.world,
      LAYER.worldLabel,
      LAYER.hud,
      LAYER.panel,
      LAYER.card,
      LAYER.toast,
      LAYER.critical,
      LAYER.cinematic,
    ];
    expect([...ordered].sort((a, b) => a - b)).toEqual(ordered);
    expect(new Set(ordered).size).toBe(ordered.length);
  });

  it('puts the world at the bottom', () => {
    // §42.1: the world is the hero. Everything else sits above it.
    expect(LAYER.world).toBe(Math.min(...Object.values(LAYER)));
  });
});

describe('variable helpers', () => {
  it('builds custom property references', () => {
    expect(cssVar('accent')).toBe('var(--pw-accent)');
    expect(factionAccentVar('NVDA')).toBe('var(--pw-faction-nvda)');
    expect(rarityColorVar('LEGENDARY')).toBe('var(--pw-rarity-legendary)');
  });

  it('resolves to a property the stylesheet actually declares', () => {
    for (const ticker of ACTIVE_TICKERS) {
      const name = factionAccentVar(ticker).slice('var('.length, -1);
      expect(css).toContain(`${name}:`);
    }
  });
});

describe('geometry', () => {
  it('keeps card proportions inside the specified range', () => {
    // §9: approximately 0.72-0.76 wide to 1 tall.
    expect(CARD_ASPECT_RATIO).toBeGreaterThanOrEqual(0.72);
    expect(CARD_ASPECT_RATIO).toBeLessThanOrEqual(0.76);
  });

  it('keeps radii restrained', () => {
    // §9: chamfered and industrial, "no soft consumer-app rounded card
    // language". A 24px radius would read as a consumer app whatever the
    // palette does.
    for (const value of Object.values(RADIUS)) {
      expect(value).toBeLessThanOrEqual(12);
    }
  });

  it('meets the minimum touch target', () => {
    // §13 and masterplan §83.5. On a device where the world also responds to
    // drag, a small control is a control people miss.
    expect(MIN_TOUCH_TARGET).toBeGreaterThanOrEqual(44);
  });

  it('grows spacing monotonically', () => {
    expect([...SPACE].sort((a, b) => a - b)).toEqual([...SPACE]);
  });
});
