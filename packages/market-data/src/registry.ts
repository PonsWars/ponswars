import type { DurationMs, Ticker } from '@ponswars/shared-types';

/**
 * Canonical asset metadata (§74.1).
 *
 * Every field here is per-environment or per-vendor, so the registry is loaded
 * from configuration rather than compiled in — `docs/OPEN_PARAMETERS.md` keeps
 * feed IDs, token addresses and provider cadence `OPEN`, and §4.1 requires the
 * whole roster to be verified against the live Robinhood Chain / Stock Token
 * environment before deployment.
 */
export interface AssetMetadata {
  readonly ticker: Ticker;
  /** Stock-token contract, where the asset has one. */
  readonly tokenAddress?: string;
  /** Primary high-frequency price stream identifier. */
  readonly priceFeedId: string;
  /**
   * Independent reference feed for the §23.7 cross-check.
   *
   * Optional because not every asset will have a second source. Where it is
   * absent, divergence protection cannot run and that asset carries more risk —
   * a fact worth being able to see in the registry rather than discovering
   * during an incident.
   */
  readonly referenceFeedId?: string;
  readonly decimals: number;
  /**
   * Cumulative corporate-action multiplier (§23.8, §74.1).
   *
   * A 4-for-1 split makes historical prices four times too high relative to
   * today's. Normalizing before return calculation is what stops a split from
   * reading as a 75% crash and deciding a battle.
   */
  readonly corporateActionMultiplier: number;
  readonly status: 'ACTIVE' | 'RESERVE';
  /** How often the provider is expected to publish. Drives freshness (§23.6). */
  readonly expectedCadence: DurationMs;
}

export type AssetRegistry = Readonly<Record<string, AssetMetadata>>;

/** Looks up an asset, failing loudly rather than returning a partial default. */
export function requireAsset(registry: AssetRegistry, ticker: Ticker): AssetMetadata {
  const asset = registry[ticker];
  if (asset === undefined) {
    throw new RangeError(
      `No registry entry for ${ticker}. §74.1 requires canonical metadata per asset; ` +
        'ingesting without it would mean guessing decimals and cadence.',
    );
  }
  return asset;
}

/** The active roster as configured. Reserve assets substitute before a round (§4.2). */
export function activeAssets(registry: AssetRegistry): readonly AssetMetadata[] {
  return Object.values(registry).filter((asset) => asset.status === 'ACTIVE');
}
