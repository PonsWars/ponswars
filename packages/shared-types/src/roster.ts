/**
 * Active and reserve stock rosters, and the canonical faction identity for
 * each active ticker.
 *
 * Masterplan §4.1–4.2, §14, §39. Visual Implementation Guide §24.
 *
 * The unit names below are the canonical set. Several generated faction
 * dossiers in the visual pack contain alternate AI-invented names — Data
 * Bastion, Skynet Drones, Arc Lancer, Ape Captain, Portal Master and others.
 * Guide §24.1 rules those non-canonical. Defining the names once, here, is what
 * stops a plausible-looking name in a PNG from becoming production truth.
 *
 * No colour values appear in this file. Exact palettes are `OPEN` production
 * tuning (§59.4) and belong to the design tokens, not to compiled constants.
 */

/**
 * The ten active V1 factions (§4.1).
 *
 * Production availability, data coverage, token contracts and ticker metadata
 * must still be verified against the live Robinhood Chain / Stock Token
 * environment before deployment.
 */
export const ACTIVE_TICKERS = [
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
] as const;

export type ActiveTicker = (typeof ACTIVE_TICKERS)[number];

/**
 * Reserve roster (§4.2).
 *
 * A reserve asset replaces an active asset **before** a round when the active
 * asset's required data is unavailable or unhealthy. It is never swapped in
 * mid-battle — that path is BATTLE VOID (§4.4).
 */
export const RESERVE_TICKERS = ['COIN', 'PLTR', 'NFLX', 'QQQ'] as const;

export type ReserveTicker = (typeof RESERVE_TICKERS)[number];

export type Ticker = ActiveTicker | ReserveTicker;

/** The five unit slots every faction fields (§36.8). */
export interface FactionUnits {
  readonly infantry: string;
  readonly elite: string;
  readonly heavy: string;
  /** Air or drone tier. */
  readonly air: string;
  /**
   * Temporary Forward Operating Base deployed into the assigned sector for the
   * round, retracted at reshuffle (§38.5). Never a permanent territory.
   */
  readonly base: string;
}

export interface FactionDefinition {
  readonly ticker: ActiveTicker;
  /** Product-facing faction name (§14). */
  readonly name: string;
  /** One-line identity used for art direction and intel copy (§39). */
  readonly identity: string;
  readonly units: FactionUnits;
  /**
   * How this faction reads while pushing (§26).
   *
   * Presentation only. Momentum signatures never carry hidden scoring weight —
   * the battle score is fixed at 45/25/20/10 (§12).
   */
  readonly momentumSignature: string;
  /**
   * Named accent family. A description, not a hex value: faction colour is an
   * accent rather than a full-screen wash (§36.5), and the exact palette is
   * open production tuning.
   *
   * Colour is never the sole carrier of identity — every faction must stay
   * recognisable from silhouette alone (§36.7) and from labels for
   * accessibility (§83.4).
   */
  readonly accent: string;
}

