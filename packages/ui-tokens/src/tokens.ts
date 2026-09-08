import { ACTIVE_TICKERS, RARITIES, type ActiveTicker, type Rarity } from '@ponswars/shared-types';

/**
 * The design tokens, typed.
 *
 * `tokens.css` is what the browser reads; this is what TypeScript reads — the
 * camera runtime needs motion durations as numbers, a canvas needs faction
 * accents as colour strings, and neither can query a CSS custom property from
 * a test.
 *
 * A test asserts the two agree. Design tokens §1 forbids scattering one-off
 * colours, radii, timings and z-indexes through components; two copies of the
 * same values that could disagree would be the same failure wearing a different
 * coat.
 */

/** Motion durations in milliseconds (§14, masterplan §114.2). */
export const DURATION = {
  instant: 90,
  fast: 160,
  ui: 240,
  panel: 360,
  spatialShort: 650,
  spatial: 1_050,
  cinematic: 1_600,
} as const;

export type DurationName = keyof typeof DURATION;

/**
 * Durations under Reduced Motion (§15, masterplan §83.3).
 *
 * Collapsed, never zeroed: *"Never remove functional feedback."* A state change
 * still registers — it simply stops travelling.
 */
export const REDUCED_MOTION_DURATION = {
  ...DURATION,
  panel: DURATION.fast,
  spatialShort: DURATION.fast,
  spatial: DURATION.ui,
  cinematic: DURATION.ui,
} as const;

export function durations(reducedMotion: boolean): Readonly<Record<DurationName, number>> {
  return reducedMotion ? REDUCED_MOTION_DURATION : DURATION;
}

/**
 * Stacking order (§18).
 *
 * Ownership rather than suggestion: a component picking its own z-index is how
 * a toast ends up behind a panel. Every layer the app uses is named here.
 */
export const LAYER = {
  world: 0,
  worldLabel: 10,
  hud: 100,
  panel: 200,
  card: 300,
  toast: 500,
  critical: 700,
  cinematic: 900,
} as const;

export type LayerName = keyof typeof LAYER;

/**
 * Faction accents (§3).
 *
 * *"Use faction accents for identity cues, selected states, VFX, world labels,
 * and local highlights. Do not fill the entire UI with faction color."*
 *
 * Masterplan §36.7 adds the constraint these values live under: a faction must
 * stay identifiable with its colour removed, so an accent is a cue and never
 * the carrier of meaning. §83.4 says the same for accessibility.
 */
export const FACTION_ACCENT: Readonly<Record<ActiveTicker, string>> = {
  NVDA: '#76f04d',
  AAPL: '#9ed4ff',
  MSFT: '#43cfff',
  TSLA: '#ff3f4a',
  GME: '#e74d86',
  META: '#a45cff',
  AMZN: '#e69a32',
  GOOGL: '#66b7ff',
  AMD: '#e63a35',
  SPY: '#c7a55a',
} as const;

/** Rarity colours (§2). */
export const RARITY_COLOR: Readonly<Record<Rarity, string>> = {
  COMMON: '#8c949b',
  UNCOMMON: '#aeb8bf',
  RARE: '#72a9ff',
  EPIC: '#9c6cff',
  LEGENDARY: '#d4ad63',
  SECRET: '#d8d7e9',
} as const;

/** Spacing scale, in pixels (§2). */
export const SPACE = [4, 8, 12, 16, 24, 32, 48, 64] as const;

/** Corner geometry (§2, §9: restrained and angular, never bubbly). */
export const RADIUS = {
  sm: 4,
  md: 8,
  lg: 12,
  panel: 10,
} as const;

/**
 * Minimum touch target, in pixels (§13, masterplan §83.5).
 *
 * A control smaller than this on a device where the world also responds to
 * drag is a control people miss — and §37.4 keeps gesture complexity low
 * precisely so the two do not compete.
 */
export const MIN_TOUCH_TARGET = 44;

/**
 * Card aspect ratio (§9): roughly 0.72–0.76 wide to 1 tall.
 *
 * The midpoint, so a layout has one number rather than a range to argue over.
 */
export const CARD_ASPECT_RATIO = 0.74;

/** CSS custom property name for a token, for use in inline styles. */
export function cssVar(name: string): string {
  return `var(--pw-${name})`;
}

/** The custom property holding a faction's accent. */
export function factionAccentVar(ticker: ActiveTicker): string {
  return cssVar(`faction-${ticker.toLowerCase()}`);
}

/** The custom property holding a rarity's colour. */
export function rarityColorVar(rarity: Rarity): string {
  return cssVar(`rarity-${rarity.toLowerCase()}`);
}

/** Every active ticker has an accent, checked at module load in tests. */
export const FACTION_TICKERS = ACTIVE_TICKERS;
export const ALL_RARITIES = RARITIES;
