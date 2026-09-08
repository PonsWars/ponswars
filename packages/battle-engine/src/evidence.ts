import { createHash } from 'node:crypto';
import type { FeedHealth, UtcTimestamp } from '@ponswars/shared-types';
import type { SideInputs } from '@ponswars/battle-math';

/**
 * The running evidence digest (§26).
 *
 * §26 requires enough retained evidence to reproduce a historical battle, and
 * `battle_results.evidence_hash` is the anchor for it. A hash computed at the
 * end over a stored blob would prove the blob was not edited afterwards; a hash
 * folded forward tick by tick also proves nothing was dropped along the way.
 *
 * The chain is `H(previous ‖ tickBytes)`, so the final digest depends on every
 * tick, in order. Removing a tick, reordering two, or altering one input
 * changes it — which is what makes it worth storing next to the result.
 */

/** Digest of an empty battle, before the first tick. */
export const EMPTY_EVIDENCE = '0'.repeat(64);

function encodeSide(side: SideInputs): string {
  const { cardSupport } = side;
  return [
    side.windowReturn,
    side.volatility,
    side.relativeVolume,
    side.qualifiedPonsActivity,
    side.uniqueActiveWallets,
    cardSupport.market,
    cardSupport.volume,
    cardSupport.pons,
    cardSupport.general,
  ]
    .map((value) => value.toString())
    .join(',');
}

export interface EvidenceTick {
  readonly sequence: number;
  readonly at: UtcTimestamp;
  readonly left: SideInputs;
  readonly right: SideInputs;
  readonly leftHealth: FeedHealth;
  readonly rightHealth: FeedHealth;
  readonly leftScoreScaled: bigint;
  readonly rightScoreScaled: bigint;
}

/**
 * Folds one tick into the digest.
 *
 * Fields are joined with a separator that cannot appear inside any of them, so
 * two different ticks cannot serialise to the same string. Every numeric value
 * is written as a decimal `bigint` string rather than a float, for the same
 * reason the engine computes in `bigint`: a digest that depended on float
 * formatting would not survive a change of runtime.
 */
export function foldEvidence(previous: string, tick: EvidenceTick): string {
  const payload = [
    String(tick.sequence),
    String(tick.at),
    encodeSide(tick.left),
    encodeSide(tick.right),
    tick.leftHealth,
    tick.rightHealth,
    tick.leftScoreScaled.toString(),
    tick.rightScoreScaled.toString(),
  ].join('|');

  return createHash('sha256')
    .update(Buffer.from('PONSWARS_EVIDENCE_V1', 'utf8'))
    .update(Buffer.from(previous, 'utf8'))
    .update(Buffer.from(payload, 'utf8'))
    .digest('hex');
}
