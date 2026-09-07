import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TICKERS,
  FACTIONS,
  isActiveTicker,
  isReserveTicker,
  isTicker,
  RESERVE_TICKERS,
  type ActiveTicker,
} from './roster.js';

describe('roster composition', () => {
  it('fields exactly ten active tickers', () => {
    // §4.3: ten stocks produce exactly five battles, each stock appearing once.
    // An odd count would make a self-match or a bye unavoidable.
    expect(ACTIVE_TICKERS).toHaveLength(10);
    expect(ACTIVE_TICKERS.length % 2).toBe(0);
  });

  it('holds the locked active roster in order', () => {
    expect([...ACTIVE_TICKERS]).toEqual([
      'NVDA',
      'AAPL',
      'MSFT',
      'TSLA',
      'GME',
      'META',
      'AMZN',
      'GOOGL',
      'AMD',
      'SPY',
    ]);
  });

  it('holds the locked reserve roster', () => {
    expect([...RESERVE_TICKERS]).toEqual(['COIN', 'PLTR', 'NFLX', 'QQQ']);
  });

  it('contains no duplicate tickers', () => {
    const all = [...ACTIVE_TICKERS, ...RESERVE_TICKERS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps the active and reserve rosters disjoint', () => {
    const active = new Set<string>(ACTIVE_TICKERS);
    for (const reserve of RESERVE_TICKERS) {
      expect(active.has(reserve)).toBe(false);
    }
  });
});

describe('faction definitions', () => {
  it('defines exactly one faction per active ticker', () => {
    expect(Object.keys(FACTIONS).sort()).toEqual([...ACTIVE_TICKERS].sort());
  });

  it('keys every faction by its own ticker', () => {
    for (const ticker of ACTIVE_TICKERS) {
      expect(FACTIONS[ticker].ticker).toBe(ticker);
    }
  });

  it('gives every faction all five unit slots', () => {
    // §36.8: infantry, elite, heavy, air and a temporary forward base.
    for (const ticker of ACTIVE_TICKERS) {
      const { units } = FACTIONS[ticker];
      for (const slot of ['infantry', 'elite', 'heavy', 'air', 'base'] as const) {
        expect(units[slot].length).toBeGreaterThan(0);
      }
    }
  });

  it('gives all fifty units a distinct name', () => {
    // Guide §25: factions must not be the same model in a different colour.
    // Distinct naming is the cheapest enforceable part of that rule.
    const names = ACTIVE_TICKERS.flatMap((ticker) => Object.values(FACTIONS[ticker].units));
    expect(names).toHaveLength(50);
    expect(new Set(names).size).toBe(50);
  });

  it('uses the canonical unit names, not the AI-generated alternates', () => {
    // Guide §24.2 names these specific alternates as non-canonical. They appear
    // inside generated dossier PNGs, which makes them easy to adopt by mistake.
    const rejected = [
      'Data Bastion',
      'Skynet Drones',
      'Azure Nexus',
      'Arc Lancer',
      'Breakthrough Carrier',
      'Propulsion Drones',
      'Mars Foundry',
      'Ape Captain',
      'Meme Engine',
      'Hype Drones',
      'Retail Fortress',
      'Portal Master',
      'Rift Carrier',
      'Holo Drones',
      'Reality Spire',
      'Lens Warden',
      'Oracle Platform',
      'Intel Drones',
      'Intelligence Spire',
      'Overclock Captain',
      'Thermal Siege',
      'Compute Drones',
      'Red Core Citadel',
      'Command Guard',
      'Combined Arms Carrier',
      'Market Drones',
      'Market Core',
    ];
    const names = new Set(ACTIVE_TICKERS.flatMap((t) => Object.values(FACTIONS[t].units)));
    for (const alternate of rejected) {
      expect(names.has(alternate)).toBe(false);
    }
  });

  it('spot-checks the benchmark faction against masterplan section 39.1', () => {
    // NVDA is the visual benchmark the other nine propagate from (§28.1).
    expect(FACTIONS.NVDA).toMatchObject({
      name: 'AI Mech Legion',
      units: {
        infantry: 'Compute Trooper',
        elite: 'GPU Sentinel',
        heavy: 'Tensor Walker',
        air: 'CUDA Drone Swarm',
        base: 'Compute Fortress',
      },
    });
  });

  it('names no faction after a permanent territory', () => {
    // §38.3: sectors are neutral and reused. Permanent per-faction territory is
    // the deprecated conquest system and must not creep back in through naming.
    for (const ticker of ACTIVE_TICKERS) {
      expect(FACTIONS[ticker].identity.toLowerCase()).not.toContain('territory');
    }
  });
});

describe('ticker guards', () => {
  it('narrows active tickers', () => {
    expect(isActiveTicker('NVDA')).toBe(true);
    expect(isActiveTicker('COIN')).toBe(false);
    expect(isActiveTicker('NOPE')).toBe(false);
  });

  it('narrows reserve tickers', () => {
    expect(isReserveTicker('COIN')).toBe(true);
    expect(isReserveTicker('NVDA')).toBe(false);
  });

  it('narrows any known ticker', () => {
    expect(isTicker('NVDA')).toBe(true);
    expect(isTicker('QQQ')).toBe(true);
    expect(isTicker('nvda')).toBe(false);
    expect(isTicker('')).toBe(false);
  });

  it('narrows to a usable type', () => {
    const candidate = 'AMD';
    if (isActiveTicker(candidate)) {
      const ticker: ActiveTicker = candidate;
      expect(FACTIONS[ticker].name).toBe('Red Core Battalion');
    } else {
      expect.unreachable('AMD is an active ticker');
    }
  });
});
