import { describe, expect, it } from 'vitest';
import {
  FOB_FACTIONS,
  FOB_MAX_HEIGHT,
  FOB_MIN_HEIGHT,
  FOB_RADIUS,
  fobHeight,
  fobShape,
  fobSilhouette,
} from './fob-shape.js';

/**
 * The bases the ten factions land (§38.5), against the rule that decides
 * whether they are ten bases or one (§36.7).
 */

describe('a faction forward base', () => {
  it('exists for every faction §4.1 fields', () => {
    expect(FOB_FACTIONS).toHaveLength(10);
    for (const ticker of FOB_FACTIONS) {
      expect(fobShape(ticker).parts.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('is identifiable with its colour taken away (§36.7)', () => {
    // The rule this file exists for. Every faction used to land the same
    // footing, mast and octahedron with one colour swapped — which in a grey
    // screenshot, or to a viewer who cannot tell green from red, is one base
    // shown ten times.
    const silhouettes = FOB_FACTIONS.map((ticker) => fobSilhouette(fobShape(ticker)));

    expect(new Set(silhouettes).size).toBe(FOB_FACTIONS.length);
  });

  it('carries its colour as an accent rather than as paint (§36.5)', () => {
    for (const ticker of FOB_FACTIONS) {
      const parts = fobShape(ticker).parts;
      const accents = parts.filter((part) => part.material === 'accent');

      expect(accents.length).toBeGreaterThanOrEqual(1);
      expect(accents.length).toBeLessThanOrEqual(Math.ceil(parts.length / 2));
    }
  });

  it('keeps every faction within a hand of the others in height (§36.9)', () => {
    // Comparable visual power: no god-base for one faction and a tent for
    // another. The band is stated rather than assumed, so a new structure that
    // towers over the rest fails here rather than in a screenshot.
    for (const ticker of FOB_FACTIONS) {
      const height = fobHeight(fobShape(ticker));

      expect(height).toBeGreaterThanOrEqual(FOB_MIN_HEIGHT);
      expect(height).toBeLessThanOrEqual(FOB_MAX_HEIGHT);
    }
  });

  it('stands clear of the ranks that form in front of it', () => {
    // The base sits at the outer edge of its staging ground; the army forms
    // inward. Anything reaching past this is standing in a formation.
    for (const ticker of FOB_FACTIONS) {
      for (const part of fobShape(ticker).parts) {
        const [x, , z] = part.position;
        const reach = Math.max(part.size[0], part.size[2]);

        expect(Math.hypot(x, z) + reach).toBeLessThanOrEqual(FOB_RADIUS);
      }
    }
  });

  it('stands on the deck rather than sinking into it or floating over it', () => {
    for (const ticker of FOB_FACTIONS) {
      for (const part of fobShape(ticker).parts) {
        expect(part.position[1]).toBeGreaterThan(0);
      }
      // And something is actually touching it: a base whose lowest piece starts
      // at knee height would read as hovering.
      const lowest = Math.min(
        ...fobShape(ticker).parts.map((part) => part.position[1] - part.size[1] / 2),
      );
      expect(lowest).toBeLessThanOrEqual(1);
    }
  });
});
