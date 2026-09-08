/**
 * Algorithm versions stamped onto every battle result (§73.1).
 *
 * *"Every battle result stores: scoring engine version, normalization version,
 * Pons qualification version, baseline dataset version, card aggregation
 * version. This enables historical replay after future tuning."*
 *
 * Five separate versions rather than one, because they change independently. A
 * recalibrated volatility normalizer does not invalidate a Pons qualification
 * filter, and a replay needs to know which combination produced a given result
 * — a single number would force every historical battle to be reinterpreted
 * whenever any one of them moved.
 *
 * Bump the specific version whose behaviour changed, in the same commit as the
 * change. A result stamped with a version whose behaviour has since shifted is
 * a result nobody can reproduce, which is exactly what §26 forbids.
 */
export interface EngineVersions {
  /** The score engine itself: weights, edges, the split primitive. */
  readonly scoring: string;
  /** Volatility adjustment and relative-volume normalization (§12.1, §12.2). */
  readonly normalization: string;
  /** Pons anti-abuse qualification and filtering (§12.3). */
  readonly ponsQualification: string;
  /** The historical baseline dataset volume is compared against (§12.2). */
  readonly baselineDataset: string;
  /** Card support aggregation and diminishing returns (§12.4). */
  readonly cardAggregation: string;
}

/**
 * Versions this build produces.
 *
 * Deliberately not derived from the package version. A patch release that
 * touches documentation must not restamp results as though the maths moved,
 * and a maths change must bump the version whether or not the package version
 * did.
 */
export const CURRENT_ENGINE_VERSIONS: EngineVersions = {
  scoring: 'scoring-v1',
  normalization: 'normalization-v1',
  ponsQualification: 'pons-qualification-v1',
  baselineDataset: 'baseline-v1',
  cardAggregation: 'card-aggregation-v1',
} as const;

/** Renders the version set into one stable string for storage and logs. */
export function versionTag(versions: EngineVersions): string {
  return [
    versions.scoring,
    versions.normalization,
    versions.ponsQualification,
    versions.baselineDataset,
    versions.cardAggregation,
  ].join('+');
}