export const FACTIONS: Readonly<Record<ActiveTicker, FactionDefinition>> = {
  NVDA: {
    ticker: 'NVDA',
    name: 'AI Mech Legion',
    identity: 'Precision AI warfare — compute, autonomy, a coordinated green and graphite force.',
    units: {
      infantry: 'Compute Trooper',
      elite: 'GPU Sentinel',
      heavy: 'Tensor Walker',
      air: 'CUDA Drone Swarm',
      base: 'Compute Fortress',
    },
    momentumSignature: 'Coordinated AI push with targeting grid',
    accent: 'controlled neon green',
  },
  AAPL: {
    ticker: 'AAPL',
    name: 'Titanium Guard',
    identity:
      'Clean titanium and controlled cool blue — defensive precision. Absorb, control, counter.',
    units: {
      infantry: 'Titanium Guard',
      elite: 'Pro Sentinel',
      heavy: 'Titanium Bastion',
      air: 'Halo Drones',
      base: 'Titanium Citadel',
    },
    momentumSignature: 'Shield formation and controlled counter',
    accent: 'cool white, silver and blue',
  },
  MSFT: {
    ticker: 'MSFT',
    name: 'Azure Cyber Corps',
    identity:
      'Networked battlefield control — modular navy and cyan infrastructure, firewall visuals.',
    units: {
      infantry: 'Azure Operator',
      elite: 'Cloud Warden',
      heavy: 'Azure Fortress Walker',
      air: 'Synapse Drones',
      base: 'Azure Command Grid',
    },
    momentumSignature: 'Network links and the Firewall Wall',
    accent: 'cyan-blue',
  },
  TSLA: {
    ticker: 'TSLA',
    name: 'Mars Vanguard',
    identity: 'Speed, propulsion and electric assault with Mars-industrial aggression.',
    units: {
      infantry: 'Volt Raider',
      elite: 'Arc Striker',
      heavy: 'Mars Assault Rover',
      air: 'Starlink Strike Drones',
      base: 'Mars Forward Colony',
    },
    momentumSignature: 'Overdrive Charge and propulsion',
    accent: 'red, Mars-orange and electric arcs',
  },
  GME: {
    ticker: 'GME',
    name: 'Retail Rebellion',
    identity: 'Gritty improvised rebellion — community rally and underdog resilience.',
    units: {
      infantry: 'Diamond Hand Raider',
      elite: 'Ape Vanguard',
      heavy: 'YOLO Breaker',
      air: 'Meme Swarm Drones',
      base: 'Retail Stronghold',
    },
    momentumSignature: 'Rally Surge and irregular counterattack',
    accent: 'charcoal with red and purple signals',
  },
  META: {
    ticker: 'META',
    name: 'Reality Legion',
    identity: 'Mixed-reality warfare — portals, refraction and holographic deception.',
    units: {
      infantry: 'Reality Trooper',
      elite: 'Mirage Operative',
      heavy: 'Reality Anchor',
      air: 'Echo Drones',
      base: 'Reality Nexus',
    },
    momentumSignature: 'Reality Shift and spatial distortion',
    accent: 'violet and cyan refraction',
  },
  AMZN: {
    ticker: 'AMZN',
    name: 'Fulfillment Army',
    identity: 'Logistics domination — modular industrial systems and constant resupply.',
    units: {
      infantry: 'Fulfillment Trooper',
      elite: 'Prime Enforcer',
      heavy: 'Fulfillment Crawler',
      air: 'Delivery Drone Fleet',
      base: 'Fulfillment Fortress',
    },
    momentumSignature: 'Prime Delivery and logistics saturation',
    accent: 'amber-orange routing',
  },
  GOOGL: {
    ticker: 'GOOGL',
    name: 'Intelligence Division',
    identity: 'Information superiority — prediction, scanning, optical and sensor warfare.',
    units: {
      infantry: 'Search Operator',
      elite: 'DeepScan Ranger',
      heavy: 'Oracle Array',
      air: 'Index Drones',
      base: 'Search Nexus',
    },
    momentumSignature: 'Predictive Lock — scan, mark, strike',
    accent: 'restrained spectral scanning colours',
  },
  AMD: {
    ticker: 'AMD',
    name: 'Red Core Battalion',
    identity: 'Overclocked brute compute — thick gunmetal armour and thermal heat language.',
    units: {
      infantry: 'Core Breaker',
      elite: 'Overclock Enforcer',
      heavy: 'Redline Juggernaut',
      air: 'Thermal Raptors',
      base: 'Red Core Foundry',
    },
    momentumSignature: 'Redline Overdrive and thermal pressure',
    accent: 'crimson and molten orange',
  },
  SPY: {
    ticker: 'SPY',
    name: 'Market Federation',
    identity:
      'Balanced combined arms — dark military steel, muted market green, restrained warm gold.',
    units: {
      infantry: 'Federation Rifleman',
      elite: 'Index Vanguard',
      heavy: 'Market Titan',
      air: 'Sentinel Wings',
      base: 'Federation Command Bastion',
    },
    momentumSignature: 'Market Formation and combined-arms synchronisation',
    accent: 'muted market green with warm gold',
  },
} as const;

/** Narrows an arbitrary string to an active ticker. */
export function isActiveTicker(value: string): value is ActiveTicker {
  return (ACTIVE_TICKERS as readonly string[]).includes(value);
}

/** Narrows an arbitrary string to a reserve ticker. */
export function isReserveTicker(value: string): value is ReserveTicker {
  return (RESERVE_TICKERS as readonly string[]).includes(value);
}

/** Narrows an arbitrary string to any known ticker. */
export function isTicker(value: string): value is Ticker {
  return isActiveTicker(value) || isReserveTicker(value);
}
