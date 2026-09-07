import { createHash } from 'node:crypto';

/**
 * Deterministic pseudo-random byte stream for verifiable game decisions.
 *
 * Masterplan §4.3 requires matchmaking to be *"deterministic and verifiable from
 * a chain-derived seed and round context"*, and §26 requires enough evidence for
 * a third party to reproduce a round. Both mean the randomness has to be a
 * published function of a published seed — not `Math.random()`, and not any
 * engine-specific PRNG whose internals another implementation would have to
 * replicate exactly.
 *
 * The construction is SHA-256 in counter mode: `SHA256(domain ‖ seed ‖ counter)`
 * concatenated across increasing counters. It has no hidden state, needs only a
 * SHA-256 implementation to reproduce, and is specified in three lines — an
 * auditor can rewrite it in Python or Solidity without reading this file.
 */

/**
 * Validates and canonicalises a hex seed.
 *
 * Every entry point runs through this. `Buffer.from(value, 'hex')` stops at the
 * first character it cannot parse and returns what it managed to read, so an
 * unvalidated seed does not fail — it silently becomes a shorter one, or an
 * empty one. A round scheduled from an empty seed still produces a schedule,
 * and every round would produce the *same* schedule. That failure is invisible
 * at the call site and catastrophic in production, which is why parsing is
 * centralised here rather than repeated per caller.
 *
 * The `0x` prefix is stripped case-insensitively: an uppercased seed is the
 * same seed.
 */
function normalizeSeedHex(seedHex: string): string {
  const withoutPrefix = /^0x/i.test(seedHex) ? seedHex.slice(2) : seedHex;
  if (withoutPrefix.length === 0 || !/^[0-9a-fA-F]+$/.test(withoutPrefix)) {
    throw new TypeError(`Seed must be a non-empty hex string, received ${JSON.stringify(seedHex)}`);
  }
  if (withoutPrefix.length % 2 !== 0) {
    throw new TypeError(
      `Seed must contain a whole number of bytes, received ${JSON.stringify(seedHex)}`,
    );
  }
  return withoutPrefix.toLowerCase();
}

/**
 * Separates one use of a seed from another.
 *
 * Matchmaking and any future consumer derive from the same round seed, so
 * without separation they would consume identical byte streams and correlate.
 */
export type PrngDomain = string;

export class DeterministicPrng {
  readonly #seed: Buffer;
  readonly #domain: string;
  #counter = 0;
  #block: Buffer = Buffer.alloc(0);
  #offset = 0;

  /**
   * @param seedHex Chain-derived seed as a hex string, with or without `0x`.
   * @param domain Domain separator for this use of the seed.
   */
  constructor(seedHex: string, domain: PrngDomain) {
    if (domain.length === 0) {
      throw new TypeError('PRNG domain separator must not be empty');
    }
    this.#seed = Buffer.from(normalizeSeedHex(seedHex), 'hex');
    this.#domain = domain;
  }

  #refill(): void {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(this.#counter));
    this.#block = createHash('sha256')
      .update(Buffer.from(this.#domain, 'utf8'))
      .update(this.#seed)
      .update(counter)
      .digest();
    this.#counter += 1;
    this.#offset = 0;
  }

  /** Next byte of the stream. */
  nextByte(): number {
    if (this.#offset >= this.#block.length) {
      this.#refill();
    }
    const byte = this.#block[this.#offset];
    /* c8 ignore next 3 -- unreachable: refill guarantees the offset is in range. */
    if (byte === undefined) {
      throw new Error('PRNG stream underflow');
    }
    this.#offset += 1;
    return byte;
  }

  /** Next `count` bytes of the stream. */
  nextBytes(count: number): Buffer {
    const out = Buffer.alloc(count);
    for (let i = 0; i < count; i += 1) {
      out[i] = this.nextByte();
    }
    return out;
  }

  /**
   * Uniform integer in `[0, bound)`, via rejection sampling.
   *
   * Rejection rather than modulo: `x % bound` is biased toward small values
   * whenever `bound` does not divide the range evenly. The bias is tiny, but
   * "tiny bias in the matchmaking of a game with real rewards" is not a
   * sentence worth writing. Rejection costs an occasional extra draw and makes
   * the distribution exactly uniform.
   *
   * @throws RangeError unless `bound` is a positive safe integer.
   */
  nextBelow(bound: number): number {
    if (!Number.isSafeInteger(bound) || bound <= 0) {
      throw new RangeError(`Bound must be a positive integer, received ${String(bound)}`);
    }
    if (bound === 1) {
      return 0;
    }

    // Four bytes covers any bound this game needs and keeps rejection rare.
    const range = 2 ** 32;
    const limit = range - (range % bound);
    for (;;) {
      const value = this.nextBytes(4).readUInt32BE(0);
      if (value < limit) {
        return value % bound;
      }
    }
  }

  /**
   * Fisher-Yates shuffle, returning a new array.
   *
   * Named in §4.3 as the preferred algorithm. Iterating downward and drawing
   * from `[0, i]` is the unbiased form — the common upward variant drawing from
   * the full range is not, and produces a measurably skewed distribution.
   */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.nextBelow(i + 1);
      const a = out[i];
      const b = out[j];
      /* c8 ignore next 3 -- unreachable: both indices are within bounds. */
      if (a === undefined || b === undefined) {
        throw new Error('Shuffle index out of range');
      }
      out[i] = b;
      out[j] = a;
    }
    return out;
  }
}

/**
 * Derives a seed for a specific round from a chain-derived base seed.
 *
 * Round context is mixed in so two rounds sharing a base seed cannot produce
 * the same matchmaking (§4.3).
 */
export function deriveRoundSeed(baseSeedHex: string, roundId: string): string {
  if (roundId.length === 0) {
    throw new TypeError('Round id must not be empty');
  }
  return createHash('sha256')
    .update(Buffer.from('PONSWARS_ROUND_SEED_V1', 'utf8'))
    .update(Buffer.from(normalizeSeedHex(baseSeedHex), 'hex'))
    .update(Buffer.from(roundId, 'utf8'))
    .digest('hex');
}
